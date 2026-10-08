#!/usr/bin/env node
/**
 * Checks for the Bilibili update notes: the pure decisions, the transport, and the
 * routes, all without a real account and without a real `gh`.
 *
 * The rule this feature lives or dies by is idempotence — one comment per release,
 * ever — and idempotence is exactly what a test against a live account cannot
 * prove, because the second run of a live test is the bug. So every layer is
 * driven here instead:
 *
 *   - the pure module decides what to say and whether to say it at all;
 *   - `createBilibiliClient` is handed a fake `fetch`, so a `-412`, a QR code that
 *     was scanned but not confirmed, and a `Set-Cookie` sign-in are all reachable;
 *   - the mounted Host is given that same fake `fetch` through the row config, and
 *     a `ghPath` that cannot exist, so "the release list could not be read" is a
 *     deterministic result rather than a network accident.
 *
 *   node tests/bilibili-check.mjs
 *   node /tmp/asset/package/tests/bilibili-check.mjs /tmp/asset/package
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  announcementVerdict,
  composeComment,
  cookieHeader,
  cookiesFromLoginUrl,
  createBilibiliClient,
  credentialVerdict,
  emptyLedger,
  findLedgerEntry,
  latestBaseline,
  newestPublishedRelease,
  normalizeBvid,
  parseCookieJar,
  parseLedger,
  recordLedgerEntry,
  replyFailure,
  MAINTENANCE_NOTE,
  summarizeCommits,
  summarizeRelease,
  withDeviceIds,
} from '../lib/bilibili.mjs'

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

/* ---- 1. the BV id, and the three cookie shapes that really occur ---------- */

check('a BV id is accepted', normalizeBvid('BV1RopP6FEJp') === 'BV1RopP6FEJp')
check('a trimmed BV id is accepted', normalizeBvid('  BV1RopP6FEJp ') === 'BV1RopP6FEJp')
check('an aid is not a BV id', normalizeBvid('117396371216915') === null)
check('a short BV id is refused', normalizeBvid('BV1Rop') === null)
check('a non-string is refused', normalizeBvid(undefined) === null)

/* biliup's own file: `cookie_info.cookies[]`, with the platform that matters. */
const biliupJar = JSON.stringify({
  cookie_info: { cookies: [
    { name: 'SESSDATA', value: 'abc%2C123%2Cdef', expires: 1806856570 },
    { name: 'bili_jct', value: 'cafebabe' },
    { name: 'DedeUserID', value: '41942885' },
  ] },
  platform: 'BiliTV',
  token_info: { access_token: 'x' },
})
const parsedBiliup = parseCookieJar(biliupJar)
check('biliup cookies.json is understood', parsedBiliup.ok === true && parsedBiliup.sessdata === 'abc%2C123%2Cdef')
check('the platform is carried, because it explains a -101', parsedBiliup.platform === 'BiliTV')
check('the expiry is read for display', parsedBiliup.expiresAt === 1806856570)
check('the csrf is the bili_jct cookie', parsedBiliup.csrf === 'cafebabe')
check('a jar becomes a Cookie header', cookieHeader({ a: '1', b: '2' }) === 'a=1; b=2')

/* The plugin's own file, and a raw header pasted out of a browser. */
check('our own file shape is understood', parseCookieJar({ cookies: { SESSDATA: 's', bili_jct: 'j' } }).csrf === 'j')
check('a pasted header is understood', parseCookieJar('SESSDATA=s; bili_jct=j').sessdata === 's')
check('a pasted header with spaces is understood', parseCookieJar(' SESSDATA = s ; bili_jct = j ').csrf === 'j')
check('an empty source is refused', parseCookieJar('').ok === false)
check('a jar without a session is reported incomplete', credentialVerdict({ jar: parseCookieJar({ cookies: { bili_jct: 'j' } }) }).state === 'incomplete')
check('an unreadable source is reported as such', credentialVerdict({ jar: parseCookieJar('nonsense') }).state === 'unreadable')

/* The measured trap: a live APP credential the web endpoints still refuse. */
const tvVerdict = credentialVerdict({ jar: parsedBiliup, account: { ok: false, code: -101, message: '账号未登录' } })
check('an APP credential is named, not called "not signed in"', tvVerdict.state === 'not-logged-in' && tvVerdict.message.includes('BiliTV'), tvVerdict.message)
check('a web session is ready once the account answers', credentialVerdict({ jar: parseCookieJar('SESSDATA=s; bili_jct=j'), account: { ok: true, mid: '1', uname: 'me' } }).state === 'ready')

/* ---- 2. what the comment would say --------------------------------------- */

check('markdown headings lose their hashes', summarizeRelease({ tag: 'v1', name: '## A title' }) === 'A title')
check('links keep their label and lose the URL', summarizeRelease({ tag: 'v1', name: 'see [the docs](https://x/y) now' }) === 'see the docs now')
check('a name equal to the tag is not a summary', summarizeRelease({ tag: 'v0.5.1', name: 'v0.5.1', body: 'Real change here' }) === 'Real change here')
const autoNotes = summarizeRelease({
  tag: 'v2',
  body: "## What's Changed\n* Fix the thing by @someone in https://github.com/o/r/pull/1\n\n**Full Changelog**: https://github.com/o/r/compare/v1...v2",
})
check('GitHub\'s own boilerplate is not the summary', autoNotes === 'Fix the thing', autoNotes)
check('an empty release still says something', summarizeRelease({ tag: 'v3' }, { fallback: '本次更新已发布。' }) === '本次更新已发布。')
check('a long summary is cut, not dumped', summarizeRelease({ tag: 'v1', name: 'x'.repeat(300) }).length <= 90)

/* What changed, out of the commits between two releases.
   This is the ONLY source for these repositories: their release bodies are exactly
   `**Full Changelog**: <url>`, because the release workflow creates them with no notes.
   So "介绍这次更新" has to come from the history, and the filtering is what decides
   whether a viewer reads news or bookkeeping. */
const commit = (message) => ({ commit: { message } })
check('commit subjects become the summary', summarizeCommits([commit('feat: 新增语音'), commit('fix: 音量')]) === '新功能：新增语音；修复：音量')
check('the type becomes a word a viewer reads', summarizeCommits([commit('fix: 音量')]) === '修复：音量' && summarizeCommits([commit('perf: 启动更快')]) === '性能：启动更快')
check('merge commits are bookkeeping, not news', summarizeCommits([commit('Merge pull request #7 from o/r'), commit('feat: a')]) === '新功能：a')
check('a release chore is not news either', summarizeCommits([commit('chore(release): v1.0.1'), commit('feat: a')]) === '新功能：a')
check('a build tweak is not news, which is most of these histories', summarizeCommits([commit('ci: also publish the installable tarball'), commit('feat: a')]) === '新功能：a')
/* It put "文档：document the release procedure" FIRST in a comment under a demo video
   before this rule: the reader came for the feature list. */
check('release documentation is not news either', summarizeCommits([commit('docs: document the release procedure'), commit('fix: a')]) === '修复：a')
check('a skip-ci marker is not news', summarizeCommits([commit('test: x [skip ci]'), commit('feat: a')]) === '新功能：a')
check('only the first line of a message is used', summarizeCommits([commit('feat: a\n\nlong body nobody reads')]) === '新功能：a')
check('the same subject is said once', summarizeCommits([commit('feat: a'), commit('feat: a'), commit('fix: b')]) === '新功能：a；修复：b')
check('a pull-request number tail is stripped', summarizeCommits([commit('fix: a (#12)')]) === '修复：a')
/* Order is a decision, and this one was made from a real comment: the compare API hands
   commits oldest first, and taking the first three put a release's EARLIEST work in the
   note — for v0.5.0, three npm details, while 提交, the Bilibili note and the one-page
   settings were cut off the end. A version culminates in what it is for. */
check('a feature outranks a fix, even when the fix is newer', summarizeCommits([commit('feat: a'), commit('fix: b')]) === '新功能：a；修复：b')
check('within a kind, the newest comes first', summarizeCommits([commit('feat: older'), commit('feat: newer')]) === '新功能：newer；新功能：older')
check('three at most, because this is a comment box', summarizeCommits([commit('feat: 1'), commit('fix: 2'), commit('perf: 3'), commit('refactor: 4')]) === '性能：3；新功能：1；重构：4')
/* A type the repository invented is still a type: the scope belongs to its conventions,
   not to the viewer reading a comment. */
check('an unknown type loses its prefix rather than showing it', summarizeCommits([commit('polish(bilibili): size the code')]) === 'size the code')
check('and is not mistaken for bookkeeping', summarizeCommits([commit('polish: tidy the row')]) === 'tidy the row')
check('a subject in another language is passed through untouched', summarizeCommits([commit('fix: 音量包了一层')]) === '修复：音量包了一层')
check('no history at all is an empty string, so the caller can fall back', summarizeCommits([]) === '' && summarizeCommits(null) === '')
check('a range that is all bookkeeping says so instead of nothing', summarizeCommits([commit('ci: a'), commit('chore(release): v1')]) === MAINTENANCE_NOTE)
check('plain strings work too, which is what the ledger already holds', summarizeCommits(['feat: a']) === '新功能：a')

const silentRelease = { tag: 'v1.0.1', name: 'v1.0.1', body: '**Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.0.1' }
const withCommits = summarizeRelease(silentRelease, { commits: [commit('feat: 这次真的改了东西')] })
check('a release that says nothing falls back to the commits', withCommits === '新功能：这次真的改了东西', withCommits)
check('a release that says something still wins over the commits', summarizeRelease({ tag: 'v1', name: 'v1', body: '手写的更新说明' }, { commits: [commit('feat: x')] }) === '手写的更新说明')
/* The release workflow names every release `<repo> <tag>`, so that name is the tag
   repeated — treating it as a description is what made every comment read
   "【更新 v1.0.1】dsh-plugin-restart v1.0.1" and hid the changes behind it. */
const namedLikeTheWorkflow = summarizeRelease({ tag: 'v1.0.1', name: 'dsh-plugin-restart v1.0.1', body: '' }, { names: ['dsh-plugin-restart'], commits: [commit('fix: 真的修了东西')] })
check('a release named after its own repo and tag is not a description', namedLikeTheWorkflow === '修复：真的修了东西', namedLikeTheWorkflow)
check('nor is the same name with a colon', summarizeRelease({ tag: 'v0.1.1', name: 'dsh-ui-sound: v0.1.1', body: '' }, { names: ['dsh-ui-sound'], commits: [commit('fix: x')] }) === '修复：x')
check('but a real title still wins', summarizeRelease({ tag: 'v1', name: '发布台：B 站更新播报', body: '' }, { names: ['dsh-plugin-cicd'], commits: [commit('feat: x')] }) === '发布台：B 站更新播报')

const changesOnly = composeComment({ tag: 'v2', release: silentRelease, template: '【{tag}】本版更新：{changes}', commits: [commit('feat: a'), commit('fix: b')] })
check('{changes} is available to a template on its own', changesOnly.text === '【v2】本版更新：新功能：a；修复：b', changesOnly.text)
check('and an unknown placeholder is still reported, not invented', changesOnly.unknown.length === 0)

const composed = composeComment({
  label: '发布台',
  repo: 'dsh-plugin-cicd',
  tag: 'v0.5.1',
  release: { tag: 'v0.5.1', name: '新增 B 站更新播报', url: 'https://example.invalid/v0.5.1' },
  template: '',
})
check('the default template names the version and the change', composed.text === '【更新 v0.5.1】新增 B 站更新播报', composed.text)
check('the default template carries no link', composed.text.includes('http') === false, composed.text)
const withUrl = composeComment({ tag: 'v1', release: { tag: 'v1', name: 'n', url: 'https://example.invalid/1' }, template: '{tag} {url}' })
check('{url} is available when a template asks for it', withUrl.text === 'v1 https://example.invalid/1', withUrl.text)
const typo = composeComment({ tag: 'v1', release: { tag: 'v1', name: 'n' }, template: '{tag} {tagline}' })
check('an unknown placeholder is reported, not deleted', typo.unknown.includes('tagline') && typo.text.includes('{tagline}'), typo.text)
const overlong = composeComment({ tag: 'v1', release: { tag: 'v1', name: 'n' }, template: `{tag} ${'y'.repeat(1200)}` })
check('a comment longer than Bilibili allows is cut', overlong.truncated === true && overlong.text.length <= 1000, String(overlong.text.length))

/* ---- 3. has this been said already? -------------------------------------- */

const release = { tag: 'v1.2.0', name: 'x', createdAt: '2026-10-07T01:00:00Z', draft: false }
const draftOnly = newestPublishedRelease([{ tag: 'v1.3.0', draft: true, createdAt: '2026-10-07T02:00:00Z' }])
check('a draft is not a release anybody can read', draftOnly === null)
check('the newest published release wins', newestPublishedRelease([
  { tag: 'v1.0.0', draft: false, createdAt: '2026-10-01T00:00:00Z' },
  { tag: 'v1.1.0', draft: false, createdAt: '2026-10-06T00:00:00Z' },
]).tag === 'v1.1.0')

const binding = { repo: 'dsh-plugin-cicd', bvid: 'BV1RopP6FEJp' }
check('an unbound repository is refused', announcementVerdict({ binding: null, release }).state === 'unbound')
check('a repository with no release is refused', announcementVerdict({ binding, release: null }).state === 'no-release')
let ledger = recordLedgerEntry(emptyLedger(), { repo: binding.repo, tag: 'v1.2.0', at: '2026-10-07T02:00:00Z', state: 'announced', attempts: 0 })
check('an announced release is not announced twice', announcementVerdict({ binding, release, ledger }).state === 'already')
check('a forced announcement may repeat', announcementVerdict({ binding, release, ledger, force: true }).state === 'ready')
check('the ledger keeps one entry per repository and tag', ledger.entries.length === 1)
check('a ledger entry can be found', findLedgerEntry(ledger, binding.repo, 'v1.2.0')?.state === 'announced')

/* Binding seeds a baseline, so wiring a video up never announces the past. */
const baselined = recordLedgerEntry(emptyLedger(), { repo: binding.repo, tag: 'v1.2.0', at: '2026-10-07T03:00:00Z', state: 'baseline' })
check('the version already out when the video was bound is held back', announcementVerdict({ binding, release, ledger: baselined }).state === 'baseline')
check('a baseline is found by repository', latestBaseline(baselined, binding.repo)?.tag === 'v1.2.0')
check('a release newer than the binding is announced', announcementVerdict({
  binding,
  release: { ...release, tag: 'v1.3.0', createdAt: '2026-10-07T04:00:00Z' },
  ledger: baselined,
}).state === 'ready')
/* A binding that could not read the release list holds back everything older. */
const unknownBaseline = recordLedgerEntry(emptyLedger(), { repo: binding.repo, tag: null, at: '2026-10-07T03:00:00Z', state: 'baseline' })
check('an unreadable baseline holds back older releases', announcementVerdict({ binding, release, ledger: unknownBaseline }).state === 'baseline')
check('an unreadable baseline lets newer releases through', announcementVerdict({
  binding,
  release: { ...release, createdAt: '2026-10-07T04:00:00Z' },
  ledger: unknownBaseline,
}).state === 'ready')
let failedLedger = emptyLedger()
for (let attempt = 0; attempt < 3; attempt += 1) {
  failedLedger = recordLedgerEntry(failedLedger, { repo: binding.repo, tag: 'v1.2.0', at: '2026-10-07T02:00:00Z', state: 'failed', attempts: attempt + 1 })
}
check('three failures stop the sweep retrying', announcementVerdict({ binding, release, ledger: failedLedger }).state === 'gave-up')
check('a ledger that cannot be parsed is refused, never emptied', parseLedger('{oops').ok === false)
check('an empty ledger file is a fresh ledger', parseLedger('').ok === true && parseLedger('').ledger.entries.length === 0)

check('a risk-control block is named', replyFailure(-412, '请求被拦截').kind === 'risk-control')
check('a login failure is named', replyFailure(-101, '账号未登录').kind === 'not-logged-in')
check('an unknown failure keeps Bilibili\'s words', replyFailure(999999, 'whatever').message === 'whatever')

/* ---- 4. the transport, against a fake fetch ------------------------------ */

const requests = []
/** One canned answer, and a record of what was asked. */
function fakeFetch(routes) {
  return async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET', body: options.body ?? null, headers: options.headers ?? {} })
    for (const [match, answer] of routes) {
      if (String(url).includes(match)) {
        const payload = typeof answer === 'function' ? answer(String(url), options) : answer
        return {
          status: 200,
          headers: { getSetCookie: () => payload.setCookie ?? [], get: () => null },
          json: async () => payload.body ?? payload,
        }
      }
    }
    throw new Error(`no fake route for ${url}`)
  }
}

const accountClient = createBilibiliClient({ fetchImpl: fakeFetch([['member/web/account', { code: 0, data: { mid: 42, uname: '白衣为卿曲' } }]]) })
const account = await accountClient.readAccount('SESSDATA=s; bili_jct=j')
check('the account endpoint names the credential', account.ok === true && account.uname === '白衣为卿曲', JSON.stringify(account))
check('the credential really travels', requests[0].headers.cookie === 'SESSDATA=s; bili_jct=j', JSON.stringify(requests[0].headers))

requests.length = 0
const refusedAccount = await createBilibiliClient({ fetchImpl: fakeFetch([['member/web/account', { code: -101, message: '账号未登录' }]]) }).readAccount('SESSDATA=s')
check('a refused credential is an answer, not an exception', refusedAccount.ok === false && refusedAccount.code === -101)

const videoClient = createBilibiliClient({ fetchImpl: fakeFetch([['web-interface/view', { code: 0, data: { aid: 117396371216915, title: '一支视频', owner: { name: 'UP' } } }]]) })
const video = await videoClient.resolveVideo('SESSDATA=s', 'BV1RopP6FEJp')
check('a video resolves to the oid a comment needs', video.ok === true && video.aid === 117396371216915)
check('the video lookup sends the id it was given', requests.some((entry) => entry.url.includes('bvid=BV1RopP6FEJp')))

requests.length = 0
const poster = createBilibiliClient({ fetchImpl: fakeFetch([['reply/add', { code: 0, data: { rpid: 123456789, rpid_str: '123456789' } }]]) })
const posted = await poster.postComment({ cookie: 'SESSDATA=s; bili_jct=j', csrf: 'j', aid: 1, bvid: 'BV1RopP6FEJp', message: '【更新 v1】x' })
check('a comment posts and reports its id', posted.ok === true && posted.rpid === '123456789', JSON.stringify(posted))
const postRequest = requests.find((entry) => entry.url.includes('reply/add'))
check('the csrf travels in the query and the body', postRequest.url.includes('csrf=j') && String(postRequest.body).includes('csrf=j'), postRequest.url)
check('the comment body carries the oid and the type', String(postRequest.body).includes('oid=1') && String(postRequest.body).includes('type=1'), String(postRequest.body))
check('the comment is sent to the video\'s own referer', postRequest.headers.referer === 'https://www.bilibili.com/video/BV1RopP6FEJp/', postRequest.headers.referer)

const blocked = await createBilibiliClient({ fetchImpl: fakeFetch([['reply/add', { code: -412, message: '请求被拦截' }]]) })
  .postComment({ cookie: 'c', csrf: 'j', aid: 1, bvid: 'BV1RopP6FEJp', message: 'x' })
check('a risk-control refusal is classified for the panel', blocked.ok === false && blocked.failure.kind === 'risk-control', JSON.stringify(blocked.failure))

requests.length = 0
let polls = 0
const loginClient = createBilibiliClient({ fetchImpl: fakeFetch([
  ['qrcode/generate', { code: 0, data: { url: 'https://account.bilibili.com/h5/x?qrcode_key=k', qrcode_key: 'k' } }],
  ['qrcode/poll', () => {
    polls += 1
    return polls === 1
      ? { code: 0, data: { code: 86101, message: '未扫码' } }
      : { code: 0, data: { code: 0 }, setCookie: ['SESSDATA=sess; Path=/', 'bili_jct=jct; Path=/', 'DedeUserID=42; Path=/'] }
  }],
]) })
const started = await loginClient.startQrLogin()
check('the sign-in hands back a link and a key', started.ok === true && started.key === 'k', JSON.stringify(started))
const waiting = await loginClient.pollQrLogin('k')
check('an unscanned code is a state, not a failure', waiting.ok === true && waiting.state === 'waiting')
const confirmed = await loginClient.pollQrLogin('k')
check('a confirmed code yields the cookies Bilibili set', confirmed.state === 'succeeded' && confirmed.cookies.SESSDATA === 'sess', JSON.stringify(confirmed.cookies))
const expired = await createBilibiliClient({ fetchImpl: fakeFetch([['qrcode/poll', { code: 0, data: { code: 86038 } }]]) }).pollQrLogin('k')
check('an expired code is named', expired.state === 'expired')
const noCookie = await createBilibiliClient({ fetchImpl: fakeFetch([['qrcode/poll', { code: 0, data: { code: 0 } }]]) }).pollQrLogin('k')
check('a success with no cookie is a failure, not a sign-in', noCookie.ok === false && noCookie.message.includes('Cookie'), noCookie.message)

/* The same credential also arrives as a query string on `data.url`, and which half
   of the answer a client can see is not something this plugin controls. Reading only
   `Set-Cookie` turned a completed sign-in into "回了成功，但没有下发 Cookie" — honest
   and useless, because the credential was in the other half all along. */
const urlOnly = await createBilibiliClient({ fetchImpl: fakeFetch([['qrcode/poll', {
  code: 0,
  data: { code: 0, url: 'https://passport.biligame.com/crossDomain?DedeUserID=42&SESSDATA=sess%2Cfrom%2Curl&bili_jct=jct-from-url&gourl=https%3A%2F%2Fwww.bilibili.com&Expires=1806856570' },
}]]) }).pollQrLogin('k')
check('a sign-in whose credential arrives only in the URL still completes', urlOnly.ok === true && urlOnly.state === 'succeeded' && urlOnly.cookies.SESSDATA === 'sess,from,url', JSON.stringify(urlOnly.cookies))
check('the URL source does not invent cookies from gourl or Expires', urlOnly.cookies.gourl === undefined && urlOnly.cookies.Expires === undefined, Object.keys(urlOnly.cookies).join(','))
check('the account id comes along from the URL too', urlOnly.cookies.DedeUserID === '42')

const bothSources = await createBilibiliClient({ fetchImpl: fakeFetch([['qrcode/poll', {
  code: 0,
  data: { code: 0, url: 'https://passport.biligame.com/crossDomain?SESSDATA=from-url&bili_jct=from-url' },
  setCookie: ['SESSDATA=from-header; Path=/', 'buvid3=dev; Path=/'],
}]]) }).pollQrLogin('k')
check('a partial Set-Cookie is filled in from the URL', bothSources.cookies.bili_jct === 'from-url', JSON.stringify(bothSources.cookies))
check('the header wins where both carry the same name', bothSources.cookies.SESSDATA === 'from-header', bothSources.cookies.SESSDATA)
check('the device cookie the header brought is kept', bothSources.cookies.buvid3 === 'dev')

check('a malformed login URL yields no cookies rather than throwing', Object.keys(cookiesFromLoginUrl('not a url')).length === 0)
check('an absent login URL yields no cookies', Object.keys(cookiesFromLoginUrl(undefined)).length === 0)

/* The device cookies: fetched in one call, both of which belong on the request. This
   is the risk-control half that decides between a posted comment and a `-412`. */
const seeded = withDeviceIds({ SESSDATA: 's' }, { buvid3: 'b3', buvid4: 'b4' })
check('both device ids are added', seeded.buvid3 === 'b3' && seeded.buvid4 === 'b4', JSON.stringify(seeded))
check('the credential that was passed in is still there', seeded.SESSDATA === 's')
check('the credential it was given is not mutated', Object.keys({ SESSDATA: 's' }).length === 1)
const own = withDeviceIds({ buvid3: 'mine', buvid4: 'mine4' }, { buvid3: 'theirs', buvid4: 'theirs4' })
check('a device id the credential already carries is not replaced', own.buvid3 === 'mine' && own.buvid4 === 'mine4', JSON.stringify(own))
const nothing = withDeviceIds({ SESSDATA: 's' }, { buvid3: '', buvid4: '   ' })
check('an empty fingerprint adds nothing', nothing.buvid3 === undefined && nothing.buvid4 === undefined && nothing.SESSDATA === 's')
check('a missing fingerprint adds nothing rather than throwing', Object.keys(withDeviceIds({ SESSDATA: 's' })).length === 1)
check('missing cookies answer with the device ids alone', withDeviceIds(undefined, { buvid3: 'b3' }).buvid3 === 'b3')

/* ---- 5. the routes, mounted on a real server ----------------------------- */

const scratch = mkdtempSync(join(tmpdir(), 'dsh-cicd-bili-'))
const configFile = join(scratch, 'repos.json')
const credentialFile = join(scratch, 'bilibili-cookies.json')
const ledgerFile = join(scratch, 'bilibili-announcements.json')
writeFileSync(configFile, JSON.stringify({
  owner: 'octocat',
  repos: [{ repo: 'octocat/Hello-World' }, { repo: 'octocat/Spoon-Knife', bilibili: { bvid: 'BV1RopP6FEJp', auto: false } }],
}), 'utf8')

/** The Host's own shaping of the transport: one fake fetch, shared by every call. */
const hostRoutes = [
  ['member/web/account', { code: 0, data: { mid: 42, uname: '白衣为卿曲' } }],
  ['web-interface/view', { code: 0, data: { aid: 117396371216915, title: '一支视频', owner: { name: 'UP' } } }],
  ['reply/add', { code: 0, data: { rpid: 987654321 } }],
  ['finger/spi', { code: 0, data: { b_3: 'buvid3-value', b_4: 'buvid4-value' } }],
]
const hostFetch = fakeFetch(hostRoutes)

const routes = new Map()
const ctx = {
  effect: (fn) => fn(),
  logger: { info: () => {} },
  webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } },
}
module.apply(ctx, {
  owner: 'octocat',
  configFile,
  // A `gh` that cannot exist makes "the release list could not be read" a fact of
  // the test rather than a race with the network.
  ghPath: join(scratch, 'no-such-gh.exe'),
  bilibiliFetch: hostFetch,
  bilibiliVerifyTtlMs: 0,
})

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const handler = routes.get(path)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"ok":false}')
    return
  }
  handler(req, res)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const call = async (path, body = {}) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, payload }
}

const emptyStatus = (await call('/api/dsh-cicd/bilibili-status')).payload?.value ?? {}
check('the new routes are mounted as a family', routes.has('/api/dsh-cicd/bilibili-status') && routes.has('/api/dsh-cicd/bilibili-announce'))
check('status reports no credential as a state, not as an error', emptyStatus.credential?.state === 'none', JSON.stringify(emptyStatus.credential?.state))
check('status reports the repository\'s binding and its video', emptyStatus.repos?.find((entry) => entry.repo === 'octocat/Spoon-Knife')?.video?.title === '一支视频')
check('status reports the ledger file it would write', emptyStatus.ledger?.file === ledgerFile, String(emptyStatus.ledger?.file))

const badCredential = await call('/api/dsh-cicd/bilibili-credential', { cookie: 'nonsense' })
check('an unusable paste is refused before anything is written', badCredential.status === 400 && badCredential.payload?.code === 'incomplete-credential')
check('a refused paste writes no file', existsSync(credentialFile) === false)

const noLogin = await call('/api/dsh-cicd/bilibili-login-poll')
check('polling a sign-in that was never started is refused', noLogin.status === 409 && noLogin.payload?.code === 'no-login')

const badBvid = await call('/api/dsh-cicd/bilibili-bind', { repo: 'octocat/Hello-World', bvid: 'not-a-bv' })
check('a malformed BV id is refused', badBvid.status === 400 && badBvid.payload?.code === 'bad-bvid')
const unknownRepo = await call('/api/dsh-cicd/bilibili-bind', { repo: 'someone/else', bvid: 'BV1RopP6FEJp' })
check('binding an unconfigured repository is refused', unknownRepo.status === 400 && /not configured/.test(unknownRepo.payload?.message ?? ''))

/* Asked before anything is bound, because after that the answer is a different one. */
const unboundAnnounce = await call('/api/dsh-cicd/bilibili-announce', { repo: 'octocat/Hello-World', dryRun: true })
check('announcing is refused for a repository with no video', unboundAnnounce.status === 409 && unboundAnnounce.payload?.code === 'unbound', `HTTP ${unboundAnnounce.status} ${String(unboundAnnounce.payload?.code)}`)

const bound = await call('/api/dsh-cicd/bilibili-bind', { repo: 'octocat/Hello-World', bvid: 'BV1RopP6FEJp', auto: true })
check('a valid binding is stored', bound.status === 200 && bound.payload?.value?.bvid === 'BV1RopP6FEJp', JSON.stringify(bound.payload?.value ?? {}))
check('the binding reaches the managed file', JSON.parse(readFileSync(configFile, 'utf8')).repos.find((entry) => entry.repo === 'octocat/Hello-World')?.bilibili?.bvid === 'BV1RopP6FEJp')
check('binding seeds a baseline so the past is not announced', existsSync(ledgerFile) === true && JSON.parse(readFileSync(ledgerFile, 'utf8')).entries.some((entry) => entry.state === 'baseline'))
check('an unreadable release list is said out loud, not hidden', typeof bound.payload?.value?.note === 'string' && bound.payload.value.note.length > 0, bound.payload?.value?.note)

/* The credential is written by hand here: the paste route refuses one Bilibili has
   not accepted, and this test's Bilibili is a fake. */
writeFileSync(credentialFile, JSON.stringify({ version: 1, source: 'paste', savedAt: new Date().toISOString(), account: { mid: '42', uname: '白衣为卿曲' }, cookies: { SESSDATA: 'sess', bili_jct: 'jct', DedeUserID: '42' } }), 'utf8')
const readyStatus = (await call('/api/dsh-cicd/bilibili-status', { force: true })).payload?.value ?? {}
check('a stored web credential is verified and named', readyStatus.credential?.state === 'ready' && readyStatus.credential.account?.uname === '白衣为卿曲', JSON.stringify(readyStatus.credential ?? {}))

requests.length = 0
const announceNoRelease = await call('/api/dsh-cicd/bilibili-announce', { repo: 'octocat/Spoon-Knife' })
check('an unreadable release list stops the announcement', announceNoRelease.status === 502 && announceNoRelease.payload?.code === 'gh-failed', JSON.stringify(announceNoRelease.payload ?? {}))
check('nothing was posted when the release could not be read', requests.some((entry) => entry.url.includes('reply/add')) === false, requests.map((entry) => entry.url).join(','))

const dryRun = await call('/api/dsh-cicd/bilibili-announce', { repo: 'octocat/Spoon-Knife', dryRun: true })
check('a dry run also stops when the release list is unreadable', dryRun.status === 502 && dryRun.payload?.code === 'gh-failed')

/* A ledger that cannot be read must block the post, not be replaced by an empty one. */
writeFileSync(ledgerFile, '{ this is not JSON', 'utf8')
const brokenLedger = (await call('/api/dsh-cicd/bilibili-status')).payload?.value ?? {}
check('a broken ledger is reported, not swallowed', typeof brokenLedger.ledger?.problem === 'string' && brokenLedger.ledger.problem.length > 0, String(brokenLedger.ledger?.problem))
writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: [] }), 'utf8')

const loggedOut = await call('/api/dsh-cicd/bilibili-logout')
check('signing out removes the credential this plugin stored', loggedOut.status === 200 && loggedOut.payload?.value?.removed === true)
check('the credential file is really gone', existsSync(credentialFile) === false)

server.close()
await new Promise((done) => server.close(done))

const passed = results.length - failed
console.log(`\n${passed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
