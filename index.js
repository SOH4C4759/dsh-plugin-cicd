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
 *   /api/dsh-cicd/logs             the tail of the failed steps of one run
 *
 * Every route answers `{ ok: true, value }` or `{ ok: false, code, message }`.
 *
 * @module dsh-plugin-cicd
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { connect } from 'node:net'
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
 * Wire protocol of the browser half this Host half can serve.
 *
 * The two halves do not reload together: the browser bundle is read from disk on
 * every page load, while this module is imported once per Host process. A page
 * refresh therefore produces "new client, old host", where the client calls a
 * route that does not exist yet and reports it as a request failure — which reads
 * like a GitHub or credential problem and is neither. The client compares this
 * number and says what to do instead.
 */
const PROTOCOL = 2

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
 * attempt is reported as failed.
 *
 * This is not a nicety. Measured on a machine where `github.com:443` was blocked:
 * `gh auth login --web` printed NOTHING and was still running after 20 seconds —
 * no code, no error, no exit. Without this deadline the panel waits for the full
 * fifteen-minute code lifetime saying "waiting for the code", which is both wrong
 * and useless. The deadline converts silence into a diagnosis.
 */
const AUTH_CODE_DEADLINE_MS = 15_000

/**
 * Can this process open a TCP connection to `host:port`?
 *
 * The device-code flow talks to `github.com`. Where that host is intermittently
 * blocked, `gh` does not fail fast — it hangs with no output. A short probe turns
 * a silent minute into an immediate, specific message.
 *
 * @param {string} host - hostname to probe.
 * @param {number} port - TCP port.
 * @param {number} timeoutMs - how long to wait before calling it unreachable.
 * @returns {Promise<boolean>} whether a connection was established.
 */
export async function canReach(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
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

  const [branch, status, counts] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    // `@{u}` fails when the branch has no upstream; that is reported as "unknown",
    // not as zero, because "0 ahead" and "cannot tell" mean different things here.
    git(['rev-list', '--left-right', '--count', '@{u}...HEAD']),
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
    dirty: typeof status === 'string' ? status.split('\n').filter((line) => line.trim() !== '').length : null,
    ahead,
    behind,
    upstreamKnown: ahead !== null,
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

/** Normalize one REST release record into the panel's shape. */
function normalizeRelease(release) {
  if (release === null || typeof release !== 'object') return null
  const assets = Array.isArray(release.assets) ? release.assets : []
  return {
    tag: typeof release.tag_name === 'string' ? release.tag_name : '',
    name: typeof release.name === 'string' ? release.name : '',
    draft: release.draft === true,
    prerelease: release.prerelease === true,
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
   * The configuration this request should use.
   *
   * Resolved per request so `scripts/configure.mjs add` is visible on the next
   * poll rather than at the next restart — the whole point of moving the list out
   * of the hand-edited patch.
   */
  const live = () => effectiveConfig(config)

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
    ? { state: 'idle', mode: null, code: null, url: null, message: null, startedAt: null, waitedMs: 0, stalled: false, outputBytes: 0, outputExcerpt: null }
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
      env: { ...process.env, GH_PROMPT_DISABLED: '', GH_PAGER: 'cat', NO_COLOR: '1' },
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
    const repos = settled.map((outcome, index) => {
      const entry = current.repos[index]
      if (outcome.status === 'fulfilled') return outcome.value
      return {
        repo: entry.repo,
        slug: resolveSlug(current.owner, entry.repo),
        label: entry.label !== '' ? entry.label : entry.repo,
        localPath: entry.localPath,
        problems: [String(outcome.reason?.message ?? outcome.reason)],
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
     * Answer immediately — do not hold the request open waiting for the code.
     *
     * An earlier version waited up to 8s so the first render would have the code.
     * Measured consequence: where github.com is unreachable, `gh` hangs printing
     * nothing, so the wait became a fixed 8-second delay on every single click, and
     * after it the panel still had no code and no reason. The panel now renders a
     * "requesting a code" state and polls, so nothing is gained by blocking here.
     */
    const reachable = await canReach('github.com', 443, 4000)
    if (!reachable) {
      writeJson(res, 502, {
        ok: false,
        code: 'unreachable',
        message: 'cannot open a connection to github.com:443 — the device-code flow needs it, and without it gh prints no code at all. Check the network and try again.',
      })
      return
    }
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
    [`${ROUTE_PREFIX}/logs`, logsHandler],
    [`${ROUTE_PREFIX}/auth-start`, authStartHandler],
    [`${ROUTE_PREFIX}/auth-state`, authStateHandler],
    [`${ROUTE_PREFIX}/auth-cancel`, authCancelHandler],
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
