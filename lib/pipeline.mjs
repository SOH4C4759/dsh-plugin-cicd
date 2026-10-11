/**
 * 发布同台 — the ordered pipeline behind one press of 发布.
 *
 * The console could always do the three pushes; what it could not do was do them
 * as one thing. 发布 only dispatched the release workflow (which builds a DRAFT),
 * npm was a separate button on purpose, and the code push was a third. So "按下
 * 发布" meant three different things depending on which of them a person
 * remembered, and the state left behind when one of them was skipped — a draft
 * nobody published, a version on npm with no release, a release built from a
 * commit GitHub had not received — looked exactly like success from the row.
 *
 * This module is the pipeline that makes one press equal all three. It is pure
 * decision plus injected effects (the same shape `lib/bilibili.mjs` uses) because
 * the real effects are `git`, `gh` and `pnpm`, and none of them can be driven
 * from a test: what has to be provable offline is the ORDER, the refusals, and
 * what happens when one stage of three fails.
 *
 * ## The order, and why it is this order
 *
 *   代码推送 → 版本号 → 触发构建 → 等待构建 → npm 推送 → 公开 Release → B 站播报
 *
 *   - 代码推送 and 版本号 come first because both workflows run the PUSHED
 *     commit: work that is only in the working tree, or only on this machine, is
 *     invisible to a release. The version bump is second and not first because it
 *     writes a commit, and this plugin refuses to bump a dirty tree — so the tree
 *     has to be clean and pushed before the version can move.
 *   - 触发构建 asks for a DRAFT. A draft is invisible to everybody but the
 *     author, which is what makes the last two stages possible at all.
 *   - npm 推送 comes BEFORE 公开 Release, and that is the whole point of the
 *     order: a publish is irreversible (npm never accepts the same version twice)
 *     while a draft is not. If npm refuses — a missing one-time password, a
 *     revoked token, a registry that cannot be reached — the release stays a
 *     draft and the public state of the world is unchanged, so the pipeline can
 *     be resumed once the reason is gone. 公开 first would leave "the release is
 *     out but npm has nothing", which no retry can tidy up.
 *   - 公开 Release is therefore the last irreversible step, and B 站播报 follows
 *     it because a comment saying "这个版本上线了" is only true once it is.
 *
 * ## Which npm failures hold the release and which do not
 *
 * A repository that will never be on npm must still be releasable: a package
 * marked `private`, or a checkout with no `package.json`, is "not applicable",
 * not "broken". So the npm stage has three outcomes — continue, skip, hold —
 * and only HOLD keeps the draft unpublished. `already-published` counts as
 * satisfied: the goal state ("this version is on npm") already holds.
 *
 * @module dsh-plugin-cicd/lib/pipeline
 */

/** The record file, beside `repos.json` and the Bilibili ledger. */
export const PIPELINE_FILE_NAME = 'pipelines.json'

/** Schema version of that file. */
export const PIPELINE_SCHEMA = 1

/** There is one pipeline per repository; this bounds the file across many. */
export const MAX_PIPELINES = 40

/**
 * The stages, in the order they run.
 *
 * The panel renders exactly this list, so it is also the answer to "what is this
 * button about to do" — which is why the ids are stable and the labels live in
 * the client's locale rather than here.
 */
export const STAGE_IDS = ['push', 'version', 'dispatch', 'build', 'npm', 'release', 'announce']

const STAGE_STATUSES = new Set(['pending', 'active', 'done', 'skipped', 'blocked', 'failed', 'cancelled'])
const PIPELINE_STATUSES = new Set(['running', 'blocked', 'done', 'failed', 'cancelled'])
const TERMINAL_STAGES = new Set(['done', 'skipped', 'failed', 'cancelled'])
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled'])

/**
 * npm refusals that mean "this repository is not on npm, and that is fine".
 *
 * `already-published` is here rather than among the failures because it is the
 * goal state reached by somebody else's push (or an earlier run of this one): the
 * version the pipeline promised is on the registry, so holding the release back
 * would be holding it back over a requirement that is already met.
 */
export const NPM_SKIPPABLE_CODES = new Set([
  'private-package',
  'no-package-name',
  'no-version',
  'no-checkout',
  'already-published',
  'npm-not-applicable',
])

/** Trim a value that should be a non-empty string, or return the fallback. */
function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** A fresh, empty record file. */
export function emptyPipelines() {
  return { version: PIPELINE_SCHEMA, repos: {} }
}

/**
 * Parse the record file tolerantly.
 *
 * `ok: false` means "this file is not usable at all", and the caller must say so
 * rather than pretend there are no pipelines: the file is how a pipeline that is
 * halfway through (the build is running; the draft is waiting on npm) is found
 * again after a restart. Losing it would leave a draft nobody publishes, which is
 * the failure this whole feature exists to remove.
 *
 * @param {unknown} raw - file contents.
 * @returns {{ok: boolean, pipelines: object, message: string}}
 */
export function parsePipelines(raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, pipelines: emptyPipelines(), message: '' }
  }
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { ok: false, pipelines: emptyPipelines(), message: `not valid JSON: ${error.message}` }
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, pipelines: emptyPipelines(), message: 'expected an object' }
  }
  const declared = parsed.repos
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    if (declared === undefined) return { ok: true, pipelines: emptyPipelines(), message: '' }
    return { ok: false, pipelines: emptyPipelines(), message: 'expected a "repos" object' }
  }
  const repos = {}
  for (const [repo, value] of Object.entries(declared)) {
    const normalized = normalizePipeline(value, repo)
    if (normalized !== null) repos[repo] = normalized
  }
  return { ok: true, pipelines: { version: PIPELINE_SCHEMA, repos }, message: '' }
}

/**
 * Coerce one stored pipeline back into the working shape.
 *
 * A record with no usable stages is rebuilt from `STAGE_IDS` rather than dropped:
 * the interesting fields (`runId`, `tag`, `status`) are what a resumed pipeline
 * needs, and an older record without a stage list should still be resumable.
 *
 * @param {unknown} value - one stored record.
 * @param {string} repo - the key it was stored under.
 * @returns {object|null} the normalized record, or null when it is not one.
 */
export function normalizePipeline(value, repo = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const key = text(value.repo, text(repo))
  if (key === '') return null
  const stages = []
  const declared = Array.isArray(value.stages) ? value.stages : []
  for (const id of STAGE_IDS) {
    const stored = declared.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.id === id)
    const status = STAGE_STATUSES.has(stored?.status) ? stored.status : 'pending'
    stages.push({ id, status, detail: text(stored?.detail), at: text(stored?.at) })
  }
  const status = PIPELINE_STATUSES.has(value.status) ? value.status : 'failed'
  return {
    id: text(value.id, `pl-${key}`),
    repo: key,
    slug: text(value.slug),
    tag: text(value.tag) || null,
    version: text(value.version) || null,
    headSha: text(value.headSha) || null,
    startedAt: text(value.startedAt) || null,
    updatedAt: text(value.updatedAt) || null,
    status,
    message: text(value.message),
    /** The npm refusal that is holding the draft, when one is. */
    blockedCode: text(value.blockedCode) || null,
    runId: Number.isInteger(value.runId) ? value.runId : null,
    runUrl: text(value.runUrl) || null,
    runConclusion: text(value.runConclusion) || null,
    /**
     * Whether the npm stage was deliberately skipped by a person ("public the
     * release anyway"). Not persisted as a default for the NEXT pipeline: a fresh
     * one always tries npm again, and the value only survives a resume.
     */
    skipNpm: value.skipNpm === true,
    stages,
  }
}

/**
 * The pipeline recorded for one repository, if any.
 * @param {object} pipelines - parsed record.
 * @param {string} repo - repository.
 * @returns {object|null} the record.
 */
export function findPipeline(pipelines, repo) {
  const repos = pipelines !== null && typeof pipelines === 'object' ? pipelines.repos : null
  if (repos === null || typeof repos !== 'object') return null
  return normalizePipeline(repos[repo], repo)
}

/**
 * Store one pipeline, keeping the file bounded.
 *
 * The file is keyed by repository, not appended to, because there is only ever one
 * pipeline per repository — the one a second press would have to join or refuse.
 * Bound is applied by dropping the oldest terminal records first: a HALF-FINISHED
 * pipeline is never dropped to make room, because that is the state this file
 * exists to remember.
 *
 * @param {object} pipelines - parsed record.
 * @param {object} pipeline - the record to store.
 * @param {object} [options] - `{maxEntries}`.
 * @returns {object} the next record file.
 */
export function recordPipeline(pipelines, pipeline, { maxEntries = MAX_PIPELINES } = {}) {
  const normalized = normalizePipeline(pipeline, pipeline?.repo)
  if (normalized === null) return pipelines
  const repos = { ...(pipelines?.repos ?? {}), [normalized.repo]: normalized }
  const keys = Object.keys(repos)
  if (keys.length <= maxEntries) return { version: PIPELINE_SCHEMA, repos }
  const orderable = keys
    .map((key) => ({ key, done: TERMINAL_STATUSES.has(repos[key].status), at: text(repos[key].updatedAt) }))
    .sort((left, right) => (left.at === right.at ? 0 : left.at < right.at ? -1 : 1))
  const kept = { ...repos }
  for (const entry of orderable) {
    if (Object.keys(kept).length <= maxEntries) break
    if (!entry.done) continue
    delete kept[entry.key]
  }
  return { version: PIPELINE_SCHEMA, repos: kept }
}

/** Forget one repository's pipeline — used when a new one replaces it. */
export function forgetPipeline(pipelines, repo) {
  const repos = { ...(pipelines?.repos ?? {}) }
  delete repos[repo]
  return { version: PIPELINE_SCHEMA, repos }
}

/** One fresh pipeline, every stage pending. */
export function newPipeline({ repo = '', slug = '', id = '', startedAt = '' } = {}) {
  return {
    id: id !== '' ? id : `pl-${repo}-${startedAt}`,
    repo,
    slug,
    tag: null,
    version: null,
    headSha: null,
    startedAt,
    updatedAt: startedAt,
    status: 'running',
    message: '',
    blockedCode: null,
    runId: null,
    runUrl: null,
    runConclusion: null,
    skipNpm: false,
    stages: STAGE_IDS.map((stage) => ({ id: stage, status: 'pending', detail: '', at: '' })),
  }
}

/**
 * The first stage that has not finished, or null when the pipeline is complete.
 * @param {object} pipeline - the record.
 * @returns {string|null} one of `STAGE_IDS`.
 */
export function pendingStage(pipeline) {
  const stages = Array.isArray(pipeline?.stages) ? pipeline.stages : []
  for (const id of STAGE_IDS) {
    const stage = stages.find((candidate) => candidate?.id === id)
    if (stage === undefined || !TERMINAL_STAGES.has(stage.status)) return id
  }
  return null
}

/** Whether a pipeline has stopped moving (nothing further will happen without a person). */
export function pipelineFinished(pipeline) {
  return TERMINAL_STATUSES.has(text(pipeline?.status))
}

/**
 * Which npm refusal, if any, still lets the release go public.
 *
 * @param {object} result - `{ok, code, message}` from the npm publish core.
 * @returns {{action: 'continue'|'skip'|'hold', code: string, message: string}}
 */
export function npmOutcomeVerdict(result) {
  if (result !== null && typeof result === 'object' && result.ok === true) {
    return { action: 'continue', code: '', message: '' }
  }
  const code = text(result?.code, 'unknown')
  const message = text(result?.message)
  if (NPM_SKIPPABLE_CODES.has(code)) return { action: 'skip', code, message }
  return { action: 'hold', code, message }
}

/**
 * The dispatched run for one commit, if it has appeared yet.
 *
 * Matched on the pushed SHA rather than on "the newest release run": the whole
 * point of pinning the pipeline to a commit is that the release it waits for is
 * the release it started, and a run somebody else triggered in between must not
 * be mistaken for it.
 *
 * @param {Array<object>} runs - normalized runs, newest first.
 * @param {string} sha - the commit the dispatch asked to build.
 * @returns {object|null} the run.
 */
export function matchRun(runs, sha) {
  const wanted = text(sha).toLowerCase()
  if (wanted === '') return null
  const list = Array.isArray(runs) ? runs : []
  for (const run of list) {
    const candidate = text(run?.headSha).toLowerCase()
    if (candidate !== '' && candidate === wanted) return run
  }
  return null
}

/* ------------------------------------------------------------------ runner -- */

/** How long to wait for the dispatched run to appear before calling it lost. */
const DEFAULT_APPEAR_TIMEOUT_MS = 5 * 60 * 1000

/** How long the build itself may take. CI here installs, tests and packs. */
const DEFAULT_BUILD_TIMEOUT_MS = 45 * 60 * 1000

/** A ceiling on the whole pipeline, so a stuck record cannot live in the file forever. */
const DEFAULT_TOTAL_TIMEOUT_MS = 90 * 60 * 1000

/** Steps one `advance` call may take before yielding, so a loop cannot run away. */
const MAX_STEPS_PER_ADVANCE = 8

/**
 * The pipeline engine, with every outside action injected.
 *
 * The effects are what the Host does; this object decides WHAT to do and in which
 * order, records it stage by stage, and answers the three questions the panel
 * asks: what is happening now, what stopped it, and what would continue it.
 *
 * Each effect answers `{ok: true, ...}` or `{ok: false, code, message}` — the same
 * shape the routes already use, so the Host's implementations are thin wrappers
 * around code that was already there.
 *
 * @param {object} params - `{effects, onChange, now, appearTimeoutMs, buildTimeoutMs, totalTimeoutMs}`.
 * @returns {object} `{start, advance, resume, cancel}`.
 */
export function createPipelineRunner({
  effects,
  onChange = () => {},
  now = () => Date.now(),
  appearTimeoutMs = DEFAULT_APPEAR_TIMEOUT_MS,
  buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
} = {}) {
  const stamp = () => new Date(now()).toISOString()

  /**
   * One-time passwords, held in memory for exactly one attempt.
   *
   * A 2FA code is a credential, and this plugin's whole rule about credentials is
   * that they are not stored: the pipeline record is written to disk after every
   * stage, so an OTP that travelled inside it would be persisted by accident. It
   * therefore lives here, keyed by repository, is handed to the npm stage once, and
   * is dropped whether the publish succeeded or not — a failed one needs a FRESH
   * code anyway, since npm invalidates the one it just rejected.
   */
  const otpByRepo = new Map()

  /**
   * The commit message for the one push this pipeline makes.
   *
   * Also transient, and for a plainer reason: it is needed by the first stage and
   * by nothing afterwards, so writing it into a record that is saved after every
   * stage would be keeping a copy of it forever for no reader.
   */
  const messageByRepo = new Map()

  /** Mutate one stage and return the record, so every write goes through one place. */
  const setStage = (pipeline, id, status, detail = '') => {
    const stages = Array.isArray(pipeline.stages) ? pipeline.stages : []
    pipeline.stages = STAGE_IDS.map((stageId) => {
      const existing = stages.find((candidate) => candidate?.id === stageId) ?? { id: stageId, status: 'pending', detail: '', at: '' }
      if (stageId !== id) return existing
      return { id: stageId, status: STAGE_STATUSES.has(status) ? status : 'pending', detail: text(detail), at: stamp() }
    })
    return pipeline
  }

  const settle = (pipeline) => {
    pipeline.updatedAt = stamp()
    onChange(pipeline)
    return pipeline
  }

  /**
   * Stop the pipeline and say why.
   *
   * `markStage` is false for a refusal that happened before any stage ran — a
   * missing checkout, a branch behind its upstream. Marking 代码推送 as failed there
   * would be a small lie the row then renders: nothing was pushed, and nothing was
   * attempted.
   */
  const fail = (pipeline, code, message, { markStage = true } = {}) => {
    const stage = pendingStage(pipeline)
    if (markStage && stage !== null) setStage(pipeline, stage, 'failed', message)
    pipeline.status = 'failed'
    pipeline.blockedCode = text(code) || null
    pipeline.message = text(message)
    return settle(pipeline)
  }

  const hold = (pipeline, code, message) => {
    setStage(pipeline, 'npm', 'blocked', message)
    pipeline.status = 'blocked'
    pipeline.blockedCode = text(code) || null
    pipeline.message = text(message)
    return settle(pipeline)
  }

  const elapsed = (pipeline) => {
    const started = Date.parse(text(pipeline?.startedAt))
    return Number.isFinite(started) ? now() - started : 0
  }

  /**
   * Run one stage and, when it does not stop the pipeline, the next one too.
   *
   * Stopping is normal here: the build stage stops on every tick until CI has
   * finished, and a held npm stage stops until a person answers.
   */
  const step = async (pipeline) => {
    const current = pendingStage(pipeline)
    if (current === null) {
      pipeline.status = 'done'
      pipeline.message = ''
      return settle(pipeline)
    }

    if (current === 'build') {
      const found = await effects.findRun({ repo: pipeline.repo, slug: pipeline.slug, sha: pipeline.headSha, startedAt: pipeline.startedAt })
      if (found === null || typeof found !== 'object') {
        setStage(pipeline, 'build', 'active', '')
        return settle(pipeline)
      }
      if (found.state === 'failed') return fail(pipeline, 'gh-failed', found.message)
      if (found.state === 'waiting' || found.state === 'missing') {
        const limit = found.state === 'missing' ? appearTimeoutMs : buildTimeoutMs
        if (elapsed(pipeline) > limit) {
          return fail(
            pipeline,
            found.state === 'missing' ? 'run-not-found' : 'build-timeout',
            found.state === 'missing'
              ? '触发了构建，但 GitHub 一直没有出现这次运行（dispatch 被接受不等于运行存在）'
              : `构建超过 ${String(Math.round(buildTimeoutMs / 60000))} 分钟仍未结束`,
          )
        }
        setStage(pipeline, 'build', 'active', text(found.message))
        return settle(pipeline)
      }
      const run = found.run ?? {}
      pipeline.runId = Number.isInteger(run.id) ? run.id : pipeline.runId
      pipeline.runUrl = text(run.url) || pipeline.runUrl
      pipeline.runConclusion = text(run.conclusion) || null
      if (text(run.status) !== 'completed') {
        if (elapsed(pipeline) > buildTimeoutMs) {
          return fail(pipeline, 'build-timeout', `构建超过 ${String(Math.round(buildTimeoutMs / 60000))} 分钟仍未结束`)
        }
        setStage(pipeline, 'build', 'active', `${text(run.status)}${text(run.conclusion) === '' ? '' : ` / ${text(run.conclusion)}`}`)
        return settle(pipeline)
      }
      if (text(run.conclusion) !== 'success') {
        return fail(pipeline, 'build-failed', `构建${text(run.conclusion) === 'cancelled' ? '被取消' : '失败'}（${text(run.conclusion)}）`)
      }
      setStage(pipeline, 'build', 'done', text(run.conclusion))
      return settle(pipeline)
    }

    if (current === 'npm') {
      if (pipeline.skipNpm === true) {
        setStage(pipeline, 'npm', 'skipped', '按要求跳过')
        return settle(pipeline)
      }
      const otp = text(otpByRepo.get(pipeline.repo))
      otpByRepo.delete(pipeline.repo)
      const result = await effects.publishNpm({ repo: pipeline.repo, tag: pipeline.tag, otp })
      const verdict = npmOutcomeVerdict(result)
      if (verdict.action === 'hold') return hold(pipeline, verdict.code, verdict.message)
      setStage(pipeline, 'npm', verdict.action === 'skip' ? 'skipped' : 'done', verdict.action === 'skip' ? verdict.message : text(result?.detail))
      pipeline.blockedCode = null
      pipeline.message = ''
      return settle(pipeline)
    }

    /*
     * 播报 is the one stage that is not a `runStage`: it is this plugin's own
     * Bilibili sweep, it is not awaited, and its failure is not this pipeline's
     * (the release is already public, and the ledger is what stops a duplicate).
     */
    if (current === 'announce') {
      if (typeof effects.announce === 'function') void effects.announce({ repo: pipeline.repo, slug: pipeline.slug, tag: pipeline.tag })
      setStage(pipeline, 'announce', 'done', '')
      return settle(pipeline)
    }

    const result = await effects.runStage({
      stage: current,
      repo: pipeline.repo,
      slug: pipeline.slug,
      tag: pipeline.tag,
      version: pipeline.version,
      message: text(messageByRepo.get(pipeline.repo)),
    })
    if (result === null || typeof result !== 'object') return fail(pipeline, 'stage-failed', `阶段 ${current} 没有返回结果`)
    if (result.ok !== true) return fail(pipeline, text(result.code, 'stage-failed'), result.message)
    if (current === 'push') {
      messageByRepo.delete(pipeline.repo)
      pipeline.headSha = text(result.sha) || pipeline.headSha
    }
    if (current === 'version') {
      pipeline.tag = text(result.tag) || pipeline.tag
      pipeline.version = text(result.version) || pipeline.version
      pipeline.headSha = text(result.sha) || pipeline.headSha
    }
    setStage(pipeline, current, 'done', text(result.detail))
    if (current === 'dispatch') setStage(pipeline, 'build', 'active', '')
    return settle(pipeline)
  }

  /**
   * Move one running pipeline as far as it can go right now.
   *
   * Called on a timer for every running pipeline and again when the panel asks:
   * it is idempotent, and each call costs one `gh run list` at most.
   *
   * @param {object} pipeline - the record.
   * @returns {Promise<object>} the record, which is a COPY — the caller stores what it returns.
   */
  const advance = async (pipeline) => {
    const record = normalizePipeline(pipeline, pipeline?.repo)
    if (record === null) return pipeline
    if (record.status !== 'running') return record
    if (elapsed(record) > totalTimeoutMs) {
      return fail(record, 'pipeline-timeout', `流水线超过 ${String(Math.round(totalTimeoutMs / 60000))} 分钟没有结束`)
    }
    let guard = 0
    while (guard < MAX_STEPS_PER_ADVANCE) {
      guard += 1
      const before = `${record.status}:${String(pendingStage(record))}`
      await step(record)
      const after = `${record.status}:${String(pendingStage(record))}`
      if (record.status !== 'running' || before === after) break
    }
    return settle(record)
  }

  return {
    /**
     * Start a pipeline: the code push, the version, and the dispatch.
     *
     * The stages that need CI cannot happen here — they happen in `advance` — so
     * this returns with the pipeline RUNNING and the run id still unknown. The
     * panel's job from that moment is to show which stage it is on, which is the
     * only honest thing to show while a build is going.
     *
     * @param {object} input - `{repo, slug, message, id, otp}`.
     * @returns {Promise<object>} the pipeline record.
     */
    start: async ({ repo, slug, message = '', id = '', otp = '' } = {}) => {
      const startedAt = stamp()
      const pipeline = newPipeline({ repo, slug, id, startedAt })
      if (text(otp) !== '') otpByRepo.set(repo, text(otp))
      if (text(message) !== '') messageByRepo.set(repo, text(message))
      onChange(pipeline)
      const pre = await effects.inspect({ repo, slug, message })
      if (pre === null || typeof pre !== 'object') return fail(pipeline, 'no-checkout', '读不到本地检出', { markStage: false })
      if (pre.ok !== true) return fail(pipeline, text(pre.code, 'no-checkout'), pre.message, { markStage: false })
      pipeline.headSha = text(pre.sha) || null
      let guard = 0
      while (guard < MAX_STEPS_PER_ADVANCE) {
        guard += 1
        const before = `${pipeline.status}:${String(pendingStage(pipeline))}`
        await step(pipeline)
        const after = `${pipeline.status}:${String(pendingStage(pipeline))}`
        if (pipeline.status !== 'running') break
        // The build stage is where the outside world takes over: it can only be
        // advanced by a later tick, once GitHub has a run to report.
        if (pendingStage(pipeline) === 'build') break
        if (before === after) break
      }
      return pipeline
    },

    advance,

    /**
     * Continue a pipeline that was held at the npm stage.
     *
     * Continuing is the point of holding: the draft is still unpublished, so the
     * same pipeline can finish once the reason npm refused is gone. Advancing
     * immediately rather than on the next tick keeps the panel's answer honest —
     * the row says what is happening now, not what will happen in thirty seconds.
     *
     * @param {object} pipeline - the record.
     * @param {object} [options] - `{skipNpm, otp}`.
     * @returns {Promise<object>} the record.
     */
    resume: async (pipeline, { skipNpm = false, otp = '' } = {}) => {
      const record = normalizePipeline(pipeline, pipeline?.repo)
      if (record === null) return pipeline
      if (record.status !== 'blocked') return record
      if (text(otp) !== '') otpByRepo.set(record.repo, text(otp))
      if (skipNpm === true) record.skipNpm = true
      record.status = 'running'
      setStage(record, 'npm', 'pending', '')
      settle(record)
      return await advance(record)
    },

    /** Stop following a pipeline. The workflow run, if any, keeps going on GitHub. */
    cancel: (pipeline) => {
      const record = normalizePipeline(pipeline, pipeline?.repo)
      if (record === null) return pipeline
      if (TERMINAL_STATUSES.has(record.status)) return record
      const current = pendingStage(record)
      if (current !== null) setStage(record, current, 'cancelled', '')
      record.status = 'cancelled'
      record.message = ''
      return settle(record)
    },
  }
}
