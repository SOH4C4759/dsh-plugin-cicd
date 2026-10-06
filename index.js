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

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

/** Plugin name shown in loader logs. */
export const name = 'dsh-plugin-cicd'

/** The Web server is the only required service: it carries the routes. */
export const inject = ['webServer']

const runFile = promisify(execFile)

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
 * Both shapes are accepted because both are natural to write by hand in a patch:
 *   - `dsh-plugin-restart`
 *   - `{ repo: dsh-plugin-restart, localPath: 'F:\CodeProj\dsh-plugin-restart' }`
 *
 * @param {unknown} entry - one element of `config.repos`.
 * @returns {{repo: string, localPath: string, label: string}|null}
 */
export function normalizeRepoEntry(entry) {
  if (typeof entry === 'string') {
    const repo = entry.trim()
    return SLUG.test(repo) || SLUG_WITH_OWNER.test(repo) ? { repo, localPath: '', label: '' } : null
  }
  if (entry === null || typeof entry !== 'object') return null
  const repo = text(entry.repo ?? entry.name)
  if (!SLUG.test(repo) && !SLUG_WITH_OWNER.test(repo)) return null
  const localPath = text(entry.localPath ?? entry.path)
  return {
    repo,
    // An absolute path only: a relative one would be resolved against the Host's
    // own working directory, which is not the user's shell directory.
    localPath: localPath !== '' && isAbsolute(localPath) ? localPath : '',
    label: text(entry.label),
  }
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
  }
}

/**
 * Where `gh` is.
 *
 * The Host is a child of the desktop app, so its PATH is the user's environment,
 * not this module's developer shell. An explicit path is honoured first, then a
 * short list of the places the Windows installer actually uses — otherwise the
 * panel would report "gh not found" on a machine where `gh` works fine in a
 * terminal.
 *
 * @param {object} config - resolved config.
 * @returns {string} an absolute path, or the bare command name for PATH lookup.
 */
export function resolveGhPath(config) {
  const candidates = [
    config.ghPath,
    process.env.DSH_GH_PATH,
    process.env.DSH_GITHUB_CLI,
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'GitHub CLI', 'gh.exe'),
    join(process.env.ProgramFiles ?? '', 'GitHub CLI', 'gh.exe'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const value = candidate.trim()
    if (!isAbsolute(value)) return value
    if (existsSync(value)) return value
  }
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
  const local = await readLocalState(entry.localPath, config.requestTimeoutMs)

  return {
    ...base,
    version,
    expectedTag,
    /** A published release for the local version exists. */
    published: matching !== null && !matching.draft,
    /** A draft release for the local version exists, waiting to be published. */
    draftTag: matching !== null && matching.draft ? matching.tag : null,
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
  const findEntry = (body) => {
    const requested = typeof body?.repo === 'string' ? body.repo.trim() : ''
    if (requested === '') return { ok: false, message: 'body.repo is required' }
    const entry = config.repos.find((candidate) => candidate.repo === requested || candidate.label === requested)
    if (entry === undefined) return { ok: false, message: `repository is not configured in this row: ${requested}` }
    const slug = resolveSlug(config.owner, entry.repo)
    if (slug === null) return { ok: false, message: 'set `owner` in the row config, or write the entry as "owner/repo"' }
    return { ok: true, entry, slug }
  }

  const statusHandler = async (req, res) => {
    if (!guard(req, res)) return
    const [versionResult, accountResult] = await Promise.all([
      ghRun(ghPath, ['--version'], Math.min(config.requestTimeoutMs, 10_000)),
      // `--jq` prints a bare string, so this is not a JSON call.
      ghRun(ghPath, ['api', 'user', '--jq', '.login'], Math.min(config.requestTimeoutMs, 15_000)),
    ])
    const account = accountResult.ok ? firstLine(accountResult.stdout) : ''
    writeJson(res, 200, {
      ok: true,
      value: {
        enabled: config.enabled,
        gh: {
          path: ghPath,
          available: versionResult.ok,
          version: versionResult.ok ? firstLine(versionResult.stdout) : null,
          authenticated: account !== '',
          account: account === '' ? null : account,
          message: versionResult.ok ? null : versionResult.message,
        },
        config: {
          owner: config.owner,
          defaultBranch: config.defaultBranch,
          buildWorkflow: config.buildWorkflow,
          releaseWorkflow: config.releaseWorkflow,
          pollSeconds: config.pollSeconds,
          overviewTtlMs: config.overviewTtlMs,
        },
        repos: config.repos.map((entry) => ({ repo: entry.repo, label: entry.label !== '' ? entry.label : entry.repo, localPath: entry.localPath })),
      },
    })
  }

  const overviewHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    if (!config.enabled) {
      writeJson(res, 200, { ok: true, value: { fetchedAt: new Date().toISOString(), disabled: true, repos: [] } })
      return
    }
    if (config.repos.length === 0) {
      writeJson(res, 200, {
        ok: true,
        value: { fetchedAt: new Date().toISOString(), repos: [], unconfigured: true },
      })
      return
    }
    const fresh = cache !== null && Date.now() - cache.at < config.overviewTtlMs
    if (fresh && body?.force !== true) {
      writeJson(res, 200, { ok: true, value: { ...cache.value, cached: true } })
      return
    }

    const settled = await Promise.allSettled(
      config.repos.map((entry) => collectRepo({ config, ghPath, entry })),
    )
    const repos = settled.map((outcome, index) => {
      const entry = config.repos[index]
      if (outcome.status === 'fulfilled') return outcome.value
      return {
        repo: entry.repo,
        slug: resolveSlug(config.owner, entry.repo),
        label: entry.label !== '' ? entry.label : entry.repo,
        localPath: entry.localPath,
        problems: [String(outcome.reason?.message ?? outcome.reason)],
      }
    })
    const value = { fetchedAt: new Date().toISOString(), cached: false, repos }
    cache = { at: Date.now(), value }
    writeJson(res, 200, { ok: true, value })
  }

  const runsHandler = async (req, res) => {
    if (!guard(req, res)) return
    const body = await readJsonBody(req)
    const target = findEntry(body)
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
    const target = findEntry(body)
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
    const target = findEntry(body)
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
    const target = findEntry(body)
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
    const target = findEntry(body)
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

  const routes = [
    [`${ROUTE_PREFIX}/status`, statusHandler],
    [`${ROUTE_PREFIX}/overview`, overviewHandler],
    [`${ROUTE_PREFIX}/runs`, runsHandler],
    [`${ROUTE_PREFIX}/dispatch`, dispatchHandler],
    [`${ROUTE_PREFIX}/run-action`, runActionHandler],
    [`${ROUTE_PREFIX}/release-action`, releaseActionHandler],
    [`${ROUTE_PREFIX}/logs`, logsHandler],
  ]
  for (const [path, handler] of routes) {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, `dsh-plugin-cicd: ${path}`)
  }
  ctx.logger?.info?.(
    'dsh-plugin-cicd: routes mounted at %s (gh=%s, repos=%d, owner=%s)',
    ROUTE_PREFIX,
    ghPath,
    config.repos.length,
    config.owner === '' ? '(unset)' : config.owner,
  )
}
