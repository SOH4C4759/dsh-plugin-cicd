/**
 * Host half of the `dsh-plugin-cicd` bundle — 发布台 (Release Console).
 *
 * Why it exists: the repositories in `F:\CodeProj` each carry a release workflow,
 * but the answer to "what is built, what is published, and is the tree ahead of
 * the release?" lives in three places at once — GitHub Actions, the Releases
 * page, and the local checkout. This half collapses those into one loopback
 * surface the browser half renders.
 *
 * Why it shells out to `gh` instead of calling the REST API with a token:
 * `gh` is already authenticated on this machine and already knows the token's
 * scopes. Reusing it means the panel needs no credential of its own, nothing is
 * stored in the plugin, and the same command a human would run is the one the
 * panel runs (`gh run list`, `gh workflow run`, `gh release edit`).
 *
 * Surface (all POST, loopback + same-origin gated, see `isTrustedRequest`):
 *   /api/dsh-cicd/status           gh identity + the resolved repository list
 *   /api/dsh-cicd/overview         per-repo runs, releases, and local git state
 *   /api/dsh-cicd/runs             one repository's recent runs
 *   /api/dsh-cicd/dispatch         trigger a workflow (`workflow_dispatch`)
 *   /api/dsh-cicd/run-action       rerun / rerun-failed / cancel one run
 *   /api/dsh-cicd/release-action   publish a draft, or delete a release
 *   /api/dsh-cicd/version-bump     bump package.json, commit it, push the branch
 *   /api/dsh-cicd/logs             the tail of the failed steps of one run
 *   /api/dsh-cicd/update           install this profile's copy from the release's tgz
 *   /api/dsh-cicd/restart          hand a restart to dsh-plugin-restart, if it is mounted
 *
 * And the third channel, which is not a package at all: the update note under the
 * video that introduces the plugin.
 *
 *   /api/dsh-cicd/bilibili-status       credential, bindings, and what is pending
 *   /api/dsh-cicd/bilibili-login-start  begin the Bilibili web sign-in (QR / browser)
 *   /api/dsh-cicd/bilibili-login-poll   ask once whether it was confirmed
 *   /api/dsh-cicd/bilibili-login-cancel give up on the sign-in
 *   /api/dsh-cicd/bilibili-credential   store a pasted SESSDATA + bili_jct
 *   /api/dsh-cicd/bilibili-logout       forget the credential this plugin stored
 *   /api/dsh-cicd/bilibili-bind         bind a repository to a video's comments
 *   /api/dsh-cicd/bilibili-announce     post (or compose) one update comment
 *
 * The release dispatch carries a preflight, and that is not a convenience. Every
 * repository in this set releases from `package.json`'s version, and its release
 * workflow refuses to reuse a version that already belongs to another commit
 * (otherwise the tag and the uploaded assets silently disagree). So pressing
 * 发布 without bumping the version produced a run that could only fail — measured
 * four times across two repositories, each ~10 s in, at the first step — while the
 * panel announced a draft that was never created. `releasePreflight` turns that
 * into one answer before anything is dispatched, and `version-bump` is the step
 * the button was missing.
 *
 * Every route answers `{ ok: true, value }` or `{ ok: false, code, message }`.
 *
 * @module dsh-plugin-cicd
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  isValidRepoName,
  normalizeBinding,
  normalizeEntry,
  parseConfig,
  readConfig,
  writeConfig,
} from './lib/config-store.mjs'
import {
  announcementVerdict,
  composeComment,
  cookieHeader,
  createBilibiliClient,
  credentialVerdict,
  emptyLedger,
  findLedgerEntry,
  latestBaseline,
  newestPublishedRelease,
  parseCookieJar,
  parseLedger,
  recordLedgerEntry,
  withDeviceIds,
} from './lib/bilibili.mjs'

/** Plugin name shown in loader logs. */
export const name = 'dsh-plugin-cicd'

/** The Web server is the only required service: it carries the routes. */
export const inject = ['webServer']

const runFile = promisify(execFile)

/** This module's directory, so the panel can quote a command that really runs here. */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** Route namespace owned by this plugin. */
const ROUTE_PREFIX = '/api/dsh-cicd'

const DEFAULT_TIMEOUT_MS = 20_000
const MIN_TIMEOUT_MS = 2_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_OVERVIEW_TTL_MS = 15_000
const MAX_OVERVIEW_TTL_MS = 300_000
const DEFAULT_POLL_SECONDS = 30
const MAX_REPOS = 40
const DEFAULT_LOG_TAIL_LINES = 120
const MAX_LOG_TAIL_LINES = 400
const MAX_BODY_BYTES = 32 * 1024

/**
 * How long a forwarded restart request may take before it is reported as
 * unreachable. The restart plugin answers before it arms the supervisor, so this
 * is a bound on talking to a sibling route on loopback, not on restarting.
 */
const RESTART_FORWARD_TIMEOUT_MS = 15_000

/** Where a release tarball is downloaded to, beside the managed config file. */
const DOWNLOAD_DIR_NAME = 'downloads'

/**
 * The two files the Bilibili feature owns, both beside `repos.json`.
 *
 * The credential is stored here rather than in the row config because it is a
 * live session, not a setting: it expires, it gets replaced, and it must never
 * be echoed back to the panel. The ledger is the opposite — it is the record of
 * what has already been said in public, and losing it re-posts every comment.
 */
const BILIBILI_CREDENTIAL_FILE_NAME = 'bilibili-cookies.json'
const BILIBILI_LEDGER_FILE_NAME = 'bilibili-announcements.json'

/** How often the Host looks for a newly published release, and the ceiling on that. */
const DEFAULT_BILIBILI_WATCH_SECONDS = 90
const MAX_BILIBILI_WATCH_SECONDS = 3600

/** How long a credential/video answer is reused before Bilibili is asked again. */
const DEFAULT_BILIBILI_VERIFY_TTL_MS = 300_000
const MAX_BILIBILI_VERIFY_TTL_MS = 3_600_000

/** A Bilibili sign-in QR code is valid for about three minutes. */
const BILIBILI_LOGIN_TTL_MS = 180_000

/** How many failed attempts at one release before the sweep stops retrying. */
const BILIBILI_MAX_ATTEMPTS = 3

/** How many ledger entries are kept; older ones are the ones nobody reads. */
const BILIBILI_MAX_LEDGER_ENTRIES = 500

/** The registry this console publishes to, unless the row config names another. */
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/'

/**
 * One packument read is a single HTTPS request, so it is bounded tightly; a publish
 * is a package-manager run that uploads the tarball, so it is not.
 */
const NPM_STATUS_TIMEOUT_MS = 8_000
const NPM_PUBLISH_TIMEOUT_MS = 180_000

/**
 * How long one registry answer is reused.
 *
 * The npm state is asked for on demand — when the panel opens, after a push, after a
 * sign-in — and never on the 30-second poll, because a request per repository per
 * poll is a cost the panel does not need to pay for a fact that changes when someone
 * publishes.
 */
const NPM_STATUS_TTL_MS = 60_000

/**
 * Wire protocol of the browser half this Host half can serve.
 *
 * The two halves do not reload together: the browser bundle is read from disk on
 * every page load, while this module is imported once per Host process. A page
 * refresh therefore produces "new client, old host", where the client calls a
 * route that does not exist yet and reports it as a request failure — which reads
 * like a GitHub or credential problem and is neither. The client compares this
 * number and says what to do instead.
 *
 * 3: `version-bump`, the `releaseCheck` verdict on every overview row, and the
 * release dispatch's preflight. A 2.x client asking a 2.x host to publish a
 * version that is already taken is the bug this protocol bump retires.
 *
 * 5: `npm-status`, `npm-login` and `npm-publish`. A 4.x host has no `npm-*` route at
 * all, so a 5.x client's npm button would read a 401 as "the registry rejected me".
 *
 * 6: the `bilibili-*` family. Same trap, more of it: a 5.x host mounts none of
 * those routes, and this feature's failures are the kind that get misread — a 401
 * from `bilibili-credential` looks like "Bilibili refused the cookie" and a 401
 * from `bilibili-announce` looks like "not signed in", while both really mean the
 * running Host is older than the page.
 *
 * 4: `update` and `restart`, and the `install` block on every overview row. A 3.x
 * client renders rows without it, so the two halves would still agree on the old
 * surface — but the new buttons post to routes a 3.x host does not mount, which is
 * exactly the 401-reads-as-a-credential-problem this number exists to prevent.
 */
const PROTOCOL = 6

/** The managed repository list, written by `scripts/configure.mjs`. */
const DEFAULT_CONFIG_FILE_NAME = 'repos.json'

/**
 * How long a browser sign-in attempt may stay pending. GitHub expires the
 * one-time code after about fifteen minutes; the panel should not hold a polling
 * child longer than a person would plausibly take.
 */
const AUTH_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How long `gh auth login` may go without printing a one-time code before the
 * attempt is reported as stalled.
 *
 * This is not a nicety. Measured on a machine where `github.com:443` was blocked:
 * `gh auth login --web` printed NOTHING and was still running after 20 seconds —
 * no code, no error, no exit. The code otherwise arrives in well under a second, so
 * six seconds without one is already abnormal and worth saying out loud. The report
 * is advisory: the attempt keeps running, because gh was measured producing the code
 * once the network recovered.
 */
const AUTH_CODE_DEADLINE_MS = 6_000

/**
 * Probe `host:port` and say WHICH layer failed.
 *
 * Resolving first is the whole point. A DNS failure and a blocked port look
 * identical from a bare connect, and they have different causes and different
 * fixes. Measured on this machine: connecting to github.com by name timed out,
 * while connecting to the very address it resolves to succeeded in 83ms — so the
 * name resolution is what flaps, and a message saying "cannot open a connection to
 * github.com:443" described the wrong layer.
 *
 * @param {string} host - hostname to resolve and connect to.
 * @param {number} port - TCP port.
 * @param {number} timeoutMs - per-stage budget.
 * @returns {Promise<{ok: boolean, stage: 'ok'|'dns'|'tcp', address: string|null}>} probe result.
 */
export async function probeHost(host, port, timeoutMs) {
  let address = null
  try {
    const resolved = await withTimeout(lookup(host, { all: true }), timeoutMs)
    const first = Array.isArray(resolved) ? resolved[0] : resolved
    address = typeof first?.address === 'string' ? first.address : null
  } catch {
    return { ok: false, stage: 'dns', address: null }
  }
  if (address === null) return { ok: false, stage: 'dns', address: null }
  const connected = await new Promise((resolve) => {
    let settled = false
    const socket = connect({ host: address, port })
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
  return connected ? { ok: true, stage: 'ok', address } : { ok: false, stage: 'tcp', address }
}

/**
 * Work out which proxy `gh` should use.
 *
 * `gh` and `git` honour the HTTP(S)_PROXY environment variables and ignore the
 * Windows internet settings that a browser follows. On a machine whose browser can
 * open github.com while `gh auth login` prints nothing, that difference is the whole
 * story, so the system setting is read here and handed to the gh children.
 *
 * @param {string} explicit - `proxy` from the row config; wins when set.
 * @param {string} [platform] - injectable for tests.
 * @returns {{url: string|null, source: 'config'|'windows'|'none'}} the proxy to use.
 */
export function resolveProxy(explicit, platform = process.platform) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const value = explicit.trim()
    return { url: value.includes('://') ? value : `http://${value}`, source: 'config' }
  }
  if (platform !== 'win32') return { url: null, source: 'none' }
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    )
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? null
    if (!enabled || server === null) return { url: null, source: 'none' }
    return { url: server.includes('://') ? server : `http://${server}`, source: 'windows' }
  } catch {
    return { url: null, source: 'none' }
  }
}

/**
 * Environment additions that make `gh` use a proxy.
 * @param {string|null} url - proxy URL, or null for none.
 * @returns {object} environment entries to spread into a child's env.
 */
export function proxyEnvironment(url) {
  if (url === null) return {}
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    // The loopback surface this plugin serves must never be routed through it.
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  }
}

/**
 * Proxy for the gh children, set once by `apply`.
 *
 * A module-level value because `runTool` is a plain function called from dozens of
 * host handlers; threading the config through all of them would be a larger change
 * than this deserves, and one plugin instance serves one process.
 */
let activeProxyEnvironment = {}

/**
 * Can this process open a TCP connection to `host:port`, name resolution included?
 * @param {string} host - hostname.
 * @param {number} port - TCP port.
 * @param {number} timeoutMs - per-stage budget.
 * @returns {Promise<boolean>} whether the connection was established.
 */
export async function canReach(host, port, timeoutMs) {
  return (await probeHost(host, port, timeoutMs)).ok
}

/**
 * Resolve a promise, or reject once `timeoutMs` has passed.
 * @param {Promise<unknown>} promise - work to bound.
 * @param {number} timeoutMs - budget in milliseconds.
 * @returns {Promise<unknown>} the value, or a rejection on timeout.
 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Scopes the panel actually needs. `repo` covers private repositories, releases
 * and the Actions API; `workflow` is what allows dispatching one. Nothing here
 * needs `admin:*`, so the guide asks for the minimum that makes the buttons work.
 */
const REQUIRED_SCOPES = ['repo', 'workflow']

/** A repository argument is passed to `gh` as one argv element; keep it shaped like a slug. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SLUG_WITH_OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/* ------------------------------------------------------------------ config -- */

/** Clamp a number into range, falling back to a default for anything unusable. */
function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** Trim a value that should be a non-empty string, or return the fallback. */
function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Normalize one configured repository entry.
 *
 * The rules live in `lib/config-store.mjs` because `scripts/configure.mjs` writes
 * the same file the Host reads: two copies of "what a repository name may look
 * like" would eventually disagree, and the failure mode of that disagreement is a
 * registered repository the panel silently ignores.
 *
 * @param {unknown} entry - one element of `config.repos`.
 * @returns {{repo: string, localPath: string, label: string}|null}
 */
export function normalizeRepoEntry(entry) {
  return normalizeEntry(entry)
}

/**
 * Resolve the row config into the plugin's working shape.
 *
 * Values are clamped rather than rejected: a hand-written patch must never be
 * able to stop the Host from starting, so the worst case is a route that reports
 * "not configured" instead of a plugin that fails to load.
 *
 * @param {object|undefined} raw - row config from the profile patch.
 * @returns {object} resolved config.
 */
export function resolveConfig(raw) {
  const repos = []
  const seen = new Set()
  const declared = Array.isArray(raw?.repos) ? raw.repos : []
  for (const entry of declared.slice(0, MAX_REPOS)) {
    const normalized = normalizeRepoEntry(entry)
    if (normalized === null || seen.has(normalized.repo)) continue
    seen.add(normalized.repo)
    repos.push(normalized)
  }
  return {
    enabled: raw?.enabled !== false,
    owner: text(raw?.owner),
    repos,
    ghPath: text(raw?.ghPath),
    defaultBranch: text(raw?.defaultBranch, 'main'),
    buildWorkflow: text(raw?.buildWorkflow, 'ci.yml'),
    releaseWorkflow: text(raw?.releaseWorkflow, 'release.yml'),
    requestTimeoutMs: clampNumber(raw?.requestTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    overviewTtlMs: clampNumber(raw?.overviewTtlMs, 0, MAX_OVERVIEW_TTL_MS, DEFAULT_OVERVIEW_TTL_MS),
    logTailLines: clampNumber(raw?.logTailLines, 20, MAX_LOG_TAIL_LINES, DEFAULT_LOG_TAIL_LINES),
    pollSeconds: clampNumber(raw?.pollSeconds, 10, 900, DEFAULT_POLL_SECONDS),
    configFile: text(raw?.configFile),
    /**
     * Where local checkouts live. Used only to fill `localPath` automatically when
     * a repository is registered from the panel: asking a person to type an
     * absolute path is exactly the kind of step this plugin exists to remove.
     */
    projectsRoot: text(raw?.projectsRoot),
    /**
     * An explicit proxy for gh, e.g. `http://127.0.0.1:7897`.
     *
     * Empty means "work it out from the system settings". gh, like git, reads the
     * HTTP(S)_PROXY environment variables and ignores the Windows proxy that the
     * browser uses — which is how a machine can open github.com in a browser while
     * `gh auth login` sits there printing nothing at all.
     */
    proxy: text(raw?.proxy),
    /**
     * The npm registry the push targets. Configurable because "publish to npm" means
     * npmjs.com on most machines and a private registry on others, and a plugin that
     * hard-coded the first would be wrong on the second without saying so.
     */
    npmRegistry: normalizeRegistry(raw?.npmRegistry),
    /**
     * Bilibili update notes: when a repository's release goes public, say so under
     * the video that introduces it.
     *
     * `bilibiliEnabled` and `bilibiliAuto` are separate switches on purpose. Turning
     * the feature off must silence the sweep; turning `auto` off must keep the panel's
     * manual button working. One boolean could not express both.
     */
    bilibiliEnabled: raw?.bilibiliEnabled !== false,
    bilibiliAuto: raw?.bilibiliAuto !== false,
    bilibiliWatchSeconds: clampNumber(raw?.bilibiliWatchSeconds, 0, MAX_BILIBILI_WATCH_SECONDS, DEFAULT_BILIBILI_WATCH_SECONDS),
    bilibiliTemplate: typeof raw?.bilibiliTemplate === 'string' ? raw.bilibiliTemplate : '',
    /**
     * An external credential file — biliup's `cookies.json` is the one this machine
     * has. Read as a FALLBACK: what the panel's own sign-in wrote always wins, so a
     * configured path can never shadow a credential the user just created.
     */
    bilibiliCookieFile: text(raw?.bilibiliCookieFile),
    bilibiliVerifyTtlMs: clampNumber(raw?.bilibiliVerifyTtlMs, 0, MAX_BILIBILI_VERIFY_TTL_MS, DEFAULT_BILIBILI_VERIFY_TTL_MS),
    /**
     * A `fetch` the Bilibili transport should use. Not a setting: it exists so the
     * route tests can drive the whole announce path — compose, post, ledger — against
     * a fake instead of against a real account.
     */
    bilibiliFetch: typeof raw?.bilibiliFetch === 'function' ? raw.bilibiliFetch : null,
  }
}

/**
 * Where the managed repository list lives.
 *
 * The row config is the hand-written source of truth, and editing YAML by hand is
 * exactly the cost this file removes: `scripts/configure.mjs` owns a JSON file
 * instead, and the row only has to say where it is. One path per machine (under
 * `DSH_HOME`, not per profile) because "which repositories do I watch" is a
 * property of the machine, not of a profile.
 *
 * @param {object} config - resolved config.
 * @returns {string} absolute path of the managed file.
 */
export function resolveConfigFilePath(config) {
  if (typeof config.configFile === 'string' && config.configFile !== '') return config.configFile
  const home = text(process.env.DSH_HOME) !== '' ? text(process.env.DSH_HOME) : join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return join(home, 'dsh-plugin-cicd', DEFAULT_CONFIG_FILE_NAME)
}

/**
 * Parse the managed repository file.
 *
 * Rejects rather than repairs: a file this plugin wrote and cannot read is a
 * symptom worth showing, and silently falling back to "no repositories" would
 * look identical to "you configured nothing yet". The rules themselves live in
 * `lib/config-store.mjs`, which `scripts/configure.mjs` and the mutation routes
 * also use — one definition of the format, three callers.
 *
 * @param {string} raw - file contents.
 * @returns {{ok: true, owner: string, repos: object[], dropped: number}|{ok: false, message: string}}
 */
export function parseReposFile(raw) {
  return parseConfig(raw)
}

/**
 * Resolve the configuration a request should actually use.
 *
 * The managed file is read on every call rather than at plugin load, so a change
 * made from the panel or from `configure.mjs` takes effect on the next poll
 * instead of at the next restart. The row config stays the fallback for a machine
 * that never created the file, which keeps a hand-written patch working exactly as
 * documented.
 *
 * @param {object} config - the row-resolved config.
 * @returns {object} config plus `repos`, `owner`, `configSource`, `configFile`, `configProblem`.
 */
export function effectiveConfig(config) {
  const file = resolveConfigFilePath(config)
  const stored = readConfig(file)
  if (!stored.exists) {
    return { ...config, configFile: file, configSource: config.repos.length > 0 ? 'row' : 'none', configProblem: null }
  }
  if (stored.problem !== null) {
    return { ...config, configFile: file, configSource: 'file-invalid', configProblem: stored.problem }
  }
  return {
    ...config,
    owner: stored.owner !== '' ? stored.owner : config.owner,
    repos: stored.repos,
    configFile: file,
    configSource: 'file',
    configProblem: null,
    configDropped: stored.dropped,
  }
}

/**
 * Parse `gh auth status`.
 *
 * `gh` prints this on stderr and includes a "Token scopes: '...'" line only when
 * the credential actually carries scopes. The scope list is the part that
 * matters: an authenticated token without `workflow` can read a run but cannot
 * dispatch one, and that difference is invisible until a button fails.
 *
 * @param {string} text - combined stdout and stderr of `gh auth status`.
 * @returns {{authenticated: boolean, account: string|null, scopes: string[], missingScopes: string[]}}
 */
export function parseAuthStatus(text) {
  const source = typeof text === 'string' ? text : ''
  const authenticated = /Logged in to \S+ account/i.test(source)
  const accountMatch = /Logged in to \S+ account ([A-Za-z0-9-]+)/i.exec(source)
  const scopesMatch = /Token scopes:\s*(.+)/i.exec(source)
  const scopes = []
  if (scopesMatch !== null) {
    for (const token of scopesMatch[1].split(/[,\s]+/)) {
      const cleaned = token.replace(/['"]/g, '').trim()
      if (cleaned !== '') scopes.push(cleaned)
    }
  }
  return {
    authenticated,
    account: accountMatch === null ? null : accountMatch[1],
    scopes,
    // An empty scope list is "unknown", not "none": `gh` omits the line for a
    // credential it cannot introspect (a fine-grained token), and reporting that
    // as "missing repo, workflow" would send the user to fix a non-problem.
    missingScopes: scopes.length === 0 ? [] : REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)),
  }
}

/**
 * Read the current authentication posture from `gh`.
 * @param {string} ghPath - resolved executable.
 * @param {number} timeoutMs - deadline.
 * @returns {Promise<object>} what the panel needs to guide a first run.
 */
export async function readAuthStatus(ghPath, timeoutMs) {
  const result = await runTool(ghPath, ['auth', 'status'], timeoutMs)
  // `gh auth status` exits non-zero when nothing is logged in, so the streams are
  // the evidence and the exit code is not.
  const combined = `${result.stdout}\n${result.stderr}`
  return { ...parseAuthStatus(combined), exitCode: result.code, raw: combined.trim() }
}

/**
 * Whether a candidate is a command name to look up on PATH, rather than a path.
 *
 * This has to be decided by shape, not by `path.isAbsolute`: on POSIX a Windows
 * path like `C:\Program Files\GitHub CLI\gh.exe` is *not* absolute, so an
 * `isAbsolute` test reads it as a bare command name and hands it straight to
 * `spawn`. That is exactly the bug the mount check caught on a Linux runner —
 * "spawn C:\Program Files\GitHub CLI\gh.exe ENOENT" — and it would have broken
 * gh resolution for every non-Windows install.
 *
 * @param {string} value - a trimmed candidate.
 * @returns {boolean} true when the value names a command to resolve through PATH.
 */
function isCommandName(value) {
  return !/[/\\]/.test(value)
}

/**
 * Where `gh` is.
 *
 * Precedence is deliberate: an explicit configuration wins outright, even when
 * the file is not there. A typo should surface as `ENOENT` naming the path the
 * user configured, not as a silent switch to whichever `gh` happens to be on
 * PATH — that is the kind of "works on my machine" failure nobody can debug.
 * Only the built-in guesses are checked against the filesystem, and the Windows
 * ones are only considered on Windows.
 *
 * @param {object} config - resolved config.
 * @param {string} [platform] - `process.platform`, injectable so the Windows
 *   candidate list can be tested from a POSIX machine and vice versa.
 * @returns {string} an absolute path, or a command name for PATH lookup.
 */
export function resolveGhPath(config, platform = process.platform) {
  const configured = text(config?.ghPath)
  if (configured !== '') return configured

  for (const value of [process.env.DSH_GH_PATH, process.env.DSH_GITHUB_CLI]) {
    const fromEnv = text(value)
    if (fromEnv !== '') return fromEnv
  }

  // The Windows installer's locations are only candidates where they can exist;
  // on POSIX they would be dead weight at best and — as this function learned the
  // hard way — an outright wrong answer when tested for absoluteness.
  const candidates = []
  if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'GitHub CLI', 'gh.exe'),
      join(process.env.ProgramFiles ?? '', 'GitHub CLI', 'gh.exe'),
    )
  }
  for (const candidate of candidates) {
    if (isCommandName(candidate)) continue
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate
  }
  // Nothing confirmed on disk: let the OS search PATH, which is right on POSIX
  // and is the honest answer anywhere else.
  return 'gh'
}

/* -------------------------------------------------------------- gh runner -- */

/** First non-empty line of a message, for a panel-sized error string. */
function firstLine(value) {
  const source = typeof value === 'string' ? value : ''
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** How many changed file names the overview carries; the count is carried in full. */
const LOCAL_FILE_LIMIT = 20

/**
 * Ask repeatedly whether a comment can be read back, and answer honestly either way.
 *
 * The reader is injected because the interesting part is the RETRY, and the route that
 * uses it cannot be driven in a test — reaching a real post needs a readable release
 * list, and the suite deliberately hands the Host a `gh` that cannot exist.
 *
 * @param {object} params - `{read, aid, rpid, attempts, delayMs, wait}`.
 * @returns {Promise<{visible: boolean, attempts: number, code: number|null, message: string}>}
 */
export async function confirmVisible({
  read,
  aid,
  rpid,
  attempts = 3,
  delayMs = 3000,
  wait = (ms) => new Promise((settle) => setTimeout(settle, ms)),
}) {
  let last = { code: null, message: '' }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const found = await read(aid, rpid)
    if (found !== null && found !== undefined && found.ok === true && found.visible === true) {
      return { visible: true, attempts: attempt, code: 0, message: '' }
    }
    last = { code: found?.code ?? null, message: String(found?.message ?? '') }
    if (attempt < attempts) await wait(delayMs)
  }
  return { visible: false, attempts, code: last.code, message: last.message }
}

/** A clone moves a repository, not a request: give it minutes, not seconds. */
const CLONE_TIMEOUT_MS = 180_000

/**
 * The address `git clone` would use for a repository, when nothing better was given.
 *
 * Derived rather than demanded — the panel exists to remove steps, and "paste the clone
 * URL of the repository you already registered" is one of them. A bare name needs
 * `owner` from the config; a name written `owner/repo` does not.
 *
 * @param {string} owner - the configured owner, possibly ''.
 * @param {string} repo - the repository id as configured.
 * @returns {string} an https URL, or '' when there is nothing to derive it from.
 */
export function defaultCloneUrl(owner, repo) {
  const name = text(repo).trim()
  if (name === '') return ''
  if (name.includes('/')) return `https://github.com/${name.replace(/^\/+|\/+$/g, '')}.git`
  const login = text(owner).trim()
  return login === '' ? '' : `https://github.com/${login}/${name}.git`
}

/**
 * The path out of one `git status --porcelain` line.
 *
 * V1 format is `XY <path>`, quoted when the name holds unusual bytes, and a rename
 * reads `XY <old> -> <new>`. Both are passed through rather than prettified: this list
 * exists so a person recognises what is about to be committed, and a path this code
 * rewrote is one they would not recognise.
 *
 * @param {string} line - one trimmed porcelain line.
 * @returns {string} what to show.
 */
export function statusPath(line) {
  /*
   * No leading trim. Porcelain v1 is `XY <path>`, and for an unstaged modification X is
   * a SPACE — ` M package.json`. Trimming first turns that into `M package.json`, whose
   * first three characters then eat the `p` of the path: the list promised to help
   * someone recognise what they are about to commit would read `ackage.json`.
   */
  const raw = String(line).replace(/\r$/, '')
  return raw.length <= 3 ? raw.trim() : raw.slice(3).trim()
}

/**
 * The one line of a failed command's output that explains it.
 *
 * A failed `pnpm publish` writes EVERY byte to STDOUT — measured, stderr is 0 bytes —
 * and its first line is the progress line (`📦 pkg@1.0.0 → registry`) while its last
 * few hundred are a stack trace. Node then adds `Command failed: <the whole command>`
 * as the child-process error's message. So "the first line of stderr" is the progress
 * bar, the wrapper, or nothing at all: the sentence that says WHY sits in the middle
 * and is the only part worth putting on screen.
 *
 * Preference: a line carrying an error code (`[E403]`, `npm ERR!`, `ERR_PNPM_…`) →
 * a `pnpm: ` sentence → the first line that is not noise. Noise is the progress line,
 * the wrapper, stack frames, blank lines.
 *
 * @param {unknown} output - combined stdout and stderr.
 * @param {string} [fallback] - what to answer when nothing meaningful is there.
 * @returns {string} the line to show.
 */
export function firstMeaningfulLine(output, fallback = '') {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const isNoise = (line) => line.startsWith('📦')
    || line.startsWith('Command failed:')
    || line.startsWith('at ')
    || line.startsWith('throw ')
    || line === '^'
    || line.startsWith('node:internal')
    || /^Progress: /.test(line)
  for (const line of lines) {
    if (/^\[(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+)\]/.test(line) || line.startsWith('npm ERR!') || /ERR_PNPM_[A-Z_]+/.test(line)) return line
  }
  for (const line of lines) {
    if (line.startsWith('pnpm: ')) return line
  }
  for (const line of lines) {
    if (!isNoise(line)) return line
  }
  return fallback
}

/**
 * `firstMeaningfulLine` for a `runTool`/`runSpawn` result: both streams, then the
 * child-process error as the last resort.
 *
 * @param {object} result - a failed spawn result.
 * @param {string} fallback - the sentence for "it failed and said nothing usable".
 * @returns {string} the line to show.
 */
export function commandFailureLine(result, fallback) {
  return firstMeaningfulLine(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`, result?.error || fallback)
}

/**
 * The file name of a workflow reference, lowercased.
 *
 * `release.yml`, `./.github/workflows/release.yml` and a Windows-spelled path all
 * name the same workflow, and the configured value is a file name while a caller
 * may pass the path GitHub reports. Comparing the last segment is what makes the
 * release preflight apply to every spelling of "the release workflow" instead of
 * only to the one the panel happens to send.
 *
 * @param {unknown} value - workflow reference.
 * @returns {string} lowercased file name.
 */
function workflowFileName(value) {
  const trimmed = text(value).replace(/\\/g, '/')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1).toLowerCase()
}

/**
 * Run one command in a directory of its own, with stdin closed.
 *
 * `runTool` is the gh- and git-shaped case; this is the package-manager-shaped one,
 * which needs a working directory and extra environment. The stdin decision is the
 * important one: a publish on an account with two-factor auth asks for a one-time
 * password, and a child waiting on a stdin nobody holds would show a spinner until
 * the timeout. `ignore` gives it an immediate EOF, so it fails with a message the
 * panel can act on — which is what turns "it hangs" into "enter the code".
 *
 * @param {string} executable - resolved path or bare command name.
 * @param {string[]} argv - arguments, passed without a shell.
 * @param {object} options - `cwd`, `timeoutMs`, and environment additions.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, killed: boolean}>}
 */
async function runSpawn(executable, argv, { cwd = undefined, timeoutMs, env = {} } = {}) {
  try {
    const { stdout, stderr } = await runFile(executable, argv, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
      env: {
        ...process.env,
        ...activeProxyEnvironment,
        ...env,
        NO_COLOR: '1',
        // npm's own progress bars and prompts are useless to a captured pipe and have
        // been known to keep a child alive after its work is done.
        npm_config_progress: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
    })
    return { ok: true, stdout, stderr, code: 0, killed: false }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      /*
       * Exactly what the child wrote — an empty stderr is a fact about the child, not
       * a slot to fill. Node's `Command failed: <the whole command>` goes in `error`
       * instead, so a caller reaches for it only after the real streams were empty.
       * Filling `stderr` with it is how a wrapper line came to shadow the reason:
       * pnpm writes every byte of a failed publish to STDOUT (measured: stderr = 0).
       */
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
      error: typeof error?.message === 'string' ? error.message : String(error),
      code: Number.isInteger(error?.code) ? error.code : null,
      killed: error?.killed === true,
    }
  }
}

/**
 * Run one external command.
 *
 * `GH_PROMPT_DISABLED` matters more than it looks: without it a `gh` that
 * decides to ask a question (a missing credential, an unreviewed release) waits
 * on a stdin nobody is holding, and the panel would show a spinner until the
 * timeout instead of the reason. It is harmless for `git`, which this also runs.
 *
 * @param {string} executable - resolved path or bare command name.
 * @param {string[]} args - argv, passed without a shell.
 * @param {number} timeoutMs - hard deadline.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, killed: boolean}>}
 */
export async function runTool(executable, args, timeoutMs) {
  try {
    const { stdout, stderr } = await runFile(executable, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        // gh ignores the Windows proxy settings that a browser follows. Without
        // this, a machine can open github.com in a browser while gh cannot send a
        // single request — which is exactly what was happening here.
        ...activeProxyEnvironment,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PAGER: 'cat',
        NO_COLOR: '1',
      },
    })
    return { ok: true, stdout, stderr, code: 0, killed: false }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      /*
       * Exactly what the child wrote — an empty stderr is a fact about the child, not
       * a slot to fill. Node's `Command failed: <the whole command>` goes in `error`
       * instead, so a caller reaches for it only after the real streams were empty.
       * Filling `stderr` with it is how a wrapper line came to shadow the reason:
       * pnpm writes every byte of a failed publish to STDOUT (measured: stderr = 0).
       */
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
      error: typeof error?.message === 'string' ? error.message : String(error),
      code: Number.isInteger(error?.code) ? error.code : null,
      killed: error?.killed === true,
    }
  }
}

/**
 * Run one `gh` invocation and parse stdout as JSON.
 * @returns {Promise<{ok: true, value: unknown}|{ok: false, message: string}>}
 */
export async function ghJson(ghPath, args, timeoutMs) {
  const result = await runTool(ghPath, [...args], timeoutMs)
  if (!result.ok) {
    return { ok: false, message: result.killed ? `gh timed out after ${timeoutMs} ms` : commandFailureLine(result, 'gh failed') }
  }
  const raw = result.stdout.trim()
  if (raw === '') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false, message: 'gh returned output that is not JSON' }
  }
}

/**
 * Run one `gh` invocation that is expected to succeed, mapping failure to a message.
 * @returns {Promise<{ok: true, stdout: string}|{ok: false, message: string}>}
 */
export async function ghRun(ghPath, args, timeoutMs) {
  const result = await runTool(ghPath, [...args], timeoutMs)
  if (result.ok) return { ok: true, stdout: result.stdout }
  return {
    ok: false,
    message: result.killed ? `gh timed out after ${timeoutMs} ms` : commandFailureLine(result, 'gh failed'),
  }
}

/* ------------------------------------------------------------------ trust -- */

/** Whether a socket address is the loopback interface. */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Parse one bare Host authority into a URL, or undefined when malformed. */
function parseAuthority(authority) {
  if (typeof authority !== 'string' || authority.trim() !== authority || authority === '') return undefined
  const match = authority.startsWith('[') ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority) : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL(`http://${authority}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Whether a request is same-origin with the (loopback) Host it reached. */
function isSameOriginRequest(request, hostUrl) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Loopback-only, same-origin trust decision.
 *
 * These routes act with the machine's GitHub credentials, so the decision is the
 * same one the shipped settings bridge applies to its own loopback routes: only a
 * request that came from this machine AND from the document this Host served.
 * @param {object} request - incoming request.
 * @returns {boolean}
 */
export function isTrustedRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  return isSameOriginRequest(request, hostUrl)
}

/** Write one JSON response without depending on any Host helper. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Read a bounded JSON body; null for a blank, oversized or invalid body. */
async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- local state -- */

/** Read the `version` field of a checkout's package.json, or null. */
export function readLocalVersion(localPath) {
  if (localPath === '' || !existsSync(localPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(join(localPath, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * A full commit id, or null.
 *
 * Only a 40-character id counts as evidence. GitHub stores a release's
 * `target_commitish` as whatever `gh release create --target` was given, and a
 * hand-made release can carry a branch name there; resolving that name locally
 * would answer a different question than the one that matters (which commit the
 * *workflow* will build), so it is reported as unknown instead.
 *
 * @param {unknown} value - candidate.
 * @returns {string|null} lowercase id, or null when it is not one.
 */
export function fullSha(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null
}

/**
 * Whether the release workflow can publish the version this checkout declares.
 *
 * The workflow refuses to touch a version that already belongs to another commit,
 * and it is right to: publishing it would create the tag at the old commit, whose
 * own build would overwrite the fresh assets — a release whose tag and contents
 * disagree, produced silently. The cost of that guard is that a dispatch without a
 * version bump cannot succeed, which is invisible from the panel and was measured
 * failing four times. So the panel asks the same question first, and only answers
 * `blocked` when it can PROVE the mismatch: a release whose target commit is a full
 * id that differs from the commit the run would build. Anything unprovable — no
 * local version, a branch name for a target, an unknown build commit — is `ready`,
 * because a preflight that refuses a release that would have worked is worse than
 * no preflight at all.
 *
 * @param {object} params - the two sides of the comparison.
 * @param {string|null} params.version - local package.json version.
 * @param {string|null} params.expectedTag - `v<version>`, when known.
 * @param {object[]} params.releases - normalized releases.
 * @param {string|null} params.builtSha - commit the dispatch would build.
 * @returns {{state: string, code: string, tag: string|null, owner: string|null, built: string|null, message: string}}
 */
export function releasePreflight({ version = null, expectedTag = null, releases = [], builtSha = null } = {}) {
  const tag = typeof expectedTag === 'string' && expectedTag !== ''
    ? expectedTag
    : (typeof version === 'string' && version !== '' ? `v${version}` : null)
  if (tag === null) {
    return { state: 'unknown', code: 'no-local-version', tag: null, owner: null, built: null, message: 'no package.json version to release' }
  }
  const match = Array.isArray(releases) ? releases.find((release) => release?.tag === tag) ?? null : null
  if (match === null) {
    return { state: 'ready', code: 'version-free', tag, owner: null, built: null, message: '' }
  }
  const owner = fullSha(match.targetCommitish)
  const built = fullSha(builtSha)
  if (owner !== null && built !== null && owner !== built) {
    return {
      state: 'blocked',
      code: 'version-taken',
      tag,
      owner,
      built,
      message: `release ${tag} was created from ${owner.slice(0, 7)}, but this run would build ${built.slice(0, 7)} — bump the version first`,
    }
  }
  return { state: 'ready', code: match.draft ? 'draft-replace' : 'same-commit', tag, owner, built, message: '' }
}

/**
 * The next version in a `major.minor.patch` line, as a string.
 *
 * Deliberately refuses anything else. A prerelease or build suffix (`1.0.0-rc.1`)
 * is a human's decision about what the release means, and guessing a successor for
 * it is how a console publishes something nobody asked for.
 *
 * @param {string} version - current version.
 * @param {string} kind - `patch`, `minor`, or `major`.
 * @returns {{ok: true, from: string, to: string}|{ok: false, message: string}}
 */
export function nextVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof version === 'string' ? version.trim() : '')
  if (match === null) return { ok: false, message: `package.json version is not a plain major.minor.patch: ${String(version)}` }
  if (!['patch', 'minor', 'major'].includes(kind)) return { ok: false, message: `unsupported release kind: ${String(kind)}` }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const to = kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
  return { ok: true, from: `${major}.${minor}.${patch}`, to }
}

/**
 * Rewrite the top-level `version` of a package.json text, byte-for-byte elsewhere.
 *
 * `JSON.parse` + `JSON.stringify` would reformat the whole manifest — key order,
 * indentation, the escaping of every non-ASCII string — and those files carry
 * hand-written prose in their metadata. A release commit must contain exactly one
 * changed line. Only an unambiguous single occurrence is accepted: two `version`
 * keys mean the text is not a manifest this can safely edit.
 *
 * @param {string} source - the file's text.
 * @param {string} to - the new version.
 * @returns {{ok: true, text: string}|{ok: false, message: string}}
 */
export function rewriteVersion(source, to) {
  if (typeof source !== 'string' || source === '') return { ok: false, message: 'package.json is empty' }
  if (!/^\d+\.\d+\.\d+$/.test(String(to))) return { ok: false, message: `refusing to write a non-version: ${String(to)}` }
  const matches = [...source.matchAll(/^([ \t]*"version"[ \t]*:[ \t]*")([^"]*)(")/gm)]
  if (matches.length !== 1) {
    return { ok: false, message: `expected exactly one top-level "version" key, found ${matches.length}` }
  }
  const match = matches[0]
  return { ok: true, text: `${source.slice(0, match.index)}${match[1]}${to}${match[3]}${source.slice(match.index + match[0].length)}` }
}

/**
 * Read what the local checkout knows that the remote does not.
 *
 * This is the half of "should I release?" that GitHub cannot answer: a tree with
 * uncommitted work, or commits that exist only locally, is not what a release tag
 * would capture. Every field degrades to null rather than failing the overview —
 * a checkout that is missing, or not a git repository, is a normal state.
 *
 * @param {string} localPath - configured absolute path.
 * @param {number} timeoutMs - per-command deadline.
 * @returns {Promise<object>} local state.
 */
export async function readLocalState(localPath, timeoutMs) {
  if (localPath === '') return { available: false, reason: 'no localPath configured' }
  if (!existsSync(localPath)) return { available: false, reason: 'localPath does not exist' }
  if (!existsSync(join(localPath, '.git'))) return { available: false, reason: 'not a git checkout' }

  const git = async (args) => {
    const result = await runTool('git', ['-C', localPath, ...args], timeoutMs)
    return result.ok ? result.stdout.trim() : null
  }

  const [branch, status, counts, head] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    // `@{u}` fails when the branch has no upstream; that is reported as "unknown",
    // not as zero, because "0 ahead" and "cannot tell" mean different things here.
    git(['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    // The commit a dispatch of this branch would build, when the branch is in sync
    // with its upstream. Comparisons that decide whether a release may proceed are
    // only made when the two provably agree (see `releasePreflight`).
    git(['rev-parse', 'HEAD']),
  ])

  let ahead = null
  let behind = null
  if (typeof counts === 'string') {
    const [behindRaw, aheadRaw] = counts.split(/\s+/)
    if (/^\d+$/.test(behindRaw ?? '') && /^\d+$/.test(aheadRaw ?? '')) {
      behind = Number(behindRaw)
      ahead = Number(aheadRaw)
    }
  }

  /* `\r` only: a leading space is the X half of `XY`, so trimming here would throw
     away the status of every unstaged change (see `statusPath`). */
  const lines = typeof status === 'string'
    ? status.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '')
    : null

  return {
    available: true,
    branch: branch ?? null,
    head: typeof head === 'string' && head !== '' ? head : null,
    dirty: lines === null ? null : lines.length,
    /*
     * The names, not just the count.
     *
     * 提交 commits the working tree with `git add -A`, and a count is not enough to
     * press that button honestly — "7 changes" could be the three files you meant and
     * four you have never seen. Capped, because this rides in the overview the panel
     * polls: the count is the number that matters, these are the ones that fit.
     */
    files: lines === null ? null : lines.slice(0, LOCAL_FILE_LIMIT).map(statusPath),
    ahead,
    behind,
    upstreamKnown: ahead !== null,
  }
}

/* --------------------------------------------------- installed copy, releases -- */

/**
 * Where the running profile keeps its `package.json`.
 *
 * `DSH_PROFILE_DIR` is written for shell tools rather than for this process, so it
 * is only the first guess. The authoritative answer is the `profileContext`
 * service, which knows the directory it is actually running from; the environment
 * is the fallback for a Host that composes this plugin without that service.
 *
 * @param {object} [env] - environment to read, injectable for tests.
 * @returns {string} absolute path of the profile directory.
 */
export function resolveProfileDir(env = process.env) {
  const explicit = text(env.DSH_PROFILE_DIR)
  if (explicit !== '') return explicit
  const home = text(env.DSH_HOME) !== ''
    ? text(env.DSH_HOME)
    : join(text(env.USERPROFILE, text(env.HOME, '.')), '.dsh')
  return join(home, 'profiles', text(env.DSH_PROFILE, 'desktop'))
}

/** Read `name` and `version` from one directory's package.json, or null. */
export function readManifest(directory) {
  if (typeof directory !== 'string' || directory === '') return null
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      version: typeof parsed.version === 'string' ? parsed.version : null,
      bundle: parsed.dsh?.bundle !== undefined,
      /**
       * `private: true` is the one manifest field that makes `publish` impossible, and
       * it is a deliberate choice by the author rather than a mistake — so the panel
       * reports it as a reason, instead of offering a button that must fail.
       */
      private: parsed.private === true,
    }
  } catch {
    return null
  }
}

/** The comparison form of a path, so `F:\x` and `f:/x/` are the same checkout. */
function comparablePath(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Classify one profile dependency spec.
 *
 * The distinction that matters is where the code actually comes from. `link:` is a
 * symlink into a checkout, so the profile is running files that were never
 * published; a `file:` tarball IS the published artifact. Reporting both as
 * "installed v1.2.3" would hide the only difference the update button exists for.
 *
 * The shape test must NOT be `path.isAbsolute` alone. That function is
 * platform-specific: on a POSIX Host it reads `F:\CodeProj\x` as RELATIVE, so every
 * `link:`/`file:` spec a Windows profile writes classified as `other`. Measured on
 * the Linux CI runner: three checks failed and `an installed tarball reports the
 * version from node_modules` printed `"kind":"other"`. The consequence is the exact
 * bug this judgement exists to prevent — a `link:` checkout whose version matches
 * the release would be reported as `current`, with no way to tell that the profile
 * is not running the published code. A `link:`/`file:` prefix and a drive-letter
 * path therefore declare a local path by their TEXT, on every platform.
 *
 * @param {unknown} spec - the dependency value from the profile manifest.
 * @returns {{kind: 'link'|'path'|'tarball'|'registry'|'other', path: string|null, range: string|null}}
 */
export function classifySpec(spec) {
  const value = typeof spec === 'string' ? spec.trim() : ''
  if (value === '') return { kind: 'other', path: null, range: null }
  const linked = /^link:/i.test(value)
  const filed = /^file:/i.test(value)
  const raw = value.replace(/^(?:file|link):/i, '')
  const declaresAPath = linked || filed || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
  if (declaresAPath) {
    if (raw === '') return { kind: 'other', path: null, range: null }
    if (linked) return { kind: 'link', path: raw, range: null }
    return { kind: /\.(?:tgz|tar\.gz)$/i.test(raw) ? 'tarball' : 'path', path: raw, range: null }
  }
  // A protocol or host alias is neither a path this can read nor a version this can
  // compare: guessing a version for `github:me/repo` would be an invented answer.
  if (/^(?:workspace:|npm:|git\+|git:|git@|github:|gitlab:|bitbucket:|ssh:|https?:)/i.test(value)) {
    return { kind: 'other', path: null, range: null }
  }
  return { kind: 'registry', path: null, range: value }
}

/**
 * What this profile has installed for one package name.
 *
 * A checkout can publish under a name that is not its directory's name (the
 * checkout in `dsh-plugin-knowledge-console` publishes `dsh-knowledge-console`),
 * so the name is not enough on its own: when nothing matches it, the specs are
 * scanned for one that points at the configured checkout.
 *
 * @param {string} profileDir - the profile directory.
 * @param {string} packageName - the package the repository publishes.
 * @param {string} [localPath] - the configured checkout, if any.
 * @returns {object} the install record the panel renders.
 */
export function readProfileInstall(profileDir, packageName, localPath = '') {
  const base = {
    packageName: typeof packageName === 'string' ? packageName : '',
    present: false,
    spec: '',
    kind: 'other',
    path: null,
    installedVersion: null,
    profileDir,
    profileReadable: false,
  }
  if (readManifest(profileDir) === null) return base
  const parsed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const dependencies = parsed?.dependencies !== null && typeof parsed?.dependencies === 'object' ? parsed.dependencies : {}
  let key = base.packageName !== '' && Object.hasOwn(dependencies, base.packageName) ? base.packageName : null
  if (key === null && typeof localPath === 'string' && localPath !== '') {
    const wanted = comparablePath(localPath)
    for (const [candidate, spec] of Object.entries(dependencies)) {
      const classified = classifySpec(spec)
      if (classified.path !== null && comparablePath(classified.path) === wanted) {
        key = candidate
        break
      }
    }
  }
  if (key === null) return { ...base, profileReadable: true }
  const spec = String(dependencies[key] ?? '')
  const classified = classifySpec(spec)
  const installed = readManifest(join(profileDir, 'node_modules', key))
  return {
    packageName: key,
    present: true,
    spec,
    kind: classified.kind,
    path: classified.path,
    installedVersion: installed?.version ?? null,
    profileDir,
    profileReadable: true,
  }
}

/**
 * Compare two `major.minor.patch` versions.
 *
 * Returns null rather than guessing for anything else — a prerelease, a range, a
 * version read from a directory that is not a package. "Cannot tell" and "older"
 * lead to different sentences on screen, and only one of them justifies a button.
 *
 * @param {unknown} left - installed version.
 * @param {unknown} right - released version.
 * @returns {-1|0|1|null} the order, or null when the two are not comparable.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(typeof value === 'string' ? value.trim() : '')
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return null
  for (const at of [0, 1, 2]) {
    if (a[at] !== b[at]) return a[at] < b[at] ? -1 : 1
  }
  return 0
}

/** `v1.2.3` as `1.2.3`; anything else as null. */
export function versionFromTag(tag) {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(typeof tag === 'string' ? tag.trim() : '')
  return match === null ? null : match[1]
}

/**
 * The newest published release that carries an installable `.tgz`.
 *
 * Drafts are skipped — a draft is not downloadable by anyone but its author, and
 * "update to the draft" is not a thing the panel should offer. A release without a
 * tarball is skipped too: `.zip` is the tree, not what `pnpm add` takes.
 *
 * @param {object[]} releases - normalized releases, newest first as GitHub returns them.
 * @param {string} [tag] - an explicit tag, when the caller named one.
 * @returns {{tag: string, asset: string, version: string|null}|null} the choice, or null.
 */
export function pickInstallableRelease(releases, tag = '') {
  const list = Array.isArray(releases) ? releases : []
  const wanted = text(tag)
  for (const release of list) {
    if (release === null || typeof release !== 'object') continue
    if (release.draft === true) continue
    const releaseTag = text(release.tag)
    if (releaseTag === '') continue
    if (wanted !== '' && releaseTag !== wanted) continue
    const assets = Array.isArray(release.assets) ? release.assets : []
    const asset = assets.find((candidate) => /\.(?:tgz|tar\.gz)$/i.test(text(candidate?.name)))
    if (asset === undefined) continue
    return { tag: releaseTag, asset: text(asset.name), version: versionFromTag(releaseTag) }
  }
  return null
}

/**
 * What installing the newest release would mean for this profile.
 *
 * `checkout` is the state the version comparison cannot reach and the reason this
 * feature exists: a `link:` checkout and a published tarball can carry the very
 * same version string while being different code, and only one of them is what a
 * user who downloaded the release would run.
 *
 * @param {object} install - from `readProfileInstall`.
 * @param {object|null} latest - from `pickInstallableRelease`.
 * @returns {string} one of not-installed / no-release / current / update / ahead / differs / checkout.
 */
export function updateState(install, latest) {
  if (install === null || typeof install !== 'object' || install.present !== true) return 'not-installed'
  if (latest === null || latest === undefined) return 'no-release'
  if (install.kind === 'link' || install.kind === 'path') return 'checkout'
  const order = compareVersions(install.installedVersion, latest.version ?? versionFromTag(latest.tag))
  if (order === 0) return 'current'
  if (order === null) return 'differs'
  return order < 0 ? 'update' : 'ahead'
}

/** The repository part of `owner/name`. */
export function bareRepoName(repo) {
  const value = text(repo)
  return value.includes('/') ? value.slice(value.indexOf('/') + 1) : value
}

/**
 * Everything the panel shows about "is the installed copy the released one".
 *
 * @param {object} params - the two sides.
 * @param {string} params.profileDir - profile directory.
 * @param {string} params.profileName - profile name, for the sentence on screen.
 * @param {object} params.entry - the configured repository entry.
 * @param {object[]} params.releases - that repository's normalized releases.
 * @returns {object} the install block carried by every overview row.
 */
export function describeInstall({ profileDir, profileName, entry, releases } = {}) {
  const checkout = readManifest(entry?.localPath ?? '')
  const declared = checkout !== null && checkout.name !== '' ? checkout.name : bareRepoName(entry?.repo ?? '')
  const install = readProfileInstall(profileDir, declared, entry?.localPath ?? '')
  const latest = pickInstallableRelease(releases)
  return {
    profile: text(profileName, 'desktop'),
    profileDir,
    profileReadable: install.profileReadable === true,
    packageName: install.present === true ? install.packageName : declared,
    present: install.present === true,
    spec: install.spec,
    kind: install.kind,
    installedVersion: install.installedVersion,
    latestTag: latest === null ? null : latest.tag,
    latestVersion: latest === null ? null : (latest.version ?? versionFromTag(latest.tag)),
    latestAsset: latest === null ? null : latest.asset,
    state: updateState(install, latest),
  }
}

/* ------------------------------------------------------------- npm registry -- */

/**
 * The registry to talk to, in the form every URL below assumes.
 *
 * A registry is a base, not a package URL: normalizing the trailing slash once here
 * is what keeps `${registry}${name}` right for both `https://registry.npmjs.org` and
 * a private registry written with a path. Anything that is not an http(s) URL without
 * embedded credentials falls back to the default, because a credential smuggled into
 * a registry URL would end up in the panel and in logs.
 *
 * @param {unknown} value - configured or defaulted registry.
 * @param {string} [fallback] - what to answer when the value is unusable.
 * @returns {string} a registry base ending in `/`.
 */
export function normalizeRegistry(value, fallback = DEFAULT_NPM_REGISTRY) {
  const raw = text(value)
  if (raw === '') return fallback
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback
    if (url.username !== '' || url.password !== '') return fallback
    return url.href.endsWith('/') ? url.href : `${url.href}/`
  } catch {
    return fallback
  }
}

/** The `//host/path/` prefix an `.npmrc` auth line is keyed by. */
export function npmrcAuthKey(registry) {
  const normalized = normalizeRegistry(registry)
  const url = new URL(normalized)
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return `//${url.host}${path}`
}

/**
 * Where the user-level `.npmrc` is.
 *
 * This is the file `npm login` and `pnpm login` write, and it is the only credential
 * store this feature touches: the plugin holds no token of its own, exactly as it
 * holds none of `gh`'s.
 *
 * @param {object} [env] - environment, injectable for tests.
 * @returns {string} absolute path.
 */
export function resolveNpmrcPath(env = process.env) {
  const explicit = text(env.NPM_CONFIG_USERCONFIG)
  if (explicit !== '') return explicit
  return join(text(env.USERPROFILE, text(env.HOME, '.')), '.npmrc')
}

/**
 * Whether an `.npmrc` text carries a token for this registry.
 *
 * Only the presence of the key is answered. The value is deliberately not read out:
 * a secret this plugin has no use for is a secret it must not hold, and returning it
 * would put a live publish token into a JSON response and into whatever logs it.
 *
 * @param {string} source - the file's text.
 * @param {string} registry - registry base.
 * @returns {boolean} whether a usable line exists.
 */
export function hasNpmToken(source, registry) {
  if (typeof source !== 'string' || source === '') return false
  const key = npmrcAuthKey(registry)
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const name = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if ((name === `${key}:_authToken` || name === `${key}:_auth`) && value !== '') return true
  }
  return false
}

/**
 * Put one token into an `.npmrc` text, replacing that registry's line and nothing else.
 *
 * `.npmrc` is line-oriented, so a value that could start a new line or a comment is
 * refused rather than escaped: the only thing worse than a rejected token is a token
 * that silently became two lines. Every other line — other registries, other
 * settings, comments — is preserved byte for byte, because this file usually belongs
 * to other tools too.
 *
 * @param {string} source - current file text (may be empty).
 * @param {string} registry - registry base.
 * @param {string} token - the token to write.
 * @returns {{ok: true, text: string, replaced: boolean}|{ok: false, message: string}}
 */
export function upsertAuthToken(source, registry, token) {
  const value = typeof token === 'string' ? token.trim() : ''
  if (value === '') return { ok: false, message: 'the token is empty' }
  if (!/^[A-Za-z0-9_\-.:+/=]+$/.test(value)) {
    return { ok: false, message: 'the token has characters an .npmrc line cannot hold' }
  }
  const key = npmrcAuthKey(registry)
  const wanted = [`${key}:_authToken`, `${key}:_auth`]
  const line = `${key}:_authToken=${value}`
  const lines = (typeof source === 'string' ? source : '').split(/\r?\n/)
  let replaced = false
  const next = lines.map((candidate) => {
    const trimmed = candidate.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) return candidate
    const separator = trimmed.indexOf('=')
    if (separator === -1) return candidate
    if (!wanted.includes(trimmed.slice(0, separator).trim())) return candidate
    replaced = true
    return line
  })
  if (!replaced) {
    // Keep the file's own shape: an .npmrc conventionally ends with a newline, which
    // splits into a final empty element that the new line goes before, not after.
    if (next.length > 0 && next[next.length - 1].trim() === '') next.splice(next.length - 1, 0, line)
    else next.push(line)
  }
  return { ok: true, text: next.join('\n'), replaced }
}

/**
 * What the registry already knows about one package version.
 *
 * `versions` is the only real evidence: `dist-tags.latest` alone cannot answer "is
 * THIS version published", and a version that is already on npm can never be
 * republished — so the difference between the two decides whether the button exists
 * or is a trap.
 *
 * @param {unknown} packument - the registry document, or null for "404, nobody owns this name".
 * @param {string|null} version - the local version.
 * @returns {{state: 'unregistered'|'published'|'unpublished'|'unknown', latest: string|null, published: boolean}}
 */
export function npmPackageState(packument, version) {
  if (packument === null || packument === undefined) return { state: 'unregistered', latest: null, published: false }
  if (typeof packument !== 'object') return { state: 'unknown', latest: null, published: false }
  const versions = packument.versions !== null && typeof packument.versions === 'object' ? packument.versions : {}
  const distTags = packument['dist-tags'] !== null && typeof packument['dist-tags'] === 'object' ? packument['dist-tags'] : {}
  const latest = text(distTags.latest)
  const published = typeof version === 'string' && version !== '' && Object.hasOwn(versions, version)
  return { state: published ? 'published' : 'unpublished', latest: latest === '' ? null : latest, published }
}

/**
 * The URL a packument is read from.
 *
 * `?write=true` is how npm's own publish path asks for the document it is about to
 * write against, and here it is not decoration — it is the difference between the
 * panel agreeing with a publish and calling it a failure. Measured on this machine
 * against a package that was just published:
 *
 *   GET /<pkg>              cache-control: public, max-age=300, age: 116
 *   GET /<pkg>?write=true   cache-control: public, max-age=300, age: —   (origin)
 *
 * The registry's packument is served through a CDN that may hand back a copy up to
 * five minutes old, so for five minutes after a successful publish the panel went on
 * saying "npm 待推 v1.1.1" about a version that was already there — and, worse, kept
 * offering a push for a version the registry would refuse. A local disk cache has a
 * TTL and can be cleared; this one belongs to someone else, so the read has to ask
 * for the origin.
 *
 * @param {string} registry - normalized registry base.
 * @param {string} packageName - the package to ask about.
 * @returns {string} the URL.
 */
export function packumentUrl(registry, packageName) {
  const base = String(registry)
  const query = base.indexOf('?')
  if (query === -1) return `${base}${packageName}?write=true`
  // A base that already carries a query puts the package name BEFORE it, not inside it.
  return `${base.slice(0, query)}${packageName}${base.slice(query)}&write=true`
}

/**
 * Whether this machine can publish, as three states rather than a boolean.
 *
 * `whoami` is the obvious probe and not a sufficient one. It is a user-level
 * endpoint, while a granular access token — the only kind npm has issued since
 * November 2025 — is scoped to packages, so it can be refused there and still work
 * for `publish`. Reading that refusal as "not signed in" would block the very
 * credential npm now tells everyone to create, which is the worst possible place for
 * a false negative: the panel would tell a first-time publisher that their brand-new
 * token is not a credential.
 *
 * So a token line in `.npmrc` counts as a credential on its own, and `whoami` is what
 * turns it into a name:
 *   signed-in          whoami answered; the account is known.
 *   credential-present a token line exists but whoami would not confirm it. The
 *                      publish itself is the real test, and its failure is classified.
 *   none               nothing to authenticate with — where the guide belongs.
 *
 * @param {object} params - the two probes.
 * @param {boolean} params.whoami - whether `whoami` answered.
 * @param {boolean} params.hasToken - whether `.npmrc` carries a token for this registry.
 * @returns {'signed-in'|'credential-present'|'none'}
 */
export function npmAuthState({ whoami = false, hasToken = false } = {}) {
  if (whoami === true) return 'signed-in'
  return hasToken === true ? 'credential-present' : 'none'
}

/**
 * Whether the push should be offered, and every reason it should not be.
 *
 * The blockers are named strings rather than a boolean because "there is no button"
 * is the least useful thing a panel can say: `private-package` and `not-logged-in`
 * are the same absence on screen and completely different fixes.
 *
 * @param {object} params - what was read about this repository. `authed` means a
 *   credential EXISTS (see `npmAuthState`), not that the account is confirmed.
 * @returns {{state: string, latest: string|null, packageName: string, version: string|null, blockers: string[], canPublish: boolean}}
 */
export function npmPublishVerdict({ packageName = '', version = null, manifest = null, registryState = null, authed = false, dirty = null } = {}) {
  const blockers = []
  if (packageName === '') blockers.push('no-package-name')
  if (manifest === null) blockers.push('no-checkout')
  else if (manifest.private === true) blockers.push('private-package')
  if (version === null || version === '') blockers.push('no-version')
  if (authed !== true) blockers.push('not-logged-in')
  if (registryState === null || registryState.state === 'unknown') blockers.push('registry-unreachable')
  else if (registryState.published === true) blockers.push('already-published')
  if (Number.isFinite(dirty) && dirty > 0) blockers.push('dirty-tree')
  return {
    state: registryState === null ? 'unknown' : registryState.state,
    latest: registryState === null ? null : registryState.latest,
    packageName,
    version: version === null || version === '' ? null : version,
    blockers,
    canPublish: blockers.length === 0,
  }
}

/**
 * What a failed publish actually means, as a name the panel can answer.
 *
 * A raw npm error is the least useful thing to show someone who has never made a
 * token: `EOTP` and `E403` are one line of jargon each and completely different
 * fixes. The patterns are matched most-specific-first, because `E403` appears inside
 * messages that are about an unverified email or a token scoped to another package.
 *
 * @param {unknown} output - combined stdout and stderr of the publish.
 * @returns {string} one of otp-required / email-unverified / not-logged-in /
 *   already-published / payment-required / forbidden / not-found / rate-limited /
 *   registry-error / network / unknown.
 */
export function classifyPublishFailure(output) {
  const text = typeof output === 'string' ? output : ''
  if (text.trim() === '') return 'unknown'
  const rules = [
    [/one-time password|one-time passcode|\bEOTP\b|ERR_PNPM_OTP/i, 'otp-required'],
    [/verify your email|email address.{0,40}not verified|unverified email/i, 'email-unverified'],
    [/EPUBLISHCONFLICT|cannot publish over|previously published/i, 'already-published'],
    [/E402|Payment Required|private packages? (?:require|need)/i, 'payment-required'],
    [/ENEEDAUTH|\bE401\b|You must be logged in|unauthorized/i, 'not-logged-in'],
    [/\bE403\b|Forbidden|not authorized|does not have permission/i, 'forbidden'],
    [/\bE404\b|Not Found/i, 'not-found'],
    [/\bE429\b|Too Many Requests/i, 'rate-limited'],
    [/\bE5\d\d\b|Internal Server Error|Service Unavailable|Bad Gateway/i, 'registry-error'],
    [/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|network/i, 'network'],
  ]
  for (const [pattern, code] of rules) {
    if (pattern.test(text)) return code
  }
  return 'unknown'
}

/**
 * The package manager this Host itself uses.
 *
 * Reused rather than re-found, for the same reason `gh` is reused instead of a token:
 * the Host already resolved one, it is the exact one the plugin manager installs
 * with, and a second answer would eventually disagree with the first. The fallbacks
 * are the two real ones — an explicit `DSH_PNPM`, and the packaged application's own
 * bundled pnpm, which is reachable only because this process knows where it started.
 *
 * @param {object} ctx - Host plugin context.
 * @returns {{command: string, args: string[], env: object, source: string}|null}
 */
export function resolvePackageManagerInvocation(ctx) {
  const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  const invocation = profile?.packageManager
  if (invocation !== null && invocation !== undefined && typeof invocation.command === 'string' && invocation.command !== '') {
    return {
      command: invocation.command,
      args: Array.isArray(invocation.args) ? invocation.args.map((arg) => String(arg)) : [],
      env: invocation.env !== null && typeof invocation.env === 'object' ? { ...invocation.env } : {},
      source: 'profile',
    }
  }
  const explicit = text(process.env.DSH_PNPM)
  if (explicit !== '') return { command: explicit, args: [], env: {}, source: 'DSH_PNPM' }
  /*
   * The packaged application ships pnpm under `resources/runtime`, and its own
   * launcher runs it through the Electron binary with ELECTRON_RUN_AS_NODE — the same
   * mechanism, not an invented path. Below that, `pnpm` on PATH is the honest last
   * answer; a command that does not exist fails with ENOENT naming it, which is a
   * better report than this plugin guessing at an install layout it cannot see.
   */
  const runtime = join(dirname(process.execPath), 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs')
  if (existsSync(runtime)) {
    return { command: process.execPath, args: [runtime], env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'bundled' }
  }
  return { command: 'pnpm', args: [], env: {}, source: 'path' }
}

/**
 * How many entries are uncommitted in a checkout, or null when it cannot be read.
 *
 * One `git status` rather than `readLocalState`'s four commands: the npm status is
 * asked for per repository, and four spawns each would make opening the panel the
 * most expensive thing it does.
 *
 * @param {string} localPath - configured checkout.
 * @param {number} timeoutMs - deadline.
 * @returns {Promise<number|null>} the count, or null when there is no checkout to ask.
 */
export async function readDirtyCount(localPath, timeoutMs) {
  if (typeof localPath !== 'string' || localPath === '' || !existsSync(join(localPath, '.git'))) return null
  const result = await runTool('git', ['-C', localPath, 'status', '--porcelain'], timeoutMs)
  if (result.ok !== true) return null
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length
}

/* --------------------------------------------------------------- overview -- */

/** Resolve a configured entry to the `owner/name` slug `gh` expects. */
export function resolveSlug(owner, repo) {
  if (SLUG_WITH_OWNER.test(repo)) return repo
  if (owner === '') return null
  return `${owner}/${repo}`
}

/** Normalize one gh run record into the panel's shape. */
function normalizeRun(run) {
  if (run === null || typeof run !== 'object') return null
  return {
    id: Number.isInteger(run.databaseId) ? run.databaseId : null,
    workflow: typeof run.workflowName === 'string' ? run.workflowName : '',
    title: typeof run.displayTitle === 'string' ? run.displayTitle : '',
    status: typeof run.status === 'string' ? run.status : '',
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : '',
    event: typeof run.event === 'string' ? run.event : '',
    branch: typeof run.headBranch === 'string' ? run.headBranch : '',
    createdAt: typeof run.createdAt === 'string' ? run.createdAt : '',
    updatedAt: typeof run.updatedAt === 'string' ? run.updatedAt : '',
    url: typeof run.url === 'string' ? run.url : '',
  }
}

/**
 * Normalize one REST release record into the panel's shape.
 *
 * `targetCommitish` is kept because it is the only evidence for the question the
 * release workflow asks itself: does this version already belong to a different
 * commit? The workflow passes `--target "$GITHUB_SHA"`, so it is a full commit id
 * for every release this set produces; a release made by hand can carry a branch
 * name there instead, which `fullSha` treats as "cannot prove" rather than as a
 * mismatch.
 */
function normalizeRelease(release) {
  if (release === null || typeof release !== 'object') return null
  const assets = Array.isArray(release.assets) ? release.assets : []
  return {
    tag: typeof release.tag_name === 'string' ? release.tag_name : '',
    name: typeof release.name === 'string' ? release.name : '',
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    targetCommitish: typeof release.target_commitish === 'string' ? release.target_commitish : '',
    createdAt: typeof release.created_at === 'string' ? release.created_at : '',
    url: typeof release.html_url === 'string' ? release.html_url : '',
    assets: assets.map((asset) => ({
      name: typeof asset?.name === 'string' ? asset.name : '',
      size: Number.isFinite(asset?.size) ? asset.size : null,
    })),
  }
}

/**
 * Collect one repository's remote and local state.
 *
 * The three remote calls are independent and each degrades on its own: a missing
 * release list must not blank out the run list. Anything that failed is reported
 * in `problems` so the panel can say which part is unknown instead of implying
 * "nothing there".
 *
 * @param {object} params - dependencies.
 * @returns {Promise<object>} one repository's overview entry.
 */
export async function collectRepo({ config, ghPath, entry }) {
  const slug = resolveSlug(config.owner, entry.repo)
  const base = {
    repo: entry.repo,
    slug,
    label: entry.label !== '' ? entry.label : entry.repo,
    localPath: entry.localPath,
    /*
     * What a 克隆 would use, and where it would land. Sent with the overview so the
     * panel can offer the address pre-filled instead of asking someone to type a URL
     * the Host can already derive from the repository name.
     */
    cloneUrl: defaultCloneUrl(config.owner, entry.repo),
    checkoutRoot: config.projectsRoot,
    problems: [],
  }
  if (slug === null) {
    return { ...base, problems: ['set `owner` in the row config, or write the entry as "owner/repo"'] }
  }

  const [runsResult, releasesResult, workflowsResult] = await Promise.all([
    ghJson(ghPath, ['run', 'list', '-R', slug, '--limit', '6', '--json',
      'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,createdAt,updatedAt,url'], config.requestTimeoutMs),
    ghJson(ghPath, ['api', `repos/${slug}/releases?per_page=5`], config.requestTimeoutMs),
    ghJson(ghPath, ['api', `repos/${slug}/actions/workflows`], config.requestTimeoutMs),
  ])

  const runs = []
  if (runsResult.ok && Array.isArray(runsResult.value)) {
    for (const run of runsResult.value) {
      const normalized = normalizeRun(run)
      if (normalized !== null) runs.push(normalized)
    }
  } else if (!runsResult.ok) {
    base.problems.push(`runs: ${runsResult.message}`)
  }

  const releases = []
  if (releasesResult.ok && Array.isArray(releasesResult.value)) {
    for (const release of releasesResult.value) {
      const normalized = normalizeRelease(release)
      if (normalized !== null) releases.push(normalized)
    }
  } else if (!releasesResult.ok) {
    base.problems.push(`releases: ${releasesResult.message}`)
  }

  const workflows = []
  if (workflowsResult.ok && Array.isArray(workflowsResult.value?.workflows)) {
    for (const workflow of workflowsResult.value.workflows) {
      if (typeof workflow?.path === 'string') {
        workflows.push({ name: typeof workflow.name === 'string' ? workflow.name : '', path: workflow.path.replace(/^\.github\/workflows\//, ''), state: typeof workflow.state === 'string' ? workflow.state : '' })
      }
    }
  } else if (!workflowsResult.ok) {
    base.problems.push(`workflows: ${workflowsResult.message}`)
  }

  const version = readLocalVersion(entry.localPath)
  const expectedTag = version === null ? null : `v${version}`
  const matching = expectedTag === null ? null : releases.find((release) => release.tag === expectedTag) ?? null
  /*
   * Without a local checkout there is no version to compare against — and that is
   * the normal state on a fresh install, where not one repository has a
   * `localPath` yet. GitHub's own release list is then the only truth, so it
   * decides: a row that reports 未发布 while a published release sits in its own
   * expanded detail is simply wrong, and it was wrong for exactly this reason.
   */
  const publishedRelease = matching !== null
    ? (matching.draft ? null : matching)
    : releases.find((release) => !release.draft) ?? null
  const draftRelease = matching !== null
    ? (matching.draft ? matching : null)
    : releases.find((release) => release.draft) ?? null
  const local = await readLocalState(entry.localPath, config.requestTimeoutMs)
  /*
   * The commit a dispatch of the configured branch would build, known only when
   * this checkout provably IS that commit: same branch, upstream known, and no
   * divergence in either direction. When either side is in doubt the panel says
   * nothing rather than guessing, because a wrong "this version is taken" sends
   * someone to bump a version that did not need bumping.
   */
  const builtSha = local.available === true
    && local.upstreamKnown === true
    && local.ahead === 0
    && local.behind === 0
    && local.branch === config.defaultBranch
    ? local.head ?? null
    : null

  return {
    ...base,
    version,
    expectedTag,
    /** Whether the local version is known; when it is not, the state comes from GitHub. */
    versionKnown: version !== null,
    /** A published release exists — for the local version when known, else the newest. */
    published: publishedRelease !== null,
    publishedTag: publishedRelease === null ? null : publishedRelease.tag,
    /** A draft release is waiting, for the local version when known, else the newest. */
    draftTag: draftRelease === null ? null : draftRelease.tag,
    /**
     * Whether releasing the local version is possible right now, and why not when
     * it is not. Computed on the Host so the panel and the dispatch route cannot
     * disagree about it.
     */
    releaseCheck: (() => {
      const verdict = releasePreflight({ version, expectedTag, releases, builtSha })
      const next = version === null ? { ok: false } : nextVersion(version, 'patch')
      return {
        ...verdict,
        /** What the panel offers when the version is taken: the next patch, if any. */
        next: next.ok === true ? next.to : null,
        nextTag: next.ok === true ? `v${next.to}` : null,
      }
    })(),
    latestRun: runs[0] ?? null,
    runs,
    releases,
    workflows,
    hasBuildWorkflow: workflows.some((workflow) => workflow.path === config.buildWorkflow),
    hasReleaseWorkflow: workflows.some((workflow) => workflow.path === config.releaseWorkflow),
    local,
  }
}

/* ------------------------------------------------------------------- apply -- */

/**
 * Mount the release-console routes.
 * @param {object} ctx - Host plugin context carrying `webServer`.
 * @param {object} [rawConfig] - row config from the profile patch.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const ghPath = resolveGhPath(config)

  /** Overview cache: the panel polls, and each poll fans out three calls per repo. */
  let cache = null

  /**
   * One install at a time.
   *
   * The plugin manager serialises through its own profile lock, so a second
   * request would not corrupt anything — it would queue behind the first while the
   * panel showed two spinners and neither could be cancelled. Refusing is clearer.
   */
  let updateInFlight = false

  /**
   * The configuration this request should use.
   *
   * Resolved per request so `scripts/configure.mjs add` is visible on the next
   * poll rather than at the next restart — the whole point of moving the list out
   * of the hand-edited patch.
   */
  const live = () => effectiveConfig(config)

  /*
   * Hand gh the proxy the browser is already using.
   *
   * Resolved once, from the row config or the Windows internet settings, because
   * gh reads HTTP(S)_PROXY and ignores the setting the browser follows — which is
   * how a machine can open github.com in a browser while `gh auth login` prints
   * nothing at all.
   *
   * Injected only once the proxy has answered on its port. A local proxy that is
   * not running would otherwise be worse than no proxy: gh would fail to connect to
   * 127.0.0.1 instead of trying GitHub directly. Until the check completes the
   * children simply go direct.
   */
  const proxy = resolveProxy(live().proxy)
  if (proxy.url !== null) {
    try {
      const parsed = new URL(proxy.url)
      const host = parsed.hostname
      const port = Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port)
      void probeHost(host, port, 1_500).then((probe) => {
        if (probe.ok) activeProxyEnvironment = proxyEnvironment(proxy.url)
      })
    } catch {
      /* A malformed proxy URL is gh's to report; going direct is the safe default. */
    }
  }

  const guard = (req, res) => {
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'release-console routes are loopback-only' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }

  /**
   * The profile this Host is running from.
   *
   * `profileContext` is the authority — it is the service that knows where it was
   * started before any environment variable was written for a shell. The
   * environment is the fallback for a composition without that service.
   */
  const profileFacts = () => {
    const service = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    const dir = text(service?.dir)
    return {
      dir: dir !== '' ? dir : resolveProfileDir(),
      name: text(service?.name, text(process.env.DSH_PROFILE, 'desktop')),
    }
  }

  /** Resolve a body's `repo` to a configured entry, refusing anything unconfigured. */
  const findEntry = (current, body) => {
    const requested = typeof body?.repo === 'string' ? body.repo.trim() : ''
    if (requested === '') return { ok: false, message: 'body.repo is required' }
    const entry = current.repos.find((candidate) => candidate.repo === requested || candidate.label === requested)
    if (entry === undefined) return { ok: false, message: `repository is not configured: ${requested}` }
    const slug = resolveSlug(current.owner, entry.repo)
    if (slug === null) return { ok: false, message: 'set `owner` in the config, or write the entry as "owner/repo"' }
    return { ok: true, entry, slug }
  }

  /* ------------------------------------------------------------- sign-in -- */

  /**
   * The single in-flight sign-in, if any.
   *
   * `gh auth login --web` prints a one-time code and a URL and then polls GitHub
   * until the user approves in a browser. Measured behaviour, which is what makes
   * this drivable from a panel at all: with stdin left untouched and not a
   * terminal, `gh` still prints both, so nothing has to fake a keystroke — and
   * nothing does, because a stray newline would answer whatever prompt came next.
   */
  let authAttempt = null

  const stopAuth = () => {
    const child = authAttempt?.child
    if (child === null || child === undefined) return
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  const settleAuth = (state, message = null) => {
    if (authAttempt === null) return
    if (authAttempt.timer !== null) clearTimeout(authAttempt.timer)
    authAttempt.state = state
    authAttempt.message = message
    authAttempt.child = null
    authAttempt.timer = null
  }

  const authSnapshot = () => authAttempt === null
    ? { state: 'idle', mode: null, code: null, url: null, message: null, startedAt: null, waitedMs: 0, stalled: false, reachable: null, reachabilityStage: null, reachabilityAddress: null, outputBytes: 0, outputExcerpt: null }
    : {
        state: authAttempt.state,
        mode: authAttempt.mode,
        code: authAttempt.code,
        url: authAttempt.url,
        message: authAttempt.message,
        startedAt: new Date(authAttempt.startedAt).toISOString(),
        waitedMs: Date.now() - authAttempt.startedAt,
        /**
         * True once the code has been missing for AUTH_CODE_DEADLINE_MS.
         *
         * This does NOT end the attempt. `gh` was measured printing nothing while
         * github.com was unreachable and then producing the code once the network
         * came back, so ending it on a timer would turn a recoverable wait into a
         * failure the user has to notice and retry. The panel keeps its cancel
         * button, and the hard limit stays the code's own lifetime.
         */
        stalled: authAttempt.stalled === true,
        /**
         * The advisory probe's verdict: `true`, `false`, or `null` while unknown.
         * `false` is a hint, never a refusal — gh may still succeed through a path
         * this probe cannot see.
         */
        reachable: typeof authAttempt.reachable === 'boolean' ? authAttempt.reachable : null,
        /**
         * Which layer the probe failed at: `dns`, `tcp`, or `ok`. They need
         * different advice — a resolver problem is not a blocked port.
         */
        reachabilityStage: typeof authAttempt.reachabilityStage === 'string' ? authAttempt.reachabilityStage : null,
        reachabilityAddress: typeof authAttempt.reachabilityAddress === 'string' ? authAttempt.reachabilityAddress : null,
        outputBytes: authAttempt.output.length,
        /**
         * What `gh` actually printed, for the case where it printed nothing useful.
         *
         * Measured shape: output beginning with a bare newline, so the first line is
         * empty — which is how a message came to read "its output began:" followed by
         * nothing. Whitespace-only output is reported as such rather than quoted.
         */
        outputExcerpt: (() => {
          const cleaned = authAttempt.output.replace(/\s+/g, ' ').trim()
          return cleaned === '' ? null : cleaned.slice(0, 200)
        })(),
      }

  const startAuth = (mode, scopes) => {
    stopAuth()
    const args = mode === 'refresh'
      ? ['auth', 'refresh', '--hostname', 'github.com', '-s', scopes.join(',')]
      // Ask for everything this plugin needs in the ONE prompt the user is already
      // looking at. Logging in with gh's defaults and then sending them back for a
      // second grant is a worse experience for no benefit.
      : ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', REQUIRED_SCOPES.join(',')]
    const child = spawn(ghPath, args, {
      windowsHide: true,
      // `GH_PROMPT_DISABLED` must stay unset here: this IS the interactive flow,
      // just without a terminal. Everything else that would page or colour output
      // is, because the panel renders what comes back.
      env: { ...process.env, ...activeProxyEnvironment, GH_PROMPT_DISABLED: '', GH_PAGER: 'cat', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const attempt = {
      id: String(Date.now()),
      mode,
      scopes,
      child,
      state: 'running',
      code: null,
      url: null,
      output: '',
      message: null,
      startedAt: Date.now(),
      timer: null,
    }
    authAttempt = attempt

    const absorb = (chunk) => {
      attempt.output = `${attempt.output}${chunk.toString()}`.slice(-8_000)
      const code = /one-time code \(([A-Za-z0-9-]+)\)/i.exec(attempt.output)
      if (code !== null && attempt.code === null) attempt.code = code[1].toUpperCase()
      const url = /(https:\/\/\S*\/login\/device)/i.exec(attempt.output)
      if (url !== null && attempt.url === null) attempt.url = url[1]
    }
    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)
    child.on('error', (error) => {
      settleAuth('failed', error.message)
    })
    child.on('exit', (exitCode) => {
      if (attempt.state !== 'running') return
      if (exitCode === 0) settleAuth('succeeded')
      else settleAuth('failed', firstLine(attempt.output) || `gh exited with code ${String(exitCode)}`)
    })
    // The one-time code is valid for about fifteen minutes; the panel should not
    // keep a polling child alive for longer than a person would plausibly take.
    attempt.timer = setTimeout(() => {
      stopAuth()
      settleAuth('expired', 'the one-time code expired — start again')
    }, AUTH_TIMEOUT_MS)
    if (typeof attempt.timer.unref === 'function') attempt.timer.unref()
    /*
     * `login` is the flow that has a one-time code. Mark — do not fail — an attempt
     * that has gone AUTH_CODE_DEADLINE_MS without one: `gh` was measured producing
     * the code once the network recovered, so the panel reports the wait and lets
     * the user decide, while the fifteen-minute expiry still bounds it.
     */
    if (mode === 'login') {
      const stallTimer = setTimeout(() => {
        if (attempt.state === 'running' && attempt.code === null) attempt.stalled = true
      }, AUTH_CODE_DEADLINE_MS)
      if (typeof stallTimer.unref === 'function') stallTimer.unref()
      attempt.stallTimer = stallTimer
      /*
       * Advisory only, and deliberately not awaited: `null` means "not answered
       * yet", `false` is a hint that the wait will probably fail. It must never
       * prevent the attempt — see the note in `auth-start`.
       */
      attempt.reachable = null
      attempt.reachabilityStage = null
      /*
       * Probe the PROXY when one is in use, not github.com.
       *
       * gh reaches GitHub through the proxy, so a direct connection failing says
       * nothing about whether gh will succeed — and reporting it would send the
       * reader off to fix a network that is already working.
       */
      const proxyUrl = typeof activeProxyEnvironment.HTTPS_PROXY === 'string' ? activeProxyEnvironment.HTTPS_PROXY : null
      let probeTarget = { host: 'github.com', port: 443, via: null }
      if (proxyUrl !== null) {
        try {
          const parsed = new URL(proxyUrl)
          probeTarget = { host: parsed.hostname, port: Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port), via: proxyUrl }
        } catch {
          /* A malformed proxy URL is reported by gh itself; keep the direct probe. */
        }
      }
      void probeHost(probeTarget.host, probeTarget.port, 3000)
        .then((probe) => {
          if (authAttempt !== attempt) return
          attempt.reachable = probe.ok
          /* 'dns' and 'tcp' need different advice, so the stage is kept. */
          attempt.reachabilityStage = probeTarget.via === null ? probe.stage : (probe.ok ? 'proxy' : 'proxy-failed')
          attempt.reachabilityAddress = probeTarget.via === null ? probe.address : probeTarget.via
        })
        .catch(() => {
          if (authAttempt === attempt) attempt.reachable = null
        })
    }
    return attempt
  }

  /* --------------------------------------------------- repository list -- */

  /**
   * Find the local checkout of a repository under a configured root.
   *
   * Matched by the `name` field of each candidate's package.json rather than by
   * directory name, because the two genuinely differ here: the checkout that
   * publishes `dsh-knowledge-console` lives in a directory called
   * `dsh-plugin-knowledge-console`.
   *
   * @param {string} root - configured projects root.
   * @param {string} repo - repository name (with or without an owner).
   * @returns {string} absolute path, or '' when nothing matched.
   */
  const findLocalCheckout = (root, repo) => {
    if (root === '' || !existsSync(root)) return ''
    const wanted = repo.includes('/') ? repo.slice(repo.indexOf('/') + 1) : repo
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return ''
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      const manifest = join(directory, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed?.name === wanted || parsed?.name === repo) return directory
      } catch {
        /* an unreadable manifest is simply not a match */
      }
    }
    return ''
  }

  /** Persist a change to the managed list, creating the file when it is absent. */
  const mutateConfig = (current, mutate) => {
    const stored = readConfig(current.configFile)
    if (stored.problem !== null && stored.exists) {
      return { ok: false, message: `the config file cannot be read, so it was left alone: ${stored.problem}` }
    }
    const next = mutate({ owner: stored.owner !== '' ? stored.owner : current.owner, repos: [...stored.repos] })
    if (next.ok !== true) return next
    writeConfig(current.configFile, { owner: next.owner, repos: next.repos })
    cache = null
    return { ok: true, owner: next.owner, count: next.repos.length }
  }

  const statusHandler = async (req, res) => {
    if (!guard(req, res)) return
    const current = live()
    const [versionResult, auth] = await Promise.all([
      ghRun(ghPath, ['--version'], Math.min(current.requestTimeoutMs, 10_000)),
      readAuthStatus(ghPath, Math.min(current.requestTimeoutMs, 15_000)),
    ])
    // The scope list comes from `gh auth status`, not from `api user`: an
    // authenticated token that cannot dispatch a workflow is a state the panel
    // has to name before a button fails on it.
    const authenticated = auth.authenticated || (versionResult.ok && auth.exitCode === 0)
    writeJson(res, 200, {
      ok: true,
      value: {
        protocol: PROTOCOL,
        enabled: current.enabled,
        gh: {
          path: ghPath,
          available: versionResult.ok,
          version: versionResult.ok ? firstLine(versionResult.stdout) : null,
          authenticated,
          account: auth.account,
          scopes: auth.scopes,
          missingScopes: authenticated ? auth.missingScopes : [],
          message: versionResult.ok ? null : versionResult.message,
        },
        config: {
          owner: current.owner,
          defaultBranch: current.defaultBranch,
          buildWorkflow: current.buildWorkflow,
          releaseWorkflow: current.releaseWorkflow,
          pollSeconds: current.pollSeconds,
          overviewTtlMs: current.overviewTtlMs,
          projectsRoot: current.projectsRoot,
          bilibili: {
            enabled: current.bilibiliEnabled,
            auto: current.bilibiliAuto,
            watchSeconds: current.bilibiliWatchSeconds,
            template: current.bilibiliTemplate,
            cookieFile: current.bilibiliCookieFile,
          },
        },
        auth: authSnapshot(),
        /**
         * Which profile the update route would write to. Reported rather than
         * assumed: "not installed" is a different sentence from "the panel looked in
         * the wrong profile", and only the path makes the two distinguishable.
         */
        profile: {
          name: profileFacts().name,
          dir: profileFacts().dir,
          readable: readManifest(profileFacts().dir) !== null,
        },
        configFile: current.configFile,
        configSource: current.configSource,
        configProblem: current.configProblem,
        configDropped: current.configDropped ?? 0,
        /**
         * Commands quoted from where this copy is actually installed. A panel that
         * told the user to run `node scripts/configure.mjs` would be wrong for
         * everyone who installed the plugin somewhere else.
         */
        helper: {
          pluginRoot: moduleDir,
          configureScript: join(moduleDir, 'scripts', 'configure.mjs'),
          configFile: current.configFile,
        },
        repos: current.repos.map((entry) => ({ repo: entry.repo, label: entry.label !== '' ? entry.label : entry.repo, localPath: entry.localPath })),
      },
    })
  }

  const overviewHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    if (!current.enabled) {
      writeJson(res, 200, { ok: true, value: { fetchedAt: new Date().toISOString(), disabled: true, repos: [] } })
      return
    }
    if (current.repos.length === 0) {
      writeJson(res, 200, {
        ok: true,
        value: { fetchedAt: new Date().toISOString(), repos: [], unconfigured: true },
      })
      return
    }
    const fresh = cache !== null && Date.now() - cache.at < current.overviewTtlMs
    if (fresh && body?.force !== true) {
      writeJson(res, 200, { ok: true, value: { ...cache.value, cached: true } })
      return
    }

    const settled = await Promise.allSettled(
      current.repos.map((entry) => collectRepo({ config: current, ghPath, entry })),
    )
    const profile = profileFacts()
    const repos = settled.map((outcome, index) => {
      const entry = current.repos[index]
      const value = outcome.status === 'fulfilled'
        ? outcome.value
        : {
            repo: entry.repo,
            slug: resolveSlug(current.owner, entry.repo),
            label: entry.label !== '' ? entry.label : entry.repo,
            localPath: entry.localPath,
            releases: [],
            problems: [String(outcome.reason?.message ?? outcome.reason)],
          }
      /*
       * The install block is computed from local files, not from GitHub, so it is
       * attached here rather than inside `collectRepo` — that function's contract is
       * "one repository's remote and local git state", and this is neither.
       */
      return {
        ...value,
        install: describeInstall({
          profileDir: profile.dir,
          profileName: profile.name,
          entry,
          releases: value.releases ?? [],
        }),
      }
    })
    const value = { fetchedAt: new Date().toISOString(), cached: false, repos, configSource: current.configSource, configProblem: current.configProblem }
    cache = { at: Date.now(), value }
    writeJson(res, 200, { ok: true, value })
  }

  const runsHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(live(), body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const limit = clampNumber(body?.limit, 1, 30, 10)
    const result = await ghJson(ghPath, ['run', 'list', '-R', target.slug, '--limit', String(limit), '--json',
      'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,createdAt,updatedAt,url'], config.requestTimeoutMs)
    if (!result.ok) {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: result.message })
      return
    }
    const runs = Array.isArray(result.value) ? result.value.map(normalizeRun).filter((run) => run !== null) : []
    writeJson(res, 200, { ok: true, value: { repo: target.entry.repo, runs } })
  }

  const dispatchHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(live(), body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const workflow = text(body?.workflow, config.buildWorkflow)
    if (!SLUG.test(workflow.replace(/\.ya?ml$/, ''))) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: `unusable workflow name: ${workflow}` })
      return
    }
    const ref = text(body?.ref, config.defaultBranch)
    /*
     * A release dispatch is preflighted, because the run it would start cannot
     * succeed when the local version is already taken by another commit. The check
     * asks GitHub for the two facts the workflow's own guard uses — the commit this
     * ref would build, and the release that owns `v<version>` — and refuses only on
     * a proven mismatch. An unreadable answer dispatches as before: a preflight that
     * blocks a release that would have worked is worse than no preflight.
     */
    if (workflowFileName(workflow) === workflowFileName(config.releaseWorkflow)) {
      const version = readLocalVersion(target.entry.localPath)
      const expectedTag = version === null ? null : `v${version}`
      if (expectedTag !== null) {
        const [headResult, releasesResult] = await Promise.all([
          runTool(ghPath, ['api', `repos/${target.slug}/commits/${encodeURIComponent(ref)}`, '--jq', '.sha'], config.requestTimeoutMs),
          ghJson(ghPath, ['api', `repos/${target.slug}/releases?per_page=5`], config.requestTimeoutMs),
        ])
        if (releasesResult.ok) {
          const releases = Array.isArray(releasesResult.value)
            ? releasesResult.value.map(normalizeRelease).filter((release) => release !== null)
            : []
          const verdict = releasePreflight({
            version,
            expectedTag,
            releases,
            builtSha: headResult.ok ? headResult.stdout.trim() : null,
          })
          if (verdict.state === 'blocked') {
            const next = nextVersion(version, 'patch')
            cache = null
            writeJson(res, 409, {
              ok: false,
              code: 'version-taken',
              message: verdict.message,
              value: {
                repo: target.entry.repo,
                workflow,
                ref,
                tag: verdict.tag,
                owner: verdict.owner,
                built: verdict.built,
                nextTag: next.ok === true ? `v${next.to}` : null,
              },
            })
            return
          }
        }
      }
    }
    const args = ['workflow', 'run', workflow, '-R', target.slug, '--ref', ref]
    const inputs = body?.inputs
    if (inputs !== null && typeof inputs === 'object') {
      for (const [key, value] of Object.entries(inputs)) {
        if (!SLUG.test(key)) continue
        args.push('-f', `${key}=${String(value)}`)
      }
    }
    const result = await ghRun(ghPath, args, config.requestTimeoutMs)
    cache = null
    if (!result.ok) {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: result.message, value: { repo: target.entry.repo, workflow } })
      return
    }
    writeJson(res, 200, {
      ok: true,
      value: { repo: target.entry.repo, workflow, ref, dispatched: true, note: firstLine(result.stdout) || null },
    })
  }

  const runActionHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(live(), body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const runId = clampNumber(body?.runId, 1, Number.MAX_SAFE_INTEGER, 0)
    if (runId === 0) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'body.runId is required' })
      return
    }
    const action = text(body?.action)
    /** Only these three exist, and each maps to one documented `gh run` subcommand. */
    const args = action === 'rerun'
      ? ['run', 'rerun', String(runId), '-R', target.slug]
      : action === 'rerun-failed'
        ? ['run', 'rerun', String(runId), '-R', target.slug, '--failed']
        : action === 'cancel'
          ? ['run', 'cancel', String(runId), '-R', target.slug]
          : null
    if (args === null) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: `unsupported action: ${action || '(empty)'}` })
      return
    }
    const result = await ghRun(ghPath, args, config.requestTimeoutMs)
    cache = null
    if (!result.ok) {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: result.message })
      return
    }
    writeJson(res, 200, { ok: true, value: { repo: target.entry.repo, runId, action, note: firstLine(result.stdout) || null } })
  }

  const releaseActionHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(live(), body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const tag = text(body?.tag)
    if (!SLUG.test(tag)) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: `unusable tag: ${tag}` })
      return
    }
    const action = text(body?.action)
    // Publishing a draft is a one-way, user-visible action on a public page, which
    // is exactly why the release workflow creates drafts by default and why this
    // is the only route that can make one public.
    const args = action === 'publish'
      ? ['release', 'edit', tag, '-R', target.slug, '--draft=false']
      : action === 'delete'
        ? ['release', 'delete', tag, '-R', target.slug, '--yes']
        : null
    if (args === null) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: `unsupported action: ${action || '(empty)'}` })
      return
    }
    const result = await ghRun(ghPath, args, config.requestTimeoutMs)
    cache = null
    if (!result.ok) {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: result.message })
      return
    }
    /* A published release is exactly the moment an update note becomes true, so
       the sweep is asked now rather than at the next tick. It is not awaited: the
       comment is Bilibili's business, and this answer is GitHub's. */
    if (action === 'publish') void sweepBilibili('release-published')
    writeJson(res, 200, { ok: true, value: { repo: target.entry.repo, tag, action, note: firstLine(result.stdout) || null } })
  }

  /**
   * Bump `package.json`, commit it, and push the branch.
   *
   * This is the step 发布 was silently missing. Every repository in this set
   * releases from `package.json`'s version, and re-releasing a version that already
   * belongs to another commit is refused by the workflow on purpose (it would leave
   * the tag and the uploaded assets disagreeing) — so a console that cannot bump the
   * version cannot release a repository whose tree has moved on.
   *
   * It is the only route that writes to a checkout, so it is conservative:
   *   - a dirty tree is refused rather than warned about, because the release is
   *     built from the commit GitHub has and every uncommitted file would be
   *     silently missing from the published package;
   *   - a branch that is behind its upstream, or has none, is refused: "push" would
   *     either fail or need a decision (merge? rebase?) that is not this button's;
   *   - only the version line of `package.json` is written, and it is restored
   *     verbatim if the commit does not go through, so a failed bump leaves no
   *     half-applied state behind.
   *
   * A failed PUSH is not rolled back. The commit is real and the failure is usually
   * the intermittent block on `github.com:443` this machine already documents, so
   * the honest answer is "committed locally, not pushed" with the reason — retrying
   * the push is a decision the user can make, and a hidden reset is not.
   */
  const versionBumpHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(live(), body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const kind = text(body?.release, 'patch')
    const localPath = target.entry.localPath
    if (localPath === '' || !existsSync(join(localPath, 'package.json'))) {
      writeJson(res, 400, {
        ok: false,
        code: 'no-checkout',
        message: 'this repository has no local checkout with a package.json to bump',
        value: { repo: target.entry.repo },
      })
      return
    }
    const state = await readLocalState(localPath, config.requestTimeoutMs)
    if (state.available !== true) {
      writeJson(res, 400, {
        ok: false,
        code: 'no-checkout',
        message: `cannot bump from here: ${state.reason ?? 'the local checkout is unusable'}`,
        value: { repo: target.entry.repo },
      })
      return
    }
    if (state.dirty !== 0) {
      writeJson(res, 409, {
        ok: false,
        code: 'dirty-tree',
        message: `the checkout has ${String(state.dirty)} uncommitted change(s); commit or stash them first — they would not be in the released package`,
        value: { repo: target.entry.repo, dirty: state.dirty },
      })
      return
    }
    if (state.upstreamKnown !== true || typeof state.branch !== 'string' || state.branch === '') {
      writeJson(res, 409, {
        ok: false,
        code: 'no-upstream',
        message: `branch ${state.branch ?? '(unknown)'} has no upstream, so a bump could not be pushed`,
        value: { repo: target.entry.repo, branch: state.branch ?? null },
      })
      return
    }
    if (Number.isInteger(state.behind) && state.behind > 0) {
      writeJson(res, 409, {
        ok: false,
        code: 'behind',
        message: `the branch is ${String(state.behind)} commit(s) behind its upstream; pull before releasing`,
        value: { repo: target.entry.repo, behind: state.behind },
      })
      return
    }

    const manifest = join(localPath, 'package.json')
    let source = ''
    try {
      source = readFileSync(manifest, 'utf8')
    } catch (error) {
      writeJson(res, 502, { ok: false, code: 'read-failed', message: String(error?.message ?? error) })
      return
    }
    const next = nextVersion(readLocalVersion(localPath), kind)
    if (next.ok !== true) {
      writeJson(res, 400, { ok: false, code: 'unusable-version', message: next.message })
      return
    }
    const rewritten = rewriteVersion(source, next.to)
    if (rewritten.ok !== true) {
      writeJson(res, 400, { ok: false, code: 'unusable-manifest', message: rewritten.message })
      return
    }

    const git = (args) => runTool('git', ['-C', localPath, ...args], config.requestTimeoutMs)
    const restore = () => {
      try {
        writeFileSync(manifest, source, 'utf8')
      } catch {
        /* Reported through the failure that follows; a second failure here is not the story. */
      }
    }

    try {
      writeFileSync(manifest, rewritten.text, 'utf8')
    } catch (error) {
      writeJson(res, 502, { ok: false, code: 'write-failed', message: String(error?.message ?? error) })
      return
    }

    const tag = `v${next.to}`
    const staged = await git(['add', '--', 'package.json'])
    if (staged.ok !== true) {
      restore()
      writeJson(res, 502, { ok: false, code: 'git-failed', message: commandFailureLine(staged, 'git add failed') })
      return
    }
    // `-- package.json` is `--only` semantics: the commit contains this one path,
    // whatever else the index happens to hold.
    const committed = await git(['commit', '-m', `chore(release): ${tag}`, '--', 'package.json'])
    if (committed.ok !== true) {
      restore()
      writeJson(res, 502, {
        ok: false,
        code: 'git-failed',
        message: commandFailureLine(committed, 'git commit failed'),
      })
      return
    }
    const head = await git(['rev-parse', 'HEAD'])
    const pushed = await git(['push', 'origin', state.branch])
    cache = null
    if (pushed.ok !== true) {
      writeJson(res, 502, {
        ok: false,
        code: 'push-failed',
        message: `committed ${tag} locally, but the push failed: ${commandFailureLine(pushed, 'git push failed')}`,
        value: { repo: target.entry.repo, from: next.from, to: next.to, tag, branch: state.branch, pushed: false },
      })
      return
    }
    writeJson(res, 200, {
      ok: true,
      value: {
        repo: target.entry.repo,
        from: next.from,
        to: next.to,
        tag,
        branch: state.branch,
        commit: head.ok === true ? head.stdout.trim() : null,
        pushed: true,
        /** Local commits that this push also delivered, so the panel can say so. */
        carried: Number.isInteger(state.ahead) ? state.ahead : 0,
      },
    })
  }

  /**
   * Commit the working tree, and push it.
   *
   * This is the way out of the trap the panel spends a lot of words on: a release
   * builds the PUSHED commit, so work that is only in the working tree — or only on
   * this machine — is silently absent from the released package. The console could
   * already tell you that; until now the way to fix it was a terminal.
   *
   * `git add -A` on purpose: a release needs new files too, and the panel lists them
   * before the button is pressed (`local.files`), so this is not a blind sweep. An
   * empty message means "push what is already committed", which is the other half of
   * the same trap — a commit that never left the machine is equally absent.
   *
   * The order is commit first, push second, and a push that fails still reports what
   * was committed, because "your work is safe locally" and "the push failed" are two
   * different things to be told.
   */
  const commitHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(live(), body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const localPath = target.entry.localPath
    if (localPath === '') {
      writeJson(res, 400, {
        ok: false,
        code: 'no-checkout',
        message: 'this repository has no local checkout, so there is nothing here to commit',
        value: { repo: target.entry.repo },
      })
      return
    }
    const state = await readLocalState(localPath, config.requestTimeoutMs)
    if (state.available !== true) {
      writeJson(res, 400, {
        ok: false,
        code: 'no-checkout',
        message: `cannot commit from here: ${state.reason ?? 'the local checkout is unusable'}`,
        value: { repo: target.entry.repo },
      })
      return
    }
    const dirty = Number.isInteger(state.dirty) ? state.dirty : 0
    const ahead = Number.isInteger(state.ahead) ? state.ahead : 0
    if (dirty === 0 && ahead === 0) {
      writeJson(res, 409, {
        ok: false,
        code: 'nothing-to-commit',
        message: 'the checkout is clean and in sync with its upstream; there is nothing to commit or push',
        value: { repo: target.entry.repo, dirty, ahead },
      })
      return
    }
    if (state.upstreamKnown !== true || typeof state.branch !== 'string' || state.branch === '') {
      writeJson(res, 409, {
        ok: false,
        code: 'no-upstream',
        message: `branch ${state.branch ?? '(unknown)'} has no upstream, so nothing could be pushed — the release builds what is on GitHub, not what is on this disk`,
        value: { repo: target.entry.repo, branch: state.branch ?? null },
      })
      return
    }
    const message = text(body?.message).trim()
    if (dirty > 0 && message === '') {
      writeJson(res, 400, {
        ok: false,
        code: 'message-required',
        message: 'a commit needs a message',
        value: { repo: target.entry.repo },
      })
      return
    }

    const git = (args) => runTool('git', ['-C', localPath, ...args], config.requestTimeoutMs)
    const files = Array.isArray(state.files) ? state.files : []
    if (dirty > 0) {
      const staged = await git(['add', '-A'])
      if (staged.ok !== true) {
        writeJson(res, 502, { ok: false, code: 'git-failed', message: commandFailureLine(staged, 'git add failed') })
        return
      }
      const committed = await git(['commit', '-m', message])
      if (committed.ok !== true) {
        writeJson(res, 502, { ok: false, code: 'git-failed', message: commandFailureLine(committed, 'git commit failed') })
        return
      }
    }
    const head = await git(['rev-parse', 'HEAD'])
    const pushed = await git(['push', 'origin', state.branch])
    cache = null
    if (pushed.ok !== true) {
      writeJson(res, 502, {
        ok: false,
        code: 'push-failed',
        message: dirty > 0
          ? `committed locally, but the push failed: ${commandFailureLine(pushed, 'git push failed')}`
          : `the push failed: ${commandFailureLine(pushed, 'git push failed')}`,
        value: { repo: target.entry.repo, branch: state.branch, committed: dirty > 0, files },
      })
      return
    }
    writeJson(res, 200, {
      ok: true,
      value: {
        repo: target.entry.repo,
        branch: state.branch,
        committed: dirty > 0,
        commit: head.ok === true ? head.stdout.trim() : null,
        /** What was committed, so the panel can name it rather than say "done". */
        files,
        /** Local commits this push also delivered — the ones a release was missing. */
        carried: ahead,
      },
    })
  }

  const logsHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(live(), body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const runId = clampNumber(body?.runId, 1, Number.MAX_SAFE_INTEGER, 0)
    if (runId === 0) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'body.runId is required' })
      return
    }
    const result = await runTool(ghPath, ['run', 'view', String(runId), '-R', target.slug, '--log-failed'], config.requestTimeoutMs)
    if (!result.ok && result.stdout.trim() === '') {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: result.killed ? `gh timed out after ${config.requestTimeoutMs} ms` : commandFailureLine(result, 'gh failed') })
      return
    }
    // The panel shows a tail, not a log viewer: `--log-failed` can be megabytes.
    const lines = result.stdout.split('\n')
    const tail = lines.slice(Math.max(0, lines.length - config.logTailLines))
    writeJson(res, 200, { ok: true, value: { repo: target.entry.repo, runId, truncated: lines.length > tail.length, lines: tail } })
  }

  /* ------------------------------------------------- installed-copy update -- */

  /**
   * Replace this profile's copy of a repository's package with the release's tgz.
   *
   * Why this exists: the console could trigger a release but never take it. A
   * checkout installed with `link:` is not the artifact anybody downloads, and the
   * only way to find that out was a terminal and `dsh plugin add file:<tgz>`. So
   * the artifact is fetched to a plugin-owned directory and handed to the Host's own
   * plugin manager — the same pnpm path `dsh plugin add` takes, which holds the
   * profile lock and restores `package.json` when a run fails. Shelling out to the
   * CLI from here would be a second writer against the same profile.
   *
   * Everything that can be decided locally is decided before GitHub is asked: a
   * repository that is not a dependency of this profile has nothing to update, and
   * saying so costs no network round trip.
   */
  const updateHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const target = findEntry(current, body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined
    if (manager === undefined || manager === null || typeof manager.installBundle !== 'function') {
      writeJson(res, 501, {
        ok: false,
        code: 'plugin-manager-missing',
        message: 'this Host has no pluginManager service, so nothing here can install a package into the profile',
      })
      return
    }
    if (updateInFlight) {
      writeJson(res, 409, { ok: false, code: 'busy', message: 'an update is already running; wait for it to settle' })
      return
    }
    const profile = profileFacts()
    const localPath = target.entry.localPath
    const checkout = readManifest(localPath)
    const declared = checkout !== null && checkout.name !== '' ? checkout.name : bareRepoName(target.entry.repo)
    const install = readProfileInstall(profile.dir, declared, localPath)
    if (install.present !== true) {
      writeJson(res, 409, {
        ok: false,
        code: 'not-installed',
        message: `${declared} is not a dependency of the ${profile.name} profile, so there is no installed copy to update`,
        value: { repo: target.entry.repo, packageName: declared, profile: profile.name, profileDir: profile.dir },
      })
      return
    }
    const wanted = text(body?.tag)
    if (wanted !== '' && !SLUG.test(wanted)) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: `unusable tag: ${wanted}` })
      return
    }

    updateInFlight = true
    try {
      const releasesResult = await ghJson(ghPath, ['api', `repos/${target.slug}/releases?per_page=10`], current.requestTimeoutMs)
      if (!releasesResult.ok) {
        writeJson(res, 502, { ok: false, code: 'gh-failed', message: releasesResult.message })
        return
      }
      const releases = Array.isArray(releasesResult.value)
        ? releasesResult.value.map(normalizeRelease).filter((release) => release !== null)
        : []
      const latest = pickInstallableRelease(releases, wanted)
      if (latest === null) {
        writeJson(res, 409, {
          ok: false,
          code: 'no-release',
          message: wanted === ''
            ? 'this repository has no published release carrying a .tgz asset yet'
            : `release ${wanted} is not published, or carries no .tgz asset`,
          value: { repo: target.entry.repo, tag: wanted === '' ? null : wanted },
        })
        return
      }

      /*
       * Downloaded beside the managed config file rather than into a temp directory,
       * and kept: the profile's dependency ends up pointing at this path, so deleting
       * the tarball afterwards would leave a manifest that no longer installs.
       */
      const directory = join(dirname(resolveConfigFilePath(config)), DOWNLOAD_DIR_NAME)
      let tarball = ''
      try {
        mkdirSync(directory, { recursive: true })
        tarball = join(directory, latest.asset)
      } catch (error) {
        writeJson(res, 500, { ok: false, code: 'download-dir-failed', message: `cannot prepare ${directory}: ${String(error?.message ?? error)}` })
        return
      }
      const fetched = await ghRun(
        ghPath,
        ['release', 'download', latest.tag, '-R', target.slug, '-p', latest.asset, '-D', directory, '--clobber'],
        Math.max(current.requestTimeoutMs, 60_000),
      )
      if (!fetched.ok) {
        writeJson(res, 502, { ok: false, code: 'download-failed', message: commandFailureLine(fetched, `gh release download failed for ${latest.asset}`) })
        return
      }
      if (!existsSync(tarball)) {
        writeJson(res, 502, { ok: false, code: 'download-failed', message: `gh reported success but ${latest.asset} is not in ${directory}` })
        return
      }
      /*
       * Make a no-op a no-op.
       *
       * Handed a spec the manifest already carries, pnpm changes nothing, so it
       * reports no changed dependency — and the plugin manager reads "no dependency
       * changed" as `ambiguous-install` and restores the profile. That is a true
       * statement about pnpm and a false one about this request: the profile already
       * points at exactly this artifact, which is the outcome that was asked for.
       */
      if (install.kind === 'tarball' && install.path !== null && comparablePath(install.path) === comparablePath(tarball)) {
        cache = null
        writeJson(res, 200, {
          ok: true,
          value: {
            repo: target.entry.repo,
            packageName: install.packageName,
            tag: latest.tag,
            version: latest.version ?? versionFromTag(latest.tag),
            asset: latest.asset,
            from: install.installedVersion,
            previousSpec: install.spec,
            tarball,
            application: 'applied',
            /** Nothing was written, so there is nothing a restart would make live. */
            changed: false,
            restartRequired: false,
            pendingBuilds: [],
            warnings: [],
          },
        })
        return
      }

      const change = await manager.installBundle(tarball, { enabled: true })
      cache = null
      const failed = change === null || typeof change !== 'object' || change.changed !== true
        || change.application === 'failed' || change.application === 'cancelled'
      if (failed) {
        const reason = change?.error?.diagnostic ?? change?.error?.code ?? 'the plugin manager installed nothing'
        writeJson(res, 502, {
          ok: false,
          code: 'install-failed',
          message: `installing ${latest.asset} failed: ${String(reason)}. The profile files were restored.`,
          value: { repo: target.entry.repo, tag: latest.tag, asset: latest.asset, application: change?.application ?? null },
        })
        return
      }
      writeJson(res, 200, {
        ok: true,
        value: {
          repo: target.entry.repo,
          packageName: install.packageName,
          tag: latest.tag,
          version: latest.version ?? versionFromTag(latest.tag),
          asset: latest.asset,
          from: install.installedVersion,
          previousSpec: install.spec,
          tarball,
          changed: true,
          application: change.application,
          /**
           * Always true for an update, and reported as such rather than inferred by
           * the panel: the module is already loaded, and even a live-reload profile
           * cannot swap ESM under a running Host.
           */
          restartRequired: true,
          pendingBuilds: Array.isArray(change.pendingBuilds) ? change.pendingBuilds : [],
          warnings: Array.isArray(change.warnings) ? change.warnings : [],
        },
      })
    } finally {
      updateInFlight = false
    }
  }

  /**
   * Forward a restart to the one-click restart plugin, if this Host mounts it.
   *
   * This plugin deliberately restarts nothing itself. Which process to stop, which
   * executable to relaunch and how to survive the gap are `dsh-plugin-restart`'s
   * contract, and a second implementation of that would eventually kill an app it
   * cannot start again. The forward is same-authority and server-side, which the
   * sibling route's trust rule accepts for exactly the reason it accepts the
   * browser: the request came from this machine and from this Host.
   */
  const restartHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    const authority = typeof req.headers?.host === 'string' ? req.headers.host : ''
    if (parseAuthority(authority) === undefined) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'the request carries no Host authority to forward to' })
      return
    }
    let response
    try {
      response = await fetch(`http://${authority}/api/dsh-restart/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(RESTART_FORWARD_TIMEOUT_MS),
      })
    } catch (error) {
      writeJson(res, 502, {
        ok: false,
        code: 'restart-unreachable',
        message: `could not reach the restart route: ${String(error?.message ?? error)}`,
      })
      return
    }
    /*
     * 401 is what this Host answers for a path no plugin mounted, so it means
     * "dsh-plugin-restart is not installed here" — not "you may not do this".
     * Saying so is the difference between a fixable install and a mystery.
     */
    if (response.status === 401 || response.status === 404) {
      writeJson(res, 501, {
        ok: false,
        code: 'restart-unavailable',
        message: 'dsh-plugin-restart is not mounted on this Host, so nothing here can restart DSH',
      })
      return
    }
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (payload === null || typeof payload !== 'object') {
      writeJson(res, 502, {
        ok: false,
        code: 'restart-unreadable',
        message: `the restart route answered HTTP ${String(response.status)} without JSON`,
      })
      return
    }
    writeJson(res, response.status, payload)
  }

  /* -------------------------------------------------------------- npm push -- */

  /** One registry answer is reused briefly; a publish or a sign-in clears it. */
  let npmCache = null

  /** The user-level `.npmrc` text, or '' when there is none to read. */
  const readNpmrcText = () => {
    try {
      return readFileSync(resolveNpmrcPath(), 'utf8')
    } catch {
      return ''
    }
  }

  /** One publish at a time: npm refuses a second upload of the same version anyway. */
  let npmPublishInFlight = false

  /**
   * Ask the registry about one package.
   *
   * A 404 is an ANSWER, not a failure: it is how the registry says "nobody owns this
   * name", which is exactly the state a first publish is in.
   *
   * @param {string} registry - normalized registry base.
   * @param {string} packageName - the package to ask about.
   * @returns {Promise<{ok: true, value: object|null}|{ok: false, message: string}>}
   */
  const fetchPackument = async (registry, packageName) => {
    const attempt = async (url) => {
      try {
        const response = await fetch(url, {
          // `no-cache` is the standard half of the same request: it asks any cache in
          // the path to revalidate rather than answer from its copy.
          headers: { accept: 'application/json', 'cache-control': 'no-cache' },
          signal: AbortSignal.timeout(NPM_STATUS_TIMEOUT_MS),
        })
        if (response.status === 404) return { ok: true, value: null }
        if (!response.ok) return { ok: false, message: `the registry answered HTTP ${String(response.status)}` }
        return { ok: true, value: await response.json() }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    }
    const fresh = await attempt(packumentUrl(registry, packageName))
    if (fresh.ok === true) return fresh
    /*
     * An unknown query parameter is the one thing a different registry may refuse, and
     * `npmRegistry` is configurable. One retry without it keeps this from turning a
     * cache fix into a panel that says "unknown" everywhere.
     */
    return await attempt(`${registry}${packageName}`)
  }

  /**
   * Ask the package manager who it is signed in as.
   *
   * This is the real check: an `.npmrc` line can be present and wrong, revoked, or
   * scoped to another registry, and `whoami` is the only thing that answers "will an
   * upload be accepted".
   *
   * @param {object} invocation - from `resolvePackageManagerInvocation`.
   * @param {string} registry - normalized registry base.
   * @returns {Promise<{loggedIn: boolean, account: string|null, message: string|null}>}
   */
  const readNpmAuth = async (invocation, registry) => {
    if (invocation === null) return { loggedIn: false, account: null, message: 'no package manager is available to ask' }
    const result = await runSpawn(invocation.command, [...invocation.args, 'whoami', '--registry', registry], {
      timeoutMs: 20_000,
      env: invocation.env,
    })
    if (result.ok !== true) {
      return { loggedIn: false, account: null, message: commandFailureLine(result, 'the package manager refused to answer') }
    }
    const account = firstLine(result.stdout)
    return account === ''
      ? { loggedIn: false, account: null, message: 'the package manager answered without an account name' }
      : { loggedIn: true, account, message: null }
  }

  /**
   * What the npm registry holds for every configured repository.
   *
   * On demand rather than polled, and separate from `overview`: this is one HTTPS
   * request per repository plus one `whoami`, and the answer changes when someone
   * publishes, not every thirty seconds.
   */
  const npmStatusHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const registry = normalizeRegistry(current.npmRegistry)
    const fresh = npmCache !== null && Date.now() - npmCache.at < NPM_STATUS_TTL_MS
    if (fresh && body?.force !== true) {
      writeJson(res, 200, { ok: true, value: { ...npmCache.value, cached: true } })
      return
    }
    const invocation = resolvePackageManagerInvocation(ctx)
    const npmrcPath = resolveNpmrcPath()
    const npmrcReadable = existsSync(npmrcPath)
    const npmrcText = readNpmrcText()
    const hasToken = hasNpmToken(npmrcText, registry)
    const auth = await readNpmAuth(invocation, registry)
    const authState = npmAuthState({ whoami: auth.loggedIn, hasToken })

    const repos = await Promise.all(current.repos.map(async (entry) => {
      const localPath = entry.localPath
      const manifest = readManifest(localPath)
      const packageName = manifest !== null && manifest.name !== '' ? manifest.name : bareRepoName(entry.repo)
      const version = manifest === null ? null : manifest.version
      const [packument, dirty] = await Promise.all([
        fetchPackument(registry, packageName),
        readDirtyCount(localPath, current.requestTimeoutMs),
      ])
      const registryState = packument.ok === true ? npmPackageState(packument.value, version) : null
      const verdict = npmPublishVerdict({
        packageName,
        version,
        manifest,
        registryState,
        // A credential that exists is enough to offer the push: whether it is accepted
        // is the registry's answer to give, and the publish route names it if not.
        authed: authState !== 'none',
        dirty,
      })
      return {
        repo: entry.repo,
        label: entry.label !== '' ? entry.label : entry.repo,
        localPath,
        packageName,
        version,
        dirty,
        privatePackage: manifest !== null && manifest.private === true,
        blockers: verdict.blockers,
        canPublish: verdict.canPublish,
        state: verdict.state,
        latest: verdict.latest,
        /** Why the registry could not be asked, when it could not. */
        registryProblem: packument.ok === true ? null : packument.message,
        /** Carried per row so a row can render its own confirmation unaided. */
        registry,
        pageUrl: `${registry}${packageName}`,
      }
    }))

    const value = {
      fetchedAt: new Date().toISOString(),
      cached: false,
      registry,
      packageManager: invocation === null ? null : { source: invocation.source, command: invocation.command },
      auth: {
        /** signed-in / credential-present / none — see `npmAuthState`. */
        state: authState,
        loggedIn: authState === 'signed-in',
        account: auth.account,
        /** What `whoami` said when it did not confirm. Shown verbatim. */
        message: auth.message,
        npmrcPath,
        npmrcReadable,
        /** Whether a token line exists at all, without reading the token itself. */
        npmrcHasToken: hasToken,
      },
      repos,
    }
    npmCache = { at: Date.now(), value }
    writeJson(res, 200, { ok: true, value })
  }

  /**
   * Put an npm token where npm itself would put it, and prove it works.
   *
   * The panel is meant to be usable without a terminal, and `pnpm login` needs one —
   * so the token a person already generated on npmjs.com is written into the same
   * user-level `.npmrc` that `npm login` writes, and then verified with `whoami`.
   * The plugin still stores nothing: the credential lives in the file the npm
   * ecosystem owns, and it is never returned, echoed or logged here.
   */
  const npmLoginHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const registry = normalizeRegistry(current.npmRegistry)
    const token = typeof body?.token === 'string' ? body.token.trim() : ''
    const npmrcPath = resolveNpmrcPath()
    const existing = readNpmrcText()
    const merged = upsertAuthToken(existing, registry, token)
    if (merged.ok !== true) {
      writeJson(res, 400, { ok: false, code: 'bad-token', message: merged.message })
      return
    }
    try {
      // Keep the previous revision, as every other write in this plugin does. The
      // backup holds whatever the file held, which may itself be an older token —
      // that is the user's own file and their own credential.
      if (existsSync(npmrcPath)) writeFileSync(`${npmrcPath}.bak`, existing, 'utf8')
      writeFileSync(npmrcPath, merged.text, 'utf8')
    } catch (error) {
      writeJson(res, 502, { ok: false, code: 'write-failed', message: `cannot write ${npmrcPath}: ${String(error?.message ?? error)}` })
      return
    }
    const invocation = resolvePackageManagerInvocation(ctx)
    const auth = await readNpmAuth(invocation, registry)
    npmCache = null
    if (auth.loggedIn !== true) {
      writeJson(res, 401, {
        ok: false,
        code: 'token-rejected',
        message: `the token was written to ${npmrcPath}, but the registry did not accept it: ${auth.message ?? 'unknown reason'}`,
        value: { registry, npmrcPath, replaced: merged.replaced },
      })
      return
    }
    writeJson(res, 200, { ok: true, value: { account: auth.account, registry, npmrcPath, replaced: merged.replaced } })
  }

  /**
   * Publish this repository's current version to the npm registry.
   *
   * Every refusal happens before anything is uploaded, because a publish is one of
   * the two irreversible things this panel can do: npm lets a version be unpublished
   * only briefly and never lets the same version be published twice. So a dirty tree
   * is refused (the tarball is packed from the working directory, and the `files`
   * allow-list does not protect a file that sits inside a listed directory), a
   * version that is already on the registry is refused, and a missing credential is
   * refused with what to do about it.
   */
  const npmPublishHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const target = findEntry(current, body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const registry = normalizeRegistry(current.npmRegistry)
    const invocation = resolvePackageManagerInvocation(ctx)
    if (invocation === null) {
      writeJson(res, 501, { ok: false, code: 'no-package-manager', message: 'this Host has no package manager to publish with' })
      return
    }
    if (npmPublishInFlight) {
      writeJson(res, 409, { ok: false, code: 'busy', message: 'a publish is already running; wait for it to settle' })
      return
    }
    const localPath = target.entry.localPath
    const manifest = readManifest(localPath)
    if (manifest === null || manifest.name === '') {
      writeJson(res, 400, {
        ok: false,
        code: 'no-checkout',
        message: 'this repository has no local checkout with a package.json to publish',
        value: { repo: target.entry.repo },
      })
      return
    }
    if (manifest.private === true) {
      writeJson(res, 409, {
        ok: false,
        code: 'private-package',
        message: `${manifest.name} is marked "private": true, so npm would refuse it. Publishing it is the author's decision to make first.`,
        value: { repo: target.entry.repo, packageName: manifest.name },
      })
      return
    }
    if (manifest.version === null) {
      writeJson(res, 409, {
        ok: false,
        code: 'no-version',
        message: `${manifest.name} has no version in its package.json, so there is nothing to publish`,
        value: { repo: target.entry.repo, packageName: manifest.name },
      })
      return
    }
    const dirty = await readDirtyCount(localPath, current.requestTimeoutMs)
    if (Number.isFinite(dirty) && dirty > 0) {
      writeJson(res, 409, {
        ok: false,
        code: 'dirty-tree',
        message: `the checkout has ${String(dirty)} uncommitted change(s); a publish packs the working directory, so commit or stash them first`,
        value: { repo: target.entry.repo, dirty },
      })
      return
    }
    const packument = await fetchPackument(registry, manifest.name)
    if (packument.ok !== true) {
      writeJson(res, 502, {
        ok: false,
        code: 'registry-unreachable',
        message: `cannot ask ${registry} about ${manifest.name}: ${packument.message}`,
        value: { repo: target.entry.repo, packageName: manifest.name, registry },
      })
      return
    }
    const registryState = npmPackageState(packument.value, manifest.version)
    if (registryState.published === true) {
      writeJson(res, 409, {
        ok: false,
        code: 'already-published',
        message: `${manifest.name}@${manifest.version} is already on ${registry}; npm never accepts the same version twice, so bump the version first`,
        value: { repo: target.entry.repo, packageName: manifest.name, version: manifest.version, latest: registryState.latest, registry },
      })
      return
    }
    /*
     * The gate is "is there anything to authenticate WITH", not "did `whoami` answer".
     * A granular token is scoped to packages and can be refused by the user-level
     * endpoint while publishing perfectly well, so `whoami` is asked for the account
     * name and never used as the permission slip. A publish with a bad token fails
     * anyway, and it fails with a classification that says which step to repeat.
     */
    const hasToken = hasNpmToken(readNpmrcText(), registry)
    const auth = await readNpmAuth(invocation, registry)
    if (hasToken !== true && auth.loggedIn !== true) {
      writeJson(res, 401, {
        ok: false,
        code: 'not-logged-in',
        message: `${invocation.command} has no credential for ${registry}: ${auth.message ?? 'no account'}`,
        value: { repo: target.entry.repo, packageName: manifest.name, registry, npmrcPath: resolveNpmrcPath() },
      })
      return
    }
    const otp = text(body?.otp)
    if (otp !== '' && !/^\d{6,8}$/.test(otp)) {
      writeJson(res, 400, { ok: false, code: 'bad-otp', message: 'the one-time password must be 6 to 8 digits' })
      return
    }

    const argv = [...invocation.args, 'publish', '--no-git-checks', '--registry', registry]
    if (otp !== '') argv.push('--otp', otp)
    // Only a scoped name carries an access level; passing it for an unscoped one is
    // noise at best.
    if (manifest.name.startsWith('@')) argv.push('--access', 'public')

    npmPublishInFlight = true
    try {
      const result = await runSpawn(invocation.command, argv, {
        cwd: localPath,
        timeoutMs: NPM_PUBLISH_TIMEOUT_MS,
        env: invocation.env,
      })
      npmCache = null
      if (result.ok !== true) {
        /*
         * A named outcome, not a wall of npm text. `EOTP` and `E403` are one line of
         * jargon each and completely different fixes; the panel answers each with the
         * step that resolves it, which is the whole point of guiding a first publish.
         */
        const code = result.killed === true
          ? 'timeout'
          : classifyPublishFailure(`${result.stdout}\n${result.stderr}`)
        const message = result.killed === true
          ? `the publish timed out after ${String(NPM_PUBLISH_TIMEOUT_MS)} ms`
          : commandFailureLine(result, 'the publish failed')
        const status = code === 'otp-required' || code === 'not-logged-in' || code === 'forbidden' || code === 'email-unverified'
          ? 401
          : code === 'already-published'
            ? 409
            : 502
        writeJson(res, status, {
          ok: false,
          code,
          message,
          value: {
            repo: target.entry.repo,
            packageName: manifest.name,
            version: manifest.version,
            registry,
            needsOtp: code === 'otp-required',
          },
        })
        return
      }
      writeJson(res, 200, {
        ok: true,
        value: {
          repo: target.entry.repo,
          packageName: manifest.name,
          version: manifest.version,
          registry,
          pageUrl: `${registry}${manifest.name}`,
          wasUnregistered: registryState.state === 'unregistered',
          account: auth.account,
          note: firstLine(result.stdout) || null,
        },
      })
    } finally {
      npmPublishInFlight = false
    }
  }

  /* --------------------------------------------------- setup, no terminal -- */

  /**
   * Start the browser sign-in.
   *
   * This is the whole point of the route: `gh auth login` normally needs a
   * terminal, and asking someone with no programming background to open one is
   * asking them not to use the feature. The panel renders the code and the URL and
   * links the URL; `gh` does the polling and writes the credential itself, so the
   * plugin still never stores a token.
   */
  const authStartHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const mode = text(body?.mode, 'login')
    if (mode !== 'login' && mode !== 'refresh') {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: `unsupported auth mode: ${mode}` })
      return
    }
    const current = live()
    const scopes = mode === 'refresh'
      // Only scopes this plugin can justify: `gh` refuses an unknown one, and the
      // panel asks for the minimum that makes its buttons work.
      ? (Array.isArray(body?.scopes) ? body.scopes : []).map((scope) => String(scope)).filter((scope) => REQUIRED_SCOPES.includes(scope))
      : []
    if (mode === 'refresh' && scopes.length === 0) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'refresh needs at least one of: repo, workflow' })
      return
    }
    /*
     * Answer immediately, and never let the probe decide.
     *
     * A raw TCP connect is not the same question as "can gh complete its HTTP
     * device-code request": a proxy or an HTTP-layer filter makes the two disagree,
     * and where they disagreed here the refusal blocked a login that would have
     * worked. So gh is always started, the probe runs alongside it, and its verdict
     * reaches the panel through `auth-state` as a warning. Nothing is held open.
     */
    startAuth(mode, scopes)
    const value = authSnapshot()
    writeJson(res, 202, {
      ok: true,
      value: {
        ...value,
        scopes,
        gh: ghPath,
        /** False when the code has not arrived yet, so the panel can say so. */
        ready: typeof value.code === 'string' && value.code !== '',
        note: `waiting for the one-time code from ${current.configSource} configuration`,
      },
    })
  }

  const authStateHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    writeJson(res, 200, { ok: true, value: authSnapshot() })
  }

  const authCancelHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    stopAuth()
    settleAuth('cancelled', null)
    writeJson(res, 200, { ok: true, value: authSnapshot() })
  }

  /**
   * Sign out of GitHub.
   *
   * The panel could log in, grant scopes, cancel and re-check, but not log out —
   * leaving the one credential-destroying action available only from a terminal,
   * which is the opposite of what this panel is for.
   *
   * `gh auth logout` asks for confirmation on stdin, so "y" has to be written to
   * the child. That is the one prompt in this whole plugin where answering stdin is
   * correct: there is nothing else the child could be waiting on.
   */
  const authLogoutHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    // An attempt that is still running would re-authenticate what this removes.
    stopAuth()
    settleAuth('idle', null)
    const child = spawn(ghPath, ['auth', 'logout', '--hostname', 'github.com'], {
      windowsHide: true,
      env: { ...process.env, ...activeProxyEnvironment, GH_PAGER: 'cat', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: error.message })
    })
    child.stdin?.write('y\n')
    child.stdin?.end()
    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1))
      child.on('error', () => resolve(1))
      const killTimer = setTimeout(() => {
        child.kill()
        resolve(1)
      }, 20_000)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    })
    if (exitCode !== 0 && !/logged out/i.test(output)) {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: firstLine(output) || `gh exited with code ${String(exitCode)}` })
      return
    }
    // The account is gone, so every cached answer about its repositories is stale.
    cache = null
    writeJson(res, 200, { ok: true, value: { ...authSnapshot(), note: firstLine(output) || null, gh: await readAuthStatus(ghPath, live().requestTimeoutMs) } })
  }

  /** The repositories this account can see, with any local checkout already found. */
  const reposAvailableHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const limit = clampNumber(body?.limit, 1, 200, 100)
    const result = await ghJson(ghPath, ['api', `user/repos?per_page=${String(limit)}&sort=pushed`, '--jq', '[.[] | {full_name, private, pushed_at, description, fork}]'], current.requestTimeoutMs)
    if (!result.ok) {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: result.message })
      return
    }
    const declared = new Map(current.repos.map((entry) => [entry.repo, entry]))
    const repos = (Array.isArray(result.value) ? result.value : []).map((entry) => {
      const fullName = typeof entry?.full_name === 'string' ? entry.full_name : ''
      const bare = fullName.includes('/') ? fullName.slice(fullName.indexOf('/') + 1) : fullName
      const existing = declared.get(bare) ?? declared.get(fullName) ?? null
      return {
        fullName,
        bare,
        private: entry?.private === true,
        fork: entry?.fork === true,
        pushedAt: typeof entry?.pushed_at === 'string' ? entry.pushed_at : '',
        description: typeof entry?.description === 'string' ? entry.description : '',
        registered: existing !== null,
        /**
         * The exact string this repository is registered under.
         *
         * The panel must remove by that string, not by the name it would have
         * chosen: a list registered when `owner` was set holds bare names, while
         * one registered from the picker holds `owner/name`, and both are
         * legitimate. Removing by the wrong form silently fails to match.
         */
        registeredAs: existing !== null ? existing.repo : null,
        localPath: existing !== null ? existing.localPath : findLocalCheckout(current.projectsRoot, bare),
      }
    })
    writeJson(res, 200, { ok: true, value: { repos, projectsRoot: current.projectsRoot, registered: current.repos.length } })
  }

  /** Register a repository: the click-driven equivalent of `configure.mjs add`. */
  const configAddHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
    if (!isValidRepoName(repo)) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: `unusable repository name: ${JSON.stringify(repo)}` })
      return
    }
    const requestedPath = typeof body?.localPath === 'string' ? body.localPath.trim() : ''
    // A path that was not asked for is looked up rather than demanded: typing an
    // absolute path is the step this route exists to remove.
    const localPath = requestedPath !== '' ? requestedPath : findLocalCheckout(current.projectsRoot, repo)
    if (localPath !== '' && !isAbsolute(localPath)) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'localPath must be absolute' })
      return
    }
    const outcome = mutateConfig(current, (draft) => {
      const index = draft.repos.findIndex((candidate) => candidate.repo === repo)
      /* Merged into whatever is already there, not written over it: this route is also
         how a path gets set, and rebuilding the entry from scratch would drop the
         Bilibili binding — a video unbound as a side effect of editing a directory. */
      const entry = {
        ...(index === -1 ? {} : draft.repos[index]),
        repo,
        ...(localPath !== '' ? { localPath } : {}),
      }
      if (index === -1) draft.repos.push(entry)
      else draft.repos[index] = entry
      return { ok: true, owner: draft.owner, repos: draft.repos }
    })
    if (!outcome.ok) {
      writeJson(res, 502, { ok: false, code: 'config-failed', message: outcome.message })
      return
    }
    writeJson(res, 200, { ok: true, value: { repo, localPath, registered: outcome.count, file: current.configFile } })
  }

  /**
   * Clone a registered repository into the checkout root, and record where it landed.
   *
   * The missing step for a repository that is registered but has no working tree:
   * everything the console does with one — the dirty chip, 提交, 构建, 发布 — needs it,
   * and until now the answer was "go and clone it yourself".
   *
   * The address is derived from the repository name unless one is given, and the panel
   * shows that same derivation pre-filled (`cloneUrl` in the overview), because being
   * asked to paste the clone URL of a repository the Host can already name is exactly
   * the kind of step this console exists to remove. The destination is
   * `projectsRoot/<name>`, which is where `findLocalCheckout` would look for it next.
   */
  const cloneHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const target = findEntry(current, body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const entry = target.entry

    /* Already there: say so rather than making a second copy beside the first. */
    if (entry.localPath !== '') {
      const existing = await readLocalState(entry.localPath, current.requestTimeoutMs)
      if (existing.available === true) {
        writeJson(res, 409, {
          ok: false,
          code: 'already-cloned',
          message: `这个仓库已经有本地检出了：${entry.localPath}`,
          value: { repo: entry.repo, path: entry.localPath },
        })
        return
      }
    }

    const requestedUrl = text(body?.url).trim()
    const url = requestedUrl !== '' ? requestedUrl : defaultCloneUrl(current.owner, entry.repo)
    if (url === '') {
      writeJson(res, 400, {
        ok: false,
        code: 'no-url',
        message: '没有可用的仓库地址：填一个，或者把行配置写成 "owner/repo"',
        value: { repo: entry.repo },
      })
      return
    }
    /* A shell is never involved, so this is not about injection: it is about not asking
       git to fetch something that is not a repository address at all. */
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])/.test(url)) {
      writeJson(res, 400, { ok: false, code: 'bad-url', message: `不像是 git 地址：${JSON.stringify(url)}`, value: { repo: entry.repo } })
      return
    }

    const requestedDirectory = text(body?.directory).trim()
    if (requestedDirectory !== '' && !isAbsolute(requestedDirectory)) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'directory must be absolute', value: { repo: entry.repo } })
      return
    }
    const directory = requestedDirectory !== ''
      ? requestedDirectory
      : (current.projectsRoot === '' ? '' : join(current.projectsRoot, bareRepoName(entry.repo)))
    if (directory === '') {
      writeJson(res, 409, {
        ok: false,
        code: 'no-projects-root',
        message: '`projectsRoot` 还没设置，所以不知道该克隆到哪里：在 profile 的 cordis.patch.yml 里给它一个绝对路径，或者指定一个目录。',
        value: { repo: entry.repo },
      })
      return
    }
    if (existsSync(directory)) {
      let occupied = true
      try {
        occupied = readdirSync(directory).length > 0
      } catch {
        /* Unreadable counts as occupied: cloning into it could destroy something. */
        occupied = true
      }
      if (occupied === true) {
        writeJson(res, 409, {
          ok: false,
          code: 'target-exists',
          message: `${directory} 已经存在且不是空的；换一个目录，或者先把它移走。`,
          value: { repo: entry.repo, path: directory },
        })
        return
      }
    }

    const cloned = await runTool('git', ['clone', '--', url, directory], CLONE_TIMEOUT_MS)
    if (cloned.ok !== true) {
      writeJson(res, 502, {
        ok: false,
        code: 'clone-failed',
        message: commandFailureLine(cloned, 'git clone failed'),
        value: { repo: entry.repo, url, path: directory },
      })
      return
    }
    const outcome = mutateConfig(current, (draft) => {
      const index = draft.repos.findIndex((candidate) => candidate.repo === entry.repo)
      if (index === -1) return { ok: false, message: `not registered: ${entry.repo}` }
      /* The rest of the entry is kept. A clone is about where the working tree is, and
         rebuilding the entry without its `bilibili` would unbind a video as a side
         effect of pointing the console at a checkout. */
      draft.repos[index] = { ...draft.repos[index], localPath: directory }
      return { ok: true, owner: draft.owner, repos: draft.repos }
    })
    cache = null
    if (outcome.ok !== true) {
      /* The clone is on disk; only the bookkeeping failed. Saying which is the
         difference between "clone it again" and "fix the config". */
      writeJson(res, 502, {
        ok: false,
        code: 'config-failed',
        message: `已克隆到 ${directory}，但写不进配置：${outcome.message}`,
        value: { repo: entry.repo, path: directory, url },
      })
      return
    }
    writeJson(res, 200, { ok: true, value: { repo: entry.repo, path: directory, url, branch: null } })
  }

  /** Unregister a repository. */
  const configRemoveHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
    if (repo === '') {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'body.repo is required' })
      return
    }
    const outcome = mutateConfig(current, (draft) => {
      const before = draft.repos.length
      draft.repos = draft.repos.filter((candidate) => candidate.repo !== repo)
      if (draft.repos.length === before) return { ok: false, message: `not registered: ${repo}` }
      return { ok: true, owner: draft.owner, repos: draft.repos }
    })
    if (!outcome.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: outcome.message })
      return
    }
    writeJson(res, 200, { ok: true, value: { repo, registered: outcome.count, file: current.configFile } })
  }

  /* ------------------------------------------- Bilibili update notes -- */

  /*
   * The third channel, and the only one that is not a package: the comment under
   * the video that introduces the plugin.
   *
   * The shape of the feature follows from two facts that were measured, not
   * assumed, and both of them are the reason this is not simply "POST a comment
   * when the release workflow succeeds":
   *
   *   - A comment is a WEB API, so the credential has to be a web session. The
   *     `cookies.json` biliup writes here is a `BiliTV` login: alive, and refused
   *     by every web member endpoint with `-101`. So the credential is never
   *     trusted because a file exists — it is asked, and the answer is shown.
   *   - A release workflow creates a DRAFT. A draft is invisible to everybody but
   *     the author, so announcing it would post "this is out" about something
   *     nobody can download. Only a published release counts, and the console's own
   *     【公开草稿】 button is what makes one.
   *
   * Everything here is idempotent by `(repo, tag)`: the ledger is written before
   * the panel is told anything, a ledger that cannot be read blocks the post
   * instead of duplicating it, and binding a video seeds a baseline so the version
   * that was already public when it was bound is never announced.
   */

  /** The directory the plugin owns: wherever the managed repository list lives. */
  const stateDirectory = () => dirname(resolveConfigFilePath(config))

  const credentialPath = () => join(stateDirectory(), BILIBILI_CREDENTIAL_FILE_NAME)
  const ledgerPath = () => join(stateDirectory(), BILIBILI_LEDGER_FILE_NAME)

  /** Write JSON through a temporary file, keeping the previous revision beside it. */
  const writeJsonAtomic = (file, value) => {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      try {
        writeFileSync(`${file}.bak`, readFileSync(file))
      } catch {
        /* a missing backup must not block the write */
      }
    }
    const temporary = `${file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  }

  /**
   * The credential this request would use, and where it came from.
   *
   * The file the panel's sign-in wrote always wins over a configured external
   * path: someone who just completed a sign-in in this panel means it, and a
   * path left in the patch from an earlier experiment must not shadow it.
   */
  const readCredential = () => {
    const current = live()
    const ownPath = credentialPath()
    const configuredPath = current.bilibiliCookieFile
    const ownExists = existsSync(ownPath)
    const path = ownExists ? ownPath : (configuredPath !== '' && existsSync(configuredPath) ? configuredPath : '')
    const source = ownExists ? 'plugin' : 'configured'
    if (path === '') {
      return {
        jar: {
          ok: false,
          /* Not "unreadable": there is simply nothing configured yet, which is where
             every install starts and is a setup step rather than a fault. */
          absent: true,
          cookies: {},
          sessdata: '',
          csrf: '',
          uid: '',
          platform: '',
          expiresAt: null,
          message: '还没有 B 站凭据：用面板里的【登录 B 站】，或粘贴浏览器里的 SESSDATA + bili_jct。',
        },
        source: 'none',
        path: '',
        ownPath,
        configuredPath,
      }
    }
    let raw = ''
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      return {
        jar: {
          ok: false,
          cookies: {},
          sessdata: '',
          csrf: '',
          uid: '',
          platform: '',
          expiresAt: null,
          message: `读不到 ${path}：${String(error?.message ?? error)}`,
        },
        source,
        path,
        ownPath,
        configuredPath,
      }
    }
    return { jar: parseCookieJar(raw), source, path, ownPath, configuredPath }
  }

  /** The Bilibili transport, with the test seam the route tests drive. */
  const bilibiliClient = () => createBilibiliClient({
    fetchImpl: typeof config.bilibiliFetch === 'function' ? config.bilibiliFetch : globalThis.fetch,
    timeoutMs: Math.min(live().requestTimeoutMs, 20_000),
  })

  /** The last account answer, so a panel that polls does not poll Bilibili. */
  let credentialCache = null

  /** BV id to resolved video, reused for the same reason. */
  const videoCache = new Map()

  /**
   * Ask Bilibili who this credential belongs to, reusing a recent answer.
   *
   * The account endpoint is the whole point: it is the one call that separates
   * "there is a SESSDATA line in a file" from "this is a web session that may
   * comment". A `-101` is an answer, not an error, and it is reported with the
   * platform it came from.
   */
  const verifyCredential = async ({ force = false } = {}) => {
    const current = live()
    const found = readCredential()
    if (found.jar.ok !== true) return { account: null, credential: found }
    const fresh = credentialCache !== null
      && credentialCache.path === found.path
      && Date.now() - credentialCache.at < current.bilibiliVerifyTtlMs
    if (fresh && force !== true) return { account: credentialCache.account, credential: found }
    const account = await bilibiliClient().readAccount(cookieHeader(found.jar.cookies))
    credentialCache = { at: Date.now(), path: found.path, account }
    return { account, credential: found }
  }

  /** Resolve one bound video to its `aid`, reusing a recent answer. */
  const resolveVideoCached = async (bvid, { force = false } = {}) => {
    const current = live()
    const found = readCredential()
    const key = `${bvid}|${found.path}`
    const cached = videoCache.get(key)
    if (force !== true && cached !== undefined && Date.now() - cached.at < current.bilibiliVerifyTtlMs) return cached.value
    const value = await bilibiliClient().resolveVideo(cookieHeader(found.jar.cookies), bvid)
    videoCache.set(key, { at: Date.now(), value })
    return value
  }

  /**
   * The announcement ledger.
   *
   * An unreadable file is reported, never replaced. Treating it as empty is the
   * one failure that would be worse than not posting at all: every comment this
   * plugin has ever written would be written again on the next sweep.
   */
  const readLedgerFile = () => {
    const file = ledgerPath()
    if (!existsSync(file)) return { ledger: emptyLedger(), problem: null, file }
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      return { ledger: emptyLedger(), problem: `读不到 ${file}：${String(error?.message ?? error)}`, file }
    }
    const parsed = parseLedger(raw)
    return parsed.ok === true
      ? { ledger: parsed.ledger, problem: null, file }
      : { ledger: emptyLedger(), problem: `${file}：${parsed.message}`, file }
  }

  /** Append one ledger entry, bounded in size. */
  const appendLedger = (entry) => {
    const read = readLedgerFile()
    const next = recordLedgerEntry(read.ledger, entry, { maxEntries: BILIBILI_MAX_LEDGER_ENTRIES })
    try {
      writeJsonAtomic(read.file, next)
      return { ok: true, file: read.file }
    } catch (error) {
      return { ok: false, message: `写不进 ${read.file}：${String(error?.message ?? error)}` }
    }
  }

  /**
   * Whether a comment Bilibili ACCEPTED can actually be read back.
   *
   * `code: 0` and an rpid mean the comment was taken, not that a reader can see it. Two
   * of these comments were recorded as announced and then answered `12006 没有该评论`
   * when looked up — a post that no one can find, filed as a success.
   *
   * Measured, so the waiting is not superstition: a freshly posted comment answers
   * `12006` immediately and reads back from about four seconds. A single immediate check
   * would therefore report a perfectly good comment as invisible, which is worse than not
   * checking at all — so it asks, waits, and asks again.
   *
   * @returns {Promise<{visible: boolean, attempts: number, code: number|null, message: string}>}
   */
  const verifyVisible = async (cookie, aid, rpid, options = {}) => {
    const client = bilibiliClient()
    return await confirmVisible({
      read: (video, comment) => client.readComment(cookie, video, comment),
      aid,
      rpid,
      ...options,
    })
  }

  /** The comment one release would produce, in the configured template. */
  const composeForEntry = (current, entry, release, commits = null) => composeComment({
    label: entry.label !== '' ? entry.label : entry.repo,
    repo: entry.repo,
    tag: typeof release?.tag === 'string' ? release.tag : '',
    release,
    commits,
    template: current.bilibiliTemplate,
    date: new Date().toISOString().slice(0, 10),
  })

  /**
   * What changed between the previous release and this one.
   *
   * The release itself cannot answer this for these repositories: their bodies are
   * exactly `**Full Changelog**: <url>`, because the release workflow creates them with
   * no notes. So the changes are read from the history GitHub already has — one compare
   * call between the two tags — which is also the only source that is true rather than
   * retyped.
   *
   * Best effort by design: an unreadable range is not a reason to hold back a comment
   * that the release itself can still describe, so every failure answers with no commits
   * and the composition falls back the way it always did.
   *
   * @returns {Promise<object[]>} compare entries, or an empty array.
   */
  const readReleaseChanges = async (current, entry, release) => {
    const slug = resolveSlug(current.owner, entry.repo)
    const tag = typeof release?.tag === 'string' ? release.tag : ''
    if (slug === null || tag === '') return []
    const list = await ghJson(ghPath, ['api', `repos/${slug}/releases?per_page=30`], current.requestTimeoutMs)
    if (list.ok !== true || !Array.isArray(list.value)) return []
    const published = list.value
      .filter((item) => item !== null && typeof item === 'object' && item.draft !== true && typeof item.tag_name === 'string')
      /* Newest first, sorted here rather than trusted: the API happens to return that
         order, and the "previous release" this picks must not depend on a habit. */
      .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))
    const at = published.findIndex((item) => item.tag_name === tag)
    const previous = at >= 0 ? published[at + 1] : undefined
    if (previous === undefined) return []
    const compare = await ghJson(ghPath, ['api', `repos/${slug}/compare/${previous.tag_name}...${tag}`], current.requestTimeoutMs)
    if (compare.ok !== true) return []
    return Array.isArray(compare.value?.commits) ? compare.value.commits : []
  }

  /**
   * Post one release's update note, and record what happened either way.
   *
   * The order is deliberate: credential, then the video, then the ledger write,
   * then — and only then — the answer the panel shows. A comment that exists on
   * Bilibili but not in the ledger is the one state this feature cannot recover
   * from, so the ledger is the record, not a cache of one.
   */
  const announceEntry = async ({ current, entry, release, text = '', trigger = 'auto' }) => {
    const binding = entry.bilibili
    if (binding === null || binding === undefined) {
      return { ok: false, code: 'unbound', message: '这个仓库还没有绑定 B 站视频。', value: { repo: entry.repo } }
    }
    const read = readLedgerFile()
    if (read.problem !== null) {
      return {
        ok: false,
        code: 'ledger-unreadable',
        message: `播报记录读不出来，为避免重复刷评论，这次没有发送：${read.problem}`,
        value: { repo: entry.repo, ledger: read.file },
      }
    }
    const { account, credential } = await verifyCredential()
    const verdict = credentialVerdict({ jar: credential.jar, account })
    if (verdict.state !== 'ready') {
      return { ok: false, code: `credential-${verdict.state}`, message: verdict.message, value: { repo: entry.repo, path: credential.path } }
    }
    const video = await resolveVideoCached(binding.bvid, { force: true })
    if (video.ok !== true || video.aid === null) {
      return {
        ok: false,
        code: 'video-unreadable',
        message: `读不到视频 ${binding.bvid}：${video.message === '' ? 'B 站没有回答' : video.message}`,
        value: { repo: entry.repo, bvid: binding.bvid },
      }
    }
    const composed = composeForEntry(current, entry, release, await readReleaseChanges(current, entry, release))
    const message = (text !== '' ? text : composed.text).trim()
    if (message === '') {
      return { ok: false, code: 'empty-comment', message: '评论内容是空的，没有发送。', value: { repo: entry.repo, tag: release.tag } }
    }

    const client = bilibiliClient()
    /*
     * A device id is what a browser sends, and its absence is one of the things
     * that earns a `-412`. Best effort on purpose: a failed fingerprint call is
     * not a reason to hold back a comment that is otherwise ready.
     */
    const fingerprint = await client.fingerPrint().catch(() => ({ buvid3: '', buvid4: '' }))
    /* Both device ids, and the credential's own value wins — see `withDeviceIds`. */
    const cookies = withDeviceIds(credential.jar.cookies, fingerprint)

    const posted = await client.postComment({
      cookie: cookieHeader(cookies),
      csrf: credential.jar.csrf,
      aid: video.aid,
      bvid: binding.bvid,
      message,
    })
    /* Accepted is not the same as readable. Ask, wait, ask again — see `verifyVisible`. */
    const verified = posted.ok === true && posted.rpid !== null
      ? await verifyVisible(cookieHeader(cookies), video.aid, posted.rpid)
      : null
    const previous = findLedgerEntry(read.ledger, entry.repo, release.tag)
    const attempts = (Number.isFinite(previous?.attempts) ? Number(previous.attempts) : 0) + (posted.ok === true ? 0 : 1)
    const record = {
      repo: entry.repo,
      tag: release.tag,
      bvid: binding.bvid,
      at: new Date().toISOString(),
      state: posted.ok === true ? 'announced' : 'failed',
      trigger,
      attempts,
      text: message,
      rpid: posted.ok === true ? posted.rpid : null,
      code: posted.code,
      message: posted.message,
      failure: posted.ok === true ? null : posted.failure.kind,
      url: posted.ok === true && posted.rpid !== null ? `https://www.bilibili.com/video/${binding.bvid}/#reply${posted.rpid}` : null,
      /*
       * Whether a reader can find it, which is the fact the panel has been asserting
       * without knowing. `null` means the question was never asked (the post failed), and
       * an absent field means the same for entries written before this existed.
       */
      visible: verified === null ? null : verified.visible === true,
      visibleCode: verified === null ? null : verified.code,
    }
    const stored = appendLedger(record)
    if (posted.ok !== true) {
      return {
        ok: false,
        code: `reply-${posted.failure.kind}`,
        message: `${posted.failure.advice}（B 站原话：${posted.message === '' ? String(posted.code) : posted.message}）`,
        value: { repo: entry.repo, tag: release.tag, bvid: binding.bvid, attempts, ledgerWritten: stored.ok === true },
      }
    }
    return {
      ok: true,
      value: {
        repo: entry.repo,
        tag: release.tag,
        bvid: binding.bvid,
        rpid: posted.rpid,
        url: record.url,
        text: message,
        account: account?.uname ?? '',
        video: video.title,
        trigger,
        visible: record.visible,
        /* Said in the answer rather than buried in the ledger: the panel has to be able
           to tell "posted" from "posted and findable". */
        note: record.visible === true
          ? ''
          : `已发送，但公开列表里读不到（B 站说：${String(verified?.message ?? '') === '' ? String(verified?.code ?? '') : String(verified?.message ?? '')}）——可能还在审核，也可能已被移除。可以稍后用【仍然发送】重发。`,
      },
    }
  }

  /**
   * Look for a release that has not been announced yet, and announce it.
   *
   * This is the half that makes the feature "automatic": a release published from
   * the console, from another machine, or by hand on GitHub's website all arrive
   * here, because what is watched is the release list and not the button that was
   * pressed. The credential is checked once for the whole sweep — a broken
   * credential is not a per-repository failure, and burning the retry budget of
   * every repository on it would hide the real reason.
   */
  let sweepRunning = false
  let lastSweep = null

  const sweepBilibili = async (reason) => {
    const current = live()
    if (!current.enabled || !current.bilibiliEnabled || !current.bilibiliAuto) return
    if (sweepRunning) return
    const bound = current.repos.filter((entry) => entry.bilibili !== null && entry.bilibili.bvid !== '' && entry.bilibili.auto !== false)
    if (bound.length === 0) return
    sweepRunning = true
    const results = []
    try {
      const { account, credential } = await verifyCredential()
      const state = credentialVerdict({ jar: credential.jar, account })
      if (state.state !== 'ready') {
        results.push({ repo: '', tag: null, state: `credential-${state.state}`, message: state.message })
        return
      }
      for (const entry of bound) {
        const slug = resolveSlug(current.owner, entry.repo)
        if (slug === null) {
          results.push({ repo: entry.repo, tag: null, state: 'no-slug', message: 'set `owner` or write the entry as "owner/repo"' })
          continue
        }
        const releasesResult = await ghJson(ghPath, ['api', `repos/${slug}/releases?per_page=10`], current.requestTimeoutMs)
        if (!releasesResult.ok) {
          results.push({ repo: entry.repo, tag: null, state: 'gh-failed', message: releasesResult.message })
          continue
        }
        const releases = (Array.isArray(releasesResult.value) ? releasesResult.value : [])
          .map(normalizeRelease)
          .filter((release) => release !== null)
        const release = newestPublishedRelease(releases)
        const read = readLedgerFile()
        const verdict = announcementVerdict({
          binding: { repo: entry.repo, bvid: entry.bilibili.bvid },
          release,
          ledger: read.ledger,
        })
        if (verdict.state !== 'ready') {
          results.push({ repo: entry.repo, tag: release?.tag ?? null, state: verdict.state, message: verdict.message })
          continue
        }
        const outcome = await announceEntry({ current, entry, release, trigger: 'auto' })
        results.push({
          repo: entry.repo,
          tag: release.tag,
          state: outcome.ok === true ? 'announced' : 'failed',
          message: outcome.ok === true ? '' : outcome.message,
          url: outcome.ok === true ? outcome.value.url : null,
        })
      }
    } catch (error) {
      results.push({ repo: '', tag: null, state: 'sweep-failed', message: String(error?.message ?? error) })
    } finally {
      sweepRunning = false
      lastSweep = { at: new Date().toISOString(), reason, results }
    }
  }

  /* ------------------------------------------------------ sign-in, panel -- */

  /** The one in-flight Bilibili sign-in, if any. */
  let biliLogin = null

  const loginSnapshot = () => biliLogin === null
    ? { state: 'idle', url: '', startedAt: null, expiresAt: null, scanned: false, message: '' }
    : {
        state: biliLogin.state,
        url: biliLogin.url,
        startedAt: biliLogin.startedAt,
        expiresAt: biliLogin.expiresAt,
        scanned: biliLogin.scanned === true,
        message: biliLogin.message,
      }

  /** Store a credential this plugin owns, in its own file. */
  const storeCredential = (cookies, source, account) => {
    writeJsonAtomic(credentialPath(), {
      version: 1,
      source,
      savedAt: new Date().toISOString(),
      account: account ?? null,
      cookies,
    })
    credentialCache = null
  }

  /* --------------------------------------------------------------- routes -- */

  /**
   * The credential, the bindings, and what has already been said.
   *
   * Deliberately free of GitHub calls: the panel asks for this on open and on
   * refresh, and "which version is next" is answered by the overview it already
   * has. The two Bilibili calls it may make are cached (`bilibiliVerifyTtlMs`),
   * so a panel left open is not a poll of Bilibili.
   */
  const bilibiliStatusHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const force = body?.force === true
    const found = readCredential()
    const account = found.jar.ok === true ? (await verifyCredential({ force })).account : null
    const verdict = credentialVerdict({ jar: found.jar, account })
    const read = readLedgerFile()

    const repos = []
    for (const entry of current.repos) {
      const binding = entry.bilibili
      const mine = read.ledger.entries.filter((candidate) => candidate.repo === entry.repo)
      const baseline = latestBaseline(read.ledger, entry.repo)
      const base = {
        repo: entry.repo,
        label: entry.label !== '' ? entry.label : entry.repo,
        binding: binding === null ? null : { bvid: binding.bvid, auto: binding.auto !== false },
        announced: mine
          .filter((candidate) => candidate.state === 'announced')
          .map((candidate) => ({ tag: candidate.tag, at: candidate.at, url: candidate.url ?? null, rpid: candidate.rpid ?? null, text: candidate.text ?? '', trigger: candidate.trigger ?? '' })),
        failures: mine
          .filter((candidate) => candidate.state === 'failed')
          .map((candidate) => ({ tag: candidate.tag, at: candidate.at, attempts: candidate.attempts ?? 0, failure: candidate.failure ?? null, message: candidate.message ?? '' })),
        baseline: baseline === null ? null : { tag: baseline.tag ?? null, at: baseline.at ?? null },
        video: null,
        commentUrl: binding === null ? null : `https://www.bilibili.com/video/${binding.bvid}/`,
      }
      if (binding !== null) {
        const video = await resolveVideoCached(binding.bvid, { force })
        base.video = video.ok === true
          ? { ok: true, aid: video.aid, title: video.title, owner: video.owner }
          : { ok: false, code: video.code, message: video.message }
      }
      repos.push(base)
    }

    writeJson(res, 200, {
      ok: true,
      value: {
        enabled: current.bilibiliEnabled,
        auto: current.bilibiliAuto,
        watchSeconds: current.bilibiliWatchSeconds,
        template: current.bilibiliTemplate,
        credential: {
          ...verdict,
          source: found.source,
          path: found.path,
          ownPath: found.ownPath,
          configuredPath: found.configuredPath,
          platform: found.jar.platform,
          expiresAt: found.jar.expiresAt,
          hasSession: found.jar.sessdata !== '',
          hasCsrf: found.jar.csrf !== '',
        },
        login: loginSnapshot(),
        ledger: { file: read.file, problem: read.problem, entries: read.ledger.entries.length },
        lastSweep,
        repos,
      },
    })
  }

  const bilibiliLoginStartHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    const started = await bilibiliClient().startQrLogin()
    if (started.ok !== true) {
      writeJson(res, 502, { ok: false, code: 'login-start-failed', message: `B 站没有给出登录二维码：${started.message}` })
      return
    }
    biliLogin = {
      key: started.key,
      url: started.url,
      state: 'waiting',
      message: '',
      scanned: false,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + BILIBILI_LOGIN_TTL_MS).toISOString(),
    }
    writeJson(res, 202, { ok: true, value: loginSnapshot() })
  }

  const bilibiliLoginPollHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    if (biliLogin === null) {
      writeJson(res, 409, { ok: false, code: 'no-login', message: '没有正在进行的 B 站登录。' })
      return
    }
    if (Date.now() > Date.parse(biliLogin.expiresAt)) {
      biliLogin = null
      writeJson(res, 200, { ok: true, value: { ...loginSnapshot(), state: 'expired', message: '二维码已过期，请重新开始。' } })
      return
    }
    const polled = await bilibiliClient().pollQrLogin(biliLogin.key)
    if (polled.ok === true && polled.state === 'waiting') {
      writeJson(res, 200, { ok: true, value: loginSnapshot() })
      return
    }
    if (polled.ok === true && polled.state === 'scanned') {
      biliLogin.state = 'scanned'
      biliLogin.scanned = true
      writeJson(res, 200, { ok: true, value: loginSnapshot() })
      return
    }
    if (polled.ok !== true || polled.state !== 'succeeded') {
      biliLogin.state = 'failed'
      biliLogin.message = polled.message
      const value = loginSnapshot()
      biliLogin = null
      writeJson(res, 502, { ok: false, code: 'login-failed', message: polled.message === '' ? 'B 站登录没有完成。' : polled.message, value })
      return
    }
    const jar = parseCookieJar({ cookies: polled.cookies })
    if (jar.ok !== true || jar.sessdata === '' || jar.csrf === '') {
      biliLogin = null
      writeJson(res, 502, {
        ok: false,
        code: 'login-incomplete',
        message: `B 站回了成功，但下发的 Cookie 里缺 ${jar.sessdata === '' ? 'SESSDATA' : 'bili_jct'}，请重新登录。`,
        value: loginSnapshot(),
      })
      return
    }
    /*
     * The QR flow is authoritative — Bilibili itself handed these cookies over —
     * so the credential is stored even when the account read fails, and the
     * failure is reported rather than turned into a refused sign-in.
     */
    const account = await bilibiliClient().readAccount(cookieHeader(jar.cookies))
    let stored = { ok: true }
    try {
      storeCredential(jar.cookies, 'qr-login', account.ok === true ? { mid: account.mid, uname: account.uname } : null)
    } catch (error) {
      stored = { ok: false, message: String(error?.message ?? error) }
    }
    biliLogin = null
    if (stored.ok !== true) {
      writeJson(res, 502, { ok: false, code: 'write-failed', message: `登录成功但凭据没有落盘：${stored.message}` })
      return
    }
    writeJson(res, 200, {
      ok: true,
      value: {
        state: 'succeeded',
        scanned: true,
        url: '',
        startedAt: null,
        expiresAt: null,
        message: '',
        account: account.ok === true ? { mid: account.mid, uname: account.uname } : null,
        accountProblem: account.ok === true ? null : account.message,
        path: credentialPath(),
      },
    })
  }

  const bilibiliLoginCancelHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    biliLogin = null
    writeJson(res, 200, { ok: true, value: loginSnapshot() })
  }

  /**
   * Store a pasted credential.
   *
   * Refused unless Bilibili accepts it right now. Writing a jar that has already
   * been answered with `-101` would leave the panel saying "已登录" about a
   * credential that cannot post, which is worse than saying nothing.
   */
  const bilibiliCredentialHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const sessdata = text(body?.sessdata)
    const csrf = text(body?.bili_jct)
    const raw = sessdata !== '' || csrf !== ''
      ? { SESSDATA: sessdata, bili_jct: csrf, DedeUserID: text(body?.dedeUserId) }
      : text(body?.cookie)
    const jar = parseCookieJar(raw)
    if (jar.ok !== true || jar.sessdata === '' || jar.csrf === '') {
      writeJson(res, 400, { ok: false, code: 'incomplete-credential', message: credentialVerdict({ jar }).message })
      return
    }
    const account = await bilibiliClient().readAccount(cookieHeader(jar.cookies))
    const verdict = credentialVerdict({ jar, account })
    if (verdict.state !== 'ready') {
      writeJson(res, 401, {
        ok: false,
        code: `credential-${verdict.state}`,
        message: verdict.message,
        value: { bilibiliCode: account.code, bilibiliMessage: account.message, platform: jar.platform },
      })
      return
    }
    try {
      storeCredential(jar.cookies, 'paste', verdict.account)
    } catch (error) {
      writeJson(res, 502, { ok: false, code: 'write-failed', message: `凭据没有落盘：${String(error?.message ?? error)}` })
      return
    }
    writeJson(res, 200, { ok: true, value: { account: verdict.account, path: credentialPath(), platform: jar.platform } })
  }

  /**
   * Forget the credential this plugin stored.
   *
   * Only its own file is deleted. A configured external file belongs to whatever
   * wrote it — biliup, in the case this machine has — and deleting it would break
   * an unrelated tool. When a fallback takes over, the answer says so instead of
   * reporting a sign-out that did not happen.
   */
  const bilibiliLogoutHandler = async (req, res) => {
    if (!guard(req, res)) return
    await readJsonBody(req)
    const own = credentialPath()
    let removed = false
    if (existsSync(own)) {
      try {
        unlinkSync(own)
        removed = true
      } catch (error) {
        writeJson(res, 502, { ok: false, code: 'delete-failed', message: `删不掉 ${own}：${String(error?.message ?? error)}` })
        return
      }
    }
    credentialCache = null
    videoCache.clear()
    const after = readCredential()
    writeJson(res, 200, {
      ok: true,
      value: {
        removed,
        path: own,
        stillAvailable: after.path === '' ? null : { source: after.source, path: after.path },
      },
    })
  }

  /**
   * Bind a repository to the comment section of one video.
   *
   * Binding seeds a baseline: the version already public at that moment is
   * marked as "not this update", so wiring a video up can never fire a comment
   * about a release that went out months ago. Unbinding keeps the history —
   * what was said in public is not erased by a configuration change.
   */
  const bilibiliBindHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const target = findEntry(current, body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const requested = typeof body?.bvid === 'string' ? body.bvid.trim() : ''
    const normalized = requested === '' ? null : normalizeBinding({ bvid: requested, auto: body?.auto !== false })
    if (requested !== '' && normalized === null) {
      writeJson(res, 400, { ok: false, code: 'bad-bvid', message: `不像是 BV 号：${JSON.stringify(requested)}（形如 BV1RopP6FEJp）` })
      return
    }
    const bvid = normalized?.bvid ?? ''
    const auto = normalized?.auto !== false
    const outcome = mutateConfig(current, (draft) => {
      const index = draft.repos.findIndex((candidate) => candidate.repo === target.entry.repo)
      if (index === -1) return { ok: false, message: `not registered: ${target.entry.repo}` }
      const previous = draft.repos[index]
      draft.repos[index] = {
        repo: previous.repo,
        ...(previous.localPath !== '' ? { localPath: previous.localPath } : {}),
        ...(previous.label !== '' ? { label: previous.label } : {}),
        ...(bvid === '' ? {} : { bilibili: { bvid, auto } }),
      }
      return { ok: true, owner: draft.owner, repos: draft.repos }
    })
    if (outcome.ok !== true) {
      writeJson(res, 502, { ok: false, code: 'config-failed', message: outcome.message })
      return
    }
    if (bvid === '') {
      writeJson(res, 200, { ok: true, value: { repo: target.entry.repo, bvid: '', video: null, baseline: null, file: current.configFile } })
      return
    }

    const video = await resolveVideoCached(bvid, { force: true })
    const slug = resolveSlug(current.owner, target.entry.repo)
    let baselineTag = null
    let note = ''
    if (slug === null) {
      note = '这个仓库没有 owner，读不到 Release 列表，所以把绑定时刻之前发布的版本都视为已公开。'
    } else {
      const releasesResult = await ghJson(ghPath, ['api', `repos/${slug}/releases?per_page=10`], current.requestTimeoutMs)
      if (releasesResult.ok) {
        const releases = (Array.isArray(releasesResult.value) ? releasesResult.value : [])
          .map(normalizeRelease)
          .filter((release) => release !== null)
        baselineTag = newestPublishedRelease(releases)?.tag ?? null
      } else {
        note = `读不到 Release 列表（${releasesResult.message}），所以把绑定时刻之前发布的版本都视为已公开。`
      }
    }
    appendLedger({
      repo: target.entry.repo,
      tag: baselineTag,
      bvid,
      at: new Date().toISOString(),
      state: 'baseline',
      trigger: 'bind',
      attempts: 0,
      text: '',
      rpid: null,
      code: null,
      message: '',
      failure: null,
      url: null,
    })
    cache = null
    writeJson(res, 200, {
      ok: true,
      value: {
        repo: target.entry.repo,
        bvid,
        auto,
        video: video.ok === true ? { ok: true, title: video.title, owner: video.owner, aid: video.aid } : { ok: false, code: video.code, message: video.message },
        baseline: baselineTag,
        note,
        file: current.configFile,
      },
    })
  }

  /**
   * Compose (and, unless asked not to, post) one repository's update note.
   *
   * `dryRun` exists because posting is public and irreversible in the way that
   * matters: the panel shows the exact sentence, and the sentence it shows is the
   * sentence the Host would send — composed here, not by the browser, so a
   * template change cannot be previewed one way and posted another.
   */
  const bilibiliAnnounceHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const current = live()
    const target = findEntry(current, body)
    if (!target.ok) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: target.message })
      return
    }
    const binding = target.entry.bilibili
    if (binding === null) {
      writeJson(res, 409, {
        ok: false,
        code: 'unbound',
        message: `${target.entry.repo} 还没有绑定 B 站视频。`,
        value: { repo: target.entry.repo },
      })
      return
    }
    const slug = resolveSlug(current.owner, target.entry.repo)
    if (slug === null) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: 'set `owner` in the config, or write the entry as "owner/repo"' })
      return
    }
    const releasesResult = await ghJson(ghPath, ['api', `repos/${slug}/releases?per_page=10`], current.requestTimeoutMs)
    if (!releasesResult.ok) {
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: releasesResult.message })
      return
    }
    const releases = (Array.isArray(releasesResult.value) ? releasesResult.value : [])
      .map(normalizeRelease)
      .filter((release) => release !== null)
    const wantedTag = text(body?.tag)
    const release = wantedTag === ''
      ? newestPublishedRelease(releases)
      : releases.find((candidate) => candidate.tag === wantedTag) ?? null
    const force = body?.force === true
    const read = readLedgerFile()
    const verdict = announcementVerdict({
      binding: { repo: target.entry.repo, bvid: binding.bvid },
      release,
      ledger: read.ledger,
      force,
    })
    /* The preview and the post read the same changes, so the sentence the panel shows is
       the sentence that goes out — including the commit list. */
    const composed = release === null
      ? null
      : composeForEntry(current, target.entry, release, await readReleaseChanges(current, target.entry, release))

    if (body?.dryRun === true) {
      writeJson(res, 200, {
        ok: true,
        value: {
          repo: target.entry.repo,
          bvid: binding.bvid,
          tag: release?.tag ?? null,
          state: verdict.state,
          message: verdict.message,
          text: composed?.text ?? '',
          summary: composed?.summary ?? '',
          unknown: composed?.unknown ?? [],
          release: release === null ? null : { tag: release.tag, name: release.name, url: release.url, createdAt: release.createdAt },
          ledgerProblem: read.problem,
          attempts: verdict.attempts,
        },
      })
      return
    }
    if (verdict.state !== 'ready') {
      writeJson(res, 409, {
        ok: false,
        code: `announce-${verdict.state}`,
        message: verdict.message,
        value: { repo: target.entry.repo, tag: release?.tag ?? null, text: composed?.text ?? '', state: verdict.state },
      })
      return
    }
    const outcome = await announceEntry({ current, entry: target.entry, release, text: text(body?.text), trigger: 'manual' })
    if (outcome.ok !== true) {
      const status = outcome.code.startsWith('credential-') ? 401 : outcome.code === 'unbound' ? 409 : outcome.code === 'ledger-unreadable' ? 500 : 502
      writeJson(res, status, { ok: false, code: outcome.code, message: outcome.message, value: outcome.value ?? null })
      return
    }
    writeJson(res, 200, { ok: true, value: outcome.value })
  }

  const routes = [
    [`${ROUTE_PREFIX}/status`, statusHandler],
    [`${ROUTE_PREFIX}/overview`, overviewHandler],
    [`${ROUTE_PREFIX}/runs`, runsHandler],
    [`${ROUTE_PREFIX}/dispatch`, dispatchHandler],
    [`${ROUTE_PREFIX}/run-action`, runActionHandler],
    [`${ROUTE_PREFIX}/release-action`, releaseActionHandler],
    [`${ROUTE_PREFIX}/version-bump`, versionBumpHandler],
    // The step before 构建 and 发布: a release builds the pushed commit, so the console
    // that can cut a release should be able to get the work to GitHub in the first place.
    [`${ROUTE_PREFIX}/commit`, commitHandler],
    [`${ROUTE_PREFIX}/logs`, logsHandler],
    // Taking the release, not just cutting it: the artifact is fetched and handed
    // to the Host's own plugin manager, and the restart is left to the plugin that
    // owns restarting.
    [`${ROUTE_PREFIX}/update`, updateHandler],
    [`${ROUTE_PREFIX}/restart`, restartHandler],
    // One package, two channels: the GitHub Release above, and npm below it. The npm
    // state is asked for on demand and the push is its own button, because a publish
    // cannot be undone and must not ride along with a release.
    [`${ROUTE_PREFIX}/npm-status`, npmStatusHandler],
    [`${ROUTE_PREFIX}/npm-login`, npmLoginHandler],
    [`${ROUTE_PREFIX}/npm-publish`, npmPublishHandler],
    [`${ROUTE_PREFIX}/auth-start`, authStartHandler],
    [`${ROUTE_PREFIX}/auth-state`, authStateHandler],
    [`${ROUTE_PREFIX}/auth-cancel`, authCancelHandler],
    [`${ROUTE_PREFIX}/auth-logout`, authLogoutHandler],
    [`${ROUTE_PREFIX}/repos-available`, reposAvailableHandler],
    // A registered repository with no working tree cannot be released from here, so the
    // console can fetch one: the address is derivable, and the destination is the root
    // the rest of the panel already looks in.
    [`${ROUTE_PREFIX}/clone`, cloneHandler],
    [`${ROUTE_PREFIX}/config-add`, configAddHandler],
    [`${ROUTE_PREFIX}/config-remove`, configRemoveHandler],
    // The third channel: an update note under the video that introduces the
    // plugin. Credential first (the panel can sign in without a terminal), then
    // the binding, then the comment — and the ledger behind all of it, so the
    // same release is never announced twice.
    [`${ROUTE_PREFIX}/bilibili-status`, bilibiliStatusHandler],
    [`${ROUTE_PREFIX}/bilibili-login-start`, bilibiliLoginStartHandler],
    [`${ROUTE_PREFIX}/bilibili-login-poll`, bilibiliLoginPollHandler],
    [`${ROUTE_PREFIX}/bilibili-login-cancel`, bilibiliLoginCancelHandler],
    [`${ROUTE_PREFIX}/bilibili-credential`, bilibiliCredentialHandler],
    [`${ROUTE_PREFIX}/bilibili-logout`, bilibiliLogoutHandler],
    [`${ROUTE_PREFIX}/bilibili-bind`, bilibiliBindHandler],
    [`${ROUTE_PREFIX}/bilibili-announce`, bilibiliAnnounceHandler],
  ]
  // A sign-in child polls GitHub for up to ten minutes; it must not outlive the
  // plugin that owns it.
  if (typeof ctx.effect === 'function') ctx.effect(() => stopAuth, 'dsh-plugin-cicd: sign-in child')
  for (const [path, handler] of routes) {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, `dsh-plugin-cicd: ${path}`)
  }
  const startup = live()
  /*
   * The sweep's triggers.
   *
   * The timer is what makes the feature work while nobody is looking, and it is
   * configurable because it is not free: one `gh api` call per bound repository
   * per tick, which is the same shape the panel already produces when it is open.
   * Setting `bilibiliWatchSeconds: 0` leaves the manual button and the sweep that
   * a publish triggers, and stops the clock.
   */
  if (startup.bilibiliWatchSeconds > 0) {
    const timer = setInterval(() => {
      void sweepBilibili('timer')
    }, startup.bilibiliWatchSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer), 'dsh-plugin-cicd: bilibili sweep')
    /*
     * One sweep shortly after startup. The releases that matter most are the ones
     * published while DSH was closed — a timer that only looks forward from the
     * moment it starts would never see them.
     */
    const boot = setTimeout(() => {
      void sweepBilibili('startup')
    }, 15_000)
    if (typeof boot.unref === 'function') boot.unref()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearTimeout(boot), 'dsh-plugin-cicd: bilibili startup sweep')
  }
  if (startup.bilibiliEnabled) {
    const bound = startup.repos.filter((entry) => entry.bilibili !== null).length
    ctx.logger?.info?.(
      'dsh-plugin-cicd: bilibili notes %s (bound=%d, auto=%s, watch=%ds)',
      bound === 0 ? 'configured but no video is bound' : 'armed',
      bound,
      startup.bilibiliAuto ? 'on' : 'off',
      startup.bilibiliWatchSeconds,
    )
  }
  ctx.logger?.info?.(
    'dsh-plugin-cicd: routes mounted at %s (gh=%s, repos=%d from %s, owner=%s)',
    ROUTE_PREFIX,
    ghPath,
    startup.repos.length,
    startup.configSource,
    startup.owner === '' ? '(unset)' : startup.owner,
  )
}
