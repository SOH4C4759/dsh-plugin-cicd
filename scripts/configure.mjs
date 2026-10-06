#!/usr/bin/env node
/**
 * Configure the Release Console without editing YAML by hand.
 *
 * The plugin's row lives in the profile patch, which is the wrong place to keep a
 * list that changes: hand-editing it is slow, easy to get wrong, and needs a
 * restart to take effect. So the repository list lives in a JSON file this script
 * owns, the row only has to be pointed at it once, and the plugin re-reads the
 * file on every request — `add` is visible on the panel's next poll.
 *
 *   node scripts/configure.mjs list
 *   node scripts/configure.mjs add dsh-plugin-restart --path F:\CodeProj\dsh-plugin-restart
 *   node scripts/configure.mjs add other/repo
 *   node scripts/configure.mjs remove dsh-plugin-restart
 *   node scripts/configure.mjs owner SOH4C4759
 *   node scripts/configure.mjs check            # what the panel would show right now
 *
 * Options:
 *   --file <path>     manage a different file (default: $DSH_HOME/dsh-plugin-cicd/repos.json)
 *   --json            machine-readable output
 *   --url <base>      Host base URL for `check` (default: $DSH_WEB_URL or http://127.0.0.1:19387)
 *
 * Windows paths are written with backslashes and read back the same way; nothing
 * here rewrites a path, so what you typed is what the plugin sees.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { SLUG, SLUG_WITH_OWNER, isValidRepoName, readConfig, writeConfig } from '../lib/config-store.mjs'

const DEFAULT_HOST_URL = 'http://127.0.0.1:19387'

const argv = process.argv.slice(2)
const options = { json: false, file: '', url: '', path: '', label: '' }
const positional = []
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  if (token === '--json') options.json = true
  else if (token === '--file') options.file = argv[++index] ?? ''
  else if (token === '--url') options.url = argv[++index] ?? ''
  else if (token === '--path') options.path = argv[++index] ?? ''
  else if (token === '--label') options.label = argv[++index] ?? ''
  else if (token.startsWith('--')) fail(`unknown option: ${token}`)
  else positional.push(token)
}

const command = positional[0] ?? 'list'

/** Print a message to stderr and exit non-zero. */
function fail(message) {
  process.stderr.write(`configure: ${message}\n`)
  process.exit(2)
}

/** The managed file, resolved the same way the Host resolves it. */
function configPath() {
  if (options.file !== '') return resolve(options.file)
  if (typeof process.env.DSH_CICD_CONFIG === 'string' && process.env.DSH_CICD_CONFIG !== '') return resolve(process.env.DSH_CICD_CONFIG)
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(process.env.USERPROFILE ?? homedir(), '.dsh')
  return join(home, 'dsh-plugin-cicd', 'repos.json')
}

/** Read the managed file and turn a problem into a CLI error. */
function loadConfig(file) {
  const stored = readConfig(file)
  if (stored.problem !== null) fail(`${stored.problem}. Fix or delete the file, then retry.`)
  return { owner: stored.owner, repos: stored.repos, dropped: stored.dropped }
}

/** Validate one repository argument the way the Host will. */
function checkRepoSlug(repo) {
  if (repo === undefined) fail('a repository name is required')
  if (!isValidRepoName(repo)) {
    fail(`unusable repository name: ${JSON.stringify(repo)} — expected "name" or "owner/name"`)
  }
  return repo
}

/** Validate a local path: the Host ignores a relative one, so refuse it here. */
function checkLocalPath(value) {
  if (value === '') return ''
  if (!isAbsolute(value)) fail(`--path must be absolute, got ${JSON.stringify(value)} (a relative path resolves against the Host's own directory)`)
  return value
}

function emit(payload, human) {
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stdout.write(`${human}\n`)
}

const file = configPath()
const config = loadConfig(file)

switch (command) {
  case 'list': {
    const lines = [`config file: ${file}`, `owner:       ${config.owner === '' ? '(unset)' : config.owner}`, `repositories (${config.repos.length}):`]
    for (const entry of config.repos) {
      lines.push(`  - ${entry.repo}${entry.localPath === undefined ? '' : `  →  ${entry.localPath}`}${entry.label === undefined ? '' : `  [${entry.label}]`}`)
    }
    if (config.repos.length === 0) lines.push('  (none — add one with: configure.mjs add <repo> --path <dir>)')
    lines.push('', 'The panel re-reads this file on every poll, so changes apply without a restart.')
    emit({ file, owner: config.owner, repos: config.repos }, lines.join('\n'))
    break
  }

  case 'init': {
    if (existsSync(file)) emit({ file, created: false }, `already exists: ${file}`)
    else {
      writeConfig(file, config)
      emit({ file, created: true }, `created ${file}`)
    }
    break
  }

  case 'owner': {
    const owner = positional[1]
    if (owner === undefined || owner === '') fail('owner requires a GitHub login')
    if (!SLUG.test(owner)) fail(`unusable GitHub login: ${JSON.stringify(owner)}`)
    config.owner = owner
    writeConfig(file, config)
    emit({ file, owner }, `owner set to ${owner} in ${file}`)
    break
  }

  case 'add': {
    const repo = checkRepoSlug(positional[1])
    const localPath = checkLocalPath(options.path)
    const existing = config.repos.findIndex((entry) => entry.repo === repo)
    const entry = { repo, ...(localPath !== '' ? { localPath } : {}), ...(options.label !== '' ? { label: options.label } : {}) }
    if (existing === -1) config.repos.push(entry)
    else config.repos[existing] = entry
    writeConfig(file, config)
    const notes = [`${existing === -1 ? 'added' : 'updated'} ${repo} in ${file}`]
    if (localPath !== '' && !existsSync(localPath)) notes.push(`note: ${localPath} does not exist yet — the panel will show "not a git checkout" until it does`)
    if (localPath === '') notes.push('note: no --path given, so the panel cannot compare the local checkout against the release')
    if (!SLUG_WITH_OWNER.test(repo) && config.owner === '') notes.push(`note: "${repo}" has no owner and the file records none — set one with: configure.mjs owner <login>`)
    notes.push('It applies on the panel\'s next poll; no restart needed.')
    emit({ file, entry, configSource: 'file' }, notes.join('\n'))
    break
  }

  case 'remove': {
    const repo = checkRepoSlug(positional[1])
    const before = config.repos.length
    config.repos = config.repos.filter((entry) => entry.repo !== repo)
    if (config.repos.length === before) fail(`${repo} is not registered in ${file}`)
    writeConfig(file, config)
    emit({ file, removed: repo }, `removed ${repo} from ${file}`)
    break
  }

  case 'check': {
    const base = options.url !== '' ? options.url : (process.env.DSH_WEB_URL ?? DEFAULT_HOST_URL)
    /** POST one route; the Host gates these to loopback, which this is. */
    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      return response.json()
    }
    let status
    try {
      status = await post('/api/dsh-cicd/status', {})
    } catch (error) {
      fail(`cannot reach the Host at ${base} (${error.message}). Is DSH running? Pass --url <base> if it listens elsewhere.`)
    }
    if (status?.ok !== true) fail(`the Host refused /status: ${status?.message ?? 'unknown error'}`)
    const overview = await post('/api/dsh-cicd/overview', { force: true })

    const value = status.value
    // Read defensively: a Host running an older copy of this plugin answers with
    // fewer fields, and a diagnosis tool that crashes on that is useless exactly
    // when it is needed.
    const gh = value.gh ?? {}
    const scopes = Array.isArray(gh.scopes) ? gh.scopes : []
    const missingScopes = Array.isArray(gh.missingScopes) ? gh.missingScopes : []
    const lines = [
      `Host:        ${base}`,
      `gh:          ${gh.available ? (gh.version ?? 'present') : 'NOT FOUND'}${gh.authenticated ? ` — ${gh.account ?? 'signed in'}` : ' — not signed in'}`,
      `scopes:      ${scopes.length === 0 ? '(not reported by this Host)' : scopes.join(', ')}${missingScopes.length > 0 ? `  MISSING: ${missingScopes.join(', ')}` : ''}`,
      `config from: ${value.configSource ?? '(older Host)'}  (${value.configFile ?? 'unknown'})`,
    ]
    if (value.configProblem) lines.push(`config problem: ${value.configProblem}`)
    lines.push(`repositories: ${Array.isArray(value.repos) ? value.repos.length : 0}`)
    for (const repo of overview?.value?.repos ?? []) {
      const run = repo.latestRun === null ? 'no runs' : `${repo.latestRun.workflow}/${repo.latestRun.conclusion || repo.latestRun.status}`
      const releases = repo.releases.length === 0 ? 'no releases' : repo.releases.map((entry) => `${entry.tag}${entry.draft ? '(draft)' : ''}`).join(',')
      const local = repo.local?.available ? `dirty=${repo.local.dirty} ahead=${repo.local.ahead} behind=${repo.local.behind}` : `local: ${repo.local?.reason ?? 'unknown'}`
      const problems = repo.problems.length > 0 ? `  PROBLEMS: ${repo.problems.join(' | ')}` : ''
      lines.push(`  - ${repo.label.padEnd(28)} v${repo.version ?? '?'}  ${repo.published ? 'published' : 'unpublished'}  ${run}  ${releases}  ${local}${problems}`)
    }
    emit({ status: value, overview: overview?.value ?? null }, lines.join('\n'))
    break
  }

  default:
    fail(`unknown command: ${command}. Try list | init | add | remove | owner | check`)
}
