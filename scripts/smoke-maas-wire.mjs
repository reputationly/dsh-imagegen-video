// 自家 MaaS 的线级契约：拦 fetch，断言真正发出去的请求体。
// 覆盖三件容易错的事：聚合模型不发 size、参考族走 metadata.src_ref_images、
// 首尾帧走顶层 images + image_mode。全程不联网。
import assert from 'node:assert/strict'
import { generateImage } from '../src/engine.ts'
import { generateVideo } from '../src/video-engine.ts'

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

/** 一张最小的合法 PNG（校验用的 IEND 块在尾部）。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const API = 'https://gw.example/v1'
const IMAGE_UPSTREAM = { apiUrl: API, apiKey: 'sk-test', protocol: 'images' }
const VIDEO_UPSTREAM = { apiUrl: API, apiKey: 'sk-test' }

/**
 * 装一个假的 fetch，按「URL + 方法」分派。返回 (requests, restore)。
 *
 * 用谓词而不是子串匹配：提交是 `POST /videos`，轮询是 `GET /videos/{id}`，
 * 同一个子串会把两者混成一个，轮询就会一直拿到提交响应而挂住。
 * @param handlers - [谓词, 响应构造器] 列表，按顺序匹配
 */
function stubFetch(handlers) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    requests.push({ url: href, method, body: init.body, headers: init.headers })
    for (const [match, respond] of handlers) {
      if (match(href, method)) return respond(href, init)
    }
    throw new Error(`unexpected fetch: ${method} ${href}`)
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}

/** 提交体捕获用：POST 到 /videos。 */
const isVideoSubmit = (href, method) => method === 'POST' && href.endsWith('/videos')

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const imageRequest = (model, extra = {}) => ({
  mode: 'generate',
  model,
  prompt: '一只猫',
  size: '16:9',
  quality: '2k',
  n: 1,
  detail: '',
  ...extra,
})

/** 上一次提交体（JSON）解析结果。 */
const jsonBodyOf = request => JSON.parse(String(request.body))

// ------------------------------------------------------------------ 图片
await check('聚合模型 minimax-h3-image-enhanced 不发 size（让网关 PE 自动定画幅）', async () => {
  const stub = stubFetch([
    [(href, method) => method === 'POST' && href.endsWith('/images/generations'), () => json({ data: [{ url: 'https://cdn.example/a.png' }] })],
    [(href) => href.endsWith('.png'), () => new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
  ])
  try {
    await generateImage(IMAGE_UPSTREAM, imageRequest('minimax-h3-image-enhanced'))
  } finally {
    stub.restore()
  }
  const submit = stub.requests.find(request => request.url.includes('/images/generations'))
  assert.ok(submit !== undefined, '没有发出 /images/generations')
  const body = jsonBodyOf(submit)
  assert.equal(body.model, 'minimax-h3-image-enhanced')
  assert.equal('size' in body, false, '聚合模型不能带 size，否则网关 PE 不会自动定画幅')
  assert.equal('quality' in body, false, '网关不认 OpenAI 的 quality 档位')
})

await check('裸模型 minimax-h3-image 发 2K 档像素尺寸', async () => {
  const stub = stubFetch([
    [(href, method) => method === 'POST' && href.endsWith('/images/generations'), () => json({ data: [{ url: 'https://cdn.example/b.png' }] })],
    [(href) => href.endsWith('.png'), () => new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
  ])
  try {
    await generateImage(IMAGE_UPSTREAM, imageRequest('minimax-h3-image', { size: '16:9' }))
  } finally {
    stub.restore()
  }
  const body = jsonBodyOf(stub.requests.find(request => request.url.includes('/images/generations')))
  assert.equal(body.size, '2720x1536', '16:9 必须换成 2K 档的 2720x1536')
  assert.equal('aspect_ratio' in body, false, '网关的图片链路不读 aspect_ratio')
})

await check('未知比例回落到 2K 正方形，而不是发一个会被 400 的低分辨率', async () => {
  const stub = stubFetch([
    [(href, method) => method === 'POST' && href.endsWith('/images/generations'), () => json({ data: [{ url: 'https://cdn.example/c.png' }] })],
    [(href) => href.endsWith('.png'), () => new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
  ])
  try {
    await generateImage(IMAGE_UPSTREAM, imageRequest('minimax-h3-image', { size: 'auto' }))
  } finally {
    stub.restore()
  }
  const body = jsonBodyOf(stub.requests.find(request => request.url.includes('/images/generations')))
  assert.equal(body.size, '2048x2048')
})

await check('标注重绘的原图画幅 annotationCanvas 两个 H3 模型都原样发', async () => {
  for (const model of ['minimax-h3-image', 'minimax-h3-image-enhanced']) {
    const stub = stubFetch([
      [(href, method) => method === 'POST' && href.endsWith('/images/generations'), () => json({ data: [{ url: 'https://cdn.example/d.png' }] })],
      [(href) => href.endsWith('.png'), () => new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    ])
    try {
      await generateImage(IMAGE_UPSTREAM, imageRequest(model, { size: '1:1', annotationCanvas: '2496x1664' }))
    } finally {
      stub.restore()
    }
    const body = jsonBodyOf(stub.requests.find(request => request.url.includes('/images/generations')))
    assert.equal(body.size, '2496x1664', model)
  }
})

await check('图生图向 new-api 请求异步任务并轮询 image.generation.job', async () => {
  const job = body => new Response(JSON.stringify(body), {
    status: 202,
    headers: {
      'content-type': 'application/json',
      location: '/v1/images/generations/task_img_1',
      'retry-after': '1',
    },
  })
  const stub = stubFetch([
    [(href, method) => method === 'POST' && href.endsWith('/images/edits'), () => job({ id: 'task_img_1', object: 'image.generation.job', status: 'queued' })],
    [(href, method) => method === 'GET' && href.endsWith('/images/generations/task_img_1'), () => json({ id: 'task_img_1', object: 'image.generation.job', status: 'completed', data: [{ url: 'https://cdn.example/async.png' }] })],
    [(href) => href.endsWith('async.png'), () => new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
  ])
  try {
    await generateImage(IMAGE_UPSTREAM, imageRequest('minimax-h3-image', {
      mode: 'edit',
      image: `data:image/png;base64,${TINY_PNG.toString('base64')}`,
    }))
  } finally {
    stub.restore()
  }
  const submit = stub.requests.find(request => request.method === 'POST' && request.url.endsWith('/images/edits'))
  assert.ok(submit !== undefined, '没有发出 /images/edits')
  assert.equal(submit.headers['X-New-Api-Async'], 'true', 'multipart edits 必须用 header 打开异步')
  assert.ok(stub.requests.some(request => request.method === 'GET' && request.url.endsWith('/images/generations/task_img_1')), '没有轮询图片任务')
})

// ------------------------------------------------------------------ 视频
const videoRequest = (model, mode, extra = {}) => ({
  mode,
  model,
  prompt: '镜头推进',
  aspectRatio: '16:9',
  resolution: '768P',
  seconds: 5,
  ...extra,
})

const dataUrl = base64 => `data:image/png;base64,${base64}`

const failedPoll = () => json({ status: 'failed', error: { message: 'stub-failure' } })

await check('首尾帧提交带 image_mode 与顶层 images，成品读 metadata.url', async () => {
  const stub = stubFetch([
    [(href) => href.endsWith('/ov/files'), () => json({ url: 'https://cdn.example/ref.png' })],
    [isVideoSubmit, () => json({ id: 'task_1', status: 'queued' })],
    [(href, method) => method === 'GET' && href.includes('/videos/'), failedPoll],
  ])
  let submit
  try {
    await generateVideo(VIDEO_UPSTREAM, videoRequest('minimax-h3-2k', 'keyframe', {
      firstFrame: dataUrl(TINY_PNG.toString('base64')),
      lastFrame: dataUrl(TINY_PNG.toString('base64')),
    }))
  } catch {
    // 轮询按 stub 返回 failed 结束，提交体已经捕获到了。
  } finally {
    submit = stub.requests.find(request => isVideoSubmit(request.url, request.method))
    stub.restore()
  }
  assert.ok(submit !== undefined, '没有发出视频提交')
  const body = jsonBodyOf(submit)
  assert.equal(body.model, 'minimax-h3-2k')
  assert.equal(body.metadata.image_mode, 'first-last-frame')
  assert.equal(body.metadata.resolution, '768P')
  assert.ok(Array.isArray(body.images) && body.images.length === 2, '首尾帧应放在顶层 images')
  assert.equal(body.image, undefined, '两张帧时不能只发一张')
})

await check('参考族把参考图放 metadata.src_ref_images，不占顶层 images', async () => {
  const stub = stubFetch([
    [(href) => href.endsWith('/ov/files'), () => json({ url: 'https://cdn.example/ref.png' })],
    [isVideoSubmit, () => json({ id: 'task_2', status: 'queued' })],
    [(href, method) => method === 'GET' && href.includes('/videos/'), failedPoll],
  ])
  let submit
  try {
    await generateVideo(VIDEO_UPSTREAM, videoRequest('minimax-h3-ref-2k', 'reference', {
      image: dataUrl(TINY_PNG.toString('base64')),
      images: [dataUrl(TINY_PNG.toString('base64'))],
    }))
  } catch {
    // 后续轮询不在本用例范围内。
  } finally {
    submit = stub.requests.find(request => isVideoSubmit(request.url, request.method))
    stub.restore()
  }
  assert.ok(submit !== undefined, '没有发出视频提交')
  const body = jsonBodyOf(submit)
  assert.equal(body.metadata.image_mode, 'reference')
  assert.ok(Array.isArray(body.metadata.src_ref_images), '参考图必须进 metadata.src_ref_images')
  assert.equal(body.metadata.src_ref_images.length, 2)
  assert.equal(body.image, undefined, '参考图不能被当成首帧')
})

await check('单图模式用顶层 image，不传 image_mode（让网关按 i2v 推断）', async () => {
  const stub = stubFetch([
    [(href) => href.endsWith('/ov/files'), () => json({ url: 'https://cdn.example/first.png' })],
    [isVideoSubmit, () => json({ id: 'task_3', status: 'queued' })],
    [(href, method) => method === 'GET' && href.includes('/videos/'), failedPoll],
  ])
  let submit
  try {
    await generateVideo(VIDEO_UPSTREAM, videoRequest('minimax-h3-fl2va', 'image', {
      image: dataUrl(TINY_PNG.toString('base64')),
    }))
  } catch {
    // 同上。
  } finally {
    submit = stub.requests.find(request => isVideoSubmit(request.url, request.method))
    stub.restore()
  }
  const body = jsonBodyOf(submit)
  assert.ok(typeof body.image === 'string' && body.image.startsWith('https://'), '首帧应是上传后的 URL')
  assert.equal(body.metadata.image_mode, undefined)
})

await check('文生视频不发任何素材字段', async () => {
  const stub = stubFetch([
    [isVideoSubmit, () => json({ id: 'task_4', status: 'queued' })],
    [(href, method) => method === 'GET' && href.includes('/videos/'), failedPoll],
  ])
  let submit
  try {
    await generateVideo(VIDEO_UPSTREAM, videoRequest('minimax-h3-2k', 'text'))
  } catch {
    // 同上。
  } finally {
    submit = stub.requests.find(request => isVideoSubmit(request.url, request.method))
    stub.restore()
  }
  const body = jsonBodyOf(submit)
  assert.equal(body.image, undefined)
  assert.equal(body.images, undefined)
  assert.equal(body.duration, 5)
  assert.equal(body.metadata.generate_audio, true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
