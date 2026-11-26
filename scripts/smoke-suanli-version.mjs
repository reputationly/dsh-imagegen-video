// 蒜狸发行版本号：没发过的版本原样使用，发过的接递增构建号，写入同时改 package.json 与 PLUGIN_VERSION。
// Run: node scripts/smoke-suanli-version.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextVersion, stamp } from './suanli-version.mjs'

const NAME = '@q253595422/dsh-imagegen-video'
const line = version => `${NAME} ${version} q253595422-dsh-imagegen-video-${version}.tgz`

assert.equal(nextVersion('1.35.0-suanli.3', [line('1.35.0-suanli.2')].join('\n')), '1.35.0-suanli.3')
assert.equal(nextVersion('1.35.0-suanli.2', [line('1.35.0-suanli.1'), line('1.35.0-suanli.2')].join('\n')), '1.35.0-suanli.2.1')
assert.equal(nextVersion('1.35.0-suanli.2', [line('1.35.0-suanli.2'), line('1.35.0-suanli.2.1'), `${line('1.35.0-suanli.2.2')} 0123abc`].join('\n')), '1.35.0-suanli.2.3')
assert.equal(nextVersion('1.35.0-suanli.2', [line('1.35.0-suanli.2'), line('1.35.0-suanli.2.10'), line('1.35.0-suanli.20.1')].join('\n')), '1.35.0-suanli.2.11')
assert.equal(nextVersion('1.35.0-suanli.2', ''), '1.35.0-suanli.2')

const root = mkdtempSync(join(tmpdir(), 'suanli-version-'))
try {
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{\n  "name": "x",\n  "version": "1.35.0-suanli.2",\n  "dependencies": { "a": "1.0.0" }\n}\n')
  writeFileSync(join(root, 'src', 'protocol.ts'), "// head\nexport const PLUGIN_VERSION = '1.35.0-suanli.2'\nexport const OTHER = 1\n")
  stamp(root, '1.35.0-suanli.2.1')
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{\n  "name": "x",\n  "version": "1.35.0-suanli.2.1",\n  "dependencies": { "a": "1.0.0" }\n}\n')
  assert.equal(readFileSync(join(root, 'src', 'protocol.ts'), 'utf8'), "// head\nexport const PLUGIN_VERSION = '1.35.0-suanli.2.1'\nexport const OTHER = 1\n")
  writeFileSync(join(root, 'src', 'protocol.ts'), 'export const OTHER = 1\n')
  assert.throws(() => stamp(root, '1.35.0-suanli.2.2'), /no PLUGIN_VERSION line/u)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('suanli-version: ok')
