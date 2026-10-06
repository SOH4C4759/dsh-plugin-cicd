/**
 * The managed repository list: parsing, validation, and one atomic writer.
 *
 * Two callers own this file's format — the panel's HTTP routes and
 * `scripts/configure.mjs` — and they must not drift: a list the script writes has
 * to be a list the Host reads, byte for byte, with the same rules about what a
 * repository name may look like. So the rules live here once.
 *
 * The parse is deliberately tolerant and the write is deliberately strict. The
 * Host must never fail to start because a file is malformed (it reports the
 * problem instead), while a write must refuse anything it would later have to
 * quietly drop.
 *
 * @module dsh-plugin-cicd/lib/config-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'

/** Upper bound on registered repositories, so a runaway file cannot hurt startup. */
export const MAX_REPOS = 40

/**
 * A repository name is passed to `gh` as one argv element with no shell in
 * between, so this shape check is not cosmetic: it is what keeps `--help` or a
 * flag-looking string from being read as an option.
 */
export const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const SLUG_WITH_OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Trim a value that should be a non-empty string, or return the fallback. */
function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Normalize one entry, accepting both shapes a person would naturally write:
 * `dsh-plugin-restart` or `{ repo, localPath?, label? }`.
 *
 * @param {unknown} entry - one element of `repos`.
 * @returns {{repo: string, localPath: string, label: string}|null} null when unusable.
 */
export function normalizeEntry(entry) {
  if (typeof entry === 'string') {
    const repo = entry.trim()
    return SLUG.test(repo) || SLUG_WITH_OWNER.test(repo) ? { repo, localPath: '', label: '' } : null
  }
  if (entry === null || typeof entry !== 'object') return null
  const repo = text(entry.repo ?? entry.name)
  if (!SLUG.test(repo) && !SLUG_WITH_OWNER.test(repo)) return null
  const localPath = text(entry.localPath ?? entry.path)
  return {
    repo,
    // Absolute only: a relative path would be resolved against the Host's own
    // working directory, which is not the user's shell directory.
    localPath: localPath !== '' && isAbsolute(localPath) ? localPath : '',
    label: text(entry.label),
  }
}

/**
 * Parse the file tolerantly and report what had to be dropped.
 *
 * @param {string} raw - file contents.
 * @returns {{ok: true, owner: string, repos: object[], dropped: number}|{ok: false, message: string}}
 */
export function parseConfig(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, message: `not valid JSON: ${error.message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'expected a JSON object with "owner" and "repos"' }
  }
  if (parsed.repos !== undefined && !Array.isArray(parsed.repos)) {
    return { ok: false, message: '"repos" must be an array' }
  }
  const declared = Array.isArray(parsed.repos) ? parsed.repos : []
  const repos = []
  const seen = new Set()
  for (const entry of declared.slice(0, MAX_REPOS)) {
    const normalized = normalizeEntry(entry)
    if (normalized === null || seen.has(normalized.repo)) continue
    seen.add(normalized.repo)
    repos.push(normalized)
  }
  return { ok: true, owner: text(parsed.owner), repos, dropped: declared.length - repos.length }
}

/**
 * Read the file; a missing file is an empty configuration, not an error.
 * @param {string} file - absolute path.
 * @returns {{exists: boolean, owner: string, repos: object[], dropped: number, problem: string|null}}
 */
export function readConfig(file) {
  if (!existsSync(file)) return { exists: false, owner: '', repos: [], dropped: 0, problem: null }
  const parsed = parseConfig(readFileSync(file, 'utf8'))
  if (!parsed.ok) return { exists: true, owner: '', repos: [], dropped: 0, problem: `${file}: ${parsed.message}` }
  return { exists: true, owner: parsed.owner, repos: parsed.repos, dropped: parsed.dropped, problem: null }
}

/**
 * Write the file atomically.
 *
 * The plugin re-reads this file on every request, so a partially written file
 * would be observed as a broken configuration and would blank the panel. The new
 * content therefore lands via rename, and the previous revision is kept beside it.
 *
 * @param {string} file - absolute path.
 * @param {{owner: string, repos: object[]}} config - what to store.
 * @returns {string} the exact bytes written.
 */
export function writeConfig(file, config) {
  const body = `${JSON.stringify({ owner: text(config.owner), repos: config.repos }, null, 2)}\n`
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    try {
      writeFileSync(`${file}.bak`, readFileSync(file))
    } catch {
      /* a missing backup must not block the write */
    }
  }
  const temporary = `${file}.tmp`
  writeFileSync(temporary, body, 'utf8')
  renameSync(temporary, file)
  return body
}

/**
 * Whether a name may be registered at all.
 * @param {unknown} repo - candidate.
 * @returns {boolean}
 */
export function isValidRepoName(repo) {
  return typeof repo === 'string' && (SLUG.test(repo) || SLUG_WITH_OWNER.test(repo))
}
