// 旧设置的密钥清理：幂等、只清密钥、不动其它字段。
//
// 迁移用在两个时机（插件 apply 时、宿主导入旧 settings.yaml 之后），所以「已经干净时
// 不再写一次」是它的契约而不是优化：每次启动都写一遍设置会让宿主重载配置，进而让插件
// 二次 apply。这里用假的 settings seam 把三种情形钉住。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

let passed = 0
let failed = 0
const check = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}

if (!existsSync(new URL('../lib/index.js', import.meta.url))) {
  console.error('smoke-settings-migration: lib/index.js is missing; run `pnpm build` first')
  process.exit(1)
}
const { clearLegacySecrets } = await import('../lib/index.js')

/** 记录调用、按值返回描述符的假 seam。 */
function fakeSeam (value) {
  const mutations = []
  return {
    mutations,
    seam: {
      describe: () => [{ ns: 'imagegen', value }],
      mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
    },
  }
}

const LEGACY = {
  enabled: true,
  // 要被清掉的四类：字典密文、三个散落字符串密钥。
  channelSecrets: { ch1: 'sk-plain-1', ch2: 'sk-plain-2' },
  apiKey: 'sk-legacy',
  promptApiKey: 'sk-prompt',
  storageSecretKey: 'sk-storage',
  // 不能被误伤的非密钥字段。
  localStoragePath: '/tmp/images',
  announceToAgent: false,
  skillsEnabled: true,
  defaultModel: 'H3 图像增强',
}

await check('把旧密钥清空，且只清密钥', async () => {
  const { seam, mutations } = fakeSeam({ ...LEGACY })
  const changed = await clearLegacySecrets(seam, 'imagegen')
  assert.equal(changed, true)
  assert.equal(mutations.length, 1)
  const [mutation] = mutations
  assert.equal(mutation.ns, 'imagegen')
  const byPath = new Map(mutation.ops.map(op => [op.path.join('.'), op.value]))
  assert.deepEqual(byPath.get('channelSecrets'), {})
  assert.equal(byPath.get('apiKey'), '')
  assert.equal(byPath.get('promptApiKey'), '')
  assert.equal(byPath.get('storageSecretKey'), '')
  // 非密钥字段一个都不在 ops 里。
  assert.equal(byPath.size, 4)
  for (const untouched of ['localStoragePath', 'announceToAgent', 'skillsEnabled', 'defaultModel', 'enabled']) {
    assert.equal(byPath.has(untouched), false, `${untouched} must not be rewritten`)
  }
})

await check('已经干净时一次都不写', async () => {
  const { seam, mutations } = fakeSeam({ ...LEGACY, channelSecrets: {}, apiKey: '', promptApiKey: '', storageSecretKey: '' })
  assert.equal(await clearLegacySecrets(seam, 'imagegen'), false)
  assert.equal(mutations.length, 0)
})

await check('同一份设置跑第二遍不再写', async () => {
  const state = { ...LEGACY }
  const { seam, mutations } = fakeSeam(state)
  await clearLegacySecrets(seam, 'imagegen')
  // 把 mutate 的效果写回，模拟宿主真的落了盘。
  for (const op of mutations[0].ops) state[op.path[0]] = op.value
  assert.equal(await clearLegacySecrets(seam, 'imagegen'), false)
  assert.equal(mutations.length, 1)
})

await check('命名空间不在描述符里时不动手', async () => {
  const mutations = []
  const seam = {
    describe: () => [{ ns: 'other', value: { ...LEGACY } }],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  assert.equal(await clearLegacySecrets(seam, 'imagegen'), false)
  assert.equal(mutations.length, 0)
})

await check('描述符没有值时不动手', async () => {
  const mutations = []
  const seam = {
    describe: () => [{ ns: 'imagegen', value: null }],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  assert.equal(await clearLegacySecrets(seam, 'imagegen'), false)
  assert.equal(mutations.length, 0)
})

await check('清理内容里不含任何密钥值', async () => {
  const { seam, mutations } = fakeSeam({ ...LEGACY })
  await clearLegacySecrets(seam, 'imagegen')
  const wire = JSON.stringify(mutations)
  for (const secret of ['sk-plain-1', 'sk-plain-2', 'sk-legacy', 'sk-prompt', 'sk-storage']) {
    assert.equal(wire.includes(secret), false, `${secret} must not appear in the mutation`)
  }
})

console.log(`\n# smoke-settings-migration: ${passed} checks passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
