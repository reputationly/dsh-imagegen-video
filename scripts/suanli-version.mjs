// 蒜狸发行的版本号。
//
// package.json 的版本还没发过就用它（这是手动升版本、写发行说明的路径）；已经发过，
// 就在后面接一个递增的构建号：1.35.0-suanli.2 → 1.35.0-suanli.2.1 → .2.2。
// semver 里多一段预发布标识的版本更高，所以宿主和插件管理都按发布顺序排序。
// 构建号只写进打出来的包，不提交回仓库。
//
// Run: node scripts/suanli-version.mjs next < RELEASES.txt
//      node scripts/suanli-version.mjs stamp <version>
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION_LINE = /^export const PLUGIN_VERSION = '[^']*'$/mu

/** Versions already on the dist branch, one `name version archive [source]` line each. */
export function releasedVersions(releasesText) {
  return new Set(releasesText.split('\n').map(line => line.trim().split(/\s+/u)[1]).filter(Boolean))
}

export function nextVersion(base, releasesText) {
  const released = releasedVersions(releasesText)
  if (!released.has(base)) return base
  const prefix = `${base}.`
  let build = 0
  for (const version of released) {
    if (!version.startsWith(prefix)) continue
    const n = Number(version.slice(prefix.length))
    if (Number.isInteger(n) && n > build) build = n
  }
  return `${base}.${build + 1}`
}

export function stamp(root, version) {
  const manifestPath = `${root}/package.json`
  const manifest = readFileSync(manifestPath, 'utf8')
  const stamped = manifest.replace(/("version":\s*)"[^"]*"/u, `$1"${version}"`)
  if (stamped === manifest && !manifest.includes(`"version": "${version}"`)) throw new Error('package.json has no version field')
  const protocolPath = `${root}/src/protocol.ts`
  const protocol = readFileSync(protocolPath, 'utf8')
  if (!VERSION_LINE.test(protocol)) throw new Error('src/protocol.ts has no PLUGIN_VERSION line')
  writeFileSync(manifestPath, stamped)
  writeFileSync(protocolPath, protocol.replace(VERSION_LINE, `export const PLUGIN_VERSION = '${version}'`))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, version] = process.argv.slice(2)
  if (command === 'next') {
    const base = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')).version
    console.log(nextVersion(base, readFileSync(0, 'utf8')))
  } else if (command === 'stamp' && version) {
    stamp(ROOT, version)
  } else {
    console.error('usage: suanli-version.mjs next < RELEASES.txt | stamp <version>')
    process.exit(2)
  }
}
