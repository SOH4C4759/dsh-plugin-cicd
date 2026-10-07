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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  isValidRepoName,
  normalizeEntry,
  parseConfig,
  readConfig,
  writeConfig,
} from './lib/config-store.mjs'

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
 * 4: `update` and `restart`, and the `install` block on every overview row. A 3.x
 * client renders rows without it, so the two halves would still agree on the old
 * surface — but the new buttons post to routes a 3.x host does not mount, which is
 * exactly the 401-reads-as-a-credential-problem this number exists to prevent.
 */
const PROTOCOL = 4

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
      stderr: typeof error?.stderr === 'string' && error.stderr !== '' ? error.stderr : String(error?.message ?? error),
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
    return { ok: false, message: result.killed ? `gh timed out after ${timeoutMs} ms` : firstLine(result.stderr) || 'gh failed' }
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
    message: result.killed ? `gh timed out after ${timeoutMs} ms` : firstLine(result.stderr) || 'gh failed',
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

  return {
    available: true,
    branch: branch ?? null,
    head: typeof head === 'string' && head !== '' ? head : null,
    dirty: typeof status === 'string' ? status.split('\n').filter((line) => line.trim() !== '').length : null,
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
 * @param {unknown} spec - the dependency value from the profile manifest.
 * @returns {{kind: 'link'|'path'|'tarball'|'registry'|'other', path: string|null, range: string|null}}
 */
export function classifySpec(spec) {
  const value = typeof spec === 'string' ? spec.trim() : ''
  if (value === '') return { kind: 'other', path: null, range: null }
  const linked = /^link:/i.test(value)
  const filed = /^file:/i.test(value)
  const raw = value.replace(/^(?:file|link):/i, '')
  if (linked || filed || isAbsolute(raw)) {
    if (raw === '' || !isAbsolute(raw)) return { kind: 'other', path: null, range: null }
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
      writeJson(res, 502, { ok: false, code: 'git-failed', message: firstLine(staged.stderr) || 'git add failed' })
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
        message: firstLine(committed.stderr) || firstLine(committed.stdout) || 'git commit failed',
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
        message: `committed ${tag} locally, but the push failed: ${firstLine(pushed.stderr) || firstLine(pushed.stdout) || 'git push failed'}`,
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
      writeJson(res, 502, { ok: false, code: 'gh-failed', message: result.killed ? `gh timed out after ${config.requestTimeoutMs} ms` : firstLine(result.stderr) })
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
        writeJson(res, 502, { ok: false, code: 'download-failed', message: firstLine(fetched.stderr) || `gh release download failed for ${latest.asset}` })
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
      const entry = { repo, ...(localPath !== '' ? { localPath } : {}), label: '' }
      const index = draft.repos.findIndex((candidate) => candidate.repo === repo)
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

  const routes = [
    [`${ROUTE_PREFIX}/status`, statusHandler],
    [`${ROUTE_PREFIX}/overview`, overviewHandler],
    [`${ROUTE_PREFIX}/runs`, runsHandler],
    [`${ROUTE_PREFIX}/dispatch`, dispatchHandler],
    [`${ROUTE_PREFIX}/run-action`, runActionHandler],
    [`${ROUTE_PREFIX}/release-action`, releaseActionHandler],
    [`${ROUTE_PREFIX}/version-bump`, versionBumpHandler],
    [`${ROUTE_PREFIX}/logs`, logsHandler],
    // Taking the release, not just cutting it: the artifact is fetched and handed
    // to the Host's own plugin manager, and the restart is left to the plugin that
    // owns restarting.
    [`${ROUTE_PREFIX}/update`, updateHandler],
    [`${ROUTE_PREFIX}/restart`, restartHandler],
    [`${ROUTE_PREFIX}/auth-start`, authStartHandler],
    [`${ROUTE_PREFIX}/auth-state`, authStateHandler],
    [`${ROUTE_PREFIX}/auth-cancel`, authCancelHandler],
    [`${ROUTE_PREFIX}/auth-logout`, authLogoutHandler],
    [`${ROUTE_PREFIX}/repos-available`, reposAvailableHandler],
    [`${ROUTE_PREFIX}/config-add`, configAddHandler],
    [`${ROUTE_PREFIX}/config-remove`, configRemoveHandler],
  ]
  // A sign-in child polls GitHub for up to ten minutes; it must not outlive the
  // plugin that owns it.
  if (typeof ctx.effect === 'function') ctx.effect(() => stopAuth, 'dsh-plugin-cicd: sign-in child')
  for (const [path, handler] of routes) {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, `dsh-plugin-cicd: ${path}`)
  }
  const startup = live()
  ctx.logger?.info?.(
    'dsh-plugin-cicd: routes mounted at %s (gh=%s, repos=%d from %s, owner=%s)',
    ROUTE_PREFIX,
    ghPath,
    startup.repos.length,
    startup.configSource,
    startup.owner === '' ? '(unset)' : startup.owner,
  )
}
