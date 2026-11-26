/**
 * Brand guard: the plugin ships as 「创作」 and nothing may tell a user otherwise.
 *
 * The upstream plugin was distributed as a standalone product with its own brand mark, its own
 * GitHub link, and its own self-updater. This fork removes all of it, and a comment saying so is
 * not a guard: one restored string puts the old brand back in front of a user. So the sources,
 * the built output, the locale metadata, and the assets are scanned for the exact markers the
 * product must not show.
 *
 * Allowed places are declared here and nowhere else. Attribution files (LICENSE, NOTICE,
 * THIRD_PARTY_NOTICES.md, CHANGELOG.md) and `docs/` may keep the upstream name, because a license
 * obligation is not user-facing branding.
 *
 * Run: node scripts/verify-no-brand.mjs [--verbose]
 * Exit 0 = no marker found, 1 = at least one marker survived (or an exception went stale).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VERBOSE = process.argv.includes('--verbose')

/** Directories and files the guard reads, relative to the package root. */
const SCAN = ['src', 'locale', 'assets', 'lib', 'index.js']

/** Files and directories exempt from every marker: license and attribution obligations. */
const ATTRIBUTION = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'docs']

/** Extensions that never carry user-facing text, so scanning them wastes time and reports noise. */
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.zip'])

/**
 * Markers the shipped product must not contain.
 *
 * `pattern` is a regular expression source, applied case-insensitively where the brand was
 * capitalized inconsistently upstream.
 */
const MARKERS = [
  { id: 'brand-word', pattern: '团团', why: 'old Chinese brand' },
  { id: 'brand-latin', pattern: 'tuantuan', why: 'old Latin brand, case-insensitive' },
  { id: 'upstream-repo', pattern: 'github\\.com/q253595422', why: 'upstream marketing repository link' },
  { id: 'github-api', pattern: 'api\\.github\\.com', why: 'upstream self-update and remote asset source' },
  { id: 'github-tip', pattern: 'githubTip', why: 'tooltip that pointed at the upstream repository' },
  { id: 'brand-mark', pattern: 'BrandMark', why: 'brand lockup component' },
]

/**
 * One marker in one file that stays until a later work package deletes the feature that owns it.
 *
 * An exception must still be needed: when the file stops matching, this guard fails until the
 * entry is deleted, so an exception cannot outlive the reason it was granted.
 */
const EXCEPTIONS = [
  {
    file: 'src/outfit-reference-store.ts',
    marker: 'github-api',
    why: 'the outfit pose library still downloads from GitHub; WP8 removes the online source',
  },
  {
    // 打包产物里同一处源码的副本：源文件例外解释了一次，构建输出只是它的拷贝。
    file: 'lib/index.js',
    marker: 'github-api',
    why: 'bundled copy of src/outfit-reference-store.ts; disappears with that file',
  },
]

/** Every marker as a compiled expression. */
const EXPRESSIONS = MARKERS.map(marker => ({ ...marker, expression: new RegExp(marker.pattern, 'iu') }))

/** Whether a path is exempt from every marker. */
function isAttribution (path) {
  return ATTRIBUTION.some(entry => path === entry || path.startsWith(`${entry}/`))
}

/** Text files under one path, relative to the package root. */
function textFiles (path) {
  if (!existsSync(path)) return []
  const stats = statSync(path)
  if (stats.isFile()) return BINARY_EXTENSIONS.has(extensionOf(path)) ? [] : [path]
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
    return textFiles(join(path, entry.name))
  })
}

/** Lowercase extension of a path. */
function extensionOf (path) {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index).toLowerCase()
}

/** Line and column of the first match, for a report an author can act on. */
function locate (text, expression) {
  const match = expression.exec(text)
  if (match === null) return { line: 0, column: 0 }
  const before = text.slice(0, match.index)
  const line = before.split('\n').length
  const column = match.index - before.lastIndexOf('\n')
  return { line, column }
}

/** Every violation the scan found. */
const violations = []
/** Exceptions the scan actually needed. */
const used = new Set()

for (const entry of SCAN) {
  for (const file of textFiles(join(ROOT, entry))) {
    const path = relative(ROOT, file).split('\\').join('/')
    if (isAttribution(path)) continue
    const text = readFileSync(file, 'utf8')
    for (const candidate of EXPRESSIONS) {
      if (!candidate.expression.test(text)) continue
      const exception = EXCEPTIONS.find(item => item.file === path && item.marker === candidate.id)
      if (exception !== undefined) {
        used.add(exception)
        if (VERBOSE) process.stdout.write(`allowed ${path}: ${candidate.id} (${exception.why})\n`)
        continue
      }
      const { line, column } = locate(text, candidate.expression)
      violations.push({ path, line, column, ...candidate })
    }
  }
}

const stale = EXCEPTIONS.filter(item => !used.has(item))
for (const item of stale) {
  violations.push({
    path: item.file,
    line: 0,
    column: 0,
    id: `stale-exception:${item.marker}`,
    why: `the exception is no longer needed (${item.why}); delete it from verify-no-brand.mjs`,
  })
}

if (violations.length === 0) {
  process.stdout.write(`verify-no-brand: clean (${EXPRESSIONS.length} markers over ${SCAN.join(', ')})\n`)
  process.exit(0)
}

process.stderr.write(`verify-no-brand: ${violations.length} violation(s)\n`)
for (const violation of violations) {
  const where = violation.line === 0 ? violation.path : `${violation.path}:${violation.line}:${violation.column}`
  process.stderr.write(`  ${where}  ${violation.id}  ${violation.why}\n`)
}
process.exit(1)
