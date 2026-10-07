#!/usr/bin/env node
/**
 * Mount the Host half for real and serve its routes.
 *
 * The rest of the suite imports functions and calls them directly. This one does
 * what the loader does — calls `apply(ctx, config)` with a `webServer` that
 * actually mounts the handlers on an `http.Server` — and then talks to it over
 * HTTP. That is the difference between "the code is correct" and "the package
 * activates": a route that is never registered, or registered under a path the
 * client does not call, passes every unit check and still leaves the panel empty.
 *
 * It takes the package root as an argument, so it can be pointed at an unpacked
 * release asset to prove the *published* copy activates, not just the checkout:
 *
 *   node tests/mount-check.mjs
 *   node /tmp/asset/package/tests/mount-check.mjs /tmp/asset/package
 *
 * `DSH_CICD_LIVE=1` adds the calls that reach GitHub.
 */

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = resolve(process.argv[2] ?? join(here, '..'))
const module = await import(pathToFileURL(join(packageRoot, 'index.js')).href)

const results = []
let failed = 0
function check(label, condition, detail = '') {
  const pass = condition === true
  if (!pass) failed += 1
  results.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/* A config file of our own, so this test never depends on the machine's list. */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-cicd-mount-'))
const configFile = join(scratch, 'repos.json')
writeFileSync(configFile, JSON.stringify({ owner: 'octocat', repos: [{ repo: 'octocat/Hello-World' }] }), 'utf8')

/** Capture what `apply` registers, exactly as a loader would. */
const routes = new Map()
const effects = []
const logs = []
const ctx = {
  effect: (fn) => {
    effects.push(fn)
    return fn
  },
  logger: { info: (...args) => logs.push(args.join(' ')) },
  webServer: {
    register: ({ path, handler }) => {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  },
}

module.apply(ctx, { owner: 'octocat', configFile })

const EXPECTED = [
  '/api/dsh-cicd/status',
  '/api/dsh-cicd/overview',
  '/api/dsh-cicd/runs',
  '/api/dsh-cicd/dispatch',
  '/api/dsh-cicd/run-action',
  '/api/dsh-cicd/release-action',
  // The step 发布 was missing: the release workflow refuses to reuse a version
  // that belongs to another commit, so the console has to be able to move the
  // version forward itself.
  '/api/dsh-cicd/version-bump',
  '/api/dsh-cicd/logs',
  // Taking the release, not only cutting it: the artifact is installed into the
  // profile through the Host's own plugin manager, and the restart is forwarded to
  // the plugin that owns restarting.
  '/api/dsh-cicd/update',
  '/api/dsh-cicd/restart',
  // Setup without a terminal: the browser sign-in and the repository list are
  // routes, not instructions to go and run something elsewhere.
  '/api/dsh-cicd/auth-start',
  '/api/dsh-cicd/auth-state',
  '/api/dsh-cicd/auth-cancel',
  // Signing out belongs here for the same reason as signing in: the panel owns the
  // credential's whole lifecycle, so no step of it should require a terminal.
  '/api/dsh-cicd/auth-logout',
  '/api/dsh-cicd/repos-available',
  '/api/dsh-cicd/config-add',
  '/api/dsh-cicd/config-remove',
]
check('every route is registered', EXPECTED.every((path) => routes.has(path)), `${routes.size} registered`)
check('nothing extra is registered', routes.size === EXPECTED.length, [...routes.keys()].join(','))
check('the mount was logged', logs.some((line) => line.includes('/api/dsh-cicd')), logs[0] ?? '')

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const handler = routes.get(path)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"ok":false,"code":"no-route"}')
    return
  }
  void handler(req, res)
})
await new Promise((done) => {
  server.listen(0, '127.0.0.1', done)
})
const base = `http://127.0.0.1:${server.address().port}`

const call = async (path, body, method = 'POST') => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, payload }
}

try {
  const status = await call('/api/dsh-cicd/status', {})
  check('status answers over HTTP', status.status === 200 && status.payload?.ok === true, `HTTP ${status.status}`)
  const value = status.payload?.value ?? {}
  // The page and the Host half load independently, so the handshake is part of the
  // contract: without it a stale Host looks like a broken account.
  check('the Host declares a protocol version', typeof value.protocol === 'number' && value.protocol >= 2, String(value.protocol))
  // `gh` ships on GitHub's runners and on the machine this was written for, so
  // "installed" is a safe expectation; "signed in" is not, and is not asserted.
  check('gh is reported as available', value.gh?.available === true, String(value.gh?.version ?? value.gh?.message))
  check('the managed file is the reported source', value.configSource === 'file', String(value.configSource))
  check('the configured repository is reported', value.repos?.[0]?.repo === 'octocat/Hello-World', JSON.stringify(value.repos))
  check('the install path is quoted for the setup guide', typeof value.helper?.configureScript === 'string' && value.helper.configureScript.endsWith('configure.mjs'), String(value.helper?.configureScript))
  check('the scope fields exist', Array.isArray(value.gh?.scopes) && Array.isArray(value.gh?.missingScopes))

  const get = await call('/api/dsh-cicd/status', {}, 'GET')
  check('a GET is refused', get.status === 405 && get.payload?.code === 'method-not-allowed', `HTTP ${get.status}`)

  const unknownRoute = await call('/api/dsh-cicd/nope', {})
  check('an unknown path is not ours', unknownRoute.status === 404, `HTTP ${unknownRoute.status}`)

  const unconfigured = await call('/api/dsh-cicd/runs', { repo: 'someone/else' })
  check('an unconfigured repository is refused', unconfigured.status === 400 && /not configured/.test(unconfigured.payload?.message ?? ''), unconfigured.payload?.message ?? '')

  const badAction = await call('/api/dsh-cicd/run-action', { repo: 'octocat/Hello-World', runId: 1, action: 'obliterate' })
  check('an unsupported run action is refused before gh runs', badAction.status === 400, badAction.payload?.message ?? '')

  const badTag = await call('/api/dsh-cicd/release-action', { repo: 'octocat/Hello-World', tag: '$(rm -rf /)', action: 'publish' })
  check('an unusable tag is refused before gh runs', badTag.status === 400, badTag.payload?.message ?? '')

  /* --- taking a release ---------------------------------------------------
     The two refusals below are the ones that must happen BEFORE any network call,
     because that is the ordering claim the update route makes: an unconfigured
     repository and a Host without a plugin manager are both local facts. `ctx` here
     carries only `webServer` on purpose — that IS the "no pluginManager"
     composition — so this asserts the 501 rather than mocking an install, which
     would either need a real profile or prove nothing about one. */
  const updateUnknown = await call('/api/dsh-cicd/update', { repo: 'someone/else' })
  check('an update of an unconfigured repository is refused', updateUnknown.status === 400 && /not configured/.test(updateUnknown.payload?.message ?? ''), updateUnknown.payload?.message ?? '')

  const updateNoManager = await call('/api/dsh-cicd/update', { repo: 'octocat/Hello-World' })
  check('an update without a plugin manager is refused before GitHub', updateNoManager.status === 501 && updateNoManager.payload?.code === 'plugin-manager-missing', updateNoManager.payload?.message ?? '')

  /* No restart plugin is mounted on this test server, so the forward meets a 404 —
     which is the real shape of "dsh-plugin-restart is not installed". */
  const restartMissing = await call('/api/dsh-cicd/restart', {})
  check('a restart without the restart plugin is named, not a bare failure', restartMissing.status === 501 && restartMissing.payload?.code === 'restart-unavailable', restartMissing.payload?.message ?? '')

  /* --- setup routes -------------------------------------------------------
     Only the refusal paths of `auth-start` are exercised: its success path spawns
     `gh auth login --web`, which would start a real device flow and leave a child
     polling GitHub for ten minutes. A test must not do that to whoever runs it. */
  const idle = await call('/api/dsh-cicd/auth-state', {})
  check('auth-state starts idle', idle.status === 200 && idle.payload?.value?.state === 'idle', JSON.stringify(idle.payload?.value))

  const badMode = await call('/api/dsh-cicd/auth-start', { mode: 'sudo' })
  check('an unsupported auth mode is refused without spawning', badMode.status === 400, badMode.payload?.message ?? '')

  const emptyRefresh = await call('/api/dsh-cicd/auth-start', { mode: 'refresh', scopes: [] })
  check('a refresh with no justifiable scope is refused', emptyRefresh.status === 400, emptyRefresh.payload?.message ?? '')

  const cancelIdle = await call('/api/dsh-cicd/auth-cancel', {})
  // Cancelling with nothing in flight is a no-op that reports the truth. Saying
  // "cancelled" here would be a small lie the panel would then render.
  check('cancelling with nothing in flight reports idle', cancelIdle.status === 200 && cancelIdle.payload?.value?.state === 'idle', JSON.stringify(cancelIdle.payload?.value))

  const badAdd = await call('/api/dsh-cicd/config-add', { repo: '--flag' })
  check('an unusable repository name is refused', badAdd.status === 400, badAdd.payload?.message ?? '')

  const relativeAdd = await call('/api/dsh-cicd/config-add', { repo: 'octocat/Hello-World', localPath: 'relative\\dir' })
  check('a relative localPath is refused', relativeAdd.status === 400, relativeAdd.payload?.message ?? '')

  const added = await call('/api/dsh-cicd/config-add', { repo: 'octocat/Spoon-Knife' })
  check('a repository can be registered from the panel', added.status === 200 && added.payload?.value?.registered === 2, JSON.stringify(added.payload?.value))
  const listAfterAdd = JSON.parse(readFileSync(configFile, 'utf8'))
  check('the registration really reached the file', listAfterAdd.repos.some((entry) => entry.repo === 'octocat/Spoon-Knife'), JSON.stringify(listAfterAdd.repos.map((entry) => entry.repo)))
  check('a backup of the previous revision is kept', existsSync(`${configFile}.bak`))

  const removed = await call('/api/dsh-cicd/config-remove', { repo: 'octocat/Spoon-Knife' })
  check('a repository can be unregistered from the panel', removed.status === 200 && removed.payload?.value?.registered === 1, JSON.stringify(removed.payload?.value))
  const removeAgain = await call('/api/dsh-cicd/config-remove', { repo: 'octocat/Spoon-Knife' })
  check('removing twice is refused, not silent', removeAgain.status === 400, removeAgain.payload?.message ?? '')

  const available = await call('/api/dsh-cicd/repos-available', { limit: 1 })
  // Either it lists (signed in) or it reports why not (not signed in). What must
  // never happen is a non-JSON answer or a hang.
  check('repos-available answers with a verdict', available.payload !== null && typeof available.payload.ok === 'boolean', `HTTP ${available.status}`)

  if (process.env.DSH_CICD_LIVE === '1') {
    console.log('\n-- live over HTTP (DSH_CICD_LIVE=1) --')
    const live = await call('/api/dsh-cicd/overview', { force: true })
    check('overview answers over HTTP', live.status === 200 && live.payload?.ok === true, `HTTP ${live.status}`)
    // octocat/Hello-World is a real public repository, so a real read is possible
    // without any credential at all.
    check('overview carries the configured repository', (live.payload?.value?.repos ?? []).length === 1, JSON.stringify((live.payload?.value?.repos ?? []).map((entry) => entry.repo)))
  }
} finally {
  await new Promise((done) => {
    server.close(done)
  })
  for (const effect of effects) {
    // Unregister through the captured effects, which is what a teardown does.
    try {
      const disposer = effect()
      if (typeof disposer === 'function') disposer()
    } catch {
      /* a teardown that throws is not this test's subject */
    }
  }
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
