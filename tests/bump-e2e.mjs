#!/usr/bin/env node
/**
 * The version bump, end to end, against real git repositories.
 *
 * `version-bump` is the only route in this plugin that writes to a checkout, and it
 * writes three things a mistake would be expensive in: a version number, a commit,
 * and a push. So it is tested the way it runs — a scratch clone, a scratch bare
 * origin, the real route over real HTTP — and every refusal is asserted to leave the
 * manifest byte-identical, because the failure mode that matters is not "it said no"
 * but "it said no and left half a bump behind".
 *
 * It is also the half of 发布 that used to be missing: the release workflow refuses
 * to reuse a version that belongs to another commit, so without a bump the release
 * dispatch can only fail.
 *
 *   node tests/bump-e2e.mjs
 *   node /tmp/asset/package/tests/bump-e2e.mjs /tmp/asset/package
 *
 * Requires `git` on PATH; no network and no GitHub account.
 */

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** Run git in one of the fixtures, with a fixed identity and no user config. */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bump-e2e',
      GIT_AUTHOR_EMAIL: 'bump-e2e@example.invalid',
      GIT_COMMITTER_NAME: 'bump-e2e',
      GIT_COMMITTER_EMAIL: 'bump-e2e@example.invalid',
      GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
      GIT_CONFIG_SYSTEM: join(scratch, 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim()
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-cicd-bump-'))
writeFileSync(join(scratch, 'gitconfig'), '', 'utf8')
/** `init.defaultBranch` moved over the years; pin it once so the assertions are about our code. */
git(scratch, ['config', '--file', join(scratch, 'gitconfig'), 'init.defaultBranch', 'main'])

const manifestFor = (version) => JSON.stringify({
  name: 'fixture',
  version,
  meta: { title: '\u4e00\u952e\u91cd\u542f' },
}, null, 2) + '\n'

/** A bare origin plus a clone whose `main` tracks it. */
function makeCheckout({ version = '1.0.0' } = {}) {
  const root = mkdtempSync(join(scratch, 'repo-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  git(root, ['init', '--bare', origin])
  git(root, ['clone', origin, work])
  /* `init.defaultBranch` is pinned in the fixture config, but a git old enough to
     ignore it would otherwise leave an unborn `master` and fail the push below —
     which would read as a product failure instead of a fixture one. */
  git(work, ['branch', '-M', 'main'])
  /* The route runs `git commit` itself, inheriting the plugin process's
     environment — so the identity has to exist in the REPOSITORY, not in this
     file's child-process env. A CI runner has none, and the first Linux run of
     this suite failed with "Author identity unknown" for exactly that reason. */
  git(work, ['config', 'user.name', 'bump-e2e'])
  git(work, ['config', 'user.email', 'bump-e2e@example.invalid'])
  writeFileSync(join(work, 'package.json'), manifestFor(version), 'utf8')
  git(work, ['add', '--', 'package.json'])
  git(work, ['commit', '-m', 'init'])
  git(work, ['push', '-u', 'origin', 'main'])
  return { origin, work, manifest: join(work, 'package.json') }
}

/* Mount the Host half exactly as a loader would, with the fixture as its only repo. */
function mountFor(checkout) {
  const configFile = join(scratch, `repos-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(configFile, JSON.stringify({
    owner: 'octocat',
    repos: [{ repo: 'octocat/fixture', localPath: checkout.work }],
  }), 'utf8')
  const routes = new Map()
  const ctx = {
    effect: (fn) => fn,
    logger: { info: () => {} },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  module.apply(ctx, { owner: 'octocat', configFile })
  return routes
}

/** Serve one mounted route over loopback and return the parsed answer. */
async function callRoutes(routes, path, body) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end('{"ok":false}')
      return
    }
    void handler(req, res)
  })
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${String(port)}` },
      body: JSON.stringify(body),
    })
    return { status: response.status, payload: await response.json() }
  } finally {
    await new Promise((settle) => server.close(settle))
  }
}

/* -- 1. The happy path ------------------------------------------------------ */
{
  const checkout = makeCheckout()
  const before = readFileSync(checkout.manifest, 'utf8')
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/version-bump', { repo: 'octocat/fixture', release: 'patch' })

  check('a clean checkout is bumped', answer.status === 200 && answer.payload?.ok === true, JSON.stringify(answer.payload?.value ?? answer.payload))
  check('the bump reports both versions', answer.payload?.value?.from === '1.0.0' && answer.payload?.value?.to === '1.0.1', `${String(answer.payload?.value?.from)} → ${String(answer.payload?.value?.to)}`)
  check('the tag follows the new version', answer.payload?.value?.tag === 'v1.0.1', String(answer.payload?.value?.tag))
  check('the branch is named', answer.payload?.value?.branch === 'main', String(answer.payload?.value?.branch))
  check('the push is reported as done', answer.payload?.value?.pushed === true)

  const rewritten = readFileSync(checkout.manifest, 'utf8')
  check('the manifest on disk carries the new version', /"version":\s*"1\.0\.1"/.test(rewritten), rewritten.split('\n')[1] ?? '')
  check('every other byte of the manifest is untouched', rewritten === before.replace('"version": "1.0.0"', '"version": "1.0.1"'))
  check('the manifest still parses', JSON.parse(rewritten).version === '1.0.1')
  check('the escaped metadata survived', rewritten.includes('\\u4e00') === before.includes('\\u4e00'))

  const subject = git(checkout.work, ['log', '-1', '--pretty=%s'])
  check('the commit is a release chore', subject === 'chore(release): v1.0.1', subject)
  const files = git(checkout.work, ['show', '--name-only', '--pretty=format:', 'HEAD'])
  check('the commit contains only the manifest', files === 'package.json', files)
  check('the working tree is clean afterwards', git(checkout.work, ['status', '--porcelain']) === '')
  const originHead = git(checkout.origin, ['log', '-1', '--pretty=%s', 'main'])
  check('the commit reached the origin', originHead === 'chore(release): v1.0.1', originHead)
  check('the push carried nothing else', Number(git(checkout.work, ['rev-list', '--count', 'origin/main..HEAD'])) === 0)
}

/* -- 2. A dirty tree is refused and NOTHING is written ---------------------- */
{
  const checkout = makeCheckout()
  writeFileSync(join(checkout.work, 'scratch.txt'), 'work in progress\n', 'utf8')
  const before = readFileSync(checkout.manifest, 'utf8')
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/version-bump', { repo: 'octocat/fixture', release: 'patch' })

  check('a dirty tree is refused', answer.status === 409 && answer.payload?.code === 'dirty-tree', `${String(answer.status)} ${String(answer.payload?.code)}`)
  check('the refusal counts the changes', answer.payload?.value?.dirty === 1, String(answer.payload?.value?.dirty))
  check('the dirty refusal left the manifest alone', readFileSync(checkout.manifest, 'utf8') === before)
  check('the dirty refusal created no commit', git(checkout.work, ['log', '-1', '--pretty=%s']) === 'init')
}

/* -- 3. A version that cannot be bumped is refused ------------------------- */
{
  const checkout = makeCheckout({ version: '1.0.0-rc.1' })
  const before = readFileSync(checkout.manifest, 'utf8')
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/version-bump', { repo: 'octocat/fixture', release: 'patch' })

  check('a prerelease version is refused', answer.status === 400 && answer.payload?.code === 'unusable-version', `${String(answer.status)} ${String(answer.payload?.code)}`)
  check('the prerelease refusal left the manifest alone', readFileSync(checkout.manifest, 'utf8') === before)
  check('the prerelease refusal created no commit', git(checkout.work, ['log', '-1', '--pretty=%s']) === 'init')
}

/* -- 4. A branch behind its upstream is refused --------------------------- */
{
  const checkout = makeCheckout()
  const other = join(scratch, `other-${Math.random().toString(36).slice(2)}`)
  git(scratch, ['clone', checkout.origin, other])
  git(other, ['branch', '-M', 'main'])
  writeFileSync(join(other, 'second.txt'), 'from elsewhere\n', 'utf8')
  git(other, ['add', '--', 'second.txt'])
  git(other, ['commit', '-m', 'elsewhere'])
  git(other, ['push', 'origin', 'main'])
  git(checkout.work, ['fetch', 'origin'])
  const before = readFileSync(checkout.manifest, 'utf8')
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/version-bump', { repo: 'octocat/fixture', release: 'patch' })

  check('a branch behind its upstream is refused', answer.status === 409 && answer.payload?.code === 'behind', `${String(answer.status)} ${String(answer.payload?.code)}`)
  check('the behind refusal left the manifest alone', readFileSync(checkout.manifest, 'utf8') === before)
}

/* -- 5. Unpushed commits are allowed, and reported ------------------------- */
{
  const checkout = makeCheckout()
  writeFileSync(join(checkout.work, 'extra.txt'), 'local work\n', 'utf8')
  git(checkout.work, ['add', '--', 'extra.txt'])
  git(checkout.work, ['commit', '-m', 'local work'])
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/version-bump', { repo: 'octocat/fixture', release: 'minor' })

  check('an ahead branch is still bumpable', answer.status === 200 && answer.payload?.ok === true, JSON.stringify(answer.payload?.value ?? answer.payload))
  check('the bump says how much it carried', answer.payload?.value?.carried === 1, String(answer.payload?.value?.carried))
  check('a minor bump resets the patch', answer.payload?.value?.to === '1.1.0', String(answer.payload?.value?.to))
  check('everything local reached the origin', Number(git(checkout.work, ['rev-list', '--count', 'origin/main..HEAD'])) === 0)
}

/* -- 6. No local checkout is a message, not a crash ------------------------ */
{
  const configFile = join(scratch, 'repos-nolocal.json')
  writeFileSync(configFile, JSON.stringify({ owner: 'octocat', repos: [{ repo: 'octocat/fixture' }] }), 'utf8')
  const routes = new Map()
  module.apply({
    effect: (fn) => fn,
    logger: { info: () => {} },
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
  }, { owner: 'octocat', configFile })
  const answer = await callRoutes(routes, '/api/dsh-cicd/version-bump', { repo: 'octocat/fixture' })

  check('a repository with no checkout is refused', answer.status === 400 && answer.payload?.code === 'no-checkout', `${String(answer.status)} ${String(answer.payload?.code)}`)
}

/* -- 7. The release preflight refuses a version that is taken -------------- */
{
  const checkout = makeCheckout()
  const routes = mountFor(checkout)
  /* The fixture's upstream is unreachable for `gh`, so the preflight cannot read
     GitHub — which is exactly the case that must NOT block: an unreadable answer
     dispatches as before rather than refusing a release that would have worked. */
  const answer = await callRoutes(routes, '/api/dsh-cicd/dispatch', { repo: 'octocat/fixture', workflow: 'release.yml', inputs: { draft: 'true' } })
  check('an unreadable preflight does not block the dispatch', answer.payload?.code !== 'version-taken', `${String(answer.status)} ${String(answer.payload?.code ?? answer.payload?.message ?? '')}`)
}

/* -- 8. 提交: the step 构建 and 发布 cannot do without ------------------------ */
/*
 * A release builds the PUSHED commit, so work that is only in the working tree — or
 * only on this machine — is silently absent from the released package. That is what
 * this route exists to fix, and it is the only action in the plugin that commits
 * everything, so both halves are checked against a real origin.
 */
{
  const checkout = makeCheckout()
  writeFileSync(join(checkout.work, 'notes.md'), 'a file nobody tracked before\n', 'utf8')
  writeFileSync(checkout.manifest, manifestFor('1.0.1'), 'utf8')
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/commit', { repo: 'octocat/fixture', message: 'docs: a note' })

  check('a dirty checkout commits and pushes', answer.status === 200 && answer.payload?.ok === true, JSON.stringify(answer.payload?.value ?? answer.payload))
  check('the commit reached the origin', git(checkout.work, ['log', '-1', '--pretty=%s', 'origin/main']) === 'docs: a note', git(checkout.work, ['log', '-1', '--pretty=%s', 'origin/main']))
  check('the working tree is clean afterwards', git(checkout.work, ['status', '--porcelain']) === '')
  /* `add -A`, not `add -u`: a release needs the new files too, and a commit that
     quietly left one behind is the same trap one level down. */
  check('an untracked file is included, not left behind', git(checkout.work, ['ls-tree', '-r', '--name-only', 'HEAD']).includes('notes.md'))
  check('the edit to a tracked file is included', git(checkout.work, ['show', 'HEAD:package.json']).includes('1.0.1'))
  check('the answer lists what was committed', Array.isArray(answer.payload?.value?.files) && answer.payload.value.files.length === 2, JSON.stringify(answer.payload?.value?.files))
  check('the answer names the branch it pushed', answer.payload?.value?.branch === 'main', String(answer.payload?.value?.branch))
}

/* The message is the one thing this route cannot invent: an empty one is refused
   before anything is written, and the changes stay where they were. */
{
  const checkout = makeCheckout()
  writeFileSync(join(checkout.work, 'notes.md'), 'x\n', 'utf8')
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/commit', { repo: 'octocat/fixture', message: '   ' })

  check('a commit with no message is refused', answer.status === 400 && answer.payload?.code === 'message-required', `${String(answer.status)} ${String(answer.payload?.code)}`)
  check('the refusal created no commit', git(checkout.work, ['log', '-1', '--pretty=%s']) === 'init')
  check('the refusal left the change in place', git(checkout.work, ['status', '--porcelain']) !== '')
}

/* Clean and in sync: there is nothing to do, and the route says that rather than
   creating an empty commit or pushing nothing. */
{
  const checkout = makeCheckout()
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/commit', { repo: 'octocat/fixture', message: 'nothing to say' })

  check('a clean, in-sync checkout has nothing to commit', answer.status === 409 && answer.payload?.code === 'nothing-to-commit', `${String(answer.status)} ${String(answer.payload?.code)}`)
  check('nothing was committed for it', git(checkout.work, ['log', '-1', '--pretty=%s']) === 'init')
}

/* The other half of the same trap: the work IS committed, and it has never left this
   machine — which a release cannot see either. An empty message means exactly that. */
{
  const checkout = makeCheckout()
  writeFileSync(join(checkout.work, 'notes.md'), 'x\n', 'utf8')
  git(checkout.work, ['add', '-A'])
  git(checkout.work, ['commit', '-m', 'local only'])
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/commit', { repo: 'octocat/fixture', message: '' })

  check('a clean but unpushed branch is pushed', answer.status === 200 && answer.payload?.ok === true, JSON.stringify(answer.payload?.value ?? answer.payload))
  check('it reports that it committed nothing new', answer.payload?.value?.committed === false)
  check('it says how many local commits it carried', answer.payload?.value?.carried === 1, String(answer.payload?.value?.carried))
  check('the local commit reached the origin', git(checkout.work, ['log', '-1', '--pretty=%s', 'origin/main']) === 'local only')
}

/* No upstream: the push could only fail, so the refusal names the reason instead. */
{
  const checkout = makeCheckout()
  git(checkout.work, ['checkout', '-b', 'solo'])
  writeFileSync(join(checkout.work, 'notes.md'), 'x\n', 'utf8')
  const routes = mountFor(checkout)
  const answer = await callRoutes(routes, '/api/dsh-cicd/commit', { repo: 'octocat/fixture', message: 'solo work' })

  check('a branch with no upstream is refused', answer.status === 409 && answer.payload?.code === 'no-upstream', `${String(answer.status)} ${String(answer.payload?.code)}`)
  check('the refusal created no commit', git(checkout.work, ['log', '-1', '--pretty=%s']) === 'init')
}

/* No checkout at all, the same shape as the bump refusal above. */
{
  const configFile = join(scratch, 'repos-nolocal-commit.json')
  writeFileSync(configFile, JSON.stringify({ owner: 'octocat', repos: [{ repo: 'octocat/fixture' }] }), 'utf8')
  const routes = new Map()
  module.apply({
    effect: (fn) => fn,
    logger: { info: () => {} },
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
  }, { owner: 'octocat', configFile })
  const answer = await callRoutes(routes, '/api/dsh-cicd/commit', { repo: 'octocat/fixture', message: 'x' })

  check('a repository with no checkout is refused here too', answer.status === 400 && answer.payload?.code === 'no-checkout', `${String(answer.status)} ${String(answer.payload?.code)}`)
}

await new Promise((settle) => { rmSync(scratch, { recursive: true, force: true }); settle() })
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
