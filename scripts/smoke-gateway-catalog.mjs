// 宿主媒体目录的适配层：条目 → 网关渠道、默认模型、网关地址规范化。
// 全程不联网：这一层是纯逻辑，目录与凭据都由宿主提供。
import assert from 'node:assert/strict'
import {
  displayNameOf, entriesOfKind, gatewayChannel, gatewayOrigin, gatewayUrl, GATEWAY_CHANNEL_ID,
  hasRenderableEntries, isCredentialRefName, modelOptionsOf, pluginSnapshotOf, selectDefaultModel,
} from '../src/gateway-catalog.ts'
// 路由来自已构建的宿主包：`src/routes.ts` 用到 Node 的类型剥离不支持的语法，
// 只能在构建产物上跑；`pnpm test` 的链条先 build 再跑本脚本。
import { existsSync } from 'node:fs'
if (!existsSync(new URL('../lib/index.js', import.meta.url))) {
  console.error('smoke-gateway-catalog: lib/index.js is missing; run `pnpm build` first')
  process.exit(1)
}
const { makeRoutes } = await import('../lib/index.js')

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

const IMAGE = {
  id: 'generate_image:minimax-h3-image-enhanced',
  operation: 'generate_image',
  model: 'minimax-h3-image-enhanced',
  displayName: { zh: 'H3 图像增强', en: 'H3 image enhanced' },
  description: { zh: '', en: '' },
  transport: { kind: 'images' },
  taskTypes: ['t2i', 'i2i'],
  limits: { maxReferenceImages: 2, maxDurationSeconds: 0, maxInputBytes: 1024 },
  default: true,
}

const VIDEO = {
  id: 'generate_video:minimax-h3-2k',
  operation: 'generate_video',
  model: 'minimax-h3-2k',
  displayName: { zh: 'H3 2K', en: 'H3 2K' },
  description: { zh: '', en: '' },
  transport: { kind: 'videos_task' },
  limits: { maxReferenceImages: 0, maxDurationSeconds: 10, maxInputBytes: 0 },
  default: false,
}

const UPSCALE = {
  id: 'upscale:relayvsr',
  operation: 'upscale',
  model: 'relayvsr',
  displayName: { zh: '超分', en: 'Upscale' },
  description: { zh: '', en: '' },
  transport: { kind: 'images' },
  limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 },
  default: false,
}

const CHAT = {
  id: 'chat:deepseek-v4-1-flash',
  operation: 'chat',
  model: 'deepseek-v4-1-flash',
  displayName: { zh: '对话', en: 'Chat' },
  description: { zh: '', en: '' },
  transport: { kind: 'chat' },
  limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 },
  default: true,
}

const ENTRIES = [IMAGE, VIDEO, UPSCALE, CHAT]

await check('网关渠道只带图像与视频条目，超分与对话不进渠道', () => {
  const channel = gatewayChannel({ entries: ENTRIES, baseURL: 'https://gw.example/v1' })
  assert.equal(channel.id, GATEWAY_CHANNEL_ID)
  assert.deepEqual(channel.models, [{ alias: 'H3 图像增强', id: 'minimax-h3-image-enhanced' }])
  assert.deepEqual(channel.videoModels, [{ alias: 'H3 2K', id: 'minimax-h3-2k' }])
  // 密钥不在渠道对象里：提交时才按凭据名去取。
  assert.equal(JSON.stringify(channel).includes('sk-'), false)
})

await check('渠道 apiUrl 固定为 origin + /v1，不带结尾斜杠', () => {
  assert.equal(gatewayChannel({ entries: ENTRIES, baseURL: 'https://gw.example/v1' }).apiUrl, 'https://gw.example/v1')
  assert.equal(gatewayChannel({ entries: ENTRIES, baseURL: 'https://gw.example' }).apiUrl, 'https://gw.example/v1')
  assert.equal(gatewayChannel({ entries: ENTRIES, baseURL: 'https://gw.example/v1/' }).apiUrl, 'https://gw.example/v1')
})

await check('gatewayUrl 对三种 baseURL 写法给出同一个地址', () => {
  const expected = 'https://gw.example/v1/ov/capabilities'
  for (const baseURL of ['https://gw.example/v1', 'https://gw.example/v1/', 'https://gw.example']) {
    assert.equal(gatewayUrl(baseURL, '/v1/ov/capabilities'), expected, baseURL)
    assert.equal(gatewayOrigin(baseURL), 'https://gw.example', baseURL)
  }
})

await check('提交地址同样只用一套拼接规则', () => {
  for (const baseURL of ['https://gw.example/v1', 'https://gw.example/v1/', 'https://gw.example']) {
    assert.equal(gatewayUrl(baseURL, '/v1/videos'), 'https://gw.example/v1/videos', baseURL)
    assert.equal(gatewayUrl(baseURL, '/v1/ov/files'), 'https://gw.example/v1/ov/files', baseURL)
  }
})

await check('展示名中文优先，缺省回落到模型名', () => {
  assert.equal(displayNameOf(IMAGE), 'H3 图像增强')
  assert.equal(displayNameOf({ ...VIDEO, displayName: { zh: '', en: 'H3 2K' } }), 'minimax-h3-2k')
})

await check('默认模型：用户上次的选择仍在目录里就用它', () => {
  const candidates = entriesOfKind(ENTRIES, 'images')
  assert.equal(selectDefaultModel(candidates, 'relayvsr'), 'relayvsr')
})

await check('默认模型：选择已不在目录里时回到目录标记的默认项', () => {
  const candidates = entriesOfKind(ENTRIES, 'images')
  assert.equal(selectDefaultModel(candidates, 'retired-model'), 'minimax-h3-image-enhanced')
})

await check('默认模型：目录没有标记默认项时取第一条', () => {
  const candidates = [UPSCALE, { ...IMAGE, model: 'second', default: false, id: 'generate_image:second' }]
  assert.equal(selectDefaultModel(candidates, ''), 'relayvsr')
})

await check('默认模型：候选为空时是空串', () => {
  assert.equal(selectDefaultModel([], 'anything'), '')
})

await check('没有目录服务（Web / headless 构建）时状态是 not-configured', () => {
  const snapshot = pluginSnapshotOf(undefined)
  assert.equal(snapshot.status, 'not-configured')
  assert.equal(snapshot.entries.length, 0)
})

await check('宿主说 ready 但没有图像 / 视频条目时，本插件看到 empty', () => {
  const host = {
    media: () => ({ status: 'ready', version: 'v1', fetchedAt: 1, entries: [CHAT] }),
    refresh: async () => undefined,
    endpoint: () => ({ baseURL: 'https://gw.example/v1', credential: 'AURORA_API_KEY' }),
  }
  const snapshot = pluginSnapshotOf(host)
  assert.equal(snapshot.status, 'empty')
  // 条目仍然全部保留：意图识别、目录检查都要读聊天条目。
  assert.deepEqual(snapshot.entries.map(entry => entry.id), ['chat:deepseek-v4-1-flash'])
  assert.equal(hasRenderableEntries(snapshot.entries), false)
})

await check('宿主状态原样透传，含失败原因', () => {
  for (const status of ['loading', 'signed-out', 'unauthorized', 'kyc-required', 'rate-limited', 'unreachable']) {
    const host = {
      media: () => ({ status, version: null, fetchedAt: null, entries: [] }),
      refresh: async () => undefined,
      endpoint: () => ({ baseURL: 'https://gw.example/v1', credential: 'AURORA_API_KEY' }),
    }
    assert.equal(pluginSnapshotOf(host).status, status)
  }
})

await check('凭据名按宿主同一套语法校验', () => {
  assert.equal(isCredentialRefName('AURORA_API_KEY'), true)
  assert.equal(isCredentialRefName('_private'), true)
  assert.equal(isCredentialRefName(''), false)
  assert.equal(isCredentialRefName('aurora-api-key'), false)
  assert.equal(isCredentialRefName('1INVALID'), false)
})


/** 路由套件用的假请求：回环来源 + 本机 Host 头才能通过 guard。 */
function fakeRequest (method, path) {
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 50000 },
  }
}

/** 收集 handler 写出的 JSON。 */
function fakeResponse () {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    writeHead (code, headers) { this.statusCode = code; this.headers = headers ?? {} },
    end (body) { if (body !== undefined) chunks.push(String(body)) },
    get json () { return JSON.parse(chunks.join('') || '{}') },
  }
}

/** 一条路由的 handler。 */
function routeHandler (routes, path) {
  const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === path)
  assert.ok(route !== undefined, `the route family serves ${path}`)
  return route.handler
}

const SNAPSHOT = { status: 'ready', version: 'v1', fetchedAt: 7, image: [{ model: 'minimax-h3-image-enhanced', label: 'H3 图像增强', isDefault: true }], video: [{ model: 'minimax-h3-2k', label: 'H3 2K', isDefault: false }] }

await check('目录路由返回宿主快照', async () => {
  const routes = makeRoutes({ settings: {}, resolve: () => ({ apiUrl: '', apiKey: '' }), gateway: { snapshot: () => SNAPSHOT, refresh: async () => SNAPSHOT } })
  const res = fakeResponse()
  await routeHandler(routes, '/api/dsh-imagegen/gateway/catalog')(fakeRequest('GET', '/api/dsh-imagegen/gateway/catalog'), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.snapshot, SNAPSHOT)
})

await check('刷新路由先请宿主刷新，再返回刷新后的快照', async () => {
  let refreshed = 0
  const after = { ...SNAPSHOT, version: 'v2' }
  const routes = makeRoutes({
    settings: {},
    resolve: () => ({ apiUrl: '', apiKey: '' }),
    gateway: { snapshot: () => SNAPSHOT, refresh: async () => { refreshed += 1; return after } },
  })
  const res = fakeResponse()
  await routeHandler(routes, '/api/dsh-imagegen/gateway/refresh')(fakeRequest('POST', '/api/dsh-imagegen/gateway/refresh'), res)
  assert.equal(refreshed, 1)
  assert.equal(res.json.snapshot.version, 'v2')
})

await check('宿主没有目录服务时两条路由仍应答 not-configured', async () => {
  const routes = makeRoutes({ settings: {}, resolve: () => ({ apiUrl: '', apiKey: '' }) })
  for (const [method, path] of [['GET', '/api/dsh-imagegen/gateway/catalog'], ['POST', '/api/dsh-imagegen/gateway/refresh']]) {
    const res = fakeResponse()
    await routeHandler(routes, path)(fakeRequest(method, path), res)
    assert.equal(res.statusCode, 200, path)
    assert.equal(res.json.snapshot.status, 'not-configured', path)
    assert.deepEqual(res.json.snapshot.image, [], path)
  }
})

await check('模型选项带展示名与默认标记', () => {
  assert.deepEqual(modelOptionsOf(entriesOfKind(ENTRIES, 'images')), [
    { model: 'minimax-h3-image-enhanced', label: 'H3 图像增强', isDefault: true },
    { model: 'relayvsr', label: '超分', isDefault: false },
  ])
})

await check('目录响应里不含密钥', async () => {
  const routes = makeRoutes({ settings: {}, resolve: () => ({ apiUrl: '', apiKey: 'sk-secret' }), gateway: { snapshot: () => SNAPSHOT, refresh: async () => SNAPSHOT } })
  const res = fakeResponse()
  await routeHandler(routes, '/api/dsh-imagegen/gateway/catalog')(fakeRequest('GET', '/api/dsh-imagegen/gateway/catalog'), res)
  assert.equal(JSON.stringify(res.json).includes('sk-secret'), false)
})

console.log(`\n# smoke-gateway-catalog: ${passed} checks passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
