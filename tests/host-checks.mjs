#!/usr/bin/env node
/**
 * Checks for the dsh-plugin-cicd Host half.
 *
 * The point of this file is that the Host half's hard part is not the HTTP
 * plumbing — it is the two boundaries: what a hand-written profile patch can ask
 * for, and what a configured repository name turns into once it becomes one
 * argv element of a `gh` invocation. Both are testable without DSH, without a
 * browser, and (for the first half) without a network.
 *
 *   node tests/host-checks.mjs              offline checks only — what CI runs
 *   DSH_CICD_LIVE=1 node tests/host-checks.mjs   adds checks against the real gh
 *
 * The live checks are opt-in because they need an authenticated `gh` AND a
 * specific repository state; asserting "dsh-plugin-restart has a draft release"
 * in CI would fail the moment that release is published, which would train
 * everyone to ignore the suite.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRepo, ghJson, normalizeRepoEntry, readLocalState, readLocalVersion, resolveConfig, resolveGhPath, resolveSlug, runTool } from '../index.js'

const results = []
let failed = 0

/**
 * Record and print one check.
 * @param {string} label - what was asserted.
 * @param {boolean} condition - the assertion.
 * @param {string} [detail] - evidence, printed either way.
 */
function check(label, condition, detail = '') {
  const pass = condition === true
  if (!pass) failed += 1
  results.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/* -- 1. Entry normalization -------------------------------------------------
   A repository name is passed to `gh` as one argv element with no shell in
   between, so the shape check is not cosmetic: it is what keeps `--help` or a
   flag-looking string from being read as an option. */
check('bare name accepted', normalizeRepoEntry('dsh-plugin-restart')?.repo === 'dsh-plugin-restart')
check('owner/name accepted', normalizeRepoEntry('other/repo')?.repo === 'other/repo')
/* `path.isAbsolute` is platform-specific, and this suite runs on a Linux runner
   as well as on the Windows machine the plugin actually targets. So the shape
   that must hold everywhere is asserted everywhere, and the Windows drive-letter
   shape is pinned only where it is meaningful — asserting it on Linux would fail
   for a reason that has nothing to do with the code under test. */
const absoluteCheckout = join(tmpdir(), 'some-checkout')
check('object form accepted', normalizeRepoEntry({ repo: 'x', localPath: absoluteCheckout })?.localPath === absoluteCheckout)
if (process.platform === 'win32') {
  check('a Windows absolute path is kept', normalizeRepoEntry({ repo: 'x', localPath: 'F:\\CodeProj\\x' })?.localPath === 'F:\\CodeProj\\x')
}
check('label falls back to the name', normalizeRepoEntry({ repo: 'x' })?.label === '')
check('relative localPath refused', normalizeRepoEntry({ repo: 'x', localPath: 'CodeProj\\x' })?.localPath === '')
check('flag-shaped name refused', normalizeRepoEntry('--help') === null)
check('shell metacharacters refused', normalizeRepoEntry('a;rm -rf /') === null)
check('space in name refused', normalizeRepoEntry('a b') === null)
check('empty string refused', normalizeRepoEntry('') === null)
check('number refused', normalizeRepoEntry(42) === null)
check('null refused', normalizeRepoEntry(null) === null)

/* -- 2. Config clamping -----------------------------------------------------
   A hand-written patch must never be able to stop the Host from starting. The
   worst acceptable outcome is a route that reports "not configured". */
const clamped = resolveConfig({
  owner: 'SOH4C4759',
  repos: ['dsh-plugin-restart', 'dsh-plugin-restart', { repo: 'dsh-ui-sound' }, '!!bad', 7],
  requestTimeoutMs: 99_999_999,
  pollSeconds: 1,
  logTailLines: 99_999,
  overviewTtlMs: -5,
})
check('duplicate repository collapsed', clamped.repos.length === 2, clamped.repos.map((entry) => entry.repo).join(','))
check('unusable entry dropped', clamped.repos.every((entry) => /^[A-Za-z0-9._-]+$/.test(entry.repo)))
check('timeout clamped to the ceiling', clamped.requestTimeoutMs === 120_000, String(clamped.requestTimeoutMs))
check('poll interval floored', clamped.pollSeconds === 10, String(clamped.pollSeconds))
check('log tail capped', clamped.logTailLines === 400, String(clamped.logTailLines))
check('negative ttl floored to zero', clamped.overviewTtlMs === 0, String(clamped.overviewTtlMs))
check('missing config yields defaults', resolveConfig(undefined).defaultBranch === 'main')
check('non-array repos yields an empty list', resolveConfig({ repos: 'nope' }).repos.length === 0)
check('null config survives', resolveConfig(null).repos.length === 0)
check('repo cap enforced', resolveConfig({ repos: Array.from({ length: 100 }, (_, index) => `r${index}`) }).repos.length === 40)

/* -- 3. Slug resolution ----------------------------------------------------- */
check('owner prefixes a bare name', resolveSlug('SOH4C4759', 'dsh-plugin-restart') === 'SOH4C4759/dsh-plugin-restart')
check('owner is ignored for owner/name', resolveSlug('someone', 'a/b') === 'a/b')
check('bare name without owner is refused', resolveSlug('', 'bare') === null)

/* -- 4. gh resolution ------------------------------------------------------- */
const ghPath = resolveGhPath(resolveConfig({ owner: 'SOH4C4759' }))
check('gh resolves to something runnable', ghPath !== '', ghPath)

/* -- 5. Local-state helpers -------------------------------------------------
   These run against real directories on any machine: the point is the
   degradation path, not the specific checkout. */
/* The absent-path cases use the OS temp directory rather than a hard-coded
   Windows path, so the same suite is meaningful on a Linux runner. */
check('missing directory yields null', readLocalVersion(join(tmpdir(), '__definitely-not-here__')) === null)
check('empty path yields null', readLocalVersion('') === null)
const noPath = await readLocalState('', 5_000)
check('no localPath explains itself', noPath.available === false && noPath.reason === 'no localPath configured', noPath.reason)
const notARepo = await readLocalState(tmpdir(), 5_000)
check('a non-checkout explains itself', notARepo.available === false, notARepo.reason)

/* -- 6. Live checks (opt-in) ------------------------------------------------ */
if (process.env.DSH_CICD_LIVE === '1') {
  console.log('\n-- live checks (DSH_CICD_LIVE=1) --')
  const version = await runTool(ghPath, ['--version'], 10_000)
  check('gh runs', version.ok && /gh version/.test(version.stdout.split('\n')[0] ?? ''), version.stdout.split('\n')[0] ?? version.stderr)

  const whoami = await runTool(ghPath, ['api', 'user', '--jq', '.login'], 15_000)
  check('gh is authenticated', whoami.ok && whoami.stdout.trim() !== '', whoami.stdout.trim() || whoami.stderr.trim())

  const owner = whoami.ok ? whoami.stdout.trim() : ''
  const live = resolveConfig({ owner, repos: [{ repo: 'dsh-plugin-restart', localPath: 'F:\\CodeProj\\dsh-plugin-restart' }] })
  const overview = await collectRepo({ config: live, ghPath, entry: live.repos[0] })
  check('overview has no problems', overview.problems.length === 0, overview.problems.join(' | '))
  check('runs parsed', Array.isArray(overview.runs) && overview.runs.length > 0, `${overview.runs.length} runs`)
  check('run fields typed', typeof overview.latestRun?.id === 'number' && typeof overview.latestRun?.workflow === 'string')
  check('workflows parsed', overview.workflows.length >= 1, overview.workflows.map((entry) => entry.path).join(','))
  check('build workflow detected', overview.hasBuildWorkflow === true)
  check('release workflow detected', overview.hasReleaseWorkflow === true)

  const missing = await collectRepo({ config: live, ghPath, entry: { repo: 'this-repo-does-not-exist-xyz', localPath: '', label: '' } })
  check('a missing repository degrades to a message', missing.problems.length > 0, missing.problems[0] ?? '')
  check('a missing repository still returns a shape', Array.isArray(missing.runs) && missing.runs.length === 0)
  check('a missing repository is not an exception', missing.latestRun === null)

  const nonsense = await ghJson(ghPath, ['api', 'repos/this/does-not-exist-xyz'], 15_000)
  check('gh JSON failure is a message, not a throw', nonsense.ok === false && typeof nonsense.message === 'string', nonsense.message)
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
