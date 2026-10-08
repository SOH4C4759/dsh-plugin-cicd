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

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPublishFailure, classifySpec, collectRepo, commandFailureLine, compareVersions, confirmVisible, defaultCloneUrl, describeInstall, effectiveConfig, firstMeaningfulLine, fullSha, ghJson, hasNpmToken, nextVersion, normalizeRegistry, normalizeRepoEntry, npmAuthState, npmPackageState, npmPublishVerdict, npmrcAuthKey, packumentUrl, parseAuthStatus, parseReposFile, pickInstallableRelease, readDirtyCount, readLocalState, readLocalVersion, readManifest, readProfileInstall, releasePreflight, resolveConfig, resolveConfigFilePath, resolveGhPath, resolveNpmrcPath, resolvePackageManagerInvocation, resolveProfileDir, resolveSlug, rewriteVersion, runTool, statusPath, updateState, upsertAuthToken, versionFromTag } from '../index.js'

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

/* -- 2b. The Bilibili binding ----------------------------------------------
   The binding decides which video's comment section a repository speaks to. A
   malformed one has to become "no binding" rather than travel onward: the failure
   mode of the other choice is a comment posted under somebody else's video. */
check('a binding is kept', normalizeRepoEntry({ repo: 'x', bilibili: { bvid: 'BV1RopP6FEJp' } })?.bilibili?.bvid === 'BV1RopP6FEJp')
check('a binding is automatic unless it says otherwise', normalizeRepoEntry({ repo: 'x', bilibili: { bvid: 'BV1RopP6FEJp' } })?.bilibili?.auto === true)
check('a binding can be manual', normalizeRepoEntry({ repo: 'x', bilibili: { bvid: 'BV1RopP6FEJp', auto: false } })?.bilibili?.auto === false)
check('a malformed BV id becomes no binding', normalizeRepoEntry({ repo: 'x', bilibili: { bvid: 'BV-nope' } })?.bilibili === null)
check('a binding with no id becomes no binding', normalizeRepoEntry({ repo: 'x', bilibili: {} })?.bilibili === null)
check('a repository with no binding says so', normalizeRepoEntry({ repo: 'x' })?.bilibili === null)
check('the BV shorthand is accepted', normalizeRepoEntry({ repo: 'x', bilibili: { bv: 'BV1RopP6FEJp' } })?.bilibili?.bvid === 'BV1RopP6FEJp')
check('bilibili notes are on by default', resolveConfig(undefined).bilibiliEnabled === true)
check('the sweep interval is clamped', resolveConfig({ bilibiliWatchSeconds: 999_999 }).bilibiliWatchSeconds === 3600)
check('the sweep can be switched off', resolveConfig({ bilibiliWatchSeconds: 0 }).bilibiliWatchSeconds === 0)
check('an external credential file is remembered', resolveConfig({ bilibiliCookieFile: 'C:\\Users\\x\\cookies.json' }).bilibiliCookieFile === 'C:\\Users\\x\\cookies.json')
check('no external credential file is the default', resolveConfig(undefined).bilibiliCookieFile === '')
check('the template is kept verbatim', resolveConfig({ bilibiliTemplate: '【更新 {tag}】{summary}' }).bilibiliTemplate === '【更新 {tag}】{summary}')

/* -- 3. Slug resolution ----------------------------------------------------- */
check('owner prefixes a bare name', resolveSlug('SOH4C4759', 'dsh-plugin-restart') === 'SOH4C4759/dsh-plugin-restart')
check('owner is ignored for owner/name', resolveSlug('someone', 'a/b') === 'a/b')
check('bare name without owner is refused', resolveSlug('', 'bare') === null)

/* -- 4. gh resolution -------------------------------------------------------
   The bug this section pins: `path.isAbsolute` says a Windows path is NOT
   absolute on POSIX, so a resolver that trusted it handed
   `C:\Program Files\GitHub CLI\gh.exe` to `spawn` as if it were a command name
   on every Linux machine. */
const ghPath = resolveGhPath(resolveConfig({ owner: 'SOH4C4759' }))
check('gh resolves to something runnable', ghPath !== '', ghPath)
check('an explicit command name is kept', resolveGhPath(resolveConfig({ ghPath: 'gh' }), 'linux') === 'gh')
check('an explicit absolute path is kept', resolveGhPath(resolveConfig({ ghPath: join(tmpdir(), 'gh.exe') }), 'linux') === join(tmpdir(), 'gh.exe'))
const posix = resolveGhPath(resolveConfig({}), 'linux')
check('POSIX never answers with a Windows path', posix === 'gh', posix)
const windows = resolveGhPath(resolveConfig({}), 'win32')
check('Windows answers with a real path or the command name', windows === 'gh' || existsSync(windows), windows)

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

/* -- 6. The managed config file ---------------------------------------------
   The file exists so the repository list can change without hand-editing YAML,
   which makes its failure modes the interesting part: a file the plugin cannot
   read must be reported, never silently treated as "no repositories". */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-cicd-'))
const managedFile = join(scratch, 'repos.json')

check('an explicit config path is honoured', resolveConfigFilePath(resolveConfig({ configFile: managedFile })) === managedFile)
check('the default path lives under DSH_HOME', resolveConfigFilePath(resolveConfig({})).endsWith(join('dsh-plugin-cicd', 'repos.json')))

const parsedGood = parseReposFile(JSON.stringify({ owner: 'me', repos: ['a', { repo: 'b', localPath: join(tmpdir(), 'b') }, '!!bad', 'a'] }))
check('the managed file parses', parsedGood.ok === true && parsedGood.owner === 'me', parsedGood.ok ? '' : parsedGood.message)
check('valid entries are kept', parsedGood.ok === true && parsedGood.repos.length === 2, parsedGood.ok ? parsedGood.repos.map((entry) => entry.repo).join(',') : '')
check('dropped entries are counted', parsedGood.ok === true && parsedGood.dropped === 2, String(parsedGood.ok ? parsedGood.dropped : 'n/a'))
check('invalid JSON is refused', parseReposFile('{').ok === false)
check('a bare array is refused', parseReposFile('[]').ok === false)
check('a non-array repos is refused', parseReposFile('{"repos":{}}').ok === false)
check('a missing repos key is an empty list', parseReposFile('{"owner":"me"}').repos.length === 0)

/* File absent: the hand-written row stays authoritative. */
const rowOnly = effectiveConfig(resolveConfig({ owner: 'me', repos: ['solo'], configFile: managedFile }))
check('an absent file falls back to the row', rowOnly.configSource === 'row' && rowOnly.repos.length === 1, rowOnly.configSource)
check('an absent file is not a problem', rowOnly.configProblem === null)

writeFileSync(managedFile, JSON.stringify({ owner: 'file-owner', repos: [{ repo: 'from-file' }] }), 'utf8')
const fileBacked = effectiveConfig(resolveConfig({ owner: 'row-owner', repos: ['from-row'], configFile: managedFile }))
check('the file wins over the row list', fileBacked.repos.length === 1 && fileBacked.repos[0].repo === 'from-file')
check('the file owner wins too', fileBacked.owner === 'file-owner', fileBacked.owner)
check('the source is reported as file', fileBacked.configSource === 'file')

writeFileSync(managedFile, 'not json at all', 'utf8')
const broken = effectiveConfig(resolveConfig({ owner: 'me', repos: ['from-row'], configFile: managedFile }))
check('a broken file is reported, not swallowed', broken.configSource === 'file-invalid' && typeof broken.configProblem === 'string', String(broken.configProblem))
check('a broken file does not silently empty the list', broken.repos.length === 1 && broken.repos[0].repo === 'from-row')

/* -- 7. `gh auth status` parsing --------------------------------------------
   The scope list is the difference between "the buttons work" and "the button
   fails when you press it", so it is parsed rather than assumed. */
const loggedIn = parseAuthStatus([
  'github.com',
  '  ✓ Logged in to github.com account SOH4C4759 (keyring)',
  '  - Active account: true',
  "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
].join('\n'))
check('a signed-in status is recognised', loggedIn.authenticated === true)
check('the account is extracted', loggedIn.account === 'SOH4C4759', String(loggedIn.account))
check('scopes are extracted', loggedIn.scopes.join(',') === 'gist,read:org,repo,workflow', loggedIn.scopes.join(','))
check('a complete scope set reports nothing missing', loggedIn.missingScopes.length === 0)

const partialScopes = parseAuthStatus("  ✓ Logged in to github.com account me (keyring)\n  - Token scopes: 'repo'")
check('a partial scope set names what is missing', partialScopes.missingScopes.join(',') === 'workflow', partialScopes.missingScopes.join(','))

/* A fine-grained token prints no scope line at all. Reporting that as "missing
   repo, workflow" would send the user to fix something that is not broken. */
const opaqueToken = parseAuthStatus('  ✓ Logged in to github.com account me (keyring)\n  - Token: github_pat_***')
check('an unreported scope list is unknown, not empty', opaqueToken.missingScopes.length === 0)
check('an unreported scope list stays empty', opaqueToken.scopes.length === 0)

const signedOut = parseAuthStatus('github.com\n  X No oauth token found for github.com')
check('a signed-out status is recognised', signedOut.authenticated === false)
check('a signed-out status reports no account', signedOut.account === null)

/* -- 8. Release preflight and the version bump ------------------------------
   Every repository here releases from `package.json`'s version, and the release
   workflow refuses to reuse a version that already belongs to another commit — so a
   dispatch without a bump could only fail (measured four times, ~10 s in, at the
   first step, while the panel announced a draft that never appeared). Two
   properties matter, and they pull in opposite directions: a PROVEN mismatch must
   be blocked, and an unprovable one must never be. */
const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const releaseAt = (sha, draft = false) => ({ tag: 'v1.0.0', draft, targetCommitish: sha })

const blockedVerdict = releasePreflight({ version: '1.0.0', expectedTag: 'v1.0.0', releases: [releaseAt(shaA)], builtSha: shaB })
check('a version taken by another commit blocks the release', blockedVerdict.state === 'blocked' && blockedVerdict.code === 'version-taken', blockedVerdict.code)
check('the block names both commits', blockedVerdict.owner === shaA && blockedVerdict.built === shaB)
check('a DRAFT of that version blocks it too', releasePreflight({ version: '1.0.0', expectedTag: 'v1.0.0', releases: [releaseAt(shaA, true)], builtSha: shaB }).state === 'blocked')
check('an unreleased version is ready', releasePreflight({ version: '1.0.0', expectedTag: 'v1.0.0', releases: [], builtSha: shaB }).state === 'ready')
check('the same commit is ready — replacing its assets is safe', releasePreflight({ version: '1.0.0', expectedTag: 'v1.0.0', releases: [releaseAt(shaB)], builtSha: shaB }).state === 'ready')
check('a branch-name target cannot prove a mismatch, so it does not block', releasePreflight({ version: '1.0.0', expectedTag: 'v1.0.0', releases: [{ tag: 'v1.0.0', draft: false, targetCommitish: 'main' }], builtSha: shaB }).state === 'ready')
check('an unknown build commit cannot prove one either', releasePreflight({ version: '1.0.0', expectedTag: 'v1.0.0', releases: [releaseAt(shaA)], builtSha: null }).state === 'ready')
check('no local version is unknown, not blocked', releasePreflight({ version: null, expectedTag: null, releases: [releaseAt(shaA)], builtSha: shaB }).state === 'unknown')
check('an empty call answers instead of throwing', releasePreflight().state === 'unknown')
check('the tag is derived from the version when absent', releasePreflight({ version: '1.0.0', expectedTag: null, releases: [releaseAt(shaA)], builtSha: shaB }).state === 'blocked')
check('fullSha accepts a full id only', fullSha(shaA) === shaA && fullSha('abc1234') === null && fullSha(42) === null)

check('patch bumps the third field', nextVersion('1.0.1', 'patch').to === '1.0.2')
check('minor resets the patch', nextVersion('1.0.1', 'minor').to === '1.1.0')
check('major resets both', nextVersion('1.2.3', 'major').to === '2.0.0')
check('a prerelease is refused rather than guessed', nextVersion('1.0.0-rc.1', 'patch').ok === false)
check('an unknown release kind is refused', nextVersion('1.0.0', 'rollup').ok === false)

/* The manifest is hand-written prose in places (escaped CJK, key order), so the
   bump must be a one-line edit, never a JSON round-trip. */
const manifest = '{\n  "name": "x",\n  "version": "1.0.0",\n  "meta": { "title": "\\u4e00" }\n}\n'
const rewrittenManifest = rewriteVersion(manifest, '1.0.1')
check('only the version line changes', rewrittenManifest.ok === true && rewrittenManifest.text === manifest.replace('"version": "1.0.0"', '"version": "1.0.1"'), rewrittenManifest.ok ? '' : rewrittenManifest.message)
check('the rewritten manifest still parses', JSON.parse(rewrittenManifest.text).version === '1.0.1')
check('escaping elsewhere is untouched', rewrittenManifest.ok === true && rewrittenManifest.text.includes('\\u4e00') === manifest.includes('\\u4e00'))
check('two version keys are refused, not guessed at', rewriteVersion('{\n  "version": "1.0.0",\n  "x": {\n    "version": "2.0.0"\n  }\n}\n', '1.0.1').ok === false)
check('a non-version target is refused', rewriteVersion(manifest, '1.0').ok === false)
check('an empty manifest is refused', rewriteVersion('', '1.0.1').ok === false)

/* -- 9. The installed copy vs the release -----------------------------------
   The update button's whole judgement lives here, and none of it needs GitHub: the
   profile's manifest and the checkout's manifest are two files on disk, and the
   release list is the normalized shape `collectRepo` already produces. A fixture
   profile is built in the temp directory so the assertions are about the rules
   rather than about whatever this machine happens to have installed. */
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-cicd-profile-'))
const checkoutDir = mkdtempSync(join(tmpdir(), 'dsh-cicd-checkout-'))
const otherCheckout = mkdtempSync(join(tmpdir(), 'dsh-cicd-other-'))
const writeManifest = (dir, manifest) => writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
writeManifest(checkoutDir, { name: 'dsh-demo', version: '1.2.0' })

/* Every Windows spelling below is asserted on BOTH platforms on purpose. The bug
   this pins: classifying `link:`/`file:` through `path.isAbsolute` made every
   Windows-written spec `other` on the Linux runner, which turned a `link:` checkout
   into "current" — the one answer that hides "you are not running the published
   code". So the spellings stay Windows-shaped here and the assertions must hold
   wherever this suite runs. */
check('a link spec is classified as a checkout', classifySpec('link:F:\\CodeProj\\x').kind === 'link')
check('a file tarball is classified as a tarball', classifySpec('file:F:\\dl\\x-1.0.0.tgz').kind === 'tarball')
check('a file directory is classified as a path', classifySpec('file:F:\\CodeProj\\x').kind === 'path')
check('a bare drive-letter path is a path on any platform', classifySpec('F:\\CodeProj\\x').kind === 'path')
check('a prefixed spec keeps its path verbatim', classifySpec('link:F:\\CodeProj\\x').path === 'F:\\CodeProj\\x')
check('link: without a path is not a kind', classifySpec('link:').kind === 'other')
check('a registry range is classified as registry', classifySpec('^1.2.3').kind === 'registry')
check('a git spec is not mistaken for a registry name', classifySpec('github:me/repo').kind === 'other')
check('an empty spec is not a kind', classifySpec('').kind === 'other')

check('equal versions compare equal', compareVersions('1.2.3', '1.2.3') === 0)
check('the v prefix is ignored', compareVersions('v1.2.3', '1.2.3') === 0 || compareVersions('1.2.3', 'v1.2.3') === 0)
check('a lower minor is older', compareVersions('1.2.3', '1.3.0') === -1)
check('a higher patch is newer', compareVersions('1.2.4', '1.2.3') === 1)
check('a prerelease is not comparable, not equal', compareVersions('1.2.3-rc.1', '1.2.3') === null)
check('a missing version is not comparable', compareVersions(null, '1.2.3') === null)
check('a tag yields its version', versionFromTag('v1.2.3') === '1.2.3' && versionFromTag('1.2.3') === '1.2.3')
check('a non-version tag yields null', versionFromTag('release') === null)

const releaseOf = (tag, asset, draft = false) => ({ tag, draft, name: '', prerelease: false, targetCommitish: '', createdAt: '', url: '', assets: asset === null ? [] : [{ name: asset, size: 1 }] })
const tgzOf = (tag) => releaseOf(tag, `dsh-demo-${tag.replace(/^v/, '')}.tgz`)

check('the newest release with a tarball is chosen', pickInstallableRelease([tgzOf('v1.3.0'), tgzOf('v1.2.0')])?.tag === 'v1.3.0')
check('a draft is skipped', pickInstallableRelease([releaseOf('v1.3.0', 'dsh-demo-1.3.0.tgz', true), tgzOf('v1.2.0')])?.tag === 'v1.2.0')
check('a release without a tarball is skipped', pickInstallableRelease([releaseOf('v1.3.0', 'dsh-demo-1.3.0.zip'), tgzOf('v1.2.0')])?.tag === 'v1.2.0')
check('an explicit tag narrows the choice', pickInstallableRelease([tgzOf('v1.3.0'), tgzOf('v1.2.0')], 'v1.2.0')?.tag === 'v1.2.0')
check('an explicit draft tag is refused', pickInstallableRelease([releaseOf('v1.3.0', 'x.tgz', true)], 'v1.3.0') === null)
check('nothing installable yields null', pickInstallableRelease([]) === null)
check('the tarball name is carried, not guessed', pickInstallableRelease([tgzOf('v1.3.0')])?.asset === 'dsh-demo-1.3.0.tgz')

/* A `link:` dependency by name. It points at a fixture checkout, so nothing here
   depends on what this machine has installed. */
writeManifest(profileDir, { name: 'dsh-profile-x', dependencies: { 'dsh-demo': `link:${checkoutDir}` } })
const linkInstall = readProfileInstall(profileDir, 'dsh-demo')
check('a linked dependency is found by name', linkInstall.present === true && linkInstall.kind === 'link', JSON.stringify(linkInstall))

/* The name alone is not enough: a checkout can publish under a name that is not its
   dependency key, which is the real shape of
   dsh-plugin-knowledge-console → dsh-knowledge-console. */
writeManifest(profileDir, { name: 'dsh-profile-x', dependencies: { 'dsh-renamed': `link:${otherCheckout}` } })
const byPath = readProfileInstall(profileDir, 'dsh-absent-from-the-manifest', otherCheckout)
check('a checkout found by path keeps its dependency name', byPath.present === true && byPath.packageName === 'dsh-renamed', JSON.stringify(byPath))

writeManifest(profileDir, { name: 'dsh-profile-x', dependencies: {} })
const absent = readProfileInstall(profileDir, 'dsh-demo')
check('an uninstalled package is reported absent', absent.present === false)
check('an uninstalled package still reports the profile is readable', absent.profileReadable === true)

/* A tarball install is the case where the version decides, and the unpacked copy
   under node_modules is what pnpm actually loaded — not the spec string. */
const installedDir = join(profileDir, 'node_modules', 'dsh-demo')
mkdirSync(installedDir, { recursive: true })
writeManifest(profileDir, { name: 'dsh-profile-x', dependencies: { 'dsh-demo': 'file:F:\\dl\\dsh-demo-1.2.0.tgz' } })
writeManifest(installedDir, { name: 'dsh-demo', version: '1.2.0' })
check('an installed tarball reports the version from node_modules', readProfileInstall(profileDir, 'dsh-demo').installedVersion === '1.2.0', JSON.stringify(readProfileInstall(profileDir, 'dsh-demo')))

const entry = { repo: 'dsh-plugin-demo', localPath: checkoutDir, label: '' }
/**
 * Describe one state: the profile's dependency, the version pnpm unpacked, and the
 * releases GitHub would report. All three decide the verdict together.
 */
const describeOf = (deps, releases, installedVersion = '1.2.0') => {
  writeManifest(profileDir, { name: 'dsh-profile-x', dependencies: deps })
  mkdirSync(installedDir, { recursive: true })
  writeManifest(installedDir, { name: 'dsh-demo', version: installedVersion })
  return describeInstall({ profileDir, profileName: 'desktop', entry, releases })
}

/* The consequence, not just the classification: a Windows-written `link:` spec whose
   version EQUALS the release must still be `checkout`. If it ever reads `current`
   again, the panel has gone back to telling a developer their profile runs the
   published artifact while it runs a checkout. */
check('a Windows-spelled link is a checkout even when the version matches', describeOf({ 'dsh-demo': 'link:F:\\CodeProj\\dsh-plugin-demo' }, [tgzOf('v1.2.0')], '1.2.0').state === 'checkout')
check('an installed copy behind the release offers an update', describeOf({ 'dsh-demo': 'file:F:\\dl\\dsh-demo-1.2.0.tgz' }, [tgzOf('v1.3.0')], '1.2.0').state === 'update')
check('an installed copy at the release version is current', describeOf({ 'dsh-demo': 'file:F:\\dl\\dsh-demo-1.3.0.tgz' }, [tgzOf('v1.3.0')], '1.3.0').state === 'current')
check('an installed copy past the release says so instead of offering a downgrade silently', describeOf({ 'dsh-demo': 'file:F:\\dl\\dsh-demo-2.0.0.tgz' }, [tgzOf('v1.3.0')], '2.0.0').state === 'ahead')
check('an unorderable version is not claimed to be behind', describeOf({ 'dsh-demo': 'file:F:\\dl\\dsh-demo-1.2.0-rc.1.tgz' }, [tgzOf('v1.3.0')], '1.2.0-rc.1').state === 'differs')
/* The state the version comparison cannot see: same version string, different code. */
check('a linked checkout is its own state, never "current"', describeOf({ 'dsh-demo': `link:${checkoutDir}` }, [tgzOf('v1.2.0')], '1.2.0').state === 'checkout')
check('a package that is not installed is not-installed', describeOf({}, [tgzOf('v1.3.0')]).state === 'not-installed')
check('a package with no release is no-release', describeOf({ 'dsh-demo': `link:${checkoutDir}` }, []).state === 'no-release')
check('the state rules answer without throwing on nulls', updateState(null, null) === 'not-installed' && updateState({ present: true, kind: 'registry' }, null) === 'no-release')
check('the checkout name wins over the repository name', describeOf({ 'dsh-demo': `link:${checkoutDir}` }, [tgzOf('v1.3.0')]).packageName === 'dsh-demo')
check('the release tag and asset reach the panel', describeOf({}, [tgzOf('v1.3.0')]).latestTag === 'v1.3.0' && describeOf({}, [tgzOf('v1.3.0')]).latestAsset === 'dsh-demo-1.3.0.tgz')
check('a profile path falls back to the environment', resolveProfileDir({ DSH_PROFILE_DIR: 'C:\\p' }) === 'C:\\p')
check('a missing environment still yields a path', /profiles[\\/]desktop$/.test(resolveProfileDir({ DSH_HOME: 'C:\\h', DSH_PROFILE: 'desktop' })), resolveProfileDir({ DSH_HOME: 'C:\\h', DSH_PROFILE: 'desktop' }))
check('an unreadable profile is reported, not thrown', readManifest(join(tmpdir(), '__dsh-cicd-nope__')) === null)

/* -- 10. The npm channel ----------------------------------------------------
   The push itself needs a registry and a credential, but almost none of its
   judgement does: which registry to talk to, whether a token line exists, whether a
   version is already published, and every reason a push must be refused are all pure
   functions of strings and objects — which is exactly what makes them worth pinning. */
check('a registry gains the trailing slash every URL assumes', normalizeRegistry('https://registry.npmjs.org') === 'https://registry.npmjs.org/')
check('an explicit registry is kept', normalizeRegistry('https://npm.pkg.github.com/') === 'https://npm.pkg.github.com/')
check('a registry with a path keeps it', normalizeRegistry('https://example.com/npm') === 'https://example.com/npm/')
check('a non-http registry falls back rather than being used', normalizeRegistry('ftp://example.com/') === 'https://registry.npmjs.org/')
/* A credential smuggled into a registry URL would end up on screen and in logs. */
check('credentials inside a registry URL are refused', normalizeRegistry('https://user:pass@example.com/') === 'https://registry.npmjs.org/')
check('an unparseable registry falls back', normalizeRegistry('not a url') === 'https://registry.npmjs.org/')
check('an empty registry falls back', normalizeRegistry('') === 'https://registry.npmjs.org/')
check('the auth key is the registry host and path', npmrcAuthKey('https://registry.npmjs.org') === '//registry.npmjs.org/')

check('no .npmrc means no token', hasNpmToken('', 'https://registry.npmjs.org/') === false)
check('a token line is found', hasNpmToken('//registry.npmjs.org/:_authToken=abc\n', 'https://registry.npmjs.org/') === true)
check('a token for another registry is not this one', hasNpmToken('//npm.pkg.github.com/:_authToken=abc\n', 'https://registry.npmjs.org/') === false)
check('a commented-out token is not a token', hasNpmToken('# //registry.npmjs.org/:_authToken=abc\n', 'https://registry.npmjs.org/') === false)
check('an empty token value is not a token', hasNpmToken('//registry.npmjs.org/:_authToken=\n', 'https://registry.npmjs.org/') === false)

const npmrcSource = 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=old\n//npm.pkg.github.com/:_authToken=other\n'
const npmrcUpdated = upsertAuthToken(npmrcSource, 'https://registry.npmjs.org/', 'new-token')
check('an existing token is replaced in place', npmrcUpdated.ok === true && npmrcUpdated.text.includes('//registry.npmjs.org/:_authToken=new-token'))
check('another registry\'s token is left alone', npmrcUpdated.text.includes('//npm.pkg.github.com/:_authToken=other'))
check('unrelated settings survive', npmrcUpdated.text.includes('registry=https://registry.npmjs.org/'))
check('the replacement is reported as such', npmrcUpdated.replaced === true)
check('the old token is gone, not duplicated', npmrcUpdated.text.includes('_authToken=old') === false)
const npmrcAppended = upsertAuthToken('registry=https://registry.npmjs.org/\n', 'https://registry.npmjs.org/', 'tok')
check('a missing token line is appended', npmrcAppended.ok === true && npmrcAppended.text.includes('_authToken=tok') && npmrcAppended.replaced === false)
/* `.npmrc` is line-oriented: a value that could start a line would let a pasted
   string become a second setting. */
check('a token that would forge a second line is refused', upsertAuthToken('', 'https://registry.npmjs.org/', 'abc\ndef').ok === false)
check('an empty token is refused', upsertAuthToken('', 'https://registry.npmjs.org/', '   ').ok === false)

check('an unknown name is unregistered', npmPackageState(null, '1.0.0').state === 'unregistered')
check('a published version is recognised', npmPackageState({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } }, '1.0.0').published === true)
check('a version that is not up there is unpublished', npmPackageState({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } }, '1.1.0').state === 'unpublished')
check('the latest tag is carried even when it is not this version', npmPackageState({ versions: {}, 'dist-tags': { latest: '2.0.0' } }, '1.0.0').latest === '2.0.0')
check('a malformed packument is unknown, not unregistered', npmPackageState('nope', '1.0.0').state === 'unknown')

const pushable = { packageName: 'x', version: '1.0.0', manifest: { private: false }, registryState: { state: 'unpublished', published: false, latest: '0.9.0' }, authed: true, dirty: 0 }
check('a clean, signed-in, unpublished package can be pushed', npmPublishVerdict(pushable).canPublish === true && npmPublishVerdict(pushable).blockers.length === 0)
for (const [blocker, override] of [
  ['private-package', { manifest: { private: true } }],
  ['not-logged-in', { authed: false }],
  ['dirty-tree', { dirty: 2 }],
  ['already-published', { registryState: { state: 'published', published: true, latest: '1.0.0' } }],
  ['registry-unreachable', { registryState: null }],
  ['no-version', { version: null }],
  ['no-checkout', { manifest: null }],
]) {
  const verdict = npmPublishVerdict({ ...pushable, ...override })
  check(`a push is refused when: ${blocker}`, verdict.canPublish === false && verdict.blockers.includes(blocker), verdict.blockers.join(',') || '(none)')
}
check('a refusal answers without throwing on nothing', npmPublishVerdict().canPublish === false)

/* Three states, because a granular token is scoped to packages and `whoami` is a
   user-level endpoint: it can refuse a token that publishes perfectly well. Reading
   that refusal as "not signed in" would tell a first-time publisher their brand-new
   token is not a credential — the worst place for a false negative. */
check('a confirmed account is signed-in', npmAuthState({ whoami: true, hasToken: true }) === 'signed-in')
check('whoami alone is enough', npmAuthState({ whoami: true, hasToken: false }) === 'signed-in')
check('a token line without whoami is still a credential', npmAuthState({ whoami: false, hasToken: true }) === 'credential-present')
check('nothing at all is the state the guide belongs to', npmAuthState({ whoami: false, hasToken: false }) === 'none')
check('the state helper answers on an empty call', npmAuthState() === 'none')
/* And the verdict must not refuse a push just because whoami stayed quiet. */
check('an unconfirmed credential still offers the push', npmPublishVerdict({ ...pushable, authed: true }).canPublish === true)

check('the user-level .npmrc is where npm looks', resolveNpmrcPath({ USERPROFILE: 'C:\\u' }) === join('C:\\u', '.npmrc'))
check('an explicit NPM_CONFIG_USERCONFIG wins', resolveNpmrcPath({ USERPROFILE: 'C:\\u', NPM_CONFIG_USERCONFIG: 'D:\\x\\.npmrc' }) === 'D:\\x\\.npmrc')

/* The package manager is reused, not re-found — the same principle as reusing `gh`
   instead of storing a token of this plugin's own. */
const profileInvocation = resolvePackageManagerInvocation({ get: () => ({ packageManager: { command: 'node.exe', args: ['pnpm.cjs'], env: { DSH_X: '1' } } }) })
check('the profile\'s own package manager is reused', profileInvocation.command === 'node.exe' && profileInvocation.args[0] === 'pnpm.cjs' && profileInvocation.source === 'profile')
check('its environment comes with it', profileInvocation.env.DSH_X === '1')
const fallbackInvocation = resolvePackageManagerInvocation({ get: () => undefined })
check('a Host without a profile still names something runnable', typeof fallbackInvocation.command === 'string' && fallbackInvocation.command !== '', fallbackInvocation.source)
check('the fallback reports where it got the answer', ['DSH_PNPM', 'bundled', 'path'].includes(fallbackInvocation.source), fallbackInvocation.source)

check('a directory that is not a checkout has no dirty count', (await readDirtyCount(join(tmpdir(), '__dsh-cicd-nope__'), 5_000)) === null)
check('an empty path has no dirty count', (await readDirtyCount('', 5_000)) === null)

/* -- 10b. What a failed publish means ----------------------------------------
   This is what makes the credential guide usable rather than decorative: npm's own
   words are jargon, and each of these five is a different next step on screen. The
   order of the rules matters — `E403` shows up inside the email and scope messages,
   so it must not be the first thing that matches. */
check('a one-time password demand is recognised', classifyPublishFailure('npm ERR! code EOTP\nThis operation requires a one-time password') === 'otp-required')
check('pnpm\'s own OTP error is recognised', classifyPublishFailure('[ERR_PNPM_OTP_REQUIRED] pass --otp') === 'otp-required')
check('an unverified email is recognised', classifyPublishFailure('npm ERR! 403 Forbidden - PUT … You must verify your email before publishing') === 'email-unverified')
check('an unverified email is not reported as a plain 403', classifyPublishFailure('E403 You must verify your email') === 'email-unverified')
check('a missing credential is recognised', classifyPublishFailure('npm ERR! code ENEEDAUTH') === 'not-logged-in')
check('a version conflict is recognised', classifyPublishFailure('npm ERR! code EPUBLISHCONFLICT cannot publish over previously published version') === 'already-published')
check('the paid-private-package refusal is recognised', classifyPublishFailure('npm ERR! 402 Payment Required — private packages require a paid account') === 'payment-required')
check('a scope refusal is recognised as forbidden', classifyPublishFailure('npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/x - You do not have permission') === 'forbidden')
check('a missing name is recognised', classifyPublishFailure('npm ERR! 404 Not Found - PUT https://registry.npmjs.org/x') === 'not-found')
check('rate limiting is recognised', classifyPublishFailure('npm ERR! 429 Too Many Requests') === 'rate-limited')
check('a registry 5xx is not blamed on the user', classifyPublishFailure('npm ERR! 503 Service Unavailable') === 'registry-error')
check('a network failure is recognised', classifyPublishFailure('request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND') === 'network')
check('unrecognised output is named unknown rather than guessed at', classifyPublishFailure('something else entirely') === 'unknown')
check('empty output is unknown, not a crash', classifyPublishFailure('') === 'unknown' && classifyPublishFailure(undefined) === 'unknown')

/* The read that decides whether a version is already on npm goes through a CDN with
   `max-age=300` — measured, a plain GET came back with `age: 116`, so for up to five
   minutes after a successful publish the panel still described the previous state and
   kept offering a push the registry would refuse. */
check('the packument is read from the origin, not a five-minute-old CDN copy', packumentUrl('https://registry.npmjs.org/', 'dsh-plugin-restart') === 'https://registry.npmjs.org/dsh-plugin-restart?write=true')

/* The names a 提交 would carry, read out of `git status --porcelain`. This list is what
   makes `git add -A` an informed action rather than a blind sweep, so the two shapes
   that actually occur — a status prefix, and a rename — have to come out readable. */
check('a modified file keeps only its path', statusPath(' M package.json') === 'package.json')
check('an untracked file keeps only its path', statusPath('?? notes.md') === 'notes.md')
check('a staged file keeps only its path', statusPath('A  src/new.js') === 'src/new.js')
check('a rename is passed through as git spelled it', statusPath('R  old.md -> new.md') === 'old.md -> new.md')
check('a line too short to hold a path is not sliced into nonsense', statusPath('??') === '??')
check('a registry that already carries a query keeps the name out of it', packumentUrl('https://r.example/npm/?a=1', 'x') === 'https://r.example/npm/x?a=1&write=true')

/* The address a 克隆 would use, derived rather than demanded: being asked to paste the
   clone URL of a repository the Host can already name is exactly the kind of step this
   console exists to remove. */
check('an owner/repo id gives its own address', defaultCloneUrl('', 'SOH4C4759/dsh-ui-sound') === 'https://github.com/SOH4C4759/dsh-ui-sound.git')
check('a bare name uses the configured owner', defaultCloneUrl('octocat', 'Hello-World') === 'https://github.com/octocat/Hello-World.git')
check('a bare name with no owner has no address to guess at', defaultCloneUrl('', 'Hello-World') === '')
check('no repository, no address', defaultCloneUrl('octocat', '') === '' && defaultCloneUrl(undefined, undefined) === '')
check('a stray slash is tidied rather than doubled', defaultCloneUrl('', '/octocat/Hello-World/') === 'https://github.com/octocat/Hello-World.git')

/* Accepted is not the same as readable. Bilibili answers `code: 0` with an rpid for a
   comment the public listing may never serve, and two of these were filed as announced
   and then answered `12006 没有该评论` when looked up.
   The waiting is measured, not superstition: a fresh comment answers 12006 immediately
   and reads back from about four seconds, so a single check would libel a good comment. */
{
  const scripted = (answers) => {
    let calls = 0
    return {
      read: async () => {
        const answer = answers[Math.min(calls, answers.length - 1)]
        calls += 1
        return answer
      },
      calls: () => calls,
    }
  }
  const waits = []
  const wait = async (ms) => { waits.push(ms) }

  const delayed = scripted([
    { ok: true, visible: false, code: 12006, message: '没有该评论' },
    { ok: true, visible: false, code: 12006, message: '没有该评论' },
    { ok: true, visible: true, code: 0, message: '' },
  ])
  const late = await confirmVisible({ read: delayed.read, aid: 1, rpid: '2', attempts: 3, delayMs: 3000, wait })
  check('a comment that appears late is still confirmed', late.visible === true && late.attempts === 3, JSON.stringify(late))
  check('and it waited between the asks rather than hammering', waits.length === 2 && waits[0] === 3000, JSON.stringify(waits))

  const never = scripted([{ ok: true, visible: false, code: 12006, message: '没有该评论' }])
  const missing = await confirmVisible({ read: never.read, aid: 1, rpid: '2', attempts: 3, delayMs: 0, wait })
  check('a comment that never appears is reported as not visible', missing.visible === false && missing.attempts === 3, JSON.stringify(missing))
  check('and Bilibili\'s own reason comes with it', missing.code === 12006 && missing.message === '没有该评论', JSON.stringify(missing))

  const first = scripted([{ ok: true, visible: true, code: 0, message: '' }])
  const immediate = await confirmVisible({ read: first.read, aid: 1, rpid: '2', attempts: 3, delayMs: 3000, wait })
  check('a comment that is already readable costs one call', immediate.visible === true && first.calls() === 1, String(first.calls()))

  /* A transport failure is not a verdict: it is asked again like any other miss. */
  const broken = scripted([{ ok: false, visible: false, code: null, message: 'HTTP 500' }])
  const failed = await confirmVisible({ read: broken.read, aid: 1, rpid: '2', attempts: 2, delayMs: 0, wait })
  check('a transport failure is retried and then reported honestly', failed.visible === false && broken.calls() === 2, JSON.stringify(failed))
  const tolerated = await confirmVisible({ read: async () => undefined, aid: 1, rpid: '2', attempts: 2, delayMs: 0, wait })
  check('a reader that answers nothing at all does not crash the check', tolerated.visible === false, JSON.stringify(tolerated))
}

/* The line the panel shows. Captured from a real `pnpm publish` of an
   already-published version: every byte goes to STDOUT (measured: stderr = 0), the
   first line is the progress line, the rest is a stack trace, and node's own
   `Command failed: <the whole command>` is what a naive "first line" picks up. */
const realConflictOutput = [
  '📦 dsh-plugin-restart@1.0.1 → https://registry.npmjs.org/',
  '[E403] 403 Forbidden - PUT https://registry.npmjs.org/dsh-plugin-restart - You cannot publish over the previously published versions: 1.0.1.',
  '',
  'pnpm: 403 Forbidden - PUT https://registry.npmjs.org/dsh-plugin-restart - You cannot publish over the previously published versions: 1.0.1.',
  '    at file:///C:/Users/Administrator/AppData/Local/Programs/DeepSeek%20Harness/resources/runtime/pnpm/dist/pnpm.mjs:257427:17',
  '    at async publish3 (file:///C:/Users/Administrator/AppData/Local/Programs/DeepSeek%20Harness/resources/runtime/pnpm/dist/pnpm.mjs:281124:19)',
].join('\n')
const shown = firstMeaningfulLine(realConflictOutput, 'the publish failed')
check('the reason is shown, not the progress line', shown.startsWith('[E403] 403 Forbidden'), shown)
check('the shown line carries the actual reason', shown.includes('cannot publish over the previously published versions'))
check('the progress line is not mistaken for the error', shown.startsWith('📦') === false)
check('a stack frame is never the answer', /^\s*at /.test(shown) === false)
check('node\'s command-line wrapper never reaches the panel', shown.startsWith('Command failed:') === false)
check('pnpm\'s own sentence is used when there is no coded line', firstMeaningfulLine('📦 x@1.0.0 → reg\n\npnpm: something went wrong\n    at x.js:1:1').startsWith('pnpm: something went wrong'))
check('the wrapper is skipped when it is all there is', firstMeaningfulLine('Command failed: pnpm publish', 'the publish failed') === 'the publish failed')
check('nothing usable answers with the caller\'s sentence', firstMeaningfulLine('', 'the publish failed') === 'the publish failed')
check('stdout is searched at all, so an empty stderr cannot hide the reason', firstMeaningfulLine('[ERR_PNPM_WHOAMI_UNAUTHORIZED] You must be logged in to use whoami', 'x').startsWith('[ERR_PNPM_WHOAMI_UNAUTHORIZED]'))
check('a failed result is read across both streams', commandFailureLine({ stdout: realConflictOutput, stderr: '', error: 'Command failed: <the whole command>' }, 'the publish failed').startsWith('[E403]'))
check('the child-process error is the last resort, not the first line', commandFailureLine({ stdout: '', stderr: '', error: 'Command failed: pnpm publish' }, 'the publish failed') === 'Command failed: pnpm publish')
check('a spawn failure with no message still says something', commandFailureLine({}, 'the publish failed') === 'the publish failed')

/* -- 11. Live checks (opt-in) ----------------------------------------------- */
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
