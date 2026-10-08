/**
 * Bilibili update announcements: the cookie jar, the comment text, the verdicts,
 * and the two HTTP calls that reach Bilibili.
 *
 * Why this is its own module rather than a section of `index.js`: everything that
 * can be decided without a network — is this credential complete, what would the
 * comment say, has this version already been announced — is the part that is
 * expensive to get wrong and cheap to test. The transport is a factory that takes
 * a `fetch`, so a test drives the whole flow against a fake and never touches the
 * real account.
 *
 * Two facts about Bilibili shape all of it:
 *
 *   - A comment is a WEB API. The credential biliup writes by default is an
 *     APP/TV one (`platform: BiliTV`), which the web member endpoints answer with
 *     `-101 账号未登录`. So the credential's usability is decided by asking the
 *     account endpoint, never by trusting that a `SESSDATA` line exists.
 *   - `oid` (not the BV id) is what the reply endpoint wants, so every post costs
 *     one `view` lookup first. That lookup is also the cheapest way to prove the
 *     bound video actually exists before anything is written to it.
 *
 * @module dsh-plugin-cicd/lib/bilibili
 */

/** A BV id as Bilibili prints it: `BV` plus ten base58 characters. */
export const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/

/** The reply endpoint's own ceiling. Longer text is refused, not truncated. */
export const MAX_COMMENT_LENGTH = 1000

/** How much of a release body becomes the one-line summary. */
export const MAX_SUMMARY_LENGTH = 90

/** Video comments are `type=1`; the other types are dynamics and articles. */
export const REPLY_TYPE_VIDEO = 1

/**
 * The default comment text.
 *
 * Deliberately one line and deliberately without a URL: Bilibili's comment filter
 * treats external links as spam far more often than it treats a sentence as spam,
 * and a filtered comment looks exactly like a posted one from this side. The
 * release link is still available as `{url}` for anyone who wants it.
 */
/**
 * `{summary}` and not `{changes}`: the summary is the one that prefers whatever the
 * release itself says, and only reaches for the commit list when the release is silent —
 * which is what "介绍这次更新" wants in both cases. A template that would rather always
 * show the commit subjects can say `{changes}`.
 */
export const DEFAULT_TEMPLATE = '【更新 {tag}】{summary}'

/**
 * How long a list of changes may be. Longer than a title, because this is the part that
 * answers "更新了什么", and shorter than a comment can hold, because it is one line of
 * a chat box rather than a changelog.
 */
export const MAX_CHANGES_LENGTH = 240

/** What to say when the range held commits and none of them is news. */
export const MAINTENANCE_NOTE = '本次更新为发布流程与工程维护，功能未变'

/** Conventional-commit types, as words a viewer reads. */
const CHANGE_LABELS = [
  [/^feat(\(.+\))?!?:\s*/i, '新功能'],
  [/^fix(\(.+\))?!?:\s*/i, '修复'],
  [/^perf(\(.+\))?!?:\s*/i, '性能'],
  [/^refactor(\(.+\))?!?:\s*/i, '重构'],
]

/**
 * Types that describe the work rather than the plugin — including `docs`, which put
 * "document the release procedure" in front of a viewer who came for the feature list.
 */
const BOOKKEEPING_SUBJECT = /^(ci|chore|test|build|style|revert|release|docs)(\(.+\))?!?:\s*/i

/** `type(scope)!:` — the repository's convention, addressed to its authors. */
const CONVENTIONAL_PREFIX = /^[A-Za-z]+(\([^)]*\))?!?:\s*/

/** Sort key for a list that has room for three: what is new, before what was fixed. */
function changeRank(entry) {
  const raw = typeof entry === 'string' ? entry : String(entry?.commit?.message ?? '')
  const subject = raw.split(/\r?\n/)[0]
  if (/^(feat|perf)(\(.+\))?!?:\s*/i.test(subject)) return 0
  if (/^(fix|refactor)(\(.+\))?!?:\s*/i.test(subject)) return 1
  /* A subject with no conventional type is prose somebody wrote on purpose. */
  return 0
}

/** The placeholders a template may use. Anything else is reported, not eaten. */
export const TEMPLATE_KEYS = ['tag', 'version', 'label', 'repo', 'title', 'summary', 'url', 'date']

/**
 * Bilibili reply failures that mean something specific, and what to do about each.
 *
 * These are worth naming because the raw pairs are indistinguishable in practice:
 * a rejected message and a risk-control block both arrive as `code != 0` with a
 * Chinese sentence, and only one of them is fixed by editing the text.
 */
const REPLY_FAILURES = new Map([
  [-101, { kind: 'not-logged-in', advice: 'cookie 已失效或不是 Web 登录凭据：用面板的【登录 B 站】重新登录。' }],
  [-400, { kind: 'rejected', advice: '请求被拒：多半是评论内容触发了过滤，或这个账号还不能发评论。' }],
  [-403, { kind: 'forbidden', advice: '没有权限：检查视频是否关闭了评论区、稿件是否已删除。' }],
  [-404, { kind: 'not-found', advice: '稿件不存在：检查绑定的 BV 号。' }],
  [-412, { kind: 'risk-control', advice: '被 B 站风控拦截：等几分钟再试，别连续重试。' }],
  [-509, { kind: 'rate-limited', advice: '请求过于频繁：等一段时间再发。' }],
  [12015, { kind: 'captcha', advice: '需要验证码：先去网页端手动发一条，之后通常就恢复了。' }],
  [12051, { kind: 'rate-limited', advice: '评论频率受限：等几分钟再试。' }],
  [12061, { kind: 'content-rejected', advice: '内容含被过滤的词：改短一点、去掉链接再试。' }],
])

/**
 * Normalize a BV id, or return null.
 * @param {unknown} value - candidate.
 * @returns {string|null} the id as written when it is well formed.
 */
export function normalizeBvid(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return BVID_PATTERN.test(trimmed) ? trimmed : null
}

/**
 * Parse a cookie source into a flat jar.
 *
 * Three shapes are accepted because three genuinely occur here: biliup's
 * `cookies.json` (`cookie_info.cookies[]`), the plugin's own file
 * (`cookies: {name: value}`), and a raw header pasted from a browser
 * (`SESSDATA=…; bili_jct=…`). Refusing two of them would mean telling the user
 * their working file is the wrong format.
 *
 * @param {unknown} raw - file contents, or an already-parsed object.
 * @returns {{ok: boolean, cookies: object, sessdata: string, csrf: string, uid: string, platform: string, expiresAt: number|null, message: string}}
 */
export function parseCookieJar(raw) {
  const empty = { ok: false, cookies: {}, sessdata: '', csrf: '', uid: '', platform: '', expiresAt: null, message: '' }
  let source = raw
  if (typeof source === 'string') {
    const trimmed = source.trim()
    if (trimmed === '') return { ...empty, message: 'the file is empty' }
    if (trimmed.startsWith('{')) {
      try {
        source = JSON.parse(trimmed)
      } catch (error) {
        return { ...empty, message: `not valid JSON: ${error.message}` }
      }
    } else {
      return fromHeader(trimmed)
    }
  }
  if (source === null || typeof source !== 'object') return { ...empty, message: 'expected a JSON object or a cookie header' }

  const platform = typeof source.platform === 'string' ? source.platform : ''
  const listed = Array.isArray(source.cookie_info?.cookies)
    ? source.cookie_info.cookies
    : Array.isArray(source.cookies)
      ? source.cookies
      : null
  if (listed !== null) {
    const cookies = {}
    let expiresAt = null
    for (const entry of listed) {
      const name = typeof entry?.name === 'string' ? entry.name : ''
      if (name === '') continue
      cookies[name] = typeof entry?.value === 'string' ? entry.value : String(entry?.value ?? '')
      if (name === 'SESSDATA' && Number.isFinite(entry?.expires)) expiresAt = Number(entry.expires)
    }
    return finish(cookies, { platform, expiresAt, message: '' })
  }
  if (source.cookies !== null && typeof source.cookies === 'object') {
    const cookies = {}
    for (const [name, value] of Object.entries(source.cookies)) {
      if (typeof value === 'string') cookies[name] = value
    }
    return finish(cookies, { platform, expiresAt: null, message: '' })
  }
  if (typeof source.cookie === 'string') return { ...fromHeader(source.cookie), ok: true }
  const flat = {}
  for (const name of ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4']) {
    if (typeof source[name] === 'string') flat[name] = source[name]
  }
  if (Object.keys(flat).length > 0) return finish(flat, { platform, expiresAt: null, message: '' })
  return { ...empty, message: 'no cookie found: expected cookie_info.cookies, cookies, or a "name=value" header' }
}

/** Parse a `name=value; name2=value2` header into a jar. */
function fromHeader(text) {
  const cookies = {}
  for (const part of text.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name === '' || value === '') continue
    cookies[name] = value.replace(/^"|"$/g, '')
  }
  return finish(cookies, { platform: '', expiresAt: null, message: '' })
}

/** Assemble the canonical jar result. */
function finish(cookies, { platform, expiresAt, message }) {
  return {
    ok: Object.keys(cookies).length > 0,
    cookies,
    sessdata: cookies.SESSDATA ?? '',
    csrf: cookies.bili_jct ?? '',
    uid: cookies.DedeUserID ?? '',
    platform,
    expiresAt,
    message: message === '' && Object.keys(cookies).length === 0 ? 'no cookie found' : message,
  }
}

/**
 * Render a jar back into a `Cookie:` header.
 * @param {object} cookies - name to value.
 * @returns {string} the header value.
 */
export function cookieHeader(cookies) {
  if (cookies === null || typeof cookies !== 'object') return ''
  return Object.entries(cookies)
    .filter(([name, value]) => typeof name === 'string' && name !== '' && typeof value === 'string' && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/**
 * Decide whether this credential can post a comment at all.
 *
 * The account answer is the only evidence that counts. `platform` is carried into
 * the message because it explains the failure: a `BiliTV` jar is a real, live
 * credential that the web endpoints still refuse, and without that word the
 * `-101` reads as "you are not logged in", which sends the reader to re-login in
 * the wrong place.
 *
 * @param {object} params - `{jar, account}`.
 * @returns {{state: string, message: string, account: object|null}}
 */
export function credentialVerdict({ jar = null, account = null } = {}) {
  if (jar === null || jar.ok !== true) {
    /* "There is no file" and "the file cannot be read" need different words: the
       first is a setup step, the second is a problem to fix. */
    if (jar?.absent === true) return { state: 'none', message: jar.message ?? '还没有 B 站凭据。', account: null }
    return { state: 'unreadable', message: jar?.message ?? 'no credential file', account: null }
  }
  if (jar.sessdata === '' || jar.csrf === '') {
    const missing = [jar.sessdata === '' ? 'SESSDATA' : null, jar.csrf === '' ? 'bili_jct' : null].filter(Boolean)
    return { state: 'incomplete', message: `缺少 ${missing.join(' 与 ')}：发评论两者都需要。`, account: null }
  }
  if (account === null) return { state: 'unverified', message: '还没有验证这份凭据。', account: null }
  if (account.ok === true) {
    return { state: 'ready', message: '', account: { mid: account.mid, uname: account.uname } }
  }
  const appCredential = /tv|android|ios|app/i.test(jar.platform)
  if (account.code === -101 && appCredential) {
    return {
      state: 'not-logged-in',
      message: `这份凭据是 ${jar.platform} 登录（APP/TV），B 站 Web 会员接口回 -101——发评论走的是 Web 接口，所以它发不了。用面板的【登录 B 站】或粘贴浏览器里的 SESSDATA/bili_jct。`,
      account: null,
    }
  }
  return { state: 'not-logged-in', message: account.message === '' ? '凭据没有被 B 站接受。' : account.message, account: null }
}

/**
 * Strip Markdown down to something a comment can carry.
 *
 * Comments are plain text: a release note pasted verbatim shows up with `**` and
 * `##` in it. Links keep their label and lose the URL, which is also what keeps
 * the auto-generated "by @user in https://…" tail from swallowing the summary.
 *
 * @param {unknown} value - Markdown source.
 * @returns {string} one line of plain text.
 */
export function stripMarkdown(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/`{1,3}/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether a release-note line is GitHub's own boilerplate rather than content.
 * @param {string} line - one stripped line.
 * @returns {boolean} true when the line says nothing about the change.
 */
function isBoilerplate(line) {
  if (line === '') return true
  if (/^(what'?s changed|full changelog|changelog|更新内容|变更内容|更新日志)\s*[:：]?$/i.test(line)) return true
  if (/^full changelog\b/i.test(line)) return true
  if (/^https?:\/\/\S+$/i.test(line)) return true
  return false
}

/**
 * Turn a release into the one line a comment can carry.
 *
 * The name wins when it says something the tag does not: `v0.5.1` as a name is
 * noise, while `发布台：B 站更新播报` is the summary. The body is the fallback,
 * with the boilerplate and the co-author tails removed.
 *
 * @param {object} release - `{tag, name, body}`.
 * @param {object} [options] - `{maxLength, fallback}`.
 * @returns {string} a plain-text summary, never longer than `maxLength`.
 */
export function summarizeRelease(release, { commits = null, names = [], maxLength = MAX_SUMMARY_LENGTH, fallback = '' } = {}) {
  const tag = typeof release?.tag === 'string' ? release.tag : ''
  const version = tag.replace(/^v/, '')
  const name = stripMarkdown(release?.name)
  const nameIsNoise = name === '' || name === tag || name === version || name === `v${version}` ||
    /* `<repo> v1.0.1` says exactly as much as `v1.0.1` does, and the release workflow
       names every release that way — so treating it as a summary buries every real
       change behind the one line that carries none. Which is what it did: the comments
       read "【更新 v1.0.1】<repo> v1.0.1" and the commit list was never reached. */
    names.some((candidate) => {
      const base = stripMarkdown(candidate)
      if (base === '') return false
      return name === `${base} ${tag}` || name === `${base} ${version}` || name === `${base} v${version}` ||
        name === `${base}: ${tag}` || name === `${base}: ${version}` || name === `${base}: v${version}`
    })
  if (!nameIsNoise) return clamp(name, maxLength)

  const lines = String(release?.body ?? '')
    .split(/\r?\n/)
    .map((line) => stripMarkdown(line).replace(/\s+by\s+@\S+\s+in\s+https?:\/\/\S+\s*$/i, '').replace(/\s+in\s+https?:\/\/\S+\s*$/i, '').trim())
    .filter((line) => !isBoilerplate(line))
  const joined = lines.slice(0, 3).join(' ').trim()
  if (joined !== '') return clamp(joined, maxLength)

  /*
   * The commits, when the release says nothing itself.
   *
   * This is the normal case for these repositories: their releases carry a body of
   * exactly `**Full Changelog**: <url>` and nothing else, because the release workflow
   * creates them without notes. So "介绍这次更新" cannot come from the release — the
   * only place the changes exist is the history between the two tags.
   */
  const fromCommits = summarizeCommits(commits, { maxLength: MAX_CHANGES_LENGTH })
  if (fromCommits !== '') return fromCommits
  return clamp(stripMarkdown(fallback), maxLength)
}

/**
 * What changed, out of the commits between two releases.
 *
 * Subjects only, and the ones a reader of a video comment would recognise: a merge
 * commit, a release chore or a `[skip ci]` marker is bookkeeping, not news. Joined with
 * `；` rather than newlines because a Bilibili comment is a chat box, not a changelog.
 *
 * @param {unknown} commits - GitHub compare entries (`{commit: {message}, author}`) or plain strings.
 * @param {object} [options] - `{max, maxLength}`.
 * @returns {string} the summary, empty when nothing survives the filter.
 */
export function summarizeCommits(commits, { max = 3, maxLength = MAX_CHANGES_LENGTH } = {}) {
  const list = Array.isArray(commits) ? commits : []
  if (list.length === 0) return ''
  const seen = new Set()
  const kept = []
  /*
   * Newest first, and features before fixes.
   *
   * The compare API hands them oldest first, and taking the first three of that put the
   * EARLIEST work of a release in the comment — for v0.5.0, three npm details, while the
   * 提交 button, the Bilibili note and the one-page settings that the release is actually
   * about were cut off the end. A version culminates in what it is for, and among equals
   * a feature is what "what's new" means.
   */
  const ordered = [...list].reverse().sort((left, right) => changeRank(left) - changeRank(right))
  for (const entry of ordered) {
    const raw = typeof entry === 'string' ? entry : String(entry?.commit?.message ?? '')
    const subject = raw.split(/\r?\n/)[0].trim()
    if (subject === '') continue
    if (/^merge\b/i.test(subject)) continue
    /* A build tweak is not a change a viewer of the video can see. Filtering these out
       is the difference between "what is new" and a wall of `ci:` — which is what the
       first version of this produced, cut off mid-sentence at 90 characters. */
    if (BOOKKEEPING_SUBJECT.test(subject)) continue
    if (/\[skip ci\]/i.test(subject)) continue
    let clean = stripMarkdown(subject).replace(/\s*\(#\d+\)\s*$/, '').trim()
    if (clean === '') continue
    /*
     * `fix: stop the flashing` reads as a changelog line to its author and as jargon to
     * everyone else, so a known type becomes a word. An UNKNOWN one still loses its
     * prefix — `polish(bilibili): size the code` is a sentence with a scope in front of
     * it, and the scope belongs to the repository's conventions, not to the viewer. The
     * message itself is left exactly as written: these histories are in English, and
     * translating them by machine would be inventing meaning.
     */
    let label = ''
    for (const [pattern, text] of CHANGE_LABELS) {
      if (pattern.test(clean)) {
        label = text
        break
      }
    }
    clean = clean.replace(CONVENTIONAL_PREFIX, '').trim()
    if (clean === '') continue
    if (label !== '') clean = `${label}：${clean}`
    if (seen.has(clean)) continue
    seen.add(clean)
    kept.push(clean)
    if (kept.length >= Math.max(1, max)) break
  }
  /* Commits existed and none of them is news — that is itself worth saying, and it is
     not the same as having no history to read (which answers '' and lets the caller fall
     back). A version that only moved CI should not read as an empty announcement. */
  if (kept.length === 0) return MAINTENANCE_NOTE
  return clamp(kept.join('；'), maxLength)
}

/** Cut a string to a length, on a word boundary when there is one. */
function clamp(value, maxLength) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= maxLength) return text
  const cut = text.slice(0, Math.max(1, maxLength - 1))
  const space = cut.lastIndexOf(' ')
  return `${space > maxLength * 0.6 ? cut.slice(0, space) : cut}…`
}

/**
 * Substitute `{name}` placeholders.
 *
 * Unknown placeholders are left in place and reported: silently deleting them is
 * how a typo becomes a comment that reads fine and says nothing.
 *
 * @param {string} template - the template text.
 * @param {object} vars - placeholder values.
 * @returns {{text: string, unknown: string[]}} the rendered text and the names it did not know.
 */
export function renderTemplate(template, vars) {
  const unknown = []
  const source = typeof template === 'string' && template.trim() !== '' ? template : DEFAULT_TEMPLATE
  const text = source.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
    if (!Object.hasOwn(vars, name)) {
      if (!unknown.includes(name)) unknown.push(name)
      return match
    }
    return String(vars[name] ?? '')
  })
  return { text: text.replace(/[ \t]+/g, ' ').trim(), unknown }
}

/**
 * Compose the comment for one release.
 *
 * @param {object} params - `{label, repo, tag, release, template, date, fallback}`.
 * @returns {{text: string, unknown: string[], summary: string, truncated: boolean}} the comment and what it could not resolve.
 */
export function composeComment({ label = '', repo = '', tag = '', release = null, template = '', date = '', fallback = '', commits = null } = {}) {
  const effectiveTag = tag !== '' ? tag : (typeof release?.tag === 'string' ? release.tag : '')
  /* `{changes}` is the same material `{summary}` falls back to, exposed on its own so a
     template can say "本版更新：{changes}" without depending on what the release body
     happened to contain. */
  const changes = summarizeCommits(commits)
  /* The names a release title could be made of, so `dsh-ui-sound v0.1.1` counts as the
     tag it repeats rather than as a description of the change. */
  const names = [label !== '' ? label : repo, repo, String(repo).slice(String(repo).lastIndexOf('/') + 1)]
  const summary = summarizeRelease({ ...release, tag: effectiveTag }, { commits, names, fallback })
  const rendered = renderTemplate(template, {
    tag: effectiveTag,
    version: effectiveTag.replace(/^v/, ''),
    label: label !== '' ? label : repo,
    repo,
    title: stripMarkdown(release?.name),
    summary,
    changes,
    url: typeof release?.url === 'string' ? release.url : '',
    date,
  })
  const truncated = rendered.text.length > MAX_COMMENT_LENGTH
  return {
    text: truncated ? `${rendered.text.slice(0, MAX_COMMENT_LENGTH - 1)}…` : rendered.text,
    unknown: rendered.unknown,
    summary,
    truncated,
  }
}

/**
 * The newest release a reader can actually see, or null.
 *
 * Drafts are excluded on purpose: a draft is invisible to everyone but the
 * author, so announcing it would post "this is out" about something nobody can
 * download. The console publishes drafts deliberately — that click is the moment
 * an announcement becomes true.
 *
 * @param {object[]} releases - normalized releases.
 * @returns {object|null} the newest non-draft release with a tag.
 */
export function newestPublishedRelease(releases) {
  const list = Array.isArray(releases) ? releases : []
  const published = list.filter((release) => release !== null && typeof release === 'object' && release.draft !== true && typeof release.tag === 'string' && release.tag !== '')
  if (published.length === 0) return null
  return published.reduce((newest, release) => {
    const left = Date.parse(release.createdAt ?? '')
    const right = Date.parse(newest.createdAt ?? '')
    if (!Number.isFinite(left)) return newest
    if (!Number.isFinite(right)) return release
    return left > right ? release : newest
  })
}

/** An empty announcement ledger. */
export function emptyLedger() {
  return { version: 1, entries: [] }
}

/**
 * Parse the ledger file tolerantly.
 *
 * A ledger that cannot be read must never be treated as an empty one: the whole
 * job of this file is to remember what was already said in public, and forgetting
 * it re-posts every comment the next time the sweep runs.
 *
 * @param {unknown} raw - file contents.
 * @returns {{ok: boolean, ledger: object, message: string}}
 */
export function parseLedger(raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, ledger: emptyLedger(), message: '' }
  }
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { ok: false, ledger: emptyLedger(), message: `not valid JSON: ${error.message}` }
    }
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    return { ok: false, ledger: emptyLedger(), message: 'expected an object with an "entries" array' }
  }
  const entries = parsed.entries.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.repo === 'string')
  return { ok: true, ledger: { version: 1, entries }, message: '' }
}

/**
 * The ledger entry for one repository and tag, if any.
 * @param {object} ledger - parsed ledger.
 * @param {string} repo - repository.
 * @param {string} tag - release tag.
 * @returns {object|null} the entry.
 */
export function findLedgerEntry(ledger, repo, tag) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.repo === repo && entry.tag === tag) return entry
  }
  return null
}

/**
 * The most recent `baseline` entry for a repository.
 *
 * Binding a video must not fire a comment about the version that was already out
 * when it was bound. That is what the baseline is: a marker written at bind time
 * saying "everything up to here was already public before this video was wired up".
 *
 * @param {object} ledger - parsed ledger.
 * @param {string} repo - repository.
 * @returns {object|null} the newest baseline entry.
 */
export function latestBaseline(ledger, repo) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : []
  let newest = null
  for (const entry of entries) {
    if (entry.repo !== repo || entry.state !== 'baseline') continue
    if (newest === null || String(entry.at ?? '') > String(newest.at ?? '')) newest = entry
  }
  return newest
}

/**
 * Append or replace one entry, keeping the file bounded.
 * @param {object} ledger - parsed ledger.
 * @param {object} entry - the entry to store, keyed by `repo` + `tag`.
 * @param {object} [options] - `{maxEntries}`.
 * @returns {object} the next ledger.
 */
export function recordLedgerEntry(ledger, entry, { maxEntries = 500 } = {}) {
  const entries = (Array.isArray(ledger?.entries) ? ledger.entries : []).filter((candidate) => !(candidate.repo === entry.repo && candidate.tag === entry.tag))
  entries.push(entry)
  return { version: 1, entries: entries.slice(Math.max(0, entries.length - maxEntries)) }
}

/**
 * Whether this repository's newest release should be announced right now.
 *
 * The order of the questions is the order of their cost: a missing binding costs
 * nothing to notice, and "already announced" must be decided before anything is
 * composed, because composing is what makes a duplicate look like a fresh job.
 *
 * @param {object} params - `{binding, release, ledger, force}`.
 * @returns {{state: string, message: string, entry: object|null, attempts: number}} the verdict.
 */
export function announcementVerdict({ binding = null, release = null, ledger = emptyLedger(), force = false } = {}) {
  if (binding === null || typeof binding?.bvid !== 'string' || binding.bvid === '') {
    return { state: 'unbound', message: '这个仓库还没有绑定 B 站视频。', entry: null, attempts: 0 }
  }
  if (release === null || typeof release?.tag !== 'string' || release.tag === '') {
    return { state: 'no-release', message: '还没有已公开的 Release（草稿不算）。', entry: null, attempts: 0 }
  }
  const entry = findLedgerEntry(ledger, binding.repo ?? '', release.tag)
  if (entry !== null && entry.state === 'announced' && force !== true) {
    return { state: 'already', message: `${release.tag} 已经播报过了。`, entry, attempts: 0 }
  }
  const baseline = latestBaseline(ledger, binding.repo ?? '')
  if (baseline !== null && force !== true) {
    const sameTag = baseline.tag === release.tag
    const at = Date.parse(String(baseline.at ?? ''))
    const created = Date.parse(String(release.createdAt ?? ''))
    // A baseline without a tag is a binding that could not read the release list;
    // it then holds back everything created before it was written.
    const older = baseline.tag === null && Number.isFinite(at) && Number.isFinite(created) && created <= at
    if (sameTag || older) {
      return { state: 'baseline', message: `${release.tag} 在绑定视频之前就已经发布了，不算这次更新。`, entry: baseline, attempts: 0 }
    }
  }
  const attempts = Number.isFinite(entry?.attempts) ? Number(entry.attempts) : 0
  if (entry !== null && entry.state === 'failed' && attempts >= 3 && force !== true) {
    return { state: 'gave-up', message: `已经失败 ${attempts} 次，先看看原因再手动重试。`, entry, attempts }
  }
  return { state: 'ready', message: '', entry, attempts }
}

/**
 * Name a reply failure.
 * @param {number} code - Bilibili's `code`.
 * @param {string} message - Bilibili's own sentence.
 * @returns {{kind: string, advice: string, message: string}} the classification.
 */
export function replyFailure(code, message = '') {
  const known = REPLY_FAILURES.get(Number(code))
  if (known === undefined) {
    return { kind: 'unknown', advice: '没识别出具体原因，看 B 站返回的原话。', message: String(message ?? '') }
  }
  return { ...known, message: String(message ?? '') }
}

/**
 * Read `Set-Cookie` headers off a fetch response.
 *
 * Node exposes `getSetCookie()`; a response from a fake in a test may only have
 * `get('set-cookie')`. Both are read rather than requiring one shape.
 *
 * @param {object} headers - a `Headers`-like object.
 * @returns {string[]} the raw header values.
 */
export function readSetCookie(headers) {
  if (headers === null || headers === undefined) return []
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  if (typeof headers.get === 'function') {
    const single = headers.get('set-cookie')
    return typeof single === 'string' && single !== '' ? [single] : []
  }
  return []
}

/**
 * Build a jar out of `Set-Cookie` header values, which is how the QR sign-in
 * hands over the credential.
 * @param {string[]} values - raw header values.
 * @returns {object} name to value.
 */
export function cookiesFromSetCookie(values) {
  const cookies = {}
  for (const value of Array.isArray(values) ? values : []) {
    const first = String(value).split(';')[0]
    const index = first.indexOf('=')
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    const raw = first.slice(index + 1).trim()
    if (name === '' || raw === '') continue
    cookies[name] = raw
  }
  return cookies
}

/**
 * Add the device cookies a browser would send.
 *
 * `buvid3` and `buvid4` are what make a request look like it came from a browser
 * rather than from a script, and their absence is one of the things that earns a
 * `-412`. Both are fetched together and both belong on the request — sending only
 * the first was throwing half of the answer away.
 *
 * A credential's own value always wins: an account that already carries a device id
 * has one for a reason, and replacing it would be inventing a device.
 *
 * This lives here rather than in the route because the route cannot be tested end to
 * end: reaching a real post needs a release list, and the suite deliberately gives
 * the Host a `gh` that cannot exist. A pure function is the only way this decision
 * gets any coverage at all.
 *
 * @param {object} cookies - the credential's cookies.
 * @param {object} fingerprint - `{buvid3, buvid4}` from `fingerPrint()`.
 * @returns {object} a new object; the input is not mutated.
 */
export function withDeviceIds(cookies, fingerprint) {
  const next = { ...(cookies === null || typeof cookies !== 'object' ? {} : cookies) }
  const found = fingerprint === null || typeof fingerprint !== 'object' ? {} : fingerprint
  for (const name of ['buvid3', 'buvid4']) {
    const value = typeof found[name] === 'string' ? found[name].trim() : ''
    if (value !== '' && next[name] === undefined) next[name] = value
  }
  return next
}

/**
 * The cookies Bilibili puts in the poll's success URL.
 *
 * The web sign-in hands the same credential over twice: as `Set-Cookie` headers,
 * and as the query string of `data.url` — the cross-domain bounce the browser is
 * meant to follow. Only one of them has to arrive, and which one does is not
 * something this plugin controls: a proxy, a client that does not surface headers,
 * or a change on Bilibili's side can drop either. Reading both is the difference
 * between a completed sign-in and "B 站回了成功，但没有下发 Cookie" — a message that
 * is honest and useless, because the credential was in the other half of the
 * response all along.
 *
 * `gourl` and `Expires` travel in that query string and are not cookies.
 *
 * @param {unknown} raw - `data.url` from the poll.
 * @returns {object} name to value, empty when there is nothing usable.
 */
export function cookiesFromLoginUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return {}
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return {}
  }
  const cookies = {}
  for (const [name, parameter] of parsed.searchParams) {
    if (name === 'gourl' || name === 'Expires') continue
    if (name === '' || parameter === '') continue
    cookies[name] = parameter
  }
  return cookies
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * The Bilibili transport.
 *
 * Every call returns a plain result object instead of throwing: the panel's job
 * is to print what Bilibili said, and an exception carries no `code` to print.
 *
 * @param {object} [options] - `{fetchImpl, timeoutMs, userAgent}`.
 * @returns {object} the client.
 */
export function createBilibiliClient({ fetchImpl = globalThis.fetch, timeoutMs = 15_000, userAgent = DEFAULT_UA } = {}) {
  /** One GET, with the headers a browser would send. */
  const get = async (url, { referer = 'https://www.bilibili.com/', cookie = '' } = {}) => {
    try {
      const requestHeaders = { 'user-agent': userAgent, referer, origin: 'https://www.bilibili.com' }
      if (cookie !== '') requestHeaders.cookie = cookie
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const headers = response.headers ?? null
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return { status: response.status, payload, headers }
    } catch (error) {
      return { status: 0, payload: null, headers: null, error: String(error?.message ?? error) }
    }
  }

  return {
    /**
     * Who the credential belongs to — the only proof that it is a web session.
     * @param {string} cookie - the `Cookie:` header value.
     * @returns {Promise<object>} `{ok, mid, uname, code, message}`.
     */
    async readAccount(cookie) {
      const result = await get('https://api.bilibili.com/x/member/web/account', { cookie })
      if (result.payload === null) {
        return { ok: false, mid: '', uname: '', code: null, message: result.error ?? `HTTP ${String(result.status)}` }
      }
      const payload = result.payload
      if (payload.code !== 0) {
        return { ok: false, mid: '', uname: '', code: Number(payload.code), message: String(payload.message ?? '') }
      }
      return {
        ok: true,
        mid: String(payload.data?.mid ?? ''),
        uname: String(payload.data?.uname ?? ''),
        code: 0,
        message: '',
      }
    },

    /**
     * Resolve a video to the `aid` a comment is posted against.
     * @param {string} cookie - the `Cookie:` header value.
     * @param {string} bvid - the video.
     * @returns {Promise<object>} `{ok, aid, title, owner, code, message}`.
     */
    async resolveVideo(cookie, bvid) {
      const result = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
        cookie,
        referer: `https://www.bilibili.com/video/${bvid}/`,
      })
      if (result.payload === null) {
        return { ok: false, aid: null, title: '', owner: '', code: null, message: result.error ?? `HTTP ${String(result.status)}` }
      }
      const payload = result.payload
      if (payload.code !== 0) {
        return { ok: false, aid: null, title: '', owner: '', code: Number(payload.code), message: String(payload.message ?? '') }
      }
      return {
        ok: true,
        aid: Number(payload.data?.aid) || null,
        title: String(payload.data?.title ?? ''),
        owner: String(payload.data?.owner?.name ?? ''),
        code: 0,
        message: '',
      }
    },

    /**
     * Post one comment.
     *
     * `csrf` travels in both the query and the body, which is what the endpoint
     * actually validates; sending it once is the documented shape and the shape
     * that has been observed to fail.
     *
     * @param {object} params - `{cookie, csrf, aid, bvid, message}`.
     * @returns {Promise<object>} `{ok, rpid, code, message, failure}`.
     */
    async postComment({ cookie, csrf, aid, bvid, message }) {
      const body = new URLSearchParams({
        oid: String(aid),
        type: String(REPLY_TYPE_VIDEO),
        message,
        plat: '1',
        csrf,
      })
      let result
      try {
        const response = await fetchImpl(`https://api.bilibili.com/x/v2/reply/add?csrf=${encodeURIComponent(csrf)}`, {
          method: 'POST',
          headers: {
            'user-agent': userAgent,
            referer: `https://www.bilibili.com/video/${bvid}/`,
            origin: 'https://www.bilibili.com',
            'content-type': 'application/x-www-form-urlencoded',
            cookie,
          },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        })
        result = { status: response.status, payload: await response.json() }
      } catch (error) {
        return { ok: false, rpid: null, code: null, message: String(error?.message ?? error), failure: replyFailure(null, String(error?.message ?? error)) }
      }
      const payload = result.payload ?? {}
      if (payload.code !== 0) {
        return {
          ok: false,
          rpid: null,
          code: Number(payload.code),
          message: String(payload.message ?? ''),
          failure: replyFailure(payload.code, payload.message),
        }
      }
      const rpid = payload.data?.rpid ?? payload.data?.rpid_str ?? null
      return {
        ok: true,
        rpid: rpid === null ? null : String(rpid),
        code: 0,
        message: '',
        failure: null,
      }
    },

    /**
     * A device id, best effort.
     *
     * `buvid3` is what makes a request look like it came from a browser rather
     * than from a script, and its absence is one of the things that earns a `-412`.
     * An answer is not required: when this call fails the cookie is used as is.
     * @returns {Promise<object>} `{buvid3, buvid4}`.
     */
    async fingerPrint() {
      const result = await get('https://api.bilibili.com/x/frontend/finger/spi')
      return { buvid3: String(result.payload?.data?.b_3 ?? ''), buvid4: String(result.payload?.data?.b_4 ?? '') }
    },

    /**
     * Start the web QR sign-in: one URL and one key to poll.
     * @returns {Promise<object>} `{ok, url, key, message}`.
     */
    async startQrLogin() {
      const result = await get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
      const payload = result.payload
      if (payload === null || payload.code !== 0) {
        return { ok: false, url: '', key: '', message: payload === null ? (result.error ?? `HTTP ${String(result.status)}`) : String(payload.message ?? '') }
      }
      return { ok: true, url: String(payload.data?.url ?? ''), key: String(payload.data?.qrcode_key ?? ''), message: '' }
    },

    /**
     * Ask once whether the QR code has been scanned and confirmed.
     *
     * The three states are distinct because they need different words on screen:
     * `86101` is "still waiting", `86090` is "your phone is asking you to confirm",
     * and `86038` is "this code is dead, start again".
     *
     * @param {string} key - the `qrcode_key` from `startQrLogin`.
     * @returns {Promise<object>} `{ok, state, cookies, message}`.
     */
    async pollQrLogin(key) {
      const result = await get(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`)
      const payload = result.payload
      if (payload === null) return { ok: false, state: 'failed', cookies: {}, message: result.error ?? `HTTP ${String(result.status)}` }
      if (payload.code !== 0) return { ok: false, state: 'failed', cookies: {}, message: String(payload.message ?? '') }
      const inner = Number(payload.data?.code)
      if (inner === 0) {
        /*
         * Both halves of the answer, header first: a partial `Set-Cookie` is filled
         * in from the URL rather than reported as a sign-in that stored nothing.
         */
        const cookies = {
          ...cookiesFromLoginUrl(payload.data?.url),
          ...cookiesFromSetCookie(readSetCookie(result.headers)),
        }
        if (Object.keys(cookies).length === 0) {
          // Success with no credential is a contradiction worth naming: without
          // this the panel would report a login that stored nothing.
          return { ok: false, state: 'failed', cookies: {}, message: 'B 站回了成功，但既没有下发 Cookie，返回的链接里也没有凭据；再登录一次。' }
        }
        return { ok: true, state: 'succeeded', cookies, message: '' }
      }
      if (inner === 86090) return { ok: true, state: 'scanned', cookies: {}, message: '' }
      if (inner === 86038) return { ok: true, state: 'expired', cookies: {}, message: '' }
      if (inner === 86101) return { ok: true, state: 'waiting', cookies: {}, message: '' }
      return { ok: false, state: 'failed', cookies: {}, message: String(payload.data?.message ?? payload.message ?? '') }
    },
  }
}
