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
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  '/api/dsh-cicd/logs',
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
