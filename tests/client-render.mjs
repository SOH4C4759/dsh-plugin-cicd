#!/usr/bin/env node
/**
 * Render the panel's client half in a stub React and assert what it says.
 *
 * The Host half has `mount-check` to prove it activates; the client half had only
 * `node --check`, which proves a file parses and nothing else. That gap matters for
 * exactly the change this file was written for: whether a row offers 发布 or 【升版本
 * 并发布】 depends on a render branch, and a branch nothing exercises is the kind of
 * code that breaks only in front of the user.
 *
 * So this is a small but real renderer. It is not React and does not try to be: it
 * walks the element tree, calls function components, keeps `useState` per component
 * instance, memoises `useCallback`/`useMemo`, and runs `useEffect` with dependency
 * comparison until nothing is dirty. That is enough to run the panel, let its
 * effects fetch, and read the tree it produced.
 *
 *   node tests/client-render.mjs
 *   node /tmp/asset/package/tests/client-render.mjs /tmp/asset/package
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = resolve(process.argv[2] ?? join(here, '..'))
const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')

const results = []
let failed = 0
function check(label, condition, detail = '') {
  const pass = condition === true
  if (!pass) failed += 1
  results.push({ label, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/* ---- the smallest React that can render this panel ------------------------ */

const values = new Map()
const effectSlots = new Map()
const ownerPath = []
let cursor = 0
let dirty = false
let pendingEffects = []

/** A hook slot is keyed by the component instance, not by call order alone. */
function hookKey() {
  return `${ownerPath.join('/')}#${String(cursor++)}`
}

const React = {
  Fragment: Symbol('Fragment'),
  /* `children` belongs in props as well as on the element: a function component
     reads `props.children`, which is how every Chip and Btn in this panel is
     written. Passing it only on the element renders rows with empty buttons. */
  createElement: (type, props, ...children) => {
    const flat = children.flat(Infinity)
    return {
      type,
      props: { ...(props ?? {}), children: flat.length === 0 ? undefined : (flat.length === 1 ? flat[0] : flat) },
      children: flat,
    }
  },
  useState: (initial) => {
    const key = hookKey()
    if (!values.has(key)) values.set(key, typeof initial === 'function' ? initial() : initial)
    const set = (next) => {
      const value = typeof next === 'function' ? next(values.get(key)) : next
      if (value !== values.get(key)) {
        values.set(key, value)
        dirty = true
      }
    }
    return [values.get(key), set]
  },
  useRef: (initial) => {
    const key = hookKey()
    if (!values.has(key)) values.set(key, { current: initial })
    return values.get(key)
  },
  useEffect: (fn, deps) => {
    const key = hookKey()
    pendingEffects.push({ key, fn, deps })
  },
  /* Memoised like React with `[]` deps: the panel's callbacks are what its effects
     depend on, and a new identity every pass would re-run every effect forever. */
  useCallback: (fn) => {
    const key = hookKey()
    if (!values.has(key)) values.set(key, fn)
    return values.get(key)
  },
  useMemo: (fn) => {
    const key = hookKey()
    if (!values.has(key)) values.set(key, fn())
    return values.get(key)
  },
}

/** Render function components down to host elements, as React would. */
function walk(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, at) => walk(child, `${path}.${String(at)}`))
  if (typeof node.type === 'function' || typeof node.type === 'object') {
    const name = node.type?.name ?? node.type?.displayName ?? 'Component'
    const child = `${path}<${name}>`
    const saved = cursor
    ownerPath.push(child)
    cursor = 0
    let output
    try {
      output = node.type(node.props)
    } finally {
      cursor = saved
      ownerPath.pop()
    }
    return { type: child, props: {}, children: [walk(output, child)] }
  }
  return { type: node.type, props: node.props, children: (node.children ?? []).map((child, at) => walk(child, `${path}.${String(at)}`)) }
}

/** Run the effects whose dependencies changed, then let their promises resolve. */
async function runEffects() {
  for (const effect of pendingEffects) {
    const slot = effectSlots.get(effect.key)
    const deps = effect.deps
    const changed = slot === undefined
      || deps === undefined
      || slot.deps === undefined
      || deps.length !== slot.deps.length
      || deps.some((value, at) => value !== slot.deps[at])
    if (!changed) continue
    if (typeof slot?.cleanup === 'function') slot.cleanup()
    effectSlots.set(effect.key, { deps, cleanup: effect.fn() })
  }
  await new Promise((settle) => { setTimeout(settle, 0) })
}

/** Render one root component until nothing is dirty, and return its last tree. */
async function render(component, props, rounds = 10) {
  let tree = null
  for (let round = 0; round < rounds; round += 1) {
    dirty = false
    pendingEffects = []
    cursor = 0
    ownerPath.length = 0
    ownerPath.push('root')
    const output = component(props)
    tree = walk(output, 'root')
    await runEffects()
    if (!dirty) break
  }
  return tree
}

/** Every string in the tree, in order. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  return (node.children ?? []).map(textOf).join(' ')
}

/** Whether a rendered tree contains a button carrying this label. */
function hasButton(node, label) {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => hasButton(child, label))
  const own = node.type === 'button' && textOf(node).includes(label)
  return own || hasButton(node.children, label)
}

/**
 * Press the first button whose text contains this label, as a user would.
 *
 * The row's explanation and its confirmation both live behind the expansion, so a
 * test that never expands only ever sees the summary line — which is how the most
 * important sentence on screen could be missing while every check still passed.
 *
 * @returns {boolean} whether a button was found.
 */
function clickButton(node, label) {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => clickButton(child, label))
  if (node.type === 'button' && textOf(node).includes(label) && typeof node.props?.onClick === 'function') {
    node.props.onClick()
    return true
  }
  return clickButton(node.children, label)
}

/**
 * Type into the first input whose placeholder matches, as a user would.
 *
 * The token field is the one control in this panel that is not a button, and a test
 * that only clicks would never prove the sign-in path can be reached without a
 * terminal — which is the whole point of that field existing.
 *
 * @returns {boolean} whether an input was found.
 */
function typeInto(node, placeholderPart, value) {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => typeInto(child, placeholderPart, value))
  if (node.type === 'input' && String(node.props?.placeholder ?? '').includes(placeholderPart) && typeof node.props?.onChange === 'function') {
    node.props.onChange({ target: { value } })
    return true
  }
  return typeInto(node.children, placeholderPart, value)
}

/* ---- a document, a fetch that answers from a fixture, and the loader ---- */

const styleElements = []
const document = {
  visibilityState: 'visible',
  getElementById: () => null,
  createElement: () => ({ setAttribute: () => {}, append: () => {}, textContent: '' }),
  head: { append: (element) => styleElements.push(element) },
  addEventListener: () => {},
  removeEventListener: () => {},
}

let fixture = {}
const calls = []
async function fetchStub(url) {
  const path = String(url).slice(String(url).indexOf('/api/dsh-cicd') + '/api/dsh-cicd'.length)
  calls.push(path)
  const body = fixture[path] ?? { ok: false, code: 'not-found', message: `no fixture for ${path}` }
  return {
    ok: body.__status === undefined || (body.__status >= 200 && body.__status < 300),
    status: body.__status ?? 200,
    json: async () => body,
  }
}

const sandbox = {
  React,
  console,
  setTimeout,
  clearTimeout,
  /* The panel polls with `setInterval`; here the tick never fires, because the test
     wants the render that follows the first load, not a stream of refreshes. */
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: fetchStub,
  AbortController,
  URL,
  JSON,
  Date,
  Math,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Error,
  Promise,
  RegExp,
  Symbol,
  document,
  /* A returning user: a first visit opens the picker, and this test is about the
     repository rows, so the stored preference says "show the list". */
  localStorage: { getItem: () => 'false', setItem: () => {} },
  __load: null,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    sandbox.__load = factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('the client registers itself with the loader', typeof sandbox.__load?.apply === 'function')
check('the client declares the services it needs', Array.isArray(sandbox.__load?.inject) && sandbox.__load.inject.includes('slots'))

/* Mount it the way the Host does, and capture what it registers. */
const registered = new Map()
/** What each registration asked for, so a test can tell WHICH slot it went into. */
const registrationMeta = new Map()
let dictionary = null
sandbox.__load.apply({
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionary = dicts },
    bind: () => translate,
  },
  slots: {
    inject: (name, fn) => fn(),
    /* Keyed by slot AND cell, which is what the runtime keys by.
       Keying by `id` alone lost registrations two ways: one plugin contributing several
       entries to one slot had its second silently replace the first (how a missing
       settings page passed a whole suite), and the same id in two DIFFERENT slots —
       which the runtime treats as two unrelated cells, and this plugin does use
       (`dsh-cicd` is both its sidebar entry and its settings tab) — collided. */
    register: (meta, component) => {
      const cell = typeof meta.id === 'string' && meta.id !== ''
        ? meta.id
        : (typeof meta.key === 'string' && meta.key !== '' ? meta.key : '')
      const key = `${String(meta.name)}#${cell}`
      registered.set(key, component)
      registrationMeta.set(key, meta)
      return () => {
        registered.delete(key)
        registrationMeta.delete(key)
      }
    },
  },
})

/** The panel's own dictionary, with `{name}` substitution — what a user reads. */
function translate(key, params) {
  const template = dictionary?.zh?.[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
}

/** One registration, by the slot it went into and its cell id. */
function slotEntry(name, cell) {
  return registered.get(`${name}#${cell}`)
}

/** What a registration asked for, same addressing. */
function slotMeta(name, cell) {
  return registrationMeta.get(`${name}#${cell}`)
}

check('the main view is registered', typeof slotEntry('main', 'dsh-cicd') === 'function')
check('the theme is injected once', styleElements.length === 1)
check('the settings page is registered', typeof slotEntry('settings.plugins.tab', 'dsh-cicd') === 'function')
/*
 * ONE page for the whole console, one row of the Plugins strip.
 *
 * Both shared surfaces here are flat lists — the top-level nav (`settings.section`)
 * and the strip inside Plugins (`settings.plugins.tab`) — and this plugin's share of
 * each is one row. It was three of thirteen nav rows before, all of them above
 * 通用 / 模型 / 插件, while every other third-party plugin on this machine takes
 * exactly one. Nothing else in the suite can tell those homes apart, so these are the
 * checks that pin it.
 */
check('the settings page is a tab inside the Plugins section', slotMeta('settings.plugins.tab', 'dsh-cicd')?.name === 'settings.plugins.tab', String(slotMeta('settings.plugins.tab', 'dsh-cicd')?.name))
check('the console takes no top-level settings section at all', [...registrationMeta.values()].every((meta) => meta.name !== 'settings.section'), [...registrationMeta.values()].map((meta) => meta.name).join(','))
check('the console holds exactly one row of the Plugins strip', [...registrationMeta.values()].filter((meta) => meta.name === 'settings.plugins.tab').length === 1, [...registrationMeta.values()].filter((meta) => meta.name === 'settings.plugins.tab').map((meta) => meta.id).join(','))
check('the row sits after the inventory and before the marketplace', Number(slotMeta('settings.plugins.tab', 'dsh-cicd')?.order) === 20, String(slotMeta('settings.plugins.tab', 'dsh-cicd')?.order))
check('the row is named after the console, not after one credential', slotMeta('settings.plugins.tab', 'dsh-cicd')?.label?.() === 'DSH 插件发布台', String(slotMeta('settings.plugins.tab', 'dsh-cicd')?.label?.()))
/* The sidebar entry and the settings tab answer to the same id in two different slots.
   The runtime keys by slot, so that is two cells; a harness that keyed by id alone
   would have one registration quietly replace the other. */
check('the sidebar entry and the settings tab are two different cells', typeof slotEntry('sidebar.panellist', 'dsh-cicd') === 'function' && typeof slotEntry('settings.plugins.tab', 'dsh-cicd') === 'function' && slotEntry('sidebar.panellist', 'dsh-cicd') !== slotEntry('settings.plugins.tab', 'dsh-cicd'))

const ConsolePage = slotEntry('main', 'dsh-cicd')
const ConsoleSettingsPage = slotEntry('settings.plugins.tab', 'dsh-cicd')

/** One repository row fixture. */
function repoFixture(overrides) {
  return {
    repo: 'dsh-plugin-restart',
    slug: 'SOH4C4759/dsh-plugin-restart',
    label: 'dsh-plugin-restart',
    localPath: 'F:\\CodeProj\\dsh-plugin-restart',
    problems: [],
    version: '1.0.0',
    expectedTag: 'v1.0.0',
    versionKnown: true,
    published: true,
    publishedTag: 'v1.0.0',
    draftTag: null,
    releaseCheck: { state: 'ready', code: 'version-free', tag: 'v1.0.0', owner: null, built: null, message: '', next: '1.0.1', nextTag: 'v1.0.1' },
    latestRun: null,
    runs: [],
    releases: [{ tag: 'v1.0.0', name: '', draft: false, prerelease: false, targetCommitish: 'a'.repeat(40), createdAt: '2026-10-06T19:00:19Z', url: '', assets: [] }],
    workflows: [{ name: 'CI', path: 'ci.yml', state: 'active' }, { name: 'Release', path: 'release.yml', state: 'active' }],
    hasBuildWorkflow: true,
    hasReleaseWorkflow: true,
    local: { available: true, branch: 'main', head: 'b'.repeat(40), dirty: 0, ahead: 0, behind: 0, upstreamKnown: true },
    /* The normal state on this machine: the profile points at a checkout, while the
       release is a separate artifact that may well carry the same version. */
    install: installFixture(),
    ...overrides,
  }
}

/** One `install` block, exactly as the Host sends it. */
function installFixture(overrides) {
  return {
    profile: 'desktop',
    profileDir: 'C:\\Users\\x\\.dsh\\profiles\\desktop',
    profileReadable: true,
    packageName: 'dsh-plugin-restart',
    present: true,
    spec: 'link:F:\\CodeProj\\dsh-plugin-restart',
    kind: 'link',
    installedVersion: '1.0.0',
    latestTag: 'v1.0.0',
    latestVersion: '1.0.0',
    latestAsset: 'dsh-plugin-restart-1.0.0.tgz',
    state: 'checkout',
    ...overrides,
  }
}

/** One `npm-status` entry, exactly as the Host sends it. */
function npmFixture(overrides) {
  return {
    repo: 'dsh-plugin-restart',
    label: 'dsh-plugin-restart',
    localPath: 'F:\\CodeProj\\dsh-plugin-restart',
    packageName: 'dsh-plugin-restart',
    version: '1.0.1',
    dirty: 0,
    privatePackage: false,
    blockers: [],
    canPublish: true,
    state: 'unpublished',
    latest: '1.0.0',
    registryProblem: null,
    registry: 'https://registry.npmjs.org/',
    pageUrl: 'https://registry.npmjs.org/dsh-plugin-restart',
    ...overrides,
  }
}

/** One whole `npm-status` payload. */
function npmStatusValue(overrides) {
  return {
    fetchedAt: '2026-10-07T01:00:00Z',
    cached: false,
    registry: 'https://registry.npmjs.org/',
    packageManager: { source: 'profile', command: 'node.exe' },
    auth: { loggedIn: true, account: 'soh4c4759', message: null, npmrcPath: 'C:\\Users\\x\\.npmrc', npmrcReadable: true, npmrcHasToken: true },
    repos: [npmFixture()],
    ...overrides,
  }
}

/**
 * The protocol this client demands, read from the source it was loaded from.
 *
 * A hard-coded copy here goes stale on every bump, and its failure looks exactly
 * like a product bug ("a missing gh is explained" stops passing because the panel
 * decided the Host was stale). Reading the constant makes the fixture follow the
 * code, which is what a fixture is for.
 */
const CLIENT_PROTOCOL = Number(/const PROTOCOL = (\d+)/.exec(source)?.[1] ?? 0)
check('the client declares a protocol this test can read', CLIENT_PROTOCOL > 0, String(CLIENT_PROTOCOL))

const baseStatus = {
  ok: true,
  value: {
    protocol: CLIENT_PROTOCOL,
    config: { buildWorkflow: 'ci.yml', releaseWorkflow: 'release.yml', defaultBranch: 'main', pollSeconds: 30 },
    helper: { configureScript: 'F:\\CodeProj\\dsh-plugin-cicd\\scripts\\configure.mjs' },
    gh: { path: 'gh', available: true, version: 'gh version 2.102.0', authenticated: true, account: 'SOH4C4759', scopes: ['repo', 'workflow'], missingScopes: [], message: null },
    repos: [{ repo: 'dsh-plugin-restart', label: 'dsh-plugin-restart', localPath: 'F:\\CodeProj\\dsh-plugin-restart' }],
  },
}

/** Render the panel against one fixture, from a clean hook state. */
async function renderPanel(repos, statusValue = baseStatus.value, extra = {}, npmValue = npmStatusValue()) {
  fixture = {
    '/status': { ok: true, value: statusValue },
    '/overview': { ok: true, value: { repos } },
    /* The npm status is its own request; `null` means "the Host never answered",
       which is a state the panel has to survive rather than fabricate around. */
    ...(npmValue === null ? {} : { '/npm-status': { ok: true, value: npmValue } }),
    ...extra,
  }
  values.clear()
  effectSlots.clear()
  calls.length = 0
  return render(ConsolePage, { t: translate })
}

/** Re-render the same mounted panel, keeping its state — after a click, say. */
async function rerender() {
  return render(ConsolePage, { t: translate })
}

/** Whether the last segment press found its button. */
let lastSegmentPress = true

/**
 * Render the console's settings page and land on one of its three segments.
 *
 * The segments are the page's own, not the platform's: `settings.plugins.tab` is a
 * flat list of tabs and the plugin is one of them, so everything below that is a
 * button inside our page. Reaching the npm page therefore means pressing its segment,
 * exactly as a person would.
 */
async function renderSettings(segment = 'github') {
  const first = await render(ConsoleSettingsPage, { t: translate })
  if (segment === 'github') return first
  const label = segment === 'bilibili' ? 'Bilibili' : 'npm'
  lastSegmentPress = clickButton(first, label)
  /* Re-render the same mounted shell: the segment press marked it dirty, so this pass
     draws the segment that was asked for, with that page's own hooks under it. */
  return render(ConsoleSettingsPage, { t: translate })
}

/** Render the npm settings page against one npm-status fixture. */
async function renderNpmPage(npmValue = npmStatusValue(), extra = {}) {
  const fixtures = { '/status': { ok: true, value: baseStatus.value }, ...extra }
  /* Omitted rather than set to undefined: "the Host never answered" is a state this
     page has to survive, and a fixture key of undefined would silently become one. */
  if (npmValue !== null) fixtures['/npm-status'] = { ok: true, value: npmValue }
  fixture = fixtures
  values.clear()
  effectSlots.clear()
  calls.length = 0
  return renderSettings('npm')
}

/** Re-render the settings page, keeping its state — after a click, say. */
async function rerenderNpm() {
  return renderSettings('npm')
}

/** Expand the first row and return the tree with its detail visible. */
async function expandFirstRow(tree) {
  const pressed = clickButton(tree, '▾')
  return { pressed, tree: await rerender() }
}

/* -- 0. One settings page, three segments -----------------------------------
   The console's settings are ONE tab in the Plugins strip, and everything below that
   is its own: the platform's strip is a flat list with no nesting, so the segment
   strip is ours. One segment mounts at a time, which is not only about not probing
   three credential systems on open — the Bilibili half reads a ledger and a cookie
   file, and a malformed one must not take down the GitHub state someone opened this
   page to read. */
{
  fixture = {
    '/status': { ok: true, value: baseStatus.value },
    '/auth-state': { ok: true, value: { available: true, authenticated: true, account: 'octocat', scopes: ['repo'], missingScopes: [] } },
  }
  values.clear()
  effectSlots.clear()
  calls.length = 0
  const opened = await renderSettings('github')
  check('the page names the three credentials as segments', hasButton(opened, 'GitHub') && hasButton(opened, 'npm') && hasButton(opened, 'Bilibili'), textOf(opened).replace(/\s+/g, ' ').slice(0, 160))
  check('it opens on GitHub rather than on whichever page loaded last', calls.includes('/status') === true)
  check('opening it probes no other credential system', calls.includes('/npm-status') === false && calls.includes('/bilibili-status') === false, calls.join(','))

  fixture['/npm-status'] = { ok: true, value: npmStatusValue() }
  const onNpm = await renderSettings('npm')
  check('a segment press finds its button', lastSegmentPress === true)
  check('the pressed segment draws that credential\'s page', hasButton(onNpm, '写入并验证'), textOf(onNpm).replace(/\s+/g, ' ').slice(0, 200))
  check('the npm probe happens only once its segment is opened', calls.includes('/npm-status') === true, calls.join(','))
}

/* -- 1. A version taken by another commit offers the bump ------------------- */
{
  const collapsed = await renderPanel([repoFixture({
    releaseCheck: {
      state: 'blocked',
      code: 'version-taken',
      tag: 'v1.0.0',
      owner: '48ce81c'.padEnd(40, '0'),
      built: 'e6a1cc1'.padEnd(40, '0'),
      message: 'english fallback',
      next: '1.0.1',
      nextTag: 'v1.0.1',
    },
  })])
  const summary = textOf(collapsed)

  check('the overview is actually read', calls.includes('/overview'), calls.join(','))
  check('the blocked row is marked', summary.includes('版本被占用'), summary.replace(/\s+/g, ' ').slice(0, 140))
  check('the blocked row offers the bump instead of a plain release', hasButton(collapsed, '升版本并发布'))
  check('the English fallback is not what a Chinese user reads', summary.includes('english fallback') === false)

  const { pressed, tree } = await expandFirstRow(collapsed)
  const detail = textOf(tree)
  check('a row can be expanded', pressed === true)
  check('the blocked row names both commits', detail.includes('48ce81c') && detail.includes('e6a1cc1'), detail.replace(/\s+/g, ' ').slice(0, 160))
  check('the reason is in the panel, not only in the logs', detail.includes('release.yml 会拒绝覆盖'))
  check('the expansion offers the bump too', hasButton(tree, '升版本并发布'))

  /* The bump commits and pushes, so it must be a deliberate second click — the
     same shape as publishing a draft, which is the other one-way action here. */
  const asked = clickButton(tree, '升版本并发布')
  const confirm = textOf(await rerender())
  check('the bump asks before it writes anything', asked === true && confirm.includes('这会创建一个提交'), confirm.replace(/\s+/g, ' ').slice(0, 200))
  check('the confirmation names the version it would write', confirm.includes('1.0.1'))
}

/* -- 2. A free version keeps the ordinary release button ------------------- */
{
  const tree = await renderPanel([repoFixture({ published: false, publishedTag: null })])
  const text = textOf(tree)

  check('a free version offers 发布', hasButton(tree, '发布'))
  check('a free version does not offer a bump', hasButton(tree, '升版本并发布') === false)
  check('a free version is not marked as taken', text.includes('版本被占用') === false)
}

/* -- 3. An uncommitted tree warns that the release would miss it ----------- */
{
  const collapsed = await renderPanel([repoFixture({
    local: { available: true, branch: 'main', head: 'b'.repeat(40), dirty: 7, ahead: 0, behind: 0, upstreamKnown: true },
  })])
  check('uncommitted work is counted on the row', textOf(collapsed).includes('未提交 7'), textOf(collapsed).replace(/\s+/g, ' ').slice(0, 140))
  const { tree } = await expandFirstRow(collapsed)
  check('uncommitted work is explained, not just counted', textOf(tree).includes('不会进入发布包'), textOf(tree).replace(/\s+/g, ' ').slice(0, 200))
}

/* -- 4. A stale Host is named as a version mismatch, not a bare error ------ */
{
  const tree = await renderPanel([repoFixture()], { ...baseStatus.value, protocol: CLIENT_PROTOCOL - 1 })
  check('a stale Host is named as such', textOf(tree).includes('页面与宿主半边版本不一致'), textOf(tree).replace(/\s+/g, ' ').slice(0, 140))
}

/* -- 5. A Host that needs setup says so instead of showing an empty list --- */
{
  const tree = await renderPanel([repoFixture()], {
    ...baseStatus.value,
    gh: { ...baseStatus.value.gh, available: false, message: 'gh not found' },
  })
  check('a missing gh is explained', textOf(tree).includes('没有找到 gh CLI'), textOf(tree).replace(/\s+/g, ' ').slice(0, 140))
}

/* -- 6. A linked checkout keeps the published artifact out of the row ---------
   The state the version comparison cannot reach: the checkout and the release both
   say 1.0.0, yet only one of them is what someone who downloaded the release runs.
   The capability stays — "does the released artifact install?" is a question this
   panel exists to answer — but not on the row. A checkout is the normal state on the
   machine that DEVELOPED the plugin, where the row's button would only replace the
   code being edited with a tarball. */
{
  const collapsed = await renderPanel([repoFixture({ install: installFixture({ state: 'checkout' }) })])
  check('a linked checkout is NOT offered on the row', hasButton(collapsed, '装 Release v1.0.0') === false, textOf(collapsed).replace(/\s+/g, ' ').slice(0, 200))
  check('a linked checkout is not marked as behind on the row', textOf(collapsed).includes('可更新') === false)

  const { tree } = await expandFirstRow(collapsed)
  const detail = textOf(tree)
  check('the capability is still there, one level down', hasButton(tree, '装 Release v1.0.0'))
  check('the expansion says the installed copy is a checkout, not the release', detail.includes('不是发布出去的那份'), detail.replace(/\s+/g, ' ').slice(0, 220))
  check('the explanation names the link spec', detail.includes('link:F:\\CodeProj\\dsh-plugin-restart'))

  /* Installing rewrites a profile dependency, so it asks first — the same shape as
     the bump, which is the other action here that changes something on disk. */
  const asked = clickButton(tree, '装 Release v1.0.0')
  const confirm = await rerender()
  check('installing asks before it rewrites the profile', asked === true && textOf(confirm).includes('这会改写该 profile 的依赖条目'), textOf(confirm).replace(/\s+/g, ' ').slice(0, 240))
}

/* -- 6b. An "install" that would move BACKWARDS stays off the row ------------
   The profile holds something newer than the release. Offering that button on the row
   is offering a downgrade as if it were housekeeping. */
{
  const collapsed = await renderPanel([repoFixture({ install: installFixture({ state: 'ahead', installedVersion: '2.0.0', latestTag: 'v1.0.0', latestVersion: '1.0.0' }) })])
  check('a profile holding something newer is not offered a downgrade on the row', hasButton(collapsed, '装 Release v1.0.0') === false, textOf(collapsed).replace(/\s+/g, ' ').slice(0, 200))

  const { tree } = await expandFirstRow(collapsed)
  check('the downgrade is still explained where it is offered', hasButton(tree, '装 Release v1.0.0') && textOf(tree).includes('退回到旧版本'))
}

/* -- 7. An update, then the restart question -------------------------------- */
{
  const answers = {
    '/update': { ok: true, value: { repo: 'dsh-plugin-restart', packageName: 'dsh-plugin-restart', tag: 'v1.0.1', version: '1.0.1', from: '1.0.0', restartRequired: true, pendingBuilds: [] } },
    '/restart': { ok: true, value: { scheduled: true, armDelayMs: 1200 } },
  }
  const collapsed = await renderPanel(
    [repoFixture({ install: installFixture({ state: 'update', installedVersion: '1.0.0', latestTag: 'v1.0.1', latestVersion: '1.0.1' }) })],
    baseStatus.value,
    answers,
  )
  check('an installed copy behind the release is marked on the row', textOf(collapsed).includes('可更新 v1.0.1'), textOf(collapsed).replace(/\s+/g, ' ').slice(0, 160))
  check('the row offers the update by its target version', hasButton(collapsed, '更新到 v1.0.1'))

  const { tree } = await expandFirstRow(collapsed)
  clickButton(tree, '更新到 v1.0.1')
  const confirmation = await rerender()
  check('the update asks before it writes', textOf(confirmation).includes('换成 Release v1.0.1 的 tgz'), textOf(confirmation).replace(/\s+/g, ' ').slice(0, 240))

  clickButton(confirmation, '确认更新')
  await rerender()
  const settled = await rerender()
  const text = textOf(settled)
  check('the update really posted to the Host', calls.includes('/update'), calls.join(','))
  check('the panel says the new version needs a restart', text.includes('the new version') || text.includes('重启 DSH 才会真正生效'), text.replace(/\s+/g, ' ').slice(0, 240))
  check('and it asks the restart question instead of assuming an answer', text.includes('现在重启'), text.replace(/\s+/g, ' ').slice(0, 240))
  check('the restart is offered as a button', hasButton(settled, '立即重启 DSH'))

  clickButton(settled, '立即重启 DSH')
  await rerender()
  const restarted = await rerender()
  check('the restart really reached the restart route', calls.includes('/restart'), calls.join(','))
  check('a scheduled restart is reported, not implied', textOf(restarted).includes('已安排重启'), textOf(restarted).replace(/\s+/g, ' ').slice(0, 240))
}

/* -- 8. States with nothing to do offer no button --------------------------- */
{
  const current = await renderPanel([repoFixture({ install: installFixture({ state: 'current' }) })])
  const { tree: currentDetail } = await expandFirstRow(current)
  check('a current install offers no update button', hasButton(currentDetail, '装 Release') === false && hasButton(currentDetail, '更新到') === false)
  check('a current install says so', textOf(currentDetail).includes('已经是最新的'))

  const missing = await renderPanel([repoFixture({ install: installFixture({ state: 'not-installed', present: false, spec: '', installedVersion: null }) })])
  const { tree: missingDetail } = await expandFirstRow(missing)
  check('an uninstalled package offers no update button', hasButton(missingDetail, '装 Release') === false && hasButton(missingDetail, '更新到') === false)
  check('an uninstalled package names the profile that was searched', textOf(missingDetail).includes('desktop profile 的依赖里'), textOf(missingDetail).replace(/\s+/g, ' ').slice(0, 220))
}

/* -- 8b. Nothing written means nothing to restart --------------------------- */
{
  const panel = await renderPanel(
    [repoFixture({ install: installFixture({ state: 'update', latestTag: 'v1.0.1', latestVersion: '1.0.1' }) })],
    baseStatus.value,
    {
      /* The profile already pointed at exactly this tarball, so the Host answers
         success with `changed: false` — the outcome that was asked for, reached
         without writing anything. */
      '/update': { ok: true, value: { repo: 'dsh-plugin-restart', packageName: 'dsh-plugin-restart', tag: 'v1.0.1', from: '1.0.1', changed: false, restartRequired: false, pendingBuilds: [] } },
    },
  )
  const { tree } = await expandFirstRow(panel)
  clickButton(tree, '更新到 v1.0.1')
  const confirmation = await rerender()
  clickButton(confirmation, '确认更新')
  await rerender()
  const settled = await rerender()
  const text = textOf(settled)
  check('a no-op update says nothing changed', text.includes('没有改动，也不需要重启'), text.replace(/\s+/g, ' ').slice(0, 240))
  check('a no-op update does not claim a write that never happened', text.includes('已从') === false)
  check('a no-op update asks for no restart', hasButton(settled, '立即重启 DSH') === false)
}

/* -- 9. A missing restart plugin is named, not swallowed -------------------- */
{
  const panel = await renderPanel(
    [repoFixture({ install: installFixture({ state: 'update', latestTag: 'v1.0.1', latestVersion: '1.0.1' }) })],
    baseStatus.value,
    {
      '/update': { ok: true, value: { repo: 'dsh-plugin-restart', packageName: 'dsh-plugin-restart', tag: 'v1.0.1', from: '1.0.0', restartRequired: true, pendingBuilds: [] } },
      '/restart': { ok: false, code: 'restart-unavailable', message: 'dsh-plugin-restart is not mounted on this Host, so nothing here can restart DSH', __status: 501 },
    },
  )
  const { tree } = await expandFirstRow(panel)
  clickButton(tree, '更新到 v1.0.1')
  const confirmation = await rerender()
  clickButton(confirmation, '确认更新')
  await rerender()
  const settled = await rerender()
  clickButton(settled, '立即重启 DSH')
  await rerender()
  const after = await rerender()
  check('a refused restart is reported as a failure, not as success', textOf(after).includes('重启不了'), textOf(after).replace(/\s+/g, ' ').slice(0, 240))
  check('the refusal names the plugin that is missing', textOf(after).includes('dsh-plugin-restart'), textOf(after).replace(/\s+/g, ' ').slice(0, 200))
}

/* -- 10. npm: a version that is not up there is a job waiting ---------------- */
{
  const answers = {
    '/npm-publish': { ok: true, value: { repo: 'dsh-plugin-restart', packageName: 'dsh-plugin-restart', version: '1.0.1', registry: 'https://registry.npmjs.org/', wasUnregistered: false, account: 'soh4c4759' } },
  }
  const collapsed = await renderPanel([repoFixture()], baseStatus.value, answers, npmStatusValue())
  check('the npm status is actually asked for', calls.includes('/npm-status'), calls.join(','))
  check('a version npm does not have is marked on the row', textOf(collapsed).includes('npm 待推 v1.0.1'), textOf(collapsed).replace(/\s+/g, ' ').slice(0, 180))
  check('the npm account is shown in the header', textOf(collapsed).includes('npm soh4c4759'))
  /* The four-step guide is for someone who has no credential; showing it to someone
     who has one is the panel nagging about a solved problem. */
  check('a signed-in machine is not shown the credential guide', textOf(collapsed).includes('① 还没有 npm 账号？') === false)

  const { tree } = await expandFirstRow(collapsed)
  const detail = textOf(tree)
  check('the expansion says what npm currently has', detail.includes('npm 上是 1.0.0'), detail.replace(/\s+/g, ' ').slice(0, 240))
  /* The GitHub Release for 1.0.1 does not exist in this fixture, and the two channels
     are about to disagree in public — so the row says so before the click. */
  check('a missing GitHub release for the same version is called out', detail.includes('先于 Release 面世'))

  clickButton(tree, '推送到 npm v1.0.1')
  const confirmation = await rerender()
  const confirmText = textOf(confirmation)
  check('the push asks before it uploads', confirmText.includes('npm 不允许同一版本推第二次'), confirmText.replace(/\s+/g, ' ').slice(0, 260))
  check('the confirmation names the registry it would publish to', confirmText.includes('https://registry.npmjs.org/'))
  check('the confirmation offers a place for a 2FA code', typeInto(confirmation, '6 位数字', '123456'))

  clickButton(await rerender(), '确认推送')
  await rerender()
  const settled = await rerender()
  check('the push really posted to the Host', calls.includes('/npm-publish'), calls.join(','))
  check('a successful push is reported with the version', textOf(settled).includes('dsh-plugin-restart@1.0.1'), textOf(settled).replace(/\s+/g, ' ').slice(0, 240))
}

/* -- 11. A name nobody owns says so ----------------------------------------- */
{
  const panel = await renderPanel([repoFixture()], baseStatus.value, {}, npmStatusValue({
    repos: [npmFixture({ state: 'unregistered', latest: null })],
  }))
  /* On the row, a first publish and a later one are the same job, so they share the
     same chip; the difference — "nobody owns this name yet" — belongs in the
     expansion, where there is room to explain what it means. */
  check('an unregistered name is offered on the row like any other push', textOf(panel).includes('npm 待推 v1.0.1'), textOf(panel).replace(/\s+/g, ' ').slice(0, 180))
  const { tree } = await expandFirstRow(panel)
  check('an unregistered name is marked as unowned in the expansion', textOf(tree).includes('npm 上还没有'))
  check('an unregistered name is explained as a first release', textOf(tree).includes('首次发布'))
}

/* -- 12. Nothing to do renders no button ------------------------------------ */
{
  const published = await renderPanel([repoFixture()], baseStatus.value, {}, npmStatusValue({
    repos: [npmFixture({ state: 'published', canPublish: false, blockers: ['already-published'], version: '1.0.1' })],
  }))
  check('a published version is shown as published', textOf(published).includes('npm v1.0.1'), textOf(published).replace(/\s+/g, ' ').slice(0, 180))
  const { tree } = await expandFirstRow(published)
  check('a published version offers no push', hasButton(tree, '推送到 npm') === false)
  check('and says npm never takes the same version twice', textOf(tree).includes('同一版本推第二次'))

  /* `private: true` is an author's decision, not a mistake — the reason has to be
     the one on screen, or the missing button looks like a bug. */
  const blocked = await renderPanel([repoFixture()], baseStatus.value, {}, npmStatusValue({
    repos: [npmFixture({ canPublish: false, blockers: ['private-package'], privatePackage: true })],
  }))
  const { tree: blockedDetail } = await expandFirstRow(blocked)
  check('a private package offers no push', hasButton(blockedDetail, '推送到 npm') === false)
  check('a private package says why', textOf(blockedDetail).includes('"private": true'), textOf(blockedDetail).replace(/\s+/g, ' ').slice(0, 240))
}

/* -- 13. npm credentials without a terminal --------------------------------- */
{
  const notSignedIn = npmStatusValue({
    auth: { loggedIn: false, account: null, message: '[ERR_PNPM_WHOAMI_UNAUTHORIZED] You must be logged in to use whoami', npmrcPath: 'C:\\Users\\x\\.npmrc', npmrcReadable: false, npmrcHasToken: false },
    repos: [npmFixture({ canPublish: false, blockers: ['not-logged-in'] })],
  })
  const panel = await renderPanel([repoFixture()], baseStatus.value, {
    '/npm-login': { ok: true, value: { account: 'soh4c4759', registry: 'https://registry.npmjs.org/', npmrcPath: 'C:\\Users\\x\\.npmrc', replaced: false } },
  }, notSignedIn)
  const text = textOf(panel)
  check('a missing npm credential is explained, not hidden', text.includes('还没有登录'), text.replace(/\s+/g, ' ').slice(0, 240))
  /* What the package manager actually said, verbatim: "not signed in" and "that
     token was revoked" are the same blank state and different problems. */
  check('the package manager\'s own message is shown', text.includes('ERR_PNPM_WHOAMI_UNAUTHORIZED'))
  check('the row offers no push while unauthenticated', hasButton(panel, '推送到 npm') === false)
  /* The panel is the operational view: it carries the control, not the course. The
     four steps moved to their own settings page, and the panel says where. */
  /* The path names all three hops, and the segment, because the page moved twice: it is
     a tab inside Plugins, and npm is a segment inside that tab. A hint that stopped at
     设置 — or at the tab — would send someone to a row that is not there any more, or to
     a page whose first screen is GitHub. */
  check('the panel points at the settings guide, by its real path', text.includes('设置 → 插件 → DSH 插件发布台 · npm'), text.replace(/\s+/g, ' ').slice(0, 240))
  check('the panel no longer walks the four steps itself', text.includes('① 还没有 npm 账号？') === false)

  const typed = typeInto(panel, 'npm_', 'npm_abcdefghijklmnop')
  const ready = await rerender()
  check('the token field accepts a token', typed === true)
  const asked = clickButton(ready, '写入并验证')
  await rerender()
  const after = await rerender()
  check('the token is really posted to the Host', calls.includes('/npm-login'), calls.join(','))
  check('writing a token is confirmed with the account', asked === true && textOf(after).includes('soh4c4759'), textOf(after).replace(/\s+/g, ' ').slice(0, 240))
}

/* -- 13b. The npm credentials page: the guide, as configuration ------------- */
{
  const notSignedIn = npmStatusValue({
    auth: { state: 'none', loggedIn: false, account: null, message: '[ERR_PNPM_WHOAMI_UNAUTHORIZED] You must be logged in to use whoami', npmrcPath: 'C:\\Users\\x\\.npmrc', npmrcReadable: false, npmrcHasToken: false },
    repos: [npmFixture({ canPublish: false, blockers: ['not-logged-in'] })],
  })
  const page = await renderNpmPage(notSignedIn, {
    '/npm-login': { ok: true, value: { account: 'soh4c4759', registry: 'https://registry.npmjs.org/', npmrcPath: 'C:\\Users\\x\\.npmrc', replaced: false } },
  })
  const text = textOf(page)
  check('the settings page asks npm on its own', calls.includes('/npm-status'), calls.join(','))
  check('the page names the file npm itself reads', text.includes('C:\\Users\\x\\.npmrc'))
  /* Zero-basics means the four steps are written out, not one sentence that assumes
     the reader already knows how npm tokens work. */
  check('the guide walks all four steps', ['① 还没有 npm 账号？', '② 生成一个 Access Token', '③ 粘贴到下面', '④ 账号开了 2FA？'].every((step) => text.includes(step)), text.replace(/\s+/g, ' ').slice(0, 320))
  check('the guide links to the sign-up page', hasButton(page, '打开 npmjs.com 注册'))
  check('the guide links to the token page', hasButton(page, '打开 token 页面'))
  check('the guide links to the npm documentation', hasButton(page, 'npm 官方文档'))
  /* The facts that changed in November 2025, and that a stale guide gets wrong:
     classic tokens are gone, a write token has a 90-day ceiling, 2FA is on by default. */
  check('the guide says classic tokens are gone', text.includes('Classic token 已于 2025-11-19'), text.replace(/\s+/g, ' ').slice(0, 320))
  check('the guide states the 90-day ceiling', text.includes('最长 90 天'))
  check('the guide says not to bypass 2FA for a local push', text.includes('不要勾'))
  check('the guide says the email must be verified before publishing', text.includes('不允许未验证邮箱的账号发布'))
  /* npmjs.com answers a whole-site 403 to some networks, and the token does not care
     where it was minted — a guide that assumes this machine can open the site sends
     someone to fight a bot challenge they cannot win from there. */
  check('the guide offers the other-device workaround', text.includes('换一台设备或换一个网络'), text.replace(/\s+/g, ' ').slice(0, 320))
  /* A step is only ticked where the Host can actually know: it can see a missing
     token line, and it cannot see whether an account was ever registered. */
  check('step ③ is the one step with a live state', text.includes('待做'))
  check('the steps that cannot be checked say so instead of ticking', text.includes('无法自动检测'))
  check('an uncheckable step is never ticked as done', text.includes('✓ 已有账号') === false)
  check('the page points at trusted publishing for CI', text.includes('trusted publishing'))
  /* Every package's npm posture, which is the configuration payoff of this page. */
  check('the page lists each package', text.includes('dsh-plugin-restart') && text.includes('本地 1.0.1'))
  check('a package nobody can push yet says why', text.includes('还没有登录 npm'))

  const typed = typeInto(page, 'npm_', 'npm_abcdefghijklmnop')
  const ready = await rerenderNpm()
  check('the settings page accepts a token too', typed === true)
  const asked = clickButton(ready, '写入并验证')
  await rerenderNpm()
  const after = await rerenderNpm()
  check('the settings page posts the token to the Host', calls.includes('/npm-login'), calls.join(','))
  check('the settings page confirms with the account', asked === true && textOf(after).includes('soh4c4759'), textOf(after).replace(/\s+/g, ' ').slice(0, 260))
}

/* -- 13c. The page marks what it can verify, and only that ------------------ */
{
  const signedIn = npmStatusValue({
    auth: { state: 'signed-in', loggedIn: true, account: 'soh4c4759', message: null, npmrcPath: 'C:\\Users\\x\\.npmrc', npmrcReadable: true, npmrcHasToken: true },
    repos: [npmFixture({ state: 'published', canPublish: false, blockers: ['already-published'], version: '1.0.1', latest: '1.0.1' })],
  })
  const page = await renderNpmPage(signedIn)
  const text = textOf(page)
  check('a confirmed account ticks the steps it proves', text.includes('✓ 已有账号 soh4c4759') && text.includes('✓ 已有可用的 token'), text.replace(/\s+/g, ' ').slice(0, 320))
  check('a token line in .npmrc ticks step 3', text.includes('✓ C:\\Users\\x\\.npmrc 里已有凭据'))
  check('the registry is named with its source', text.includes('源 https://registry.npmjs.org/'))
  check('no message template leaks onto the page', text.includes('{registry}') === false && text.includes('{npmrc}') === false, text.replace(/\s+/g, ' ').slice(0, 260))
  check('a published package is listed as published', text.includes('已在 npm 上'))
  check('the page still states the 2FA step as unverifiable', text.includes('无法自动检测'))

  const noAnswer = await renderNpmPage(null)
  const noAnswerText = textOf(noAnswer)
  check('an unanswered status is named, not guessed at', noAnswerText.includes('还没读到 npm 的状态'), noAnswerText.replace(/\s+/g, ' ').slice(0, 240))
  check('an unanswered status ticks nothing', noAnswerText.includes('✓') === false)
}

/* -- 14. No npm answer means no npm claim ----------------------------------- */
{
  const silent = await renderPanel([repoFixture()], baseStatus.value, {}, null)
  const text = textOf(silent)
  check('an unanswered npm status invents no state', text.includes('npm 待推') === false && text.includes('npm 上还没有') === false, text.replace(/\s+/g, ' ').slice(0, 180))
  /* "No answer" is not "no credential": the four-step guide would claim this machine
     has nothing to authenticate with, which nobody has said. */
  check('an unanswered npm status does not claim there is no credential', text.includes('① 还没有 npm 账号？') === false)
  const { tree } = await expandFirstRow(silent)
  check('an unanswered npm status offers no push', hasButton(tree, '推送到 npm') === false)
}

/* -- 15. A failed push names the next step, not just the error --------------- */
{
  const answers = { '/npm-publish': { ok: false, code: 'otp-required', message: 'npm ERR! code EOTP — this operation requires a one-time password', __status: 401 } }
  const panel = await renderPanel([repoFixture()], baseStatus.value, answers, npmStatusValue())
  const { tree } = await expandFirstRow(panel)
  clickButton(tree, '推送到 npm v1.0.1')
  clickButton(await rerender(), '确认推送')
  await rerender()
  const after = await rerender()
  const text = textOf(after)
  check('a one-time password demand becomes a next step', text.includes('要求一次性密码'), text.replace(/\s+/g, ' ').slice(0, 260))
  check('the registry\'s own words are still shown', text.includes('EOTP'))

  const forbidden = await renderPanel([repoFixture()], baseStatus.value, {
    '/npm-publish': { ok: false, code: 'forbidden', message: 'npm ERR! 403 Forbidden - PUT … You do not have permission', __status: 401 },
  }, npmStatusValue())
  const { tree: forbiddenTree } = await expandFirstRow(forbidden)
  clickButton(forbiddenTree, '推送到 npm v1.0.1')
  clickButton(await rerender(), '确认推送')
  await rerender()
  const forbiddenText = textOf(await rerender())
  check('a scope refusal points at the token\'s package scope', forbiddenText.includes('Packages 范围'), forbiddenText.replace(/\s+/g, ' ').slice(0, 260))

  /* An unmapped code must print nothing rather than a dictionary key. */
  const unmapped = await renderPanel([repoFixture()], baseStatus.value, {
    '/npm-publish': { ok: false, code: 'something-new', message: 'a failure from a future version', __status: 502 },
  }, npmStatusValue())
  const { tree: unmappedTree } = await expandFirstRow(unmapped)
  clickButton(unmappedTree, '推送到 npm v1.0.1')
  clickButton(await rerender(), '确认推送')
  await rerender()
  const unmappedText = textOf(await rerender())
  check('an unrecognised failure code prints no dictionary key', unmappedText.includes('npm.hint.') === false, unmappedText.replace(/\s+/g, ' ').slice(0, 220))
  check('an unrecognised failure still reports the error', unmappedText.includes('a failure from a future version'))
}

/* -- 15b. A credential whoami will not confirm is not "no credential" ------- */
{
  /* The real shape: a granular token is package-scoped, so the user-level `whoami`
     endpoint refuses it while `publish` would accept it. Showing the four-step guide
     here would tell someone who just finished step 3 that they never started. */
  const unconfirmed = npmStatusValue({
    auth: { state: 'credential-present', loggedIn: false, account: null, message: '[ERR_PNPM_WHOAMI_UNAUTHORIZED] You must be logged in to use whoami', npmrcPath: 'C:\\Users\\x\\.npmrc', npmrcReadable: true, npmrcHasToken: true },
    repos: [npmFixture()],
  })
  const panel = await renderPanel([repoFixture()], baseStatus.value, {}, unconfirmed)
  const text = textOf(panel)
  check('an unconfirmed credential is not treated as no credential', text.includes('已经有一行 token'), text.replace(/\s+/g, ' ').slice(0, 240))
  check('an unconfirmed credential does not re-teach the four steps', text.includes('① 还没有 npm 账号？') === false)
  check('an unconfirmed credential keeps the push available', text.includes('npm 待推 v1.0.1'))
  const { tree } = await expandFirstRow(panel)
  check('the push is offered with an unconfirmed credential', hasButton(tree, '推送到 npm v1.0.1'))
  check('whoami\'s own refusal is still shown, not hidden', text.includes('ERR_PNPM_WHOAMI_UNAUTHORIZED'))
}

/* -- 16. A refused token raises the checklist ------------------------------- */
{
  const notSignedIn = npmStatusValue({
    auth: { loggedIn: false, account: null, message: '[ERR_PNPM_WHOAMI_UNAUTHORIZED] You must be logged in to use whoami', npmrcPath: 'C:\\Users\\x\\.npmrc', npmrcReadable: true, npmrcHasToken: true },
    repos: [npmFixture({ canPublish: false, blockers: ['not-logged-in'] })],
  })
  const panel = await renderPanel([repoFixture()], baseStatus.value, {
    '/npm-login': { ok: false, code: 'token-rejected', message: 'the token was written to C:\\Users\\x\\.npmrc, but the registry did not accept it: ERR_PNPM_WHOAMI_UNAUTHORIZED', __status: 401 },
  }, notSignedIn)
  check('no checklist before a token was tried', textOf(panel).includes('这个 token 没有被接受') === false)
  typeInto(panel, 'npm_', 'npm_bogus_token')
  clickButton(await rerender(), '写入并验证')
  await rerender()
  const after = await rerender()
  const text = textOf(after)
  check('a refused token raises the checklist', text.includes('这个 token 没有被接受'), text.replace(/\s+/g, ' ').slice(0, 300))
  check('the checklist names the 90-day limit among its causes', text.includes('90 天有效期'))
  check('the refusal does not leak what was typed back into the page', text.includes('npm_bogus_token') === false)
}

/* -- 17. The Bilibili update note: bound, previewed, then posted ------------- */

/** One `/bilibili-status` repository entry, as the Host sends it. */
function biliFixture(overrides) {
  return {
    repo: 'dsh-plugin-restart',
    label: 'dsh-plugin-restart',
    binding: { bvid: 'BV1RopP6FEJp', auto: true },
    announced: [],
    failures: [],
    baseline: { tag: 'v1.0.0', at: '2026-10-06T19:00:19Z' },
    video: { ok: true, aid: 117396371216915, title: '一支视频', owner: 'UP' },
    commentUrl: 'https://www.bilibili.com/video/BV1RopP6FEJp/',
    ...overrides,
  }
}

/** The whole payload, including the credential the settings page reads. */
function biliValue(overrides) {
  return {
    enabled: true,
    auto: true,
    watchSeconds: 90,
    template: '',
    credential: {
      state: 'ready',
      message: '',
      source: 'plugin',
      path: 'C:\\Users\\x\\.dsh\\dsh-plugin-cicd\\bilibili-cookies.json',
      ownPath: 'C:\\Users\\x\\.dsh\\dsh-plugin-cicd\\bilibili-cookies.json',
      configuredPath: '',
      platform: '',
      expiresAt: null,
      hasSession: true,
      hasCsrf: true,
      account: { mid: '42', uname: '白衣为卿曲' },
    },
    login: { state: 'idle', url: '', startedAt: null, expiresAt: null, scanned: false, message: '' },
    ledger: { file: 'C:\\Users\\x\\.dsh\\dsh-plugin-cicd\\bilibili-announcements.json', problem: null, entries: 1 },
    lastSweep: { at: '2026-10-07T01:00:00Z', reason: 'timer', results: [{ repo: 'dsh-plugin-restart', tag: 'v1.0.0', state: 'announced', message: '', url: null }] },
    repos: [biliFixture()],
    ...overrides,
  }
}

/* The third segment, reached the way a person reaches it. This is also the check that
   the Bilibili page survives being mounted as a child of the console's shell rather
   than as a slot occupant: it reads the same `t` prop and nothing else. */
{
  fixture = {
    '/status': { ok: true, value: baseStatus.value },
    '/bilibili-status': { ok: true, value: biliValue() },
  }
  values.clear()
  effectSlots.clear()
  calls.length = 0
  const onBilibili = await renderSettings('bilibili')
  check('the Bilibili segment draws the update-note page', hasButton(onBilibili, '登录 B 站') || hasButton(onBilibili, '退出 B 站登录'), textOf(onBilibili).replace(/\s+/g, ' ').slice(0, 220))
  check('the Bilibili probe happens only once its segment is opened', calls.includes('/bilibili-status') === true, calls.join(','))
}

/**
 * The value of the first input whose placeholder contains this text.
 *
 * A binding is edited in a text field, and a field's value is not part of the
 * rendered text — so a test that only reads text cannot tell a prefilled field
 * from an empty one.
 */
function inputValue(node, placeholderPart) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = inputValue(child, placeholderPart)
      if (found !== null) return found
    }
    return null
  }
  if (node.type === 'input' && String(node.props?.placeholder ?? '').includes(placeholderPart)) return String(node.props?.value ?? '')
  return inputValue(node.children, placeholderPart)
}

{
  /* A published release the note has not gone out for: the row has to say so
     before anything is clicked, because that is the state the sweep acts on. */
  const panel = await renderPanel([repoFixture({ publishedTag: 'v1.0.1' })], baseStatus.value, {
    '/bilibili-status': { ok: true, value: biliValue() },
    '/bilibili-announce': { ok: true, value: previewFixture() },
  })
  check('a published release waiting on its note is flagged', textOf(panel).includes('待播报 v1.0.1'), textOf(panel).replace(/\s+/g, ' ').slice(0, 220))

  const { tree } = await expandFirstRow(panel)
  const rowText = textOf(tree)
  check('the row names the video it is bound to', rowText.includes('绑定的视频') && rowText.includes('一支视频'), rowText.replace(/\s+/g, ' ').slice(-320))
  /* A bound video is a STATE, not a draft. Editing it in place would change which video
     a repository announces under while the announcement history still points at the old
     one, so the field is gone once something is bound and the only action left is 解绑. */
  check('a bound video is shown, not offered for editing', textOf(tree).includes('BV1RopP6FEJp') && inputValue(tree, 'BV') === null, String(inputValue(tree, 'BV')))
  check('and the way to change it is spelled out', textOf(tree).includes('要换视频先【解绑】'))
  check('binding again is not on offer', hasButton(tree, '绑定') === false, textOf(tree).replace(/\s+/g, ' ').slice(-200))
  check('unbinding is', hasButton(tree, '解绑'))
  check('the row offers the manual announcement', hasButton(tree, '发更新评论'))

  /* The preview is the Host's own composition — the sentence shown is the sentence
     that would be sent, which is why it is asked for rather than built here. */
  clickButton(tree, '发更新评论')
  const previewed = await rerender()
  check('the preview shows the exact comment', textOf(previewed).includes('【更新 v1.0.1】新增 B 站更新播报'), textOf(previewed).replace(/\s+/g, ' ').slice(0, 260))
  check('the preview asks before posting', hasButton(previewed, '确认发送'))

  clickButton(previewed, '确认发送')
  const after = await rerender()
  check('the post is sent with the previewed text', calls.includes('/bilibili-announce'), calls.join(','))
  check('posting reports where it went', textOf(after).includes('已发送到 BV1RopP6FEJp'), textOf(after).replace(/\s+/g, ' ').slice(0, 260))
}

/** What a dry run answers: the sentence, and the Host's verdict on it. */
function previewFixture(overrides) {
  return {
    repo: 'dsh-plugin-restart',
    bvid: 'BV1RopP6FEJp',
    tag: 'v1.0.1',
    state: 'ready',
    message: '',
    text: '【更新 v1.0.1】新增 B 站更新播报',
    summary: '新增 B 站更新播报',
    unknown: [],
    release: { tag: 'v1.0.1', name: '新增 B 站更新播报', url: 'https://example.invalid/v1.0.1', createdAt: '2026-10-07T00:00:00Z' },
    ledgerProblem: null,
    attempts: 0,
    ...overrides,
  }
}

{
  /* The failure this whole feature is shaped around: the credential biliup writes
     by default is an APP login, and calling that "not signed in" sends the reader
     to re-login in the wrong place. */
  const panel = await renderPanel([repoFixture()], baseStatus.value, {
    '/bilibili-status': {
      ok: true,
      value: biliValue({
        credential: {
          ...biliValue().credential,
          state: 'not-logged-in',
          account: null,
          platform: 'BiliTV',
          message: '这份凭据是 BiliTV 登录（APP/TV），B 站 Web 会员接口回 -101——发评论走的是 Web 接口，所以它发不了。',
        },
      }),
    },
  })
  const text = textOf(panel)
  check('a bound video with an unusable credential is raised in the panel', text.includes('更新评论发不出去'))
  check('the panel explains the APP credential rather than saying "not signed in"', text.includes('BiliTV'))
  check('the sign-in is offered right there', hasButton(panel, '登录 B 站'))
}

/* -- 18. 提交, 构建, 发布 — the row in the order the work happens -------------
   Both of the other two act on what is on GitHub: a release builds the pushed commit
   and a build runs it, so neither can see work that is still only on this disk. 提交
   is the step that makes the other two able to see it, which is why it comes first and
   why it is never the primary button. */
{
  /** The button labels of a tree, in the order they are drawn. */
  function buttonTexts(node, out = []) {
    if (node === null || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) buttonTexts(child, out)
      return out
    }
    if (node.type === 'button') out.push(textOf(node).trim())
    buttonTexts(node.children, out)
    return out
  }

  /** The first button carrying this label, so its props can be read. */
  function findButton(node, label) {
    if (node === null || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findButton(child, label)
        if (found !== null) return found
      }
      return null
    }
    if (node.type === 'button' && textOf(node).includes(label)) return node
    return findButton(node.children, label)
  }

  /* A checkout with two changes waiting: the state the button exists for. */
  const dirtyPanel = await renderPanel([repoFixture({ local: { ...repoFixture().local, dirty: 2, ahead: 0, files: ['package.json', 'README.md'] } })])
  const labels = buttonTexts(dirtyPanel)
  const at = (label) => labels.findIndex((text) => text.includes(label))
  check('the row offers 提交', at('提交') !== -1, labels.join(' | '))
  check('提交 comes before 构建', at('提交') !== -1 && at('构建') !== -1 && at('提交') < at('构建'), labels.join(' | '))
  check('构建 comes before 发布', at('构建') !== -1 && at('发布') !== -1 && at('构建') < at('发布'), labels.join(' | '))
  check('提交 is not the primary button', findButton(dirtyPanel, '提交')?.props?.kind === undefined, String(findButton(dirtyPanel, '提交')?.props?.kind))

  const { tree: dirtyOpen } = await expandFirstRow(dirtyPanel)
  check('the row explains what 提交 would commit', findButton(dirtyOpen, '提交')?.props?.title === '将提交 2 个改动：', String(findButton(dirtyOpen, '提交')?.props?.title))
  const asked = clickButton(dirtyOpen, '提交')
  const confirm = await rerender()
  /* `git add -A` is the one action here that can sweep in a file the author never meant
     to publish, so the names are on screen before the button, not after it. */
  check('the confirmation names the files that would be committed', textOf(confirm).includes('package.json') && textOf(confirm).includes('README.md'), textOf(confirm).replace(/\s+/g, ' ').slice(-260))
  /* Found by its placeholder: a placeholder is a prop, not text, so the message field
     is invisible to every text assertion in this file. */
  check('the confirmation asks for a message', inputValue(confirm, '提交信息') === '', String(inputValue(confirm, '提交信息')))
  check('the commit button is held until there is a message', findButton(confirm, '确认提交')?.props?.disabled === true, String(findButton(confirm, '确认提交')?.props?.disabled))
  check('asking to commit found its button', asked === true)

  typeInto(confirm, '提交信息', 'feat: notes')
  const typed = await rerender()
  check('a message releases the commit button', findButton(typed, '确认提交')?.props?.disabled === false, String(findButton(typed, '确认提交')?.props?.disabled))

  fixture['/commit'] = { ok: true, value: { repo: 'dsh-plugin-restart', branch: 'main', committed: true, commit: 'a'.repeat(40), files: ['package.json', 'README.md'], carried: 0 } }
  clickButton(typed, '确认提交')
  const afterCommit = await rerender()
  check('the commit is sent to the Host', calls.includes('/commit'), calls.join(','))
  check('the panel says what it committed, and where', textOf(afterCommit).includes('已提交并推送到 main'), textOf(afterCommit).replace(/\s+/g, ' ').slice(-240))
}

/* The other half of the same trap: the work is committed and has never left this
   machine, which a release cannot see either. The button becomes 推送. */
{
  const aheadPanel = await renderPanel([repoFixture({ local: { ...repoFixture().local, dirty: 0, ahead: 3 } })])
  check('a clean but unpushed branch offers 推送 instead', hasButton(aheadPanel, '推送') === true, textOf(aheadPanel).replace(/\s+/g, ' ').slice(0, 200))

  const { tree } = await expandFirstRow(aheadPanel)
  clickButton(tree, '推送')
  const confirm = await rerender()
  check('the push confirmation counts the commits and names the branch', textOf(confirm).includes('把 3 个本地提交推送到 main？'), textOf(confirm).replace(/\s+/g, ' ').slice(-200))
  check('pushing needs no message', hasButton(confirm, '确认推送') === true)
}

/* Nothing to do: the button is there, disabled, and says why — rather than offering a
   call whose only outcome is a refusal. */
{
  const cleanPanel = await renderPanel([repoFixture({ local: { ...repoFixture().local, dirty: 0, ahead: 0 } })])
  const button = (function find(node) {
    if (node === null || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = find(child)
        if (found !== null) return found
      }
      return null
    }
    if (node.type === 'button' && textOf(node).includes('提交')) return node
    return find(node.children)
  })(cleanPanel)

  check('a clean, in-sync checkout cannot be committed', button?.props?.disabled === true, String(button?.props?.disabled))
  check('and the button says why', String(button?.props?.title ?? '').includes('没有可提交或推送的东西'), String(button?.props?.title))
}

/* -- 19. The sign-in code is drawn, not merely linked -------------------------
   The URL the sign-in hands back exists to be SCANNED, and the panel used to answer it
   with a link while its own hint said "scan it with the phone" — nothing on screen to
   scan. So the encoder that draws it is checked module for module against a matrix a
   reference implementation produced, frozen here as a hash and one full row. A single
   flipped module changes both: a code that looks right and does not scan is worse than
   no code, because the person holding the phone is the one who finds out.
   (The reference — `qrcode`, which another package in this profile happens to depend
   on — is NOT a dependency of this plugin: it was the oracle while the encoder was
   written, and what it produced is what is frozen below.) */
{
  /** The first `<svg>` in a tree, which is the code. */
  function findSvg(node) {
    if (node === null || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findSvg(child)
        if (found !== null) return found
      }
      return null
    }
    if (node.type === 'svg') return node
    return findSvg(node.children)
  }

  /** FNV-1a over the modules, row by row. */
  function moduleHash(grid) {
    let hash = 0x811c9dc5
    for (const row of grid) {
      for (const value of row) {
        hash ^= value === 1 ? 49 : 48
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
    }
    return hash
  }

  const rowText = (grid, index) => Array.from(grid[index]).join('')

  /* Signed in — which the fixture is by default. Every control that exists to OBTAIN a
     credential must be gone: the page said 已登录：<name> and then, directly under it,
     invited the reader to sign in again. The block was gated on "is a sign-in running"
     and never on the credential, so a successful sign-in changed the status line and
     nothing else. */
  fixture = {
    '/status': { ok: true, value: baseStatus.value },
    '/bilibili-status': { ok: true, value: biliValue() },
  }
  values.clear()
  effectSlots.clear()
  calls.length = 0
  const signedIn = await renderSettings('bilibili')
  check('a signed-in page says who is signed in', textOf(signedIn).includes('已登录 白衣为卿曲'), textOf(signedIn).replace(/\s+/g, ' ').slice(0, 200))
  check('and offers no sign-in prompt', hasButton(signedIn, '登录 B 站') === false, textOf(signedIn).replace(/\s+/g, ' ').slice(0, 240))
  check('and no hint inviting a scan', textOf(signedIn).includes('点一下会生成一个二维码') === false)
  check('and no paste field, which is another way to obtain one', inputValue(signedIn, 'SESSDATA') === null && hasButton(signedIn, '保存并验证') === false)
  check('the one action left is to stop being signed in', hasButton(signedIn, '退出 B 站登录'))

  const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=fda852ed16a061fae96dd764c797168f&from='
  const signedOut = {
    ...biliValue().credential,
    state: 'none',
    account: null,
    hasSession: false,
    hasCsrf: false,
    message: '',
  }
  fixture = {
    '/status': { ok: true, value: baseStatus.value },
    '/bilibili-status': {
      ok: true,
      value: biliValue({
        credential: signedOut,
        login: { state: 'waiting', url, startedAt: '2026-10-08T01:00:00Z', expiresAt: '2026-10-08T01:03:00Z', scanned: false, message: '' },
      }),
    },
  }
  values.clear()
  effectSlots.clear()
  calls.length = 0
  const waiting = await renderSettings('bilibili')
  const svg = findSvg(waiting)

  check('a waiting sign-in draws something to scan', svg !== null, textOf(waiting).replace(/\s+/g, ' ').slice(0, 200))
  if (svg !== null) {
    const size = Number(String(svg.props?.viewBox ?? '').split(' ')[2])
    const grid = Array.from({ length: size }, () => new Uint8Array(size))
    for (const rect of svg.children ?? []) {
      const x = Number(rect.props?.x)
      const y = Number(rect.props?.y)
      const width = Number(rect.props?.width)
      for (let k = 0; k < width; k += 1) grid[y][x + k] = 1
    }
    check('the code is the version the reference chose', size === 49, String(size))
    check('every module matches the reference', moduleHash(grid) === 2409592449, String(moduleHash(grid)))
    check('the first row matches as well, so a hash collision cannot hide a difference', rowText(grid, 0) === '1111111000101110111010010111110011011100101111111', rowText(grid, 0))
    check('the code is announced as an image, for a screen reader', svg.props?.role === 'img' && svg.props?.['aria-label'] === 'B 站登录二维码', String(svg.props?.['aria-label']))
  }

  /* That URL is the H5 page for a PHONE: a desktop browser answers it with the
     Bilibili app's APK, which is a download rather than a sign-in. The code is the way
     through, and offering the page beside it is offering a dead end. */
  check('nothing offers to open the sign-in page', hasButton(waiting, '打开登录页面') === false, textOf(waiting).replace(/\s+/g, ' ').slice(0, 220))

  /* Longer than version 10 holds. The panel shows the fallback and says why, never a
     code that encodes something else. */
  fixture['/bilibili-status'] = {
    ok: true,
    value: biliValue({
      credential: signedOut,
      login: { state: 'waiting', url: `https://example.com/${'a'.repeat(260)}`, startedAt: '2026-10-08T01:00:00Z', expiresAt: '2026-10-08T01:03:00Z', scanned: false, message: '' },
    }),
  }
  values.clear()
  effectSlots.clear()
  const tooLong = await renderSettings('bilibili')
  check('a URL too long to encode draws no code', findSvg(tooLong) === null)
  check('and says so, instead of drawing something wrong', textOf(tooLong).includes('画不成二维码'), textOf(tooLong).replace(/\s+/g, ' ').slice(-200))
  /* The fallback is the paste field, not a browser page: that URL is the phone's H5
     page, and a desktop browser answers it with the app's APK instead of a sign-in. */
  check('the fallback offered is the paste field, not a browser page', hasButton(tooLong, '保存并验证') && hasButton(tooLong, '打开登录页面') === false, textOf(tooLong).replace(/\s+/g, ' ').slice(-260))
}

/* -- 20. A repository with no working tree can fetch one ----------------------
   Registered but not cloned, every action on this page is unavailable: 提交 has nothing
   to commit, 构建 and 发布 act on what is on GitHub rather than on this disk, and the
   local column reads as broken. The panel answers the one question that unblocks all of
   it — where is it, and shall I fetch it — with the address already filled in, because
   the Host can derive it from the name it already has. */
{
  const cloneFixture = (overrides) => repoFixture({
    localPath: '',
    cloneUrl: 'https://github.com/SOH4C4759/dsh-plugin-restart.git',
    checkoutRoot: 'F:\\CodeProj',
    local: { available: false, reason: 'no localPath configured' },
    ...overrides,
  })

  const panel = await renderPanel([cloneFixture({})])
  const { tree } = await expandFirstRow(panel)
  check('a repository with no checkout says so', textOf(tree).includes('还没有本地检出'), textOf(tree).replace(/\s+/g, ' ').slice(0, 200))
  check('and offers the address already filled in', inputValue(tree, '仓库地址') === 'https://github.com/SOH4C4759/dsh-plugin-restart.git', String(inputValue(tree, '仓库地址')))
  check('and says where it would land', textOf(tree).includes('将克隆到 F:\\CodeProj\\dsh-plugin-restart'), textOf(tree).replace(/\s+/g, ' ').slice(-200))
  check('with a clone button', hasButton(tree, '克隆'))

  fixture['/clone'] = { ok: true, value: { repo: 'dsh-plugin-restart', path: 'F:\\CodeProj\\dsh-plugin-restart', url: 'https://github.com/SOH4C4759/dsh-plugin-restart.git' } }
  const asked = clickButton(tree, '克隆')
  const after = await rerender()
  check('the clone is sent to the Host', asked === true && calls.includes('/clone'), calls.join(','))
  check('and the panel says where it landed', textOf(after).includes('已克隆到 F:\\CodeProj\\dsh-plugin-restart'), textOf(after).replace(/\s+/g, ' ').slice(-200))

  /* Nowhere to put it: a named refusal with the key that fixes it, rather than a button
     whose only outcome is a refusal in English from the Host. */
  const noRoot = await renderPanel([cloneFixture({ checkoutRoot: '' })])
  const { tree: noRootTree } = await expandFirstRow(noRoot)
  check('nowhere to clone into is explained', textOf(noRootTree).includes('还没设置检出根目录'), textOf(noRootTree).replace(/\s+/g, ' ').slice(-220))
  check('and the key that fixes it is named', textOf(noRootTree).includes('projectsRoot'))
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
