#!/usr/bin/env node
/**
 * Checks for 发布同台 — the pipeline behind one press of 发布.
 *
 * The three pushes it performs are `git`, `gh` and `pnpm`, none of which a test
 * can drive: a real release takes minutes, publishes something the whole world
 * sees, and cannot be taken back. So every outside action is injected, and what
 * is proved here is the part that would otherwise be folklore:
 *
 *   - the ORDER (push before version, npm before the draft goes public);
 *   - the REFUSALS (a dirty tree with no message, a build that failed, an npm
 *     refusal that must not leave a public release behind);
 *   - the RESTART story (a pipeline that was running when the Host stopped is
 *     found again in the file and resumed);
 *   - that a one-time password is never written into that file.
 *
 *   node tests/pipeline-check.mjs
 *   node /tmp/asset/package/tests/pipeline-check.mjs /tmp/asset/package
 */

import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  STAGE_IDS,
  createPipelineRunner,
  emptyPipelines,
  findPipeline,
  forgetPipeline,
  matchRun,
  newPipeline,
  normalizePipeline,
  npmOutcomeVerdict,
  parsePipelines,
  pendingStage,
  pipelineFinished,
  recordPipeline,
} from '../lib/pipeline.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = resolve(process.argv[2] ?? join(here, '..'))
const module = await import(pathToFileURL(join(packageRoot, 'index.js')).href)

const results = []
let failed = 0
function check(label, condition, detail = '') {
  const pass = condition === true
  if (!pass) failed += 1
  results.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `   — ${detail}`}`)
}

/* ------------------------------------------------------------------ records -- */

const empty = parsePipelines('')
check('an absent file parses as no pipelines, not as a problem', empty.ok === true && Object.keys(empty.pipelines.repos).length === 0)

const broken = parsePipelines('{ not json')
check('a file that is not JSON is a reported problem', broken.ok === false && broken.message.includes('not valid JSON'), broken.message)

const wrongShape = parsePipelines('{"repos": []}')
check('a "repos" array is refused rather than ignored', wrongShape.ok === false, wrongShape.message)

const draft = newPipeline({ repo: 'octocat/Hello-World', slug: 'octocat/Hello-World', startedAt: '2026-01-01T00:00:00.000Z' })
check('a new pipeline has every stage pending, in order', draft.stages.map((stage) => stage.id).join(',') === STAGE_IDS.join(','), draft.stages.map((stage) => stage.id).join(','))
check('the first pending stage of a new pipeline is the code push', pendingStage(draft) === 'push')
check('a new pipeline is not finished', pipelineFinished(draft) === false)

const stored = recordPipeline(emptyPipelines(), { ...draft, status: 'running', updatedAt: '2026-01-01T00:00:01.000Z' })
const roundTrip = parsePipelines(JSON.stringify(stored)).pipelines
const readBack = findPipeline(roundTrip, 'octocat/Hello-World')
check('a pipeline survives the file it is written to', readBack !== null && readBack.repo === 'octocat/Hello-World', JSON.stringify(readBack ?? {}).slice(0, 80))
check('an unknown repository has no pipeline', findPipeline(roundTrip, 'nobody/nothing') === null)

const withoutStages = normalizePipeline({ repo: 'a/b', status: 'running', runId: 7 }, 'a/b')
check('a record written before the stages existed is rebuilt, not dropped', withoutStages !== null && withoutStages.stages.length === STAGE_IDS.length && withoutStages.runId === 7)
check('a nonsense status becomes a failed one rather than leaking through', normalizePipeline({ repo: 'a/b', status: 'wat' }, 'a/b').status === 'failed')

let crowded = emptyPipelines()
for (let index = 0; index < 45; index += 1) {
  crowded = recordPipeline(crowded, { ...newPipeline({ repo: `o/r${index}` }), status: 'done', updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z` }, { maxEntries: 40 })
}
check('the file is bounded', Object.keys(crowded.repos).length === 40, String(Object.keys(crowded.repos).length))

let protecting = emptyPipelines()
for (let index = 0; index < 5; index += 1) {
  protecting = recordPipeline(protecting, { ...newPipeline({ repo: `o/done${index}` }), status: 'done', updatedAt: `2026-01-01T00:00:0${index}.000Z` }, { maxEntries: 2 })
}
check('a half-finished pipeline is not dropped to make room for finished ones', Object.keys(protecting.repos).some((key) => key === 'o/done0') === false && Object.keys(protecting.repos).length === 2)

const forgotten = forgetPipeline(stored, 'octocat/Hello-World')
check('a pipeline can be forgotten', Object.keys(forgotten.repos).length === 0)

/* -------------------------------------------------------------- decisions -- */

check('an npm publish that worked continues the pipeline', npmOutcomeVerdict({ ok: true }).action === 'continue')
check('a private package is skipped, not held', npmOutcomeVerdict({ ok: false, code: 'private-package', message: 'x' }).action === 'skip')
check('a version that is already on npm counts as satisfied', npmOutcomeVerdict({ ok: false, code: 'already-published', message: 'x' }).action === 'skip')
check('a missing one-time password holds the draft', npmOutcomeVerdict({ ok: false, code: 'otp-required', message: 'EOTP' }).action === 'hold')
check('a registry that cannot be reached holds the draft', npmOutcomeVerdict({ ok: false, code: 'registry-unreachable', message: 'x' }).action === 'hold')
check('an unrecognised refusal holds rather than publishes', npmOutcomeVerdict({ ok: false, code: 'something-new', message: 'x' }).action === 'hold')

const runs = [
  { id: 1, headSha: 'AAAA', status: 'completed', conclusion: 'success' },
  { id: 2, headSha: 'bbbb', status: 'in_progress', conclusion: '' },
]
check('a run is matched on the pushed commit', matchRun(runs, 'bbbb')?.id === 2)
check('a run is matched whatever case the sha is written in', matchRun(runs, 'aaaa')?.id === 1)
check('a run for another commit is not mistaken for this one', matchRun(runs, 'cccc') === null)
check('an unknown commit matches nothing', matchRun(runs, '') === null)
check('a run without a head sha is not a match', matchRun([{ id: 3 }], 'aaaa') === null)

/* ----------------------------------------------------------------- runner -- */

/**
 * A Host whose every outside action is a function in this file.
 *
 * `calls` is the record of what the pipeline asked for and in what order — which
 * is the actual subject of these checks. The overrides let one test change one
 * answer (the npm refusal, the build conclusion) without touching the rest.
 */
function harness(overrides = {}) {
  const calls = []
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  const effects = {
    inspect: async (input) => {
      calls.push({ what: 'inspect', input })
      if (typeof overrides.inspect === 'function') return overrides.inspect(input)
      return { ok: true, sha: 'sha-pushed' }
    },
    runStage: async (input) => {
      calls.push({ what: 'stage', stage: input.stage, input })
      if (typeof overrides.runStage === 'function') {
        const answer = overrides.runStage(input)
        if (answer !== undefined) return answer
      }
      if (input.stage === 'push') return { ok: true, sha: 'sha-pushed', detail: '3 个改动已提交并推送' }
      if (input.stage === 'version') return { ok: true, tag: 'v1.2.4', version: '1.2.4', sha: 'sha-bumped', detail: '版本 1.2.3 → 1.2.4' }
      if (input.stage === 'dispatch') return { ok: true, detail: 'release.yml 已触发' }
      if (input.stage === 'release') return { ok: true, detail: '草稿已公开' }
      return { ok: true, detail: '' }
    },
    findRun: async (input) => {
      calls.push({ what: 'findRun', input })
      if (typeof overrides.findRun === 'function') return overrides.findRun(input)
      return { state: 'found', run: { id: 4242, status: 'completed', conclusion: 'success', url: 'https://example.test/run/4242' } }
    },
    publishNpm: async (input) => {
      calls.push({ what: 'npm', input })
      if (typeof overrides.publishNpm === 'function') return overrides.publishNpm(input)
      return { ok: true, detail: '已推送到 npm' }
    },
    announce: (input) => {
      calls.push({ what: 'announce', input })
    },
  }
  const runner = createPipelineRunner({
    effects,
    onChange: () => {},
    now: () => clock,
    appearTimeoutMs: 60_000,
    buildTimeoutMs: 120_000,
    totalTimeoutMs: 600_000,
  })
  return {
    runner,
    calls,
    saw: (what, stage = '') => calls.some((call) => call.what === what && (stage === '' || call.stage === stage)),
    order: () => calls.map((call) => call.stage ?? call.what),
    advanceClock: (ms) => { clock += ms },
  }
}

const good = harness()
const started = await good.runner.start({ repo: 'octocat/Hello-World', slug: 'octocat/Hello-World', message: 'feat: a distinctive message' })
check('starting runs the three stages that do not need CI', good.order().join(',') === 'inspect,push,version,dispatch', good.order().join(','))
check('the order is code push, then version, then dispatch', good.calls.filter((call) => call.what === 'stage').map((call) => call.stage).join(',') === 'push,version,dispatch')
check('the commit message reaches the push stage', good.calls[1].input.message === 'feat: a distinctive message')
check('a started pipeline is running and waiting on the build', started.status === 'running' && pendingStage(started) === 'build', `${started.status}/${String(pendingStage(started))}`)
check('the version the bump produced is carried to the dispatch', good.calls.find((call) => call.stage === 'dispatch').input.tag === 'v1.2.4', String(good.calls.find((call) => call.stage === 'dispatch').input.tag))
check('the pushed commit is remembered, not the one before the bump', started.headSha === 'sha-bumped', String(started.headSha))

const finished = await good.runner.advance(started)
check('advancing past the build runs npm, then makes the draft public', good.calls.filter((call) => call.what === 'npm' || call.stage === 'release').length === 2)
check('npm is pushed BEFORE the release is made public', good.order().indexOf('npm') < good.order().indexOf('release'), good.order().join(','))
check('the release is announced only after it is public', good.order().indexOf('release') < good.order().indexOf('announce'), good.order().join(','))
check('a finished pipeline reports every stage done', finished.stages.every((stage) => stage.status === 'done'), finished.stages.map((stage) => `${stage.id}:${stage.status}`).join(','))
check('a finished pipeline says so', finished.status === 'done' && pipelineFinished(finished) === true)
check('advancing a finished pipeline changes nothing', (await good.runner.advance(finished)).status === 'done')

/* The draft is what makes the order possible: the dispatch has to ask for one. */
check('the dispatch carries the tag the workflow will build', started.tag === 'v1.2.4' && started.version === '1.2.4', `${String(started.tag)}/${String(started.version)}`)

/* --- refusals, all before anything is pushed --- */

const behind = harness({ inspect: () => ({ ok: false, code: 'behind', message: 'the branch is 2 commit(s) behind its upstream; pull before releasing' }) })
const refused = await behind.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' })
check('a checkout behind its upstream is refused', refused.status === 'failed' && refused.blockedCode === 'behind', String(refused.blockedCode))
check('a refused pipeline pushes nothing', behind.saw('stage') === false, behind.order().join(','))

const noCheckout = harness({ inspect: () => ({ ok: false, code: 'no-checkout', message: 'no working tree' }) })
check('a repository with no checkout is refused', (await noCheckout.runner.start({ repo: 'a/b', slug: 'a/b' })).blockedCode === 'no-checkout')

const pushRefused = harness({ runStage: (input) => (input.stage === 'push' ? { ok: false, code: 'message-required', message: 'a commit needs a message' } : undefined) })
const notPushed = await pushRefused.runner.start({ repo: 'a/b', slug: 'a/b', message: '' })
check('a push that is refused stops the pipeline there', notPushed.status === 'failed' && notPushed.blockedCode === 'message-required', String(notPushed.blockedCode))
check('nothing after a refused push is attempted', pushRefused.order().join(',') === 'inspect,push', pushRefused.order().join(','))
check('the failed stage is the one that failed', notPushed.stages.find((stage) => stage.id === 'push').status === 'failed')

/* --- the build --- */

const slow = harness({ findRun: () => ({ state: 'waiting' }) })
const waiting = await slow.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' })
check('a build that has not finished leaves the pipeline running', waiting.status === 'running' && pendingStage(waiting) === 'build')
check('starting does not ask GitHub about a run it just triggered', slow.calls.filter((call) => call.what === 'findRun').length === 0, String(slow.calls.filter((call) => call.what === 'findRun').length))
await slow.runner.advance(waiting)
check('each tick asks GitHub once', slow.calls.filter((call) => call.what === 'findRun').length === 1, String(slow.calls.filter((call) => call.what === 'findRun').length))
slow.advanceClock(180_000)
const tooSlow = await slow.runner.advance(waiting)
check('a build that never ends is given up on', tooSlow.status === 'failed' && tooSlow.blockedCode === 'build-timeout', String(tooSlow.blockedCode))
check('nothing is published when the build timed out', slow.saw('npm') === false && slow.saw('stage', 'release') === false)

const lost = harness({ findRun: () => ({ state: 'missing' }) })
const neverAppeared = await lost.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' })
lost.advanceClock(120_000)
const lostRun = await lost.runner.advance(neverAppeared)
check('a dispatch that never became a run is reported as such', lostRun.status === 'failed' && lostRun.blockedCode === 'run-not-found', String(lostRun.blockedCode))

const redBuild = harness({ findRun: () => ({ state: 'found', run: { id: 9, status: 'completed', conclusion: 'failure', url: 'u' } }) })
const failedBuild = await redBuild.runner.advance(await redBuild.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' }))
check('a failed build stops the pipeline', failedBuild.status === 'failed' && failedBuild.blockedCode === 'build-failed', String(failedBuild.blockedCode))
check('a failed build publishes nothing', redBuild.saw('npm') === false && redBuild.saw('stage', 'release') === false)
check('a failed build is announced to nobody', redBuild.saw('announce') === false)
check('the run that failed is still named', failedBuild.runId === 9 && failedBuild.runUrl === 'u', `${String(failedBuild.runId)}/${String(failedBuild.runUrl)}`)

const running = harness({ findRun: () => ({ state: 'found', run: { id: 11, status: 'in_progress', conclusion: '', url: 'u2' } }) })
const building = await running.runner.advance(await running.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' }))
check('a build still running is waited on, and its run id is kept', building.status === 'running' && building.runId === 11, `${building.status}/${String(building.runId)}`)

/* --- npm holds the draft, and a resume finishes it --- */

const held = harness({ publishNpm: () => ({ ok: false, code: 'otp-required', message: 'EOTP — this operation requires a one-time password' }) })
const blocked = await held.runner.advance(await held.runner.start({ repo: 'a/b', slug: 'a/b', message: 'feat: a distinctive message', otp: '123456' }))
check('an npm refusal holds the pipeline', blocked.status === 'blocked' && blocked.blockedCode === 'otp-required', String(blocked.blockedCode))
check('the one-time password offered up front is used', held.calls.find((call) => call.what === 'npm').input.otp === '123456')
check('the draft stays a draft while npm is refused', held.saw('stage', 'release') === false)
check('nothing is announced about a draft', held.saw('announce') === false)
check('the held stage is named in the record', blocked.stages.find((stage) => stage.id === 'npm').status === 'blocked')
check('a one-time password is never written into the record', JSON.stringify(blocked).includes('123456') === false)
check('the commit message is never written into the record either', JSON.stringify(blocked).includes('feat: a distinctive message') === false)

/* `resume` advances as well, so the record it returns is the finished one. */
const resumed = await held.runner.resume(blocked, { skipNpm: true })
check('a blocked pipeline that is told to skip npm goes public anyway', resumed.status === 'done' && resumed.stages.find((stage) => stage.id === 'npm').status === 'skipped', `${resumed.status}/${resumed.stages.find((stage) => stage.id === 'npm').status}`)
check('skipping npm still publishes the release', held.saw('stage', 'release') === true)
check('skipping npm still announces the release', held.saw('announce') === true)
check('a skipped npm stage does not ask the registry at all', held.calls.filter((call) => call.what === 'npm').length === 1, String(held.calls.filter((call) => call.what === 'npm').length))

const retried = harness({ publishNpm: (input) => (input.otp === '777777' ? { ok: true, detail: '已推送' } : { ok: false, code: 'otp-required', message: 'EOTP' }) })
const blockedAgain = await retried.runner.advance(await retried.runner.start({ repo: 'a/b', slug: 'a/b', message: 'm' }))
check('a pipeline with no one-time password is held the same way', blockedAgain.status === 'blocked')
const finishedResume = await retried.runner.resume(blockedAgain, { otp: '777777' })
check('a fresh one-time password finishes the same pipeline', finishedResume.status === 'done', finishedResume.status)
check('the release is published only after npm accepted it', retried.order().indexOf('npm') < retried.order().indexOf('release'), retried.order().join(','))
check('the resume advanced immediately rather than waiting for a tick', retried.calls.filter((call) => call.what === 'npm').length === 2, String(retried.calls.filter((call) => call.what === 'npm').length))

/* --- npm not applicable --- */

const privatePkg = harness({ publishNpm: () => ({ ok: false, code: 'private-package', message: '"private": true' }) })
const privateDone = await privatePkg.runner.advance(await privatePkg.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' }))
check('a package npm will never take does not block its release', privateDone.status === 'done', privateDone.status)
check('the npm stage says it was skipped, not that it succeeded', privateDone.stages.find((stage) => stage.id === 'npm').status === 'skipped')

const already = harness({ publishNpm: () => ({ ok: false, code: 'already-published', message: 'already on npm' }) })
check('a version somebody already pushed counts as satisfied', (await already.runner.advance(await already.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' }))).status === 'done')

/* --- cancellation and the ceiling --- */

const cancelled = harness({ findRun: () => ({ state: 'waiting' }) })
const toCancel = await cancelled.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' })
const stopped = cancelled.runner.cancel(toCancel)
check('a pipeline can be stopped', stopped.status === 'cancelled' && pipelineFinished(stopped) === true)
check('a cancelled pipeline does not advance', (await cancelled.runner.advance(stopped)).status === 'cancelled')

const old = harness({ findRun: () => ({ state: 'waiting' }) })
const ancient = await old.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' })
old.advanceClock(601_000)
const expired = await old.runner.advance(ancient)
check('a pipeline that outlived its ceiling is failed, not left running', expired.status === 'failed' && expired.blockedCode === 'pipeline-timeout', String(expired.blockedCode))

/* --- a Host restart in the middle --- */

const restarting = harness({ findRun: () => ({ state: 'waiting' }) })
const beforeRestart = await restarting.runner.start({ repo: 'a/b', slug: 'a/b', message: 'x' })
const file = JSON.stringify(recordPipeline(emptyPipelines(), beforeRestart))
const reloaded = findPipeline(parsePipelines(file).pipelines, 'a/b')
check('a running pipeline survives a restart through the file', reloaded !== null && reloaded.status === 'running' && reloaded.headSha === 'sha-bumped', JSON.stringify(reloaded ?? {}).slice(0, 60))
const afterRestart = harness()
const completed = await afterRestart.runner.advance(reloaded)
check('a pipeline found after a restart is finished, not restarted', completed.status === 'done' && afterRestart.saw('stage', 'push') === false, afterRestart.order().join(','))
check('the version it was already on is the one that is published', afterRestart.calls.find((call) => call.stage === 'release')?.input.tag === 'v1.2.4', String(afterRestart.calls.find((call) => call.stage === 'release')?.input.tag))

/* --------------------------------------------------------------- the config -- */

const on = module.resolveConfig({})
check('one press of 发布 means all three pushes by default', on.oneClickRelease === true)
check('the pipeline can be turned off', module.resolveConfig({ oneClickRelease: false }).oneClickRelease === false)
check('the watch interval has a default', on.pipelineWatchSeconds === 20, String(on.pipelineWatchSeconds))
check('a nonsense watch interval falls back', module.resolveConfig({ pipelineWatchSeconds: 'soon' }).pipelineWatchSeconds === 20)
check('the watch interval can be turned off', module.resolveConfig({ pipelineWatchSeconds: 0 }).pipelineWatchSeconds === 0)

const passed = results.length - failed
console.log(`\n${passed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
