/**
 * task-20 verification: run generateListingCopy against a scripted host chat
 * model covering the failure modes plus the no-invented-materials rule.
 *
 * This drives the BUILT ARTIFACT (lib/index.js re-exports the module since the
 * task-20 review), not the TS sources — a green run here also proves the
 * production bundle carries the listing-copy logic.
 *
 * Run: node scripts/smoke-listing-copy.mjs   (from the package root)
 */
import assert from 'node:assert/strict'

const { generateListingCopy, listingTitleLimit } = await import(new URL('../lib/index.js', import.meta.url))
assert.equal(typeof generateListingCopy, 'function', 'lib/index.js must export generateListingCopy')
assert.equal(typeof listingTitleLimit, 'function', 'lib/index.js must export listingTitleLimit')

/** One scripted host chat model; `calls` records every turn it was asked. */
function hostChat(reply, available = true) {
  const calls = []
  return {
    calls,
    available: () => available,
    label: () => 'fake-model',
    complete: async (options) => { calls.push(options); return reply },
  }
}

const results = []
async function check(name, fn) {
  try { await fn(); results.push(`PASS  ${name}`) }
  catch (e) { results.push(`FAIL  ${name}: ${e.message}`); process.exitCode = 1 }
}

const GOOD = {
  title: '便携不锈钢保温杯 500ml 大容量车载水杯',
  sellingPoints: ['316 不锈钢内胆', '12 小时长效保温', '一手掌握便携尺寸'],
  description: '这是一款便携保温杯。采用 316 不锈钢内胆，保温 12 小时。适合车载与通勤使用。',
  keywords: ['保温杯', '不锈钢水杯', '车载水杯'],
  specs: [{ name: '容量', value: '500ml' }, { name: '材质', value: '316 不锈钢' }],
}

await check('1 正常 JSON：解析出全部字段', async () => {
  const r = await generateListingCopy(hostChat(JSON.stringify(GOOD)), { productName: '保温杯', category: '家居用品', platform: '淘宝 / 京东', language: '中文', promptInfo: '316 不锈钢内胆，保温 12 小时，容量 500ml' })
  assert.equal(r.ok, true)
  assert.equal(r.copy.title, GOOD.title)
  assert.deepEqual(r.copy.sellingPoints, GOOD.sellingPoints)
  assert.deepEqual(r.copy.specs, GOOD.specs)
})

await check('2 带 ```json 围栏：仍能解析', async () => {
  const r = await generateListingCopy(hostChat('```json\n' + JSON.stringify(GOOD) + '\n```'), { productName: '保温杯', category: '家居用品', platform: '淘宝 / 京东', language: '中文', promptInfo: '保温 12 小时' })
  assert.equal(r.ok, true)
  assert.equal(r.copy.title, GOOD.title)
})

await check('3 非 JSON 散文：可操作错误，不把散文当文案', async () => {
  const r = await generateListingCopy(hostChat('好的，这款保温杯非常不错，我为您推荐以下卖点……'), { productName: '保温杯', category: '家居用品', platform: '淘宝 / 京东', language: '中文', promptInfo: '' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'listing-copy-unstructured')
  assert.ok(r.message.includes('不是结构化文案'), `message should be actionable: ${r.message}`)
})

await check('3b JSON 但所有字段类型全错：同样按不可用处理（review 项 a）', async () => {
  const r = await generateListingCopy(hostChat(JSON.stringify({ title: 123, sellingPoints: 'not-array', description: { a: 1 }, keywords: null, specs: 'x' })), { productName: '保温杯', category: '家居用品', platform: '淘宝 / 京东', language: '中文', promptInfo: '' })
  assert.equal(r.ok, false, 'empty usable copy must not report success')
  assert.equal(r.code, 'listing-copy-unstructured')
  assert.ok(r.message.includes('没有可用的文案字段'), `message should be actionable: ${r.message}`)
})

await check('4a 超长 title：不截断、不静默成功（原样返回，由 UI 标超限）', async () => {
  const longTitle = '超'.repeat(120)
  const r = await generateListingCopy(hostChat(JSON.stringify({ ...GOOD, title: longTitle })), { productName: '保温杯', category: '家居用品', platform: '淘宝 / 京东', language: '中文', promptInfo: '' })
  assert.equal(r.ok, true)
  assert.equal(r.copy.title.length, 120, 'host must NOT truncate')
})

await check('4b 没有可用的对话模型：可操作错误，且不发请求', async () => {
  const chat = hostChat(JSON.stringify(GOOD), false)
  const r = await generateListingCopy(chat, { productName: '保温杯', category: 'x', platform: '通用', language: '中文', promptInfo: '' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'listing-copy-no-model')
  assert.equal(chat.calls.length, 0, 'an unavailable model must not be asked')
})

await check('5 提示词不含输入之外的事实指令（不填材质 → system 不诱导编造）', async () => {
  const chat = hostChat(JSON.stringify(GOOD))
  const r = await generateListingCopy(chat, { productName: '保温杯', category: '家居用品', platform: '淘宝 / 京东', language: '中文', promptInfo: '保温 12 小时' })
  assert.equal(r.ok, true)
  const [{ system, content }] = chat.calls
  assert.ok(/不要虚构/.test(system), 'system prompt must forbid inventing attributes')
  assert.ok(/只使用输入中明确给出的事实/.test(system), 'system prompt must restrict to given facts')
  assert.ok(!/材质/.test(typeof content === 'string' ? content : JSON.stringify(content)), 'user turn must not introduce attributes the draft lacks')
})

await check('平台上限：亚马逊 200 / 淘宝京东 60 / 通用 60（经构建产物导出）', async () => {
  assert.equal(listingTitleLimit('亚马逊'), 200)
  assert.equal(listingTitleLimit('Amazon'), 200)
  assert.equal(listingTitleLimit('淘宝 / 京东'), 60)
  assert.equal(listingTitleLimit('京东'), 60)
  assert.equal(listingTitleLimit('通用'), 60)
})

console.log(results.join('\n'))
if (process.exitCode === 1) console.error('SMOKE LISTING FAILED')
else console.log('SMOKE LISTING OK')
