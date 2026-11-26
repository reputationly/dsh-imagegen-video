/**
 * Standalone smoke test for the built @q253595422/dsh-imagegen-video artifacts:
 *
 *  A. host half loads and exposes the plugin contract
 *  B. generate engine works against a mock OpenAI-compatible upstream
 *     (text mode with b64_json, edit mode with multipart + url result)
 *  C. route handlers (settings bridge + generate) work over real HTTP
 *  D. client bundle registers via window.__ModuleLoader__ and the factory
 *     exposes apply/inject with the right shape
 *
 * Run: node scripts/smoke.mjs   (from the package root)
 */
import { createServer, request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
// 画布源码可能分布在 CanvasWorkspace.tsx 与 canvas/ 下的模块中：扫描一律走
// 这个聚合读取，重构搬文件时断言才不会静静失配。
import { canvasSourceText } from './lib/canvas-source.mjs'
import { assertRules, createCheckHarness } from './lib/check-harness.mjs'

const root = new URL('../', import.meta.url)
const results = []
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
/**
 * Per-check hang guard. The implementation is `scripts/lib/check-harness.mjs`,
 * shared with smoke-video, smoke-canvas-video, smoke-video-picker, smoke-compose,
 * smoke-code-render and smoke-video-director.
 *
 * The deadline is a HANG guard, not a performance budget: a check that overruns
 * but eventually passes is a PASS that says how slow it was, and only a check
 * that never settles -- or that fails after the deadline -- is a failure.
 *
 * WHY shared: each suite used to carry its own copy of that logic, so the same
 * defect lived in six places and a seventh copy would have inherited it by
 * example. The verdict rules are pinned by `scripts/verify-check-harness.mjs`,
 * which `pnpm test` does not invoke -- so the rules are ALSO asserted below,
 * before the first real check. This suite is the right place for that: it is
 * the first thing `pnpm test` runs that uses the harness, and a harness that
 * has drifted from its rules would otherwise be discovered by the one thing it
 * gets wrong (a slow-but-correct check recorded as a failure) rather than here.
 */
const check = createCheckHarness({ results })

// Put the harness rules inside the gate. `scripts/verify-check-harness.mjs` is
// the readable specification, but `pnpm test` does not invoke it, so on its own
// it protects nothing; this suite is the first thing in `pnpm test` that uses
// the harness, which makes it the cheapest place to notice a drifted verdict.
// Throwing here is deliberate: a harness that records a correct-but-slow check
// as broken makes every suite below it lie.
await assertRules(assert)

/** Wait for React/jsdom state to settle without relying on a fixed delay.
 *
 *  Budgeted in polls as well as wall-clock, for the same measured reason
 *  `waitUntil` below documents: under load the first 25ms timer can fire
 *  seconds late, so a pure deadline expires having granted very few retries and
 *  reports "did not render" for a node the next tick would have produced. The
 *  E1 jsdom checks hit exactly that -- the same tree passed and failed on
 *  consecutive runs, naming different selectors each time. */
async function waitForSelector(root, selector, timeout = 1200) {
  const deadline = Date.now() + timeout
  const minPolls = Math.max(1, Math.ceil(timeout / 25))
  let polls = 0
  while (root.querySelector(selector) === null && (polls < minPolls || Date.now() < deadline)) {
    await new Promise(resolve => setTimeout(resolve, 25))
    polls++
  }
  assert.ok(root.querySelector(selector) !== null, `selector did not render: ${selector}`)
}

/** Wait for async fixture data to reach the rendered list, not just its host.
 *  Same poll budget as `waitForSelector`, same measured reason. */
async function waitForSelectorCount(root, selector, count, timeout = 1200) {
  const deadline = Date.now() + timeout
  const minPolls = Math.max(1, Math.ceil(timeout / 25))
  let polls = 0
  while (root.querySelectorAll(selector).length < count && (polls < minPolls || Date.now() < deadline)) {
    await new Promise(resolve => setTimeout(resolve, 25))
    polls++
  }
  assert.ok(root.querySelectorAll(selector).length >= count, `expected ${count} matches: ${selector}`)
}

/** Wait until a synchronous predicate becomes true.
 *  Budgeted in polls, not wall-clock alone: under heavy machine load the first
 *  25ms timer can fire seconds late, and a pure deadline then expires having
 *  granted zero retries (measured: a toolview render missed its 1200ms window
 *  at load 20 while every later assertion passed). Guarantee the poll count the
 *  timeout implies, and still honour the deadline once the machine keeps up. */
async function waitUntil(predicate, timeout = 1200) {
  const deadline = Date.now() + timeout
  const minPolls = Math.max(1, Math.ceil(timeout / 25))
  let polls = 0
  while (!predicate() && (polls < minPolls || Date.now() < deadline)) {
    await new Promise(resolve => setTimeout(resolve, 25))
    polls++
  }
  return predicate()
}

// ---------------------------------------------------------------- A. host half
/**
 * Point the plugin's data root at a scratch dir so the suite never touches the
 * real ~/.dsh. `DSH_HOME` is read when the module resolves its storage path and
 * when the canvas store resolves its root, so it must be set before the host
 * half is imported — the sibling suites (smoke-video, smoke-canvas-video,
 * smoke-compose) all do this.
 *
 * Without it the canvas/skill checks fell through to the real
 * ~/.dsh/dsh-imagegen/canvas: `makeRoutes` injects no `canvas` backend, so the
 * route used the real store, whose foreign index made `create` return an
 * unexpected document and every dependent check fail on `.id` / `.background` —
 * and the run wrote its fixtures into that real directory.
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-'))
const host = await import(new URL('lib/index.js', root).href)
const hostLocale = await import(new URL('lib/locale-tables.js', root).href)
// The host half renders skill copy through the same dictionaries the browser
// bundle ships; wire that resolver here so the copy assertions see real text.
host.setSkillTranslate((key, params, language) => hostLocale.interpolate(key, params, hostLocale.imageGenLanguageOf(language)))
host.setSkillLanguage(() => 'zh')

await check('A1 host exports the plugin contract', () => {
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.name, 'imagegen')
  assert.deepEqual(host.inject, ['webServer', 'systemPrompt', 'commands'])
  assert.equal(typeof host.Config, 'function')
  assert.equal(typeof host.ImageGenSettingsNamespace, 'string') // branded at runtime as string
  assert.equal(typeof host.makeRoutes, 'function')
  assert.equal(typeof host.generateImage, 'function')
})
await check('A1b installing the package as a dependency does not build', () => {
  // 反向不变量（曾经成立）：`prepare: tsdown` 让 git 依赖在安装时就地构建。本 fork 不再
  // 走 git 依赖：小助手装的是 CI 打好的 tgz，`lib/` 本来就在包里，因此安装阶段绝不能
  // 触发构建——它会把宿主的安装过程变成一次 tsdown 编译。构建移到 prepack。
  assert.equal(packageJson.scripts.prepare, undefined, 'prepare must not build on install')
  assert.equal(packageJson.scripts.prepack, 'tsdown', 'packing is where the build belongs')
})

/**
 * Windows has to find its own ffmpeg, and the rules that make that work are the
 * ones a POSIX machine never exercises. So the lookup takes the platform and
 * the environment as arguments: a scratch directory and a fake `PATH` are enough
 * to prove, on macOS, that a Windows install is discoverable at all.
 *
 * What each assertion is guarding:
 *  - `.exe` — every Windows installer writes `ffmpeg.exe`, and joining the bare
 *    name is a lookup that can never match. This was the P0 in issue #15: a
 *    correctly installed ffmpeg was invisible to the whole video pipeline.
 *  - `PATH` — winget, scoop and the official zip all install by appending a
 *    directory to the system PATH. The old candidate list held four POSIX
 *    directories, none of which exist on Windows, so PATH was the only answer
 *    and it was not consulted.
 *  - the execute bit — `X_OK` is emulated on Windows on top of the read-only
 *    attribute and says nothing about whether a file can run, so a Windows
 *    lookup must accept a plain regular file.
 *  - the override — `FFMPEG_PATH` has to be honoured by the shared lookup, not
 *    only by code rendering, or a user who answers the question still sees the
 *    clip composer report "not found".
 */
await check('A1c tool discovery finds a Windows-style install and honours the override', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-toolfind-'))
  try {
    const bin = join(scratch, 'Kdenlive', 'bin')
    mkdirSync(bin, { recursive: true })
    const exe = join(bin, 'ffmpeg.exe')
    writeFileSync(exe, 'not a real binary; discovery only stats it\n')

    // `home` points into the scratch directory, and that is not incidental. The
    // first candidate directory is `<home>/.local/bin`, and on a developer
    // machine that directory holds a real ffmpeg — so a lookup that could not be
    // told a different home would return the developer's binary and every
    // assertion below would pass for the wrong reason.
    const win = { platform: 'win32', env: { PATH: bin }, home: scratch }

    // The directory is reachable only through PATH, exactly like a winget or
    // scoop install, and only the `.exe` spelling exists in it.
    assert.equal(host.findTool('ffmpeg', win), exe,
      'a Windows lookup must find ffmpeg.exe through PATH')
    assert.equal(host.findTool('ffprobe', win), undefined,
      'a missing tool stays missing; discovery must not invent one')

    // The same directory on a POSIX lookup holds nothing usable: there is no
    // bare `ffmpeg` here, and the guard must not accept `ffmpeg.exe` instead.
    //
    // Asserted as "not this file" rather than "nothing at all", because the
    // POSIX candidate list also holds the real system directories. CI installs
    // ffmpeg into /usr/bin before the suite runs, so a lookup there legitimately
    // finds a working tool -- and an assertion that it must find nothing would
    // fail on CI while passing on a developer machine that has no
    // /usr/bin/ffmpeg. The claim under test is that a `.exe` is never accepted,
    // which holds either way.
    assert.notEqual(host.findTool('ffmpeg', { platform: 'posix', env: { PATH: bin }, home: scratch }), exe,
      'a POSIX lookup must not accept a .exe as the tool')

    // Windows has no meaningful execute bit, so a regular file is the whole
    // test. Asserting it here pins that difference instead of leaving it to a
    // platform nobody runs the suite on.
    chmodSync(exe, 0o644)
    assert.equal(host.findTool('ffmpeg', win), exe,
      'on Windows a regular file counts as runnable regardless of mode bits')

    // POSIX still requires the execute bit, and this proves the two platforms
    // really do diverge rather than both happening to return the same thing.
    //
    // The bare file goes in a SEPARATE scratch home. `<home>/.local/bin` is the
    // first candidate directory on both platforms, so planting a file there
    // under the Windows home above would give the later Windows assertions a
    // second candidate to find -- and "the override falls back to discovery"
    // would then resolve to this POSIX test's file instead of the `.exe`.
    const posixHome = join(scratch, 'posix-home')
    const localBin = join(posixHome, '.local', 'bin')
    mkdirSync(localBin, { recursive: true })
    const bare = join(localBin, 'ffmpeg')
    const posix = { platform: 'posix', env: { PATH: bin }, home: posixHome }
    writeFileSync(bare, 'not executable either\n')
    chmodSync(bare, 0o644)
    if (process.platform === 'win32') {
      // `X_OK` is emulated on Windows on top of the read-only attribute, so a
      // readable file answers "can run" no matter what mode bits the host
      // reports. The execute-bit contract below is therefore only meaningful on
      // a POSIX host — CI runs on ubuntu, which is where it gets exercised.
      assert.equal(host.findTool('ffmpeg', posix), bare,
        'a Windows host emulates X_OK, so a readable file counts as runnable')
    } else {
      assert.notEqual(host.findTool('ffmpeg', posix), bare,
        'on POSIX a file without the execute bit is not a tool')
      chmodSync(bare, 0o755)
      assert.equal(host.findTool('ffmpeg', posix), bare,
        'on POSIX the execute bit is what makes it a tool')
    }

    // The override wins over discovery, and an override pointing at nothing is
    // ignored rather than reported as a found tool.
    assert.equal(host.findTool('ffmpeg', { ...win, env: { PATH: bin, FFMPEG_PATH: exe } }), exe,
      'FFMPEG_PATH is honoured by the shared lookup')
    assert.equal(host.findTool('ffmpeg', { ...win, env: { PATH: bin, FFMPEG_PATH: join(scratch, 'nope.exe') } }), exe,
      'an override that does not exist falls back to discovery')
    assert.equal(host.findTool('ffprobe', { ...win, env: { PATH: bin, FFPROBE_PATH: join(scratch, 'nope') } }), undefined,
      'a stale override must not fabricate a tool')

    // A Windows PATH is semicolon separated. Splitting it on ':' would yield `C`
    // and the rest of the path as two separate entries, so nothing would match.
    assert.equal(host.findTool('ffmpeg', { ...win, env: { PATH: `C:\\nowhere;${bin}` } }), exe,
      'a Windows PATH is split on the semicolon, not the colon')

    // The POSIX-only package-manager directories must not be searched on Windows:
    // they do not exist there, and listing them only makes the "searched …"
    // message that accompanies a failure misleading.
    const winDirs = host.localVideoToolDirs({ platform: 'win32', env: { PATH: bin }, home: scratch })
    assert.ok(winDirs.includes(bin), 'the Windows PATH entry is searched')
    assert.ok(!winDirs.includes('/opt/homebrew/bin'), 'Homebrew is not a Windows location')
    assert.ok(!winDirs.includes('/usr/bin'), '/usr/bin is not a Windows location')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
await check('A2 Config schema validates + marks apiKey secret', () => {
  const resolvedRefs = host.Config({ apiUrl: 'https://x/v1', apiKey: 'sk-1' })
  const resolved = Object.fromEntries(Object.entries(resolvedRefs).map(([key, value]) => [
    key,
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value,
  ]))
  assert.equal(resolved.apiKey, 'sk-1')
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.allowAgentImageGeneration, true)
  assert.equal(resolved.defaultModel, '')
  assert.deepEqual(resolved.imageModels, [])
  // Config is the schemastery schema itself: the secret role lives on the
  // schema node, which the settings seam's redactor walks.
  assert.equal(host.Config.dict?.apiKey?.meta?.role, 'secret')
  assert.equal(host.Config.dict?.apiKey?.meta?.volatile, true, 'live fields are exposed to dsh-settings 0.1.7')
})
await check('A2b configured default image model is used when Agent omits model', () => {
  const channels = [{
    id: 'default',
    preset: '',
    name: 'Default',
    apiUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    models: [
      { alias: 'qwen-image-3-pro', id: 'qwen-image-3-pro' },
      { alias: 'qwen-image-2', id: 'qwen-image-2' },
    ],
  }]
  const picked = host.resolveAgentImageModel({
    enabled: true,
    allowAgentImageGeneration: true,
    channels,
    defaultChannelId: 'default',
    defaultModel: 'qwen-image-2',
  }, undefined)
  assert.equal(picked.alias, 'qwen-image-2')
  assert.equal(picked.upstream, 'qwen-image-2')
  // 展示名与模型名不同时，两种都要能选中同一条。
  const gateway = [{ ...channels[0], models: [{ alias: 'MiniMax H3 图像', id: 'minimax-h3-image' }] }]
  const config = { enabled: true, allowAgentImageGeneration: true, channels: gateway, defaultChannelId: 'default', defaultModel: '' }
  assert.equal(host.resolveAgentImageModel(config, 'minimax-h3-image').alias, 'MiniMax H3 图像')
  assert.equal(host.resolveAgentImageModel(config, 'MiniMax H3 图像').upstream, 'minimax-h3-image')
})
// ---------------------------------------------- B. engine vs mock upstream
/** A PNG fixture: one pixel, valid header, no external file needed. */
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
let activeGenerationRequests = 0
let maxGenerationRequests = 0
// A second listener = a different origin (port) from the API base. It stands in
// for a malicious relay pointing image URLs at an attacker-controlled host.
const foreignAuthHeaders = []
const resultAuthHeaders = []
const foreignHost = createServer((req, res) => {
  foreignAuthHeaders.push(req.headers.authorization)
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(pngBytes)
})
await new Promise(resolve => foreignHost.listen(0, '127.0.0.1', resolve))
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/models') {
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Gateway site</title>')
    return
  }
  if (url.pathname === '/v1/models') {
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'grok-imagine-image' },
      { id: 'gpt-image-2' },
      { id: 'gpt-4o' },
      { id: 'text-embedding-3-small' },
      { id: 'glm-image', capabilities: { image_generation: true } },
      { id: 'chat-only-model', capabilities: { image_generation: false } },
      { id: 'gpt-image-legacy', capabilities: { image_generation: false } },
      { id: 'gpt-image-2' },
      // No separator between the family name and the version: the shipped
      // defaults use this shape (`nanobanana2`, `nanobanana2-lite`), so the
      // id-only fallback has to accept it or "detect models" drops models the
      // catalog itself declares known.
      { id: 'nanobanana2' },
      { id: 'nanobanana2-lite' },
    ] }))
    return
  }
  if (url.pathname === '/v1/wand/si-image/generation') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    assert.equal(body.model, 'si-image')
    assert.equal(body.prompt, 'full endpoint')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
    return
  }
  if (url.pathname === '/v1/images/generations') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    // 网关只有一种图像协议：OpenAI 兼容的 /images/generations。两个模型族共用它，
    // 差别只在参数表——h3-image 只认 2K 档的 `size`。
    assert.ok(body.model === 'gpt-image-2' || body.model === 'minimax-h3-image',
      `unexpected upstream model: ${body.model}`)
    assert.ok(body.prompt === 'a cat' || body.prompt === 'a mismatch cat' || body.prompt === 'a background cat' || body.prompt === 'cancel this' || body.prompt === 'signed urls' || body.prompt === 'foreign url' || body.prompt === 'parallel one' || body.prompt === 'parallel two' || body.prompt === 'SMOKE-RETRY-PROMPT a lighthouse at dusk')
    // The engine never sends `n`: Responses-API gateways reject the batch
    // parameter, so the requested count is satisfied by parallel requests.
    assert.equal(body.n, undefined)
    if (body.model === 'minimax-h3-image') {
      assert.equal(body.size, '2048x2048', 'h3-image only accepts the 2K billing tier')
      assert.equal(body.quality, undefined, 'h3-image has no quality dial')
      assert.equal(body.detail, undefined, 'h3-image has no detail dial')
    } else {
      assert.equal(body.size, '1024x1024')
      assert.equal(body.quality, 'high')
      assert.equal(body.detail, body.prompt === 'signed urls' || body.prompt === 'foreign url' ? undefined : 'standard')
    }
    if (body.prompt === 'parallel one' || body.prompt === 'parallel two') {
      activeGenerationRequests += 1
      maxGenerationRequests = Math.max(maxGenerationRequests, activeGenerationRequests)
      // C4 asserts these two overlap here. The window has to be wide enough
      // for the SECOND submit to arrive while the first is still in flight:
      // both submits are awaited one after the other, so under a loaded
      // machine (the full suite runs this beside a dozen other processes)
      // 50ms was not enough and C4 failed with maxGenerationRequests===1
      // while passing on a standalone run. Widening it tests the same thing
      // and no longer doubles as a timing assertion about the harness.
      await new Promise(resolve => setTimeout(resolve, 300))
      activeGenerationRequests -= 1
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const data = body.prompt === 'foreign url'
      ? [{ url: `http://127.0.0.1:${foreignHost.address().port}/steal.png` }]
      : body.prompt === 'signed urls'
      ? [
          { b64_json: '', url: `http://127.0.0.1:${upstream.address().port}/image/gcs-signed.png?X-Goog-Credential=test&X-Goog-Signature=test` },
          { b64_json: '   ', url: `http://127.0.0.1:${upstream.address().port}/image/s3-signed.png?X-Amz-Credential=test&X-Amz-Signature=test` },
        ]
      : [
          { b64_json: pngBytes.toString('base64'), revised_prompt: 'a refined cat' },
          { url: `http://127.0.0.1:${upstream.address().port}/image/${body.prompt === 'a mismatch cat' ? 'mismatch' : 'result'}.png` },
        ]
    res.end(JSON.stringify({ created: 1, data }))
    return
  }
  if (url.pathname === '/v1/images/edits') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    assert.ok(req.headers['content-type'].startsWith('multipart/form-data'), 'multipart expected')
    const commandEdit = body.includes('edit via command') || body.includes('edit attached image')
    assert.ok(body.includes('name="prompt"') && (body.includes('edit this') || commandEdit), 'prompt part missing')
    assert.ok(body.includes('name="model"') && body.includes('gpt-image-2'), 'model part missing')
    if (!commandEdit) assert.ok(body.includes('name="size"') && body.includes('1536x1024'), 'size part missing')
    assert.ok(!body.includes('name="n"'), 'n must not be sent (batch param rejected)')
    assert.ok(body.includes('name="image"'), 'image part missing')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
    return
  }
  if (url.pathname === '/v1/chat/completions') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    const asked = body.messages.at(-1).content
    const imageUrl = `http://127.0.0.1:${upstream.address().port}/image/result.png`
    const askedText = typeof asked === 'string'
      ? asked
      : Array.isArray(asked)
        ? asked.find(part => part !== null && typeof part === 'object' && part.type === 'text')?.text ?? ''
        : ''
    if (askedText.startsWith('chat image')) {
      assert.equal(body.stream, false, 'chat image requests must disable streaming')
      assert.equal(body.messages[0].role, 'user', 'chat image request must use a user message')
    }
    if (askedText === 'chat image markdown') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: `Generated: ![cat](${imageUrl})` } }] }))
      return
    }
    if (askedText === 'chat image html') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: `<p>Result</p><img src="${imageUrl}" />` } }] }))
      return
    }
    if (askedText === 'chat image plain') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: imageUrl } }] }))
      return
    }
    if (askedText === 'chat image json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ result: { image_url: imageUrl } }) } }] }))
      return
    }
    if (askedText === 'chat image message images') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '', images: [{ image_url: { url: imageUrl } }] } }] }))
      return
    }
    if (askedText === 'chat image error text') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '上游策略拒绝了这次图片生成' } }] }))
      return
    }
    if (askedText === 'chat image edit') {
      assert.ok(Array.isArray(asked), 'chat edit content must be multimodal')
      assert.ok(asked.some(part => part !== null && typeof part === 'object' && part.type === 'image_url'), 'chat edit image_url missing')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: imageUrl } }] } }] }))
      return
    }
    // Vision request (layer decomposition): the canvas route sends a content
    // array; answer with a fenced JSON plan that also exercises normalization
    // (background first, a text layer, and one degenerate box to drop).
    const visionReply = '```json\n'
      + JSON.stringify({
        layers: [
          { kind: 'text', label: '标题', rect: { x: 0.1, y: 0.08, width: 0.6, height: 0.12 }, text: '夏日限定', color: '#FFEE00' },
          { kind: 'background', label: '背景' },
          { kind: 'object', label: '人物', rect: { x: 0.3, y: 0.25, width: 0.3, height: 0.6 } },
          { kind: 'object', label: '退化框', rect: { x: 0.2, y: 0.2, width: 0, height: 0.3 } },
        ],
      })
      + '\n```'
    const reply = Array.isArray(asked)
      ? visionReply
      : asked === 'think leak'
        ? '<think>\u9996\u5148\u5206\u6790\u7528\u6237\u9700\u6c42\u2026\uff08\u5927\u6bb5\u63a8\u7406\uff09</think>\nA lighthouse at dusk over a stormy sea.'
        : asked === 'dangling think'
          ? '<think>reasoning that never closes'
          : 'A calm meadow under morning light.'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
    return
  }
  if (url.pathname === '/image/result.png') {
    // Same-origin downloads (B1: API base is this server) keep the key; other
    // suites (Qwen / async providers on their own ports) point here from a
    // foreign origin and must arrive without it.
    resultAuthHeaders.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/mismatch.png') {
    // Regression fixture: the provider declares JPEG while returning PNG bytes.
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/gcs-signed.png' || url.pathname === '/image/s3-signed.png') {
    assert.equal(req.headers.authorization, undefined, 'presigned URLs must not receive the channel API key')
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

await check('B1 text generation normalizes b64_json + url items', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    // n=1: one request returns two data items (b64_json + url), both normalized.
    { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '4k', n: 1, detail: 'standard' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(result.images[0].revisedPrompt, 'a refined cat')
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].mime, 'image/png')
  assert.equal(resultAuthHeaders.at(-1), 'Bearer sk-test', 'same-origin result URLs keep the channel API key')
})

await check('B1b exact URL channels use the configured endpoint verbatim (#26)', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/wand/si-image/generation`, apiKey: 'sk-test', apiUrlFull: true },
    { mode: 'text', model: 'si-image', prompt: 'full endpoint', size: 'auto', quality: 'auto', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B1b3 a broken result URL resumes from the bytes already received', async () => {
  let downloadRequests = 0
  let resumeRange = ''
  const half = Math.floor(pngBytes.length / 2)
  const flaky = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [{ url: `http://127.0.0.1:${flaky.address().port}/image/flaky.png` }],
      }))
      return
    }
    if (url.pathname === '/image/flaky.png') {
      downloadRequests += 1
      if (downloadRequests === 1) {
        // A CDN that closes a "complete" body halfway through leaves the host
        // holding valid-looking bytes and no IEND. That used to turn a paid
        // generation into a truncated image; the resume must ask for the tail.
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(half),
        })
        res.end(pngBytes.subarray(0, half))
        return
      }
      resumeRange = String(req.headers.range ?? '')
      assert.equal(resumeRange, `bytes=${half}-`, 'the retry must ask for the missing tail')
      res.writeHead(206, {
        'content-type': 'image/png',
        'content-range': `bytes ${half}-${pngBytes.length - 1}/${pngBytes.length}`,
        'content-length': String(pngBytes.length - half),
      })
      res.end(pngBytes.subarray(half))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => flaky.listen(0, '127.0.0.1', resolve))
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${flaky.address().port}/v1`, apiKey: 'sk-test' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'a resumed result', size: '1:1', quality: '4k', n: 1, detail: '' },
    )
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(downloadRequests, 2, 'the host retried the result URL after the body broke')
    assert.equal(resumeRange, `bytes=${half}-`)
  } finally {
    await new Promise(resolve => flaky.close(resolve))
  }
})

await check('B1c chat completions text content extracts markdown, HTML, plain and JSON image URLs', async () => {
  const prompts = ['chat image markdown', 'chat image html', 'chat image plain', 'chat image json']
  for (const prompt of prompts) {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: 'sk-test', protocol: 'auto' },
      { mode: 'text', model: 'gpt-image-2', prompt, size: '1:1', quality: '4k', n: 1, detail: '' },
    )
    assert.equal(result.images.length, 1, prompt)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'), prompt)
    assert.equal(result.images[0].mime, 'image/png', prompt)
  }
})

await check('B1d chat completions edit sends image_url and reads structured content images', async () => {
  const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test', protocol: 'chat-completions' },
    { mode: 'edit', model: 'gpt-image-2', prompt: 'chat image edit', size: '1:1', quality: '4k', n: 1, detail: '', image: dataUrl },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B1e chat completions message.images and text errors are handled', async () => {
  const image = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'chat image message images', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(image.images.length, 1)
  await assert.rejects(
    host.generateImage(
      { apiUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: 'sk-test' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'chat image error text', size: '1:1', quality: '4k', n: 1, detail: '' },
    ),
    /上游策略拒绝了这次图片生成/,
  )
})

await check('B2 signed URLs bypass API-key auth and empty base64 falls back to URL', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'signed urls', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
})

await check('B2b result URLs on a foreign origin never receive the channel API key', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'foreign url', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(foreignAuthHeaders.length, 1)
  assert.equal(foreignAuthHeaders[0], undefined, 'a foreign-origin image URL must not carry the Bearer key')
})

await check('B3 edit mode sends multipart and normalizes', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'edit', model: 'gpt-image-2', prompt: 'edit this', size: '3:2', quality: '2k', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B3b edit mode forwards every reference image', async () => {
  const seen = { fields: [] }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('latin1')
    seen.fields = [...body.matchAll(/name="([^"]+)"/g)].map(match => match[1])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' },
      { mode: 'edit', model: 'gpt-image-2', prompt: 'combine both references', size: '1:1', quality: 'auto', n: 1, detail: '', image: dataUrl, images: [dataUrl, dataUrl] },
    )
    assert.deepEqual(seen.fields.filter(name => name.startsWith('image')), ['image[]', 'image[]', 'image[]'])
  } finally {
    server.close()
  }
})

await check('B4 config missing errors are user-presentable', async () => {
  // 网关地址来自宿主目录、密钥来自宿主凭据服务，两者都可能在提交那一刻还没就绪。
  // 这两种缺失必须在发请求之前用用户能读懂的话拒绝，而不是发出去换一个 401。
  await assert.rejects(
    host.generateImage({ apiUrl: '', apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    error => error.code === 'config-missing' && /网关地址未配置/.test(error.message),
  )
  await assert.rejects(
    host.generateImage({ apiUrl: 'http://x', apiKey: '' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    error => error.code === 'config-missing' && /网关密钥未就绪/.test(error.message),
  )
})

await check('B4b a failed call is explainable afterwards (#38)', async () => {
  // The reporter of #38 reverse-engineered an image API, verified it against
  // new-api, and then watched every plugin call fail while NEITHER side had a
  // log entry — because the request never reached their gateway. The plugin
  // toasted one sentence and kept no record, so the URL it actually called, the
  // HTTP status and the network error code were all unrecoverable.
  host.clearDiagnostics()

  // 1. A refused connection: no response at all, so the URL and the socket code
  //    are the only evidence that the request left the process.
  const closedPort = await (async () => {
    const probe = createServer(() => {})
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    return port
  })()
  await assert.rejects(
    host.generateImage(
      { apiUrl: `http://127.0.0.1:${closedPort}/v1`, apiKey: 'sk-secret-key-abcdefghijklmnop', channelName: 'MyChannel' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: 'auto', quality: 'auto', n: 1, detail: '' },
    ),
  )
  const refused = host.listDiagnostics().find(entry => entry.phase === 'generate')
  assert.ok(refused !== undefined, 'a refused connection leaves a diagnostic entry')
  assert.equal(refused.url, `http://127.0.0.1:${closedPort}/v1/images/generations`, 'the diagnostic records the FINAL request URL, including the appended path')
  assert.equal(refused.channel, 'MyChannel', 'the entry names the channel so it maps to a settings row')
  assert.equal(refused.model, 'gpt-image-2')
  assert.equal(refused.method, 'POST')
  assert.equal(refused.failureCode, 'upstream-unreachable')
  assert.equal(refused.hadAuth, true, 'the entry records THAT a key was sent, never its value')
  assert.ok(refused.durationMs >= 0, 'the entry records elapsed time')
  assert.ok(refused.requestBytes > 0, 'the entry records the request body size (a huge edit can be rejected before the app sees it)')
  assert.equal(refused.status, undefined, 'a request that never got a response carries no status')

  // 2. A non-2xx upstream: the status and the body have to survive, because
  //    that is where the gateway says WHY it refused.
  const bad = createServer((_req, res) => {
    res.writeHead(413, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'payload too large' }, request_id: 'req_123' }))
  })
  await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve))
  const badPort = bad.address().port
  try {
    await assert.rejects(
      host.generateImage(
        { apiUrl: `http://127.0.0.1:${badPort}/v1`, apiKey: 'k', channelName: 'Bad' },
        { mode: 'text', model: 'gpt-image-2', prompt: 'a dog', size: 'auto', quality: 'auto', n: 1, detail: '' },
      ),
    )
  } finally {
    await new Promise(resolve => bad.close(resolve))
  }
  const rejected = host.listDiagnostics().find(entry => entry.channel === 'Bad')
  assert.ok(rejected !== undefined, 'a rejected request leaves a diagnostic entry')
  assert.equal(rejected.status, 413, 'the upstream status is recorded')
  assert.equal(rejected.failureCode, 'upstream-rejected')
  assert.match(rejected.message, /payload too large/, 'the upstream message reaches the record')
  assert.match(rejected.bodyExcerpt ?? '', /req_123/, 'the raw upstream body (with its request id) is kept for support')

  // 3. Redaction: these entries are meant to be pasted into a public issue.
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'
  const redacted = host.redactDiagnosticText(`Authorization: Bearer ${secret}\n{"apiKey":"${secret}"}\nhttps://x.test/v1?api_key=${secret}`)
  assert.equal(redacted.includes(secret), false, 'the recorded text never carries the key')
  assert.match(redacted, /<redacted>|<redacted-key>/, 'the redaction is visible in the text')
  assert.equal(
    host.redactDiagnosticText('data:image/png;base64,' + 'A'.repeat(5000)).length < 200,
    true,
    'inline base64 image payloads are summarised, not stored',
  )

  // 4. The buffer is bounded and clearable.
  assert.ok(host.listDiagnostics().length >= 2, 'entries accumulate newest-first')
  host.clearDiagnostics()
  assert.equal(host.listDiagnostics().length, 0, 'the panel can clear the record')
})

await check('B5 upstream error surfaces its message', async () => {
  const bad = createServer(async (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Unknown parameter: detail' } }))
  })
  await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve))
  const port = bad.address().port
  try {
    await assert.rejects(
      host.generateImage({ apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
      /Unknown parameter: detail/,
    )
  } finally {
    await new Promise(resolve => bad.close(resolve))
  }
})

await check('B6 dall-e-3 clamps params', async () => {
  const seen = []
  const dalle = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => dalle.listen(0, '127.0.0.1', resolve))
  const port = dalle.address().port
  try {
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      { mode: 'text', model: 'dall-e-3', prompt: 'x', size: '512x512', quality: 'high', n: 4, detail: 'high' },
    )
    // dall-e-3: params clamp to { model, size } and no `n` is ever sent.
    assert.deepEqual(seen[0], { model: 'dall-e-3', size: '1024x1024', prompt: 'x' })
  } finally {
    await new Promise(resolve => dalle.close(resolve))
  }
})

await check('B10 async two-step providers submit, poll, and flatten URL arrays', async () => {
  const submissions = []
  const polls = new Map()
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/v1/images/generations') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const taskId = `task-${submissions.length + 1}`
      submissions.push({
        taskId,
        body,
        authorization: req.headers.authorization,
        modelScopeHeader: req.headers['x-modelscope-async-mode'],
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: taskId }] }))
      return
    }
    if (url.pathname.startsWith('/v1/tasks/')) {
      const taskId = url.pathname.slice('/v1/tasks/'.length)
      const count = (polls.get(taskId) ?? 0) + 1
      polls.set(taskId, count)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (count === 1) {
        res.end(JSON.stringify({ data: { status: 'processing', task_id: taskId } }))
      } else {
        res.end(JSON.stringify({ data: { status: 'completed', task_id: taskId, result: { images: [{ url: [`http://127.0.0.1:${upstreamPort}/image/result.png`, `data:image/png;base64,${pngBytes.toString('base64')}`] }] } } }))
      }
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'async image', size: '1:1', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(submissions.length, 2, 'one upstream task is submitted for each requested image')
    assert.equal(result.images.length, 4, 'each completed task URL array is flattened')
    assert.ok(submissions.every(item => item.authorization === 'Bearer async-key'))
    assert.ok(submissions.every(item => item.modelScopeHeader === undefined), 'ordinary gateways do not receive ModelScope headers')
    assert.ok([...polls.values()].every(count => count >= 2), 'submitted tasks are polled until completed')
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B10b ModelScope inference submits and polls the OpenAI-compatible Qwen task', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const imageDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    calls.push({ url, method, headers, body: typeof init.body === 'string' ? init.body : undefined })
    if (method === 'POST' && url === 'https://api-inference.modelscope.cn/v1/images/generations') {
      return new Response(JSON.stringify({ task_id: 'modelscope-task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET' && url === 'https://api-inference.modelscope.cn/v1/tasks/modelscope-task-1') {
      return new Response(JSON.stringify({ task_status: 'SUCCEED', output_images: [imageDataUrl] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected ModelScope request: ${method} ${url}`)
  }
  try {
    const result = await host.generateImage(
      { apiUrl: 'https://api-inference.modelscope.cn/', apiKey: 'modelscope-key' },
      { mode: 'text', model: 'qwen-image-2.1', upstream: 'Qwen/Qwen-Image-2.1', prompt: 'a calm lake', size: '1:1', quality: 'auto', n: 1, detail: '' },
    )
    assert.equal(calls.length, 2, 'submission is followed by one successful task poll')
    assert.equal(calls[0].url, 'https://api-inference.modelscope.cn/v1/images/generations')
    assert.equal(calls[0].headers.get('x-modelscope-async-mode'), 'true')
    assert.equal(calls[0].headers.get('authorization'), 'Bearer modelscope-key')
    const submitted = JSON.parse(calls[0].body)
    assert.equal(submitted.model, 'Qwen/Qwen-Image-2.1')
    assert.equal(submitted.prompt, 'a calm lake')
    assert.equal(calls[1].url, 'https://api-inference.modelscope.cn/v1/tasks/modelscope-task-1')
    assert.equal(calls[1].headers.get('x-modelscope-task-type'), 'image_generation')
    assert.equal(calls[1].headers.get('authorization'), 'Bearer modelscope-key')
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(result.images[0].mime, 'image/png')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('B11 async provider failures surface the remote error', async () => {
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'submitted', task_id: 'failed-task' } }))
      return
    }
    if (url.pathname === '/v1/tasks/failed-task') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'failed', error: { message: 'content rejected' } } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    await assert.rejects(
      host.generateImage(
        { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
        { mode: 'text', model: 'gpt-image-2', prompt: 'bad', size: '1:1', quality: 'auto', n: 1, detail: '' },
      ),
      /content rejected/,
    )
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B12 async provider cancellation aborts polling', async () => {
  let pollCount = 0
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: 'cancel-task' }] }))
      return
    }
    if (url.pathname === '/v1/tasks/cancel-task') {
      pollCount += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'processing', task_id: 'cancel-task' } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  const controller = new AbortController()
  try {
    const pending = host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'cancel', size: '1:1', quality: 'auto', n: 1, detail: '' },
      { signal: controller.signal },
    )
    await new Promise(resolve => setTimeout(resolve, 80))
    controller.abort()
    await assert.rejects(pending)
    assert.ok(pollCount >= 1)
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})
// ------------------------------------------------- C. routes over real HTTP
const stored = new Map() // namespace -> user section
const seam = {
  writable: true,
  describe({ redactSecrets } = {}) {
    const value = { enabled: true, announceToAgent: true, apiUrl: 'http://upstream/v1', apiKey: 'sk-secret' }
    const user = stored.get('imagegen')
    const merged = { ...value, ...user }
    const view = {
      ns: 'imagegen',
      value: redactSecrets ? { ...merged, apiKey: undefined } : merged,
      revision: stored.get('rev') ?? 0,
      ...user !== undefined ? { user: redactSecrets ? { ...user, apiKey: undefined } : user } : {},
      applies: 'live',
      ...redactSecrets ? { secrets: [{ path: ['apiKey'], set: (user?.apiKey ?? '') !== '' }] } : {},
    }
    return [view]
  },
  async mutate(ns, ops, expectedRevision) {
    assert.equal(String(ns), 'imagegen')
    const current = { ...(stored.get('imagegen') ?? {}) }
    for (const op of ops) {
      if (op.op === 'set') current[op.path[0]] = op.value
      else if (op.op === 'unset') delete current[op.path[0]]
    }
    stored.set('imagegen', current)
    stored.set('rev', (stored.get('rev') ?? 0) + 1)
  },
}
/**
 * 宿主的网关媒体目录：工作台与宿主解析模型都只认它。
 *
 * 面板提交的是目录里的展示名（alias），宿主按目录把上游 id 填进请求。这里让两个
 * 名字相同，是为了让一处 fixture 同时喂给路由层的 `resolveChannels` 与目录路由；
 * 「alias ≠ 上游 id」的映射由 `smoke-gateway-catalog.mjs` 与 `src/gateway-catalog.ts`
 * 的单元覆盖，不必在这里重复。
 */
const gatewaySnapshot = {
  status: 'ready',
  version: 'smoke-v1',
  fetchedAt: 0,
  image: [
    { model: 'gpt-image-2', label: 'gpt-image-2', isDefault: true },
    { model: 'minimax-h3-image', label: 'minimax-h3-image', isDefault: false },
  ],
  video: [
    { model: 'minimax-h3-2k', label: 'minimax-h3-2k', isDefault: true },
  ],
}
/** 宿主把目录投影成的那一个网关渠道（与 `gateway-catalog.ts#gatewayChannel` 同形）。 */
const gatewayChannels = () => ({
  channels: [{
    id: 'suanli-gateway',
    name: '蒜狸网关',
    apiUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiUrlFull: false,
    apiKey: 'sk-test',
    models: gatewaySnapshot.image.map(option => ({ alias: option.label, id: option.model })),
    videoModels: gatewaySnapshot.video.map(option => ({ alias: option.label, id: option.model })),
  }],
  defaultChannelId: 'suanli-gateway',
})
const gatewayFake = {
  snapshot: () => gatewaySnapshot,
  async refresh() { return gatewaySnapshot },
}
/**
 * 宿主的对话模型：提示词增强、润色、文案与图层拆分都问它。
 *
 * Scripted like the mock upstream's `/v1/chat/completions`, because these paths
 * no longer send an HTTP request of their own — they answer through this seam.
 */
const visionReply = '```json\n'
  + JSON.stringify({
    layers: [
      { kind: 'text', label: '标题', rect: { x: 0.1, y: 0.08, width: 0.6, height: 0.12 }, text: '夏日限定', color: '#FFEE00' },
      { kind: 'background', label: '背景' },
      { kind: 'object', label: '人物', rect: { x: 0.3, y: 0.25, width: 0.3, height: 0.6 } },
      { kind: 'object', label: '退化框', rect: { x: 0.2, y: 0.2, width: 0, height: 0.3 } },
    ],
  })
  + '\n```'
const chatStub = {
  available: () => true,
  label: () => 'chat-test',
  async complete({ system, content }) {
    if (system.includes('图层拆解')) return visionReply
    const asked = typeof content === 'string'
      ? content
      : content.map(part => part.type === 'text' ? part.text : '').join('')
    if (asked === 'think leak') return ' thinking\u9996\u5148\u5206\u6790\u7528\u6237\u9700\u6c42\u2026\uff08\u5927\u6bb5\u63a8\u7406\uff09</think>\nA lighthouse at dusk over a stormy sea.'
    if (asked === 'dangling think') return "<thinkreasoning that never closes"
    return 'A calm meadow under morning light.'
  },
}
const persistedHistory = []
let persistedFavorites = []
const history = {
  async list() { return persistedHistory },
  async append(entry) {
    const wire = {
      ...entry,
      images: entry.images.map((image, index) => ({
        url: `/api/dsh-imagegen/history/image/${entry.id}-${index}.png`,
        mime: image.mime,
        ...(image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt }),
      })),
    }
    persistedHistory.unshift(wire)
    return persistedHistory
  },
  async remove(id) {
    const index = persistedHistory.findIndex(entry => entry.id === id)
    if (index >= 0) persistedHistory.splice(index, 1)
    return persistedHistory
  },
  async clear() {
    persistedHistory.splice(0)
    return persistedHistory
  },
  async readImage() { historyImageReads += 1; return undefined },
}
let historyImageReads = 0
const templateImage = Buffer.from('template-image')
// issue #29: URL-type template sources reference thumbnails by full URL; the
// route must hand the decoded URL to the backend untouched.
const templateUrlRef = 'https://raw.githubusercontent.com/itgoyo/PicGoRes/master/img/case1.png'
let templateRefreshes = 0
const templateSamples = []
const templates = {
  async list(sourceId) {
    return {
      sourceId,
      cases: [{
        id: 1,
        title: 'Poster template',
        prompt: 'Create a bright product poster',
        category: 'Posters & Typography',
        categoryZh: '海报与排版',
        styles: [],
        scenes: [],
        sourceLabel: '@author',
        sourceUrl: 'https://example.test/author',
        githubUrl: 'https://example.test/repo#1',
        image: 'case1.png',
        featured: true,
      }],
      total: 1,
      origin: 'bundled',
      repository: 'example/templates',
      fetchedAt: '2026-08-19T00:00:00.000Z',
    }
  },
  async refresh(sourceId) {
    templateRefreshes += 1
    return { sourceId, total: 1, fetchedAt: '2026-08-19T00:00:01.000Z' }
  },
  async sample(count) {
    templateSamples.push(count)
    return [{ sourceId: 'vibeui', case: { id: 1, title: 'Poster template', prompt: 'Create a bright product poster', category: 'Posters & Typography', categoryZh: '海报与排版', styles: [], scenes: [], sourceLabel: '@author', sourceUrl: '', githubUrl: '', image: '', featured: false } }]
  },
  async readImage(sourceId, file) {
    if (sourceId === 'vibeui' && file === 'case1.png') return { data: templateImage, mime: 'image/png' }
    // URL-type refs arrive decoded and untouched; the real store applies the
    // host whitelist after this point, the stub only proves the passthrough.
    return sourceId === 'itgoyo' && file.startsWith('https://raw.githubusercontent.com/') ? { data: templateImage, mime: 'image/png' } : undefined
  },
}
const favorites = {
  async list() { return [...persistedFavorites] },
  async add(sourceId, item) {
    const key = `${sourceId}:${item.id}`
    const entry = { key, sourceId, savedAt: '2026-08-19T00:00:02.000Z', case: item }
    persistedFavorites = [entry, ...persistedFavorites.filter(favorite => favorite.key !== key)]
    return [...persistedFavorites]
  },
  async remove(key) {
    persistedFavorites = persistedFavorites.filter(favorite => favorite.key !== key)
    return [...persistedFavorites]
  },
}
const agentPreviewImage = Buffer.from('agent-preview-image')
const agentPreviewRef = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: agentPreviewImage.length,
  width: 1,
  height: 1,
}
const attachments = {
  async readImage(ref) {
    assert.equal(ref.attachmentId, agentPreviewRef.attachmentId)
    assert.equal(ref.mediaType, agentPreviewRef.mediaType)
    assert.equal(ref.bytes, agentPreviewRef.bytes)
    return { ref: agentPreviewRef, data: agentPreviewImage }
  },
  async saveImage(input) {
    return {
      attachmentId: `sha256:${'b'.repeat(64)}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }
  },
}
const pendingConversationImages = new Map()
let heavySkillAllowed = true
const skillRunRoot = join(tmpdir(), `dsh-imagegen-smoke-${process.pid}`)
mkdirSync(skillRunRoot, { recursive: true })
/** ---------------------------------------------------------------- canvas ---
 * In-memory canvas + file store standing in for CanvasStore, plus a scripted
 * chat model and skill registry so the skill runner can run end to end. */
const canvasDocuments = new Map()
const canvasFiles = new Map()
const canvasBlobs = new Map()
/** The same self-executing extensions `CanvasStore.putFile` refuses. */
const BLOCKED_FILE_EXTENSIONS = new Set(['exe', 'js', 'mjs', 'cjs', 'sh', 'bash', 'bat', 'cmd', 'ps1', 'html', 'htm', 'xhtml', 'svg'])
let canvasFileSeq = 0
let chatCalls = 0
let chatReply = 'polished text by model'
const skillRegistrySkills = []
const recordCanvasFile = (data, mime, name) => {
  canvasFileSeq += 1
  const assetId = `file${canvasFileSeq.toString().padStart(4, '0')}`
  const extension = name.includes('.') ? name.split('.').pop() : 'bin'
  const fileName = `${assetId}.${extension}`
  canvasFiles.set(assetId, { name, mime })
  canvasBlobs.set(fileName, { data: Buffer.from(data), mime })
  return {
    assetId,
    url: `/api/dsh-imagegen/canvas/asset/${fileName}`,
    mime,
    bytes: data.length,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name,
  }
}
const canvasBackend = {
  async read(id) { return canvasDocuments.get(id) },
  async readAsset(file) { return canvasBlobs.get(file) },
  async readAssets(refs) {
    const found = new Map()
    for (const ref of refs) {
      const extension = (ref.name ?? '').includes('.') ? ref.name.split('.').pop() : 'bin'
      const blob = canvasBlobs.get(`${ref.assetId}.${extension}`)
      if (blob !== undefined) found.set(ref.assetId, blob)
    }
    return found
  },
  async materialize(ref, targetPath) {
    const found = await canvasBackend.readAssets([ref])
    const blob = found.get(ref.assetId)
    if (blob === undefined) throw new Error(`missing asset ${ref.assetId}`)
    writeFileSync(targetPath, blob.data)
  },
  async putFile(input) {
    // Mirrors `CanvasStore.putFile`'s refusals, so a check can stage an
    // artifact the real store would reject (blocked extension, size cap).
    const name = String(input.name)
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
    if (BLOCKED_FILE_EXTENSIONS.has(extension)) throw new Error(`出于安全考虑，不支持上传 .${extension} 文件`)
    if (input.data.byteLength > 50 * 1024 * 1024) throw new Error('文件超过 50MB 上限')
    return recordCanvasFile(input.data, input.mime, name)
  },
}
let heavyRunsStarted = 0
/** Extra artifacts the fake heavy agent writes on top of `deck.pptx`, keyed by
 *  file name. A check sets this to stage an unpublishable artifact. */
let heavyArtifacts = []
/** Isolated skill library root for the install/remove cases. */
const skillLibraryRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-skills-'))
/** Isolated local skill root the canvas registry adapter falls back to. */
const skillRegistryRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-registry-'))
const canvasSkillRunner = new host.SkillRunner({
  backend: {
    canvas: canvasBackend,
    chat: {
      async complete() {
        chatCalls += 1
        return chatReply
      },
    },
  },
  enabled: () => true,
  heavyEnabled: () => heavySkillAllowed,
  allowlist: () => [],
  runRoot: () => skillRunRoot,
  heavyTimeoutMs: () => 30_000,
  dataRoot: () => skillRunRoot,
})
// The canvas reads the local library beside the host registry: on the Web
// surface a preset owns local discovery, so an unscoped `ctx.skills.list()` sees
// no installed skill at all. The fake above stands in for that empty answer.
canvasSkillRunner.attach({
  registry: host.createSkillRegistryBackend({
    async list() { return skillRegistrySkills },
    async get(name) {
      const found = skillRegistrySkills.find(skill => skill.name === name)
      return found === undefined ? undefined : { name, content: `# ${name}\nDo the thing.` }
    },
  }, { root: () => skillRegistryRoot }),
  agents: {
    available: () => true,
    async create(options) {
      heavyRunsStarted += 1
      return {
        session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'heavy done' }] }] },
        followup() {},
        async whenIdle() {
          // Publish the artifact the way a real skill would: into the run's
          // output directory the runner handed the agent.
          const outputDir = join(options.cwd, 'output')
          mkdirSync(outputDir, { recursive: true })
          writeFileSync(join(outputDir, 'deck.pptx'), Buffer.from('pptx-bytes'))
          // Extra artifacts a check may ask for — used to prove that one
          // unpublishable file does not take the rest of the run down with it.
          for (const [name, bytes] of heavyArtifacts) writeFileSync(join(outputDir, name), bytes)
        },
        cancel() {},
        async dispose() {},
      }
    },
  },
})
/** The skill-library backend the route family sees (kept by name so the config
 *  routes can be exercised with a scripted backend). */
const skillLibraryFake = {
  async list() {
    return await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  },
  async install(request) {
    const installed = []
    const failed = []
    let message
    for (const source of request.sources ?? []) {
      try { installed.push(host.classifySource(source).kind) }
      catch (error) { failed.push({ source, message: String(error.message) }) }
    }
    if (request.asset !== undefined) {
      // The upload route stores into the real canvas store, so read it back
      // the same way the plugin does.
      const found = await host.canvasStore.readAssets([request.asset])
      const blob = found.get(request.asset.assetId)
      if (blob === undefined) message = 'missing upload'
      else {
        try {
          installed.push(await host.installFromArchive(blob.data, skillLibraryRoot, request.name ?? 'skill', request.force === true))
        } catch (error) { message = String(error.message) }
      }
    }
    return {
      ok: installed.length > 0,
      installed,
      failed,
      library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }),
      ...message === undefined ? {} : { message },
    }
  },
  async remove(name) {
    try {
      await host.removeSkill(name, skillLibraryRoot)
      return { ok: true, library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }) }
    } catch (error) {
      return { ok: false, library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }), message: String(error.message) }
    }
  },
}
const routes = host.makeRoutes({
  settings: seam,
  settingsNamespace: 'imagegen',
  // 目录与渠道：模型只剩宿主网关这一个来源。
  gateway: gatewayFake,
  resolveChannels: gatewayChannels,
  // 宿主对话模型：增强 / 润色 / 文案 / 图层拆分都走它。
  chat: chatStub,
  history,
  templates,
  favorites,
  attachments,
  pendingConversationImages,
  skills: canvasSkillRunner,
  skillLibrary: skillLibraryFake,
})
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = routes.find(r => r.kind === 'exact'
    ? r.path === pathname
    : pathname === r.path || pathname.startsWith(`${r.path}/`))
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  route.handler(req, res).catch(error => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const post = async (path, body, headers = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    throw new Error(`HTTP ${response.status} returned non-JSON body: ${text || '<empty>'}`)
  }
}

await check("C0b prompt enhance strips a reasoning model's think blocks", async () => {
  // 提示词增强不再有插件自己的聊天端点：路由问的是宿主对话模型（`chatStub`），
  // 这里量的仍然是同一条不变量——推理过程永远不会进到提示词框里。
  const leak = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'think leak' })
  assert.equal(leak.status, 200)
  assert.equal(leak.body.ok, true)
  assert.equal(leak.body.prompt, 'A lighthouse at dusk over a stormy sea.')
  // 未闭合的 think 标签：它后面的内容全是推理，所以整段都要被丢掉——宁可得到空提示词，
  // 也不能把模型的思考过程交给生图模型。
  const dangling = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'dangling think' })
  assert.equal(dangling.body.ok, true)
  assert.equal(dangling.body.prompt, '', 'a dangling think tag leaves no reasoning text behind')
  // Clean content passes through untouched.
  const clean = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'clean please' })
  assert.equal(clean.body.prompt, 'A calm meadow under morning light.')
  const polished = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'clean please', mode: 'polish' })
  assert.equal(polished.body.ok, true)
  assert.equal(polished.body.prompt, 'A calm meadow under morning light.')
})

await check('C0c canvas layer decomposition parses a fenced vision plan and clamps it', async () => {
  // Unit: the normalizer accepts the documented shape, drops degenerate boxes,
  // clamps rectangles into the frame, orders background first and de-dupes it.
  assert.equal(host.normalizeLayerPlan({ layers: [] }), undefined)
  assert.equal(host.normalizeLayerPlan({ nope: 1 }), undefined)
  assert.equal(host.normalizeLayerPlan({ layers: [{ kind: 'object' }] }), undefined, 'an object layer without a rect is dropped')
  const clamped = host.normalizeLayerPlan({
    layers: [
      { kind: 'text', label: '  title  ', rect: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, text: ' hi ' },
      { kind: 'text', label: 'no text', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    ],
  })
  assert.deepEqual(clamped.layers, [{ kind: 'text', label: 'title', rect: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, text: 'hi' }])
  const ordered = host.normalizeLayerPlan([
    { kind: 'object', label: 'b', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    { kind: 'background', label: 'bg' },
    { kind: 'background', label: 'bg2' },
  ])
  assert.deepEqual(ordered.layers.map(layer => layer.kind), ['background', 'object'])
  assert.equal(ordered.layers[0].rect, undefined, 'the background layer carries no rect')

  // Route: the browser sends one data URL, the host answers with the plan.
  const plan = await post('/api/dsh-imagegen/canvas/layers', { image: `data:image/png;base64,${pngBytes.toString('base64')}` })
  assert.equal(plan.body.ok, true, JSON.stringify(plan.body))
  assert.deepEqual(plan.body.plan.layers.map(layer => layer.kind), ['background', 'object', 'text'])
  assert.equal(plan.body.plan.layers[2].text, '夏日限定')
  assert.equal(plan.body.plan.layers[2].color, '#ffee00', 'hex colors are normalized to lower case')
  assert.deepEqual(plan.body.plan.layers[1].rect, { x: 0.3, y: 0.25, width: 0.3, height: 0.6 })

  const missing = await post('/api/dsh-imagegen/canvas/layers', {})
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'bad-request')
  // 图层拆分也走宿主对话模型：宿主没接入对话模型时，报的是「没有可用的对话模型」，
  // 而不是把一张图静静吞掉或抛一个内部错误。
  await assert.rejects(
    host.analyzeLayers({ available: () => false, label: () => '', complete: async () => '' }, `data:image/png;base64,${pngBytes.toString('base64')}`),
    /需要一个可用的对话模型/,
  )
})

await check('C1 settings describe serves the redacted namespace', async () => {
  const { status, body } = await post('/api/dsh-imagegen/settings/describe', {})
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value.writable, true)
  assert.equal(body.value.namespaces.length, 1)
  const view = body.value.namespaces[0]
  assert.equal(view.ns, 'dsh-imagegen')
  assert.equal(view.value.apiUrl, 'http://upstream/v1')
  assert.equal(view.value.apiKey, undefined)
  assert.deepEqual(view.secrets, [{ path: ['apiKey'], set: false }])
})

await check('C2 settings mutate writes + redacts the key', async () => {
  const { body } = await post('/api/dsh-imagegen/settings/mutate', {
    ns: 'dsh-imagegen',
    ops: [{ op: 'set', path: ['apiKey'], value: 'sk-new' }],
    expectedRevision: 0,
  })
  assert.equal(body.ok, true)
  assert.equal(body.value.secrets.find(s => s.path[0] === 'apiKey').set, true)
  assert.equal(body.value.value.apiKey, undefined)
  assert.equal(stored.get('imagegen').apiKey, 'sk-new')
})

await check('C3 generate route persists history server-side and enforces loopback fence', async () => {
  const { status, body } = await post('/api/dsh-imagegen/generate', {
    mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '4k', n: 1, detail: 'standard',
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.images.length, 2)
  assert.equal(persistedHistory.length, 1, 'history is written before the response reaches the browser')
  assert.equal(persistedHistory[0].prompt, 'a cat')
  assert.equal(persistedHistory[0].images.length, 2)
  assert.equal(body.history.length, 1)
  const missing = await post('/api/dsh-imagegen/generate', { mode: 'text', model: 'gpt-image-2', prompt: '  ', size: 'auto', quality: 'auto', n: 1, detail: '' })
  assert.equal(missing.body.ok, false)
  assert.match(missing.body.message, /prompt is required/)
  // Non-loopback fence: a raw request carrying a foreign Host header must be
  // refused (undici forbids overriding Host on fetch, so go raw).
  const foreignStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/dsh-imagegen/generate',
      method: 'POST',
      headers: { host: 'evil.example.com', 'content-type': 'application/json' },
    }, res => { resolve(res.statusCode) }, reject)
    request.end('{}')
  })
  assert.equal(foreignStatus, 403)
})

await check('C3b diagnostics routes read back and clear the retained attempts (#38)', async () => {
  // The panel reads this route after a failure; the record has to survive the
  // HTTP hop unchanged and stay redacted.
  host.clearDiagnostics()
  const clearedOnce = await post('/api/dsh-imagegen/diagnostics/list', {})
  assert.equal(clearedOnce.body.ok, true)
  assert.equal(clearedOnce.body.entries.length, 0, 'a fresh buffer is empty')

  // Produce a real failed attempt through the engine, then read it back.
  host.recordDiagnostic({
    phase: 'generate',
    channel: 'SmokeChannel',
    model: 'gpt-image-2',
    mode: 'text',
    url: 'https://api.example.test/v1/images/generations',
    method: 'POST',
    status: 404,
    errorCode: 'ENOTFOUND',
    failureCode: 'upstream-rejected',
    message: 'model not found',
    bodyExcerpt: '{"error":"no such route"}',
    durationMs: 42,
    hadAuth: true,
  })
  const listed = await post('/api/dsh-imagegen/diagnostics/list', {})
  assert.equal(listed.body.ok, true)
  assert.equal(listed.body.entries.length, 1)
  const entry = listed.body.entries[0]
  assert.equal(entry.channel, 'SmokeChannel')
  assert.equal(entry.url, 'https://api.example.test/v1/images/generations', 'the URL the engine called reaches the panel')
  assert.equal(entry.status, 404)
  assert.equal(entry.errorCode, 'ENOTFOUND')
  assert.equal(entry.durationMs, 42)
  assert.equal(entry.hadAuth, true, 'the panel learns THAT a key was sent, never the key')

  // A secret must not survive the round trip: the store redacts on record.
  host.recordDiagnostic({
    phase: 'generate',
    channel: 'SmokeChannel',
    model: 'gpt-image-2',
    mode: 'text',
    url: 'https://api.example.test/v1/images/generations',
    method: 'POST',
    failureCode: 'upstream-unreachable',
    message: 'failed with Authorization: Bearer {{API_KEY_2iip3dvh}}',
    bodyExcerpt: '{"apiKey":"{{API_KEY_2iip3dvh}}"}',
    durationMs: 1,
    hadAuth: true,
  })
  const withSecret = await post('/api/dsh-imagegen/diagnostics/list', {})
  const serialized = JSON.stringify(withSecret.body)
  assert.equal(serialized.includes('{{API_KEY_2iip3dvh}}'), false, 'no credential survives to the client')
  assert.match(serialized, /<redacted/, 'the redaction marker is present instead')

  const cleared = await post('/api/dsh-imagegen/diagnostics/clear', {})
  assert.equal(cleared.body.ok, true)
  const afterClear = await post('/api/dsh-imagegen/diagnostics/list', {})
  assert.equal(afterClear.body.entries.length, 0, 'the Clear action empties the record')
})

await check('C3c signal routes record, report, draft an issue and clear (L0)', async () => {
  // The report panel talks to the host over HTTP, so the contract that matters
  // is the one the browser sees: what it may send, what comes back, and that a
  // prompt's text never appears in either direction.
  await post('/api/dsh-imagegen/signals/clear', {})
  const empty = await post('/api/dsh-imagegen/signals/report', {})
  assert.equal(empty.body.ok, true)
  assert.equal(empty.body.report.total, 0, 'a fresh ledger reports nothing rather than guessing')
  assert.equal(empty.body.report.buckets.length, 0)

  // An unknown kind is answered, not thrown: an older bundle talking to a newer
  // host has to learn that, and it learns it from this code.
  const bad = await post('/api/dsh-imagegen/signals/record', { kind: 'not-a-kind' })
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.code, 'bad-signal')

  const secretPrompt = 'SMOKE-SIGNAL-SECRET 一只猫在打字'
  const recorded = await post('/api/dsh-imagegen/signals/record', {
    kind: 'retry',
    pipeline: 'image',
    model: 'gpt-image-2',
    channel: 'SmokeChannel',
    mode: 'text',
    prompt: secretPrompt,
    source: 'auto',
  })
  assert.equal(recorded.body.ok, true)
  assert.match(recorded.body.entry.id, /^sig-/)
  assert.equal(recorded.body.entry.prompt, undefined, 'the browser is not handed back a prompt field to persist')

  // Fill one bucket past MIN_SAMPLE so the report has something to judge, and
  // keep one deliberate failure row so the failure rate is non-zero.
  for (let index = 0; index < 25; index += 1) {
    await post('/api/dsh-imagegen/signals/record', {
      kind: 'retry',
      pipeline: 'image',
      model: 'gpt-image-2',
      channel: 'SmokeChannel',
      mode: 'text',
      prompt: secretPrompt,
      source: 'auto',
    })
  }
  const report = await post('/api/dsh-imagegen/signals/report', { windowDays: 90 })
  assert.equal(report.body.ok, true)
  assert.ok(report.body.report.total >= 26)
  const bucket = report.body.report.buckets[0]
  assert.equal(bucket.mode, 'text')
  assert.equal(bucket.verdict, 'warn', 'a bucket of nothing but retries is a warning, not a pass')
  assert.ok(bucket.retryRate > 0.5)
  assert.equal(Object.hasOwn(bucket, 'score'), false, 'the report never publishes a single combined number')

  // The privacy red line, checked on the wire rather than in the store: this is
  // the exact shape that would end up pasted into a public issue.
  const listed = await post('/api/dsh-imagegen/signals/list', {})
  assert.equal(listed.body.ok, true)
  assert.equal(JSON.stringify(listed.body).includes('SMOKE-SIGNAL-SECRET'), false, 'no prompt text reaches the client')

  const draft = await post('/api/dsh-imagegen/signals/export', {})
  assert.equal(draft.body.ok, true)
  assert.equal(draft.body.markdown.includes('SMOKE-SIGNAL-SECRET'), false, 'the issue draft carries aggregates only')
  // Nothing is submitted by the host and nothing points at a repository: the
  // draft is markdown the user copies, reviews and files themselves.
  assert.ok(draft.body.title.length > 0)
  assert.equal(Object.hasOwn(draft.body, 'url'), false, 'the draft carries no upstream repository link')

  // The window is clamped to a range the report can defend (1..365 days), and
  // the clamp is echoed back so the panel's label always matches the numbers.
  const clampedLow = await post('/api/dsh-imagegen/signals/report', { windowDays: 0 })
  assert.equal(clampedLow.body.report.windowDays, 1)
  const clampedHigh = await post('/api/dsh-imagegen/signals/report', { windowDays: 9999 })
  assert.equal(clampedHigh.body.report.windowDays, 365)

  const cleared = await post('/api/dsh-imagegen/signals/clear', {})
  assert.equal(cleared.body.ok, true)
  const afterClear = await post('/api/dsh-imagegen/signals/report', {})
  assert.equal(afterClear.body.report.total, 0, 'Clear empties the ledger')
})

await check('C3d retry and delete reach the ledger without any client help (L0)', async () => {
  // The point of collecting these host-side: the browser never sends a signal
  // for a retry or a delete, so this check drives ONLY the routes the studio
  // already called and then reads the ledger. If the wiring is ever moved to
  // the client, this test stops seeing the entries and fails.
  await post('/api/dsh-imagegen/signals/clear', {})

  const retryPrompt = 'SMOKE-RETRY-PROMPT a lighthouse at dusk'
  const submitted = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'text', model: 'gpt-image-2', prompt: retryPrompt, size: '1:1', quality: '4k', n: 1, detail: 'standard',
  })
  assert.equal(submitted.body.ok, true, JSON.stringify(submitted.body))
  // A retry is the user saying "not this one" without typing anything. It is
  // recorded from the task the queue still holds, so it needs no round trip to
  // the browser at all.
  const retried = await post('/api/dsh-imagegen/tasks/retry', { id: submitted.body.task.id })
  assert.equal(retried.body.ok, true, 'the retry itself still works')

  // Signal writes are fire-and-forget so a slow disk can never delay the
  // user's action; poll instead of assuming the write already landed.
  const signalOf = async (kind) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const listed = await post('/api/dsh-imagegen/signals/list', {})
      const found = listed.body.entries.find(entry => entry.kind === kind)
      if (found !== undefined) return { entry: found, listed }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return { entry: undefined, listed: await post('/api/dsh-imagegen/signals/list', {}) }
  }

  const afterRetry = await signalOf('retry')
  const retryEntry = afterRetry.entry
  assert.ok(retryEntry !== undefined, 'pressing retry leaves a signal with no client involvement')
  assert.equal(retryEntry.pipeline, 'image')
  assert.equal(retryEntry.model, 'gpt-image-2')
  assert.equal(retryEntry.mode, 'text')
  assert.equal(retryEntry.source, 'auto', 'the user did not type this: it is inferred from their action')
  assert.equal(retryEntry.promptBucket, 'short', 'the prompt is reduced to its length class')
  assert.equal(JSON.stringify(afterRetry.listed.body).includes('lighthouse'), false, 'the prompt text never leaves the host')

  // Deleting a generation is a stronger statement than retrying: the user does
  // not want the result kept. The entry is looked up BEFORE the removal, which
  // is the only moment its model is still known.
  const historyId = 'smoke-signal-history-1'
  const appended = await post('/api/dsh-imagegen/history/append', {
    entry: {
      id: historyId, createdAt: Date.now(), mode: 'text', model: 'gpt-image-2',
      prompt: 'SMOKE-DELETE-PROMPT a red bicycle', size: '1:1', quality: '4k', detail: 'standard', n: 1,
      images: [{ b64: pngBytes.toString('base64'), mime: 'image/png' }],
    },
  })
  assert.equal(appended.body.ok, true, JSON.stringify(appended.body))
  const removed = await post('/api/dsh-imagegen/history/remove', { id: historyId })
  assert.equal(removed.body.ok, true, 'the delete itself still works')

  const afterDelete = await signalOf('delete')
  const deleteEntry = afterDelete.entry
  assert.ok(deleteEntry !== undefined, 'deleting a generation leaves a signal')
  assert.equal(deleteEntry.pipeline, 'image')
  assert.equal(deleteEntry.model, 'gpt-image-2')
  assert.equal(deleteEntry.mode, 'text')
  assert.equal(deleteEntry.hasReference, false, 'this entry had no reference image')
  assert.equal(JSON.stringify(afterDelete.listed.body).includes('bicycle'), false, 'the deleted prompt is not retained either')

  // And the two rates feed the report the panel renders.
  const summary = await post('/api/dsh-imagegen/signals/report', { windowDays: 90 })
  assert.equal(summary.body.ok, true)
  assert.equal(summary.body.report.byKind.retry, 1)
  assert.equal(summary.body.report.byKind.delete, 1)

  await post('/api/dsh-imagegen/signals/clear', {})
})

await check('C3e a failed generation leaves a failure signal with its code (L0)', async () => {
  // The third signal the plugin infers on its own. A failure is the most
  // specific evidence a user can produce — they neither retried nor deleted;
  // the provider refused. The report needs the failure CODE, because "it broke"
  // is not actionable and "upstream-rejected at 413" is.
  await post('/api/dsh-imagegen/signals/clear', {})
  const refusing = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream maintenance' } }))
  })
  await new Promise(resolve => refusing.listen(0, '127.0.0.1', resolve))
  const refusingPort = refusing.address().port
  try {
    await assert.rejects(
      host.generateImage(
        { apiUrl: `http://127.0.0.1:${refusingPort}/v1`, apiKey: 'k', channelName: 'SignalChannel' },
        { mode: 'text', model: 'gpt-image-2', prompt: 'SMOKE-FAILURE-PROMPT a broken road', size: 'auto', quality: 'auto', n: 1, detail: '' },
      ),
    )
  } finally {
    await new Promise(resolve => refusing.close(resolve))
  }

  let failure
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const listed = await post('/api/dsh-imagegen/signals/list', {})
    failure = listed.body.entries.find(entry => entry.kind === 'failure')
    if (failure !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(failure !== undefined, 'a refused generation leaves a failure signal without client help')
  assert.equal(failure.pipeline, 'image')
  assert.equal(failure.model, 'gpt-image-2')
  assert.equal(failure.channel, 'SignalChannel')
  assert.equal(failure.failureCode, 'upstream-rejected', 'the code, not the prose, is what a later fix can group by')
  assert.equal(failure.source, 'auto')

  const report = await post('/api/dsh-imagegen/signals/report', { windowDays: 90 })
  assert.equal(report.body.ok, true)
  assert.equal(report.body.report.byKind.failure, 1)
  // A single failure is below MIN_SAMPLE, so it must produce no verdict: one
  // bad afternoon is not a pattern, and saying otherwise is how a report loses
  // its readers.
  const bucket = report.body.report.buckets[0]
  assert.equal(bucket.verdict, 'unknown')
  assert.equal(report.body.report.findings.filter(finding => finding.severity !== 'info').length, 0)

  await post('/api/dsh-imagegen/signals/clear', {})
})

await check('C4 comparison tasks run in parallel and share comparison history metadata', async () => {
  const comparisonId = 'smoke-comparison'
  const request = { mode: 'text', model: 'gpt-image-2', prompt: 'parallel one', size: '1:1', quality: '4k', n: 1, detail: 'standard', comparisonId, comparisonModels: ['gpt-image-2', 'minimax-h3-image'] }
  const first = await post('/api/dsh-imagegen/tasks/submit', request)
  const second = await post('/api/dsh-imagegen/tasks/submit', { ...request, model: 'minimax-h3-image', prompt: 'parallel two' })
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await post('/api/dsh-imagegen/tasks/list', {})
    const ids = [first.body.task.id, second.body.task.id]
    if (ids.every(id => listed.body.tasks.find(task => task.id === id)?.status === 'completed')) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(maxGenerationRequests >= 2, 'comparison requests must overlap at the upstream')
  const comparisonEntries = persistedHistory.filter(entry => entry.comparisonId === comparisonId)
  assert.equal(comparisonEntries.length, 2)
  assert.deepEqual(comparisonEntries[0].comparisonModels, ['gpt-image-2', 'minimax-h3-image'])
})

await check('C4b task polling stays lightweight and hydrates completed results on demand', async () => {
  const image = `data:image/png;base64,${pngBytes.toString('base64')}`
  const submitted = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'edit', model: 'gpt-image-2', prompt: 'edit this lightweight task payload', size: '3:2', quality: '4k', n: 1, detail: '',
    image, refName: 'reference.png', workflow: 'replica',
  })
  assert.equal(submitted.body.ok, true, JSON.stringify(submitted.body))
  let summary
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await post('/api/dsh-imagegen/tasks/list', {})
    summary = listed.body.tasks.find(task => task.id === submitted.body.task.id)
    if (summary?.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(summary?.status, 'completed')
  assert.equal(summary.result, undefined)
  assert.equal(summary.resultAvailable, true)
  assert.equal(summary.request.workflow, 'replica', 'the host preserves replica provenance in lightweight polls')
  assert.equal(summary.request.image, undefined)
  assert.equal(summary.request.images, undefined)

  const hydrated = await post('/api/dsh-imagegen/tasks/get', { id: submitted.body.task.id })
  assert.equal(hydrated.body.ok, true)
  assert.equal(hydrated.body.task.request.workflow, 'replica')
  assert.equal(hydrated.body.task.request.image, image)
  assert.ok(hydrated.body.task.result.images.length > 0)
  assert.ok(
    persistedHistory.some(entry => entry.prompt === 'edit this lightweight task payload' && entry.workflow === 'replica'),
    'history accepts replica provenance instead of rejecting its persisted result',
  )
  const missing = await post('/api/dsh-imagegen/tasks/get', { id: 'missing-task' })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'not-found')
})
await check('C5 an unknown model is refused and the refusal lists what this account has', async () => {
  const rejected = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'text', model: 'not-configured', prompt: 'a cat', size: 'auto', quality: 'auto', n: 1, detail: '',
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'image-model-not-configured')
})

await check('C6 template routes are source-scoped, refresh per source, and proxy only known images', async () => {
  const { body: list } = await post('/api/dsh-imagegen/templates/list', { source: 'vibeui' })
  assert.equal(list.ok, true)
  assert.equal(list.sourceId, 'vibeui')
  assert.equal(list.total, 1)
  assert.equal(list.cases[0].prompt, 'Create a bright product poster')

  const { body: refreshed } = await post('/api/dsh-imagegen/templates/refresh', { source: 'vibeui' })
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.sourceId, 'vibeui')
  assert.equal(refreshed.total, 1)
  assert.equal(templateRefreshes, 1)

  // Unknown sources are rejected before the backend is touched.
  const badSource = await post('/api/dsh-imagegen/templates/list', { source: 'nope' })
  assert.equal(badSource.body.ok, false)
  assert.equal(badSource.body.code, 'templates-source-unknown')
  assert.equal(templateRefreshes, 1)

  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/case1.png`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), templateImage)
  const unknown = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/not-allowed.png`)
  assert.equal(unknown.status, 404)
  // Legacy single-segment image paths are gone: the source id is required.
  const legacy = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/case1.png`)
  assert.equal(legacy.status, 404)
  const badPool = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/canghe/case1.png`)
  assert.equal(badPool.status, 404)
})

await check('C6a2 URL-type template image references reach the backend', async () => {
  // issue #29: the encoded https:// inside the ref decodes to empty path
  // segments; the route must hand the full URL to the template store (which
  // enforces the host whitelist) instead of 404ing before it is ever called.
  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/itgoyo/${encodeURIComponent(templateUrlRef)}`)
  assert.equal(image.status, 200)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), templateImage)

  // A legal URL beyond the old 400-char composite cap still resolves.
  const longLegal = `https://raw.githubusercontent.com/${'a'.repeat(500)}.png`
  const longOk = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/itgoyo/${encodeURIComponent(longLegal)}`)
  assert.equal(longOk.status, 200)

  // Traversal stays refused even inside a URL-shaped ref.
  const traversal = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/itgoyo/${encodeURIComponent('https://raw.githubusercontent.com/a/../b.png')}`)
  assert.equal(traversal.status, 404)

  // Beyond the store's 4000-char URL limit the composite path is refused.
  const tooLong = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/itgoyo/${encodeURIComponent(`https://raw.githubusercontent.com/${'a'.repeat(4100)}.png`)}`)
  assert.equal(tooLong.status, 404)

  // Bare names keep the strict rules: empty segments and >400 chars refuse.
  const emptySegment = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/${encodeURIComponent('case//1.png')}`)
  assert.equal(emptySegment.status, 404)
  const longName = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/${'a'.repeat(401)}.png`)
  assert.equal(longName.status, 404)

  // The relaxation is template-only: a URL-shaped ref on the history image
  // route still dies in path validation, before the backend is touched.
  const before = historyImageReads
  const historyUrl = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/history/image/${encodeURIComponent(templateUrlRef)}`)
  assert.equal(historyUrl.status, 404)
  assert.equal(historyImageReads, before)
})

await check('C6b template favorites persist host-side and round-trip', async () => {
  const empty = await post('/api/dsh-imagegen/templates/favorites/list', {})
  assert.equal(empty.body.ok, true)
  assert.deepEqual(empty.body.favorites, [])

  const item = {
    id: 1,
    title: 'Poster template',
    prompt: 'Create a bright product poster',
    category: 'Posters & Typography',
    categoryZh: '海报与排版',
    styles: [],
    scenes: [],
    sourceLabel: '@author',
    sourceUrl: 'https://example.test/author',
    githubUrl: 'https://example.test/repo#1',
    image: 'case1.png',
    featured: true,
  }
  const added = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'vibeui', case: item })
  assert.equal(added.body.ok, true)
  assert.equal(added.body.favorites.length, 1)
  assert.equal(added.body.favorites[0].key, 'vibeui:1')
  assert.equal(added.body.favorites[0].case.prompt, item.prompt)

  const invalid = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'nope', case: item })
  assert.equal(invalid.body.ok, false)

  const relisted = await post('/api/dsh-imagegen/templates/favorites/list', {})
  assert.equal(relisted.body.favorites.length, 1)

  const removed = await post('/api/dsh-imagegen/templates/favorites/remove', { key: 'vibeui:1' })
  assert.equal(removed.body.ok, true)
  assert.deepEqual(removed.body.favorites, [])

  const stringItem = { ...item, id: 's-001', title: 'Hand-drawn template' }
  const stringAdded = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'handraw', case: stringItem })
  assert.equal(stringAdded.body.ok, true)
  assert.equal(stringAdded.body.favorites[0].key, 'handraw:s-001')
  await post('/api/dsh-imagegen/templates/favorites/remove', { key: 'handraw:s-001' })
})

await check('C6c template sample route draws random inspiration picks', async () => {
  const { body } = await post('/api/dsh-imagegen/templates/sample', { count: 9 })
  assert.equal(body.ok, true)
  assert.equal(body.samples.length, 1)
  assert.equal(body.samples[0].sourceId, 'vibeui')
  assert.equal(body.samples[0].case.prompt, 'Create a bright product poster')
  assert.deepEqual(templateSamples, [9])
})

await check('C6c2 bundled community template snapshots expose stable ids and images', async () => {
  const expected = {
    handraw: { total: 441, first: 's-001' },
    'prompt-signal': { total: 577, first: 'raw-subway' },
    // evolink used to hold 462: its case numbers repeat across — and inside —
    // the upstream category files, so keying by number alone discarded most of
    // the corpus. The ids are now category-scoped, and the snapshot carries
    // every case whose prompt parsed.
    evolink: { total: 967, first: 'ecommerce-1' },
    itgoyo: { total: 602, first: 't-001' },
    songtianlun: { total: 55, first: 'nb2-magazine-cover' },
    // youart publishes no images of its own — only each author's post — so its
    // cards are prompt-only by design and this source is exempt from the image
    // assertion below.
    youart: { total: 150, first: '16-panel-female-dance-pose-sheet' },
  }
  for (const [sourceId, meta] of Object.entries(expected)) {
    const list = await host.listTemplates(sourceId)
    assert.equal(list.sourceId, sourceId)
    assert.equal(list.total, meta.total)
    assert.equal(list.cases[0].id, meta.first)
    if (sourceId === 'youart') {
      assert.equal(list.cases[0].image, '', 'youart cases carry no image by design')
      assert.match(list.cases[0].sourceUrl, /^https:\/\/x\.com\//, 'the author post is the attribution')
      continue
    }
    assert.match(list.cases[0].image, /^https:\/\//)
  }
})

await check('C6c3 every bundled snapshot keeps its ids unique', async () => {
  // A snapshot whose ids collide silently loses cases: templates-store keys
  // favourites by `source:id`, and the gallery keys cards by id, so duplicates
  // render as one card and overwrite each other's favourite. The host half of
  // this contract lives in verify-ui-contracts.mjs, where it can read the real
  // `allowedImageHosts` out of SOURCE_DEFS instead of a copy of that list.
  //
  // Two image shapes are legal and they are served differently: a bare file
  // name goes through the source's `imageBaseUrl` (vibeui / canghe), anything
  // else must be an absolute http(s) URL with no credentials. youart is absent
  // because it publishes no images at all.
  for (const sourceId of ['vibeui', 'canghe', 'handraw', 'prompt-signal', 'evolink', 'itgoyo', 'songtianlun']) {
    const list = await host.listTemplates(sourceId)
    assert.ok(list.total > 0, `${sourceId} must not be empty`)
    const ids = list.cases.map(entry => entry.id)
    assert.equal(new Set(ids).size, ids.length, `${sourceId} has duplicate case ids`)
    for (const entry of list.cases) {
      if (entry.image === '') continue
      const bareName = /^[\w.-]+\.(jpg|jpeg|png|webp|gif)$/i.test(entry.image)
      // Parsed, not pattern-matched: jsdelivr's pinned URLs carry an `@commit`
      // in the path, so treating a bare `@` as userinfo rejected the handraw
      // snapshot outright. What actually matters is that the URL has no
      // credentials, which only the parser can tell.
      let absolute = false
      if (/^https?:\/\//i.test(entry.image)) {
        try {
          const url = new URL(entry.image)
          absolute = url.username === '' && url.password === '' && url.hostname !== ''
        } catch { absolute = false }
      }
      assert.ok(
        bareName || absolute,
        `${sourceId} case ${entry.id} carries an image reference this store cannot serve: ${entry.image}`,
      )
    }
  }
})


await check('C6c4 PPT routes validate the request and rebuild asset URLs host-side', async () => {
  // The client sends asset ids only; the URL is rebuilt on the host so a caller
  // cannot point the conversion at an arbitrary address. Both halves are
  // asserted: the malformed inputs are refused, and a well-formed one produces
  // a URL on this host's asset route rather than the one it was handed.
  const tooMany = await post('/api/dsh-imagegen/ppt/run', {
    images: Array.from({ length: 13 }, (_, i) => ({ assetId: `a${i}` })),
    offlineOcr: true,
  })
  assert.equal(tooMany.body.ok, false, '13 images must be refused')
  assert.equal(tooMany.body.code, 'bad-request', JSON.stringify(tooMany.body))

  const none = await post('/api/dsh-imagegen/ppt/run', { images: [], offlineOcr: true })
  assert.equal(none.body.code, 'bad-request', 'zero images must be refused')

  const badId = await post('/api/dsh-imagegen/ppt/run', {
    images: [{ assetId: '../etc/passwd' }],
    offlineOcr: true,
  })
  assert.equal(badId.body.code, 'bad-request', 'an asset id with path syntax must be refused')

  const missingOcr = await post('/api/dsh-imagegen/ppt/run', { images: [{ assetId: 'ok-1' }] })
  assert.equal(missingOcr.body.code, 'bad-request', 'offlineOcr is required, not defaulted')

  // Without a usable editppt setup the route must say what is missing instead
  // of starting a run that cannot finish. Two refusals are legitimate here —
  // the runtime is not installed, or the skill itself is not — so the assertion
  // is "refused, with a reason naming what to fix", not one exact message.
  const run = await post('/api/dsh-imagegen/ppt/run', { images: [{ assetId: 'ok-1' }], offlineOcr: true })
  assert.equal(run.body.ok, false, JSON.stringify(run.body))
  assert.match(String(run.body.message), /PPT runtime|editppt|image-to-editable-ppt|技能/i, JSON.stringify(run.body))

  const runtime = await post('/api/dsh-imagegen/ppt/runtime', {})
  assert.equal(typeof runtime.body.ok, 'boolean', JSON.stringify(runtime.body))

  // The task list is served whenever the host mounted the skill registry, which
  // this suite does. An empty list is the correct answer here — what must hold
  // is that the route answers with tasks rather than failing.
  const tasks = await post('/api/dsh-imagegen/ppt/tasks', {})
  assert.equal(tasks.body.ok, true, JSON.stringify(tasks.body))
  assert.ok(Array.isArray(tasks.body.tasks), 'the task list is always an array')
})

await check('C6d data-folder route resolves the host directory (no spawn in tests)', async () => {
  const { body } = await post('/api/dsh-imagegen/data-folder/open', { open: false })
  assert.equal(body.ok, true)
  // Assert the property that actually matters: the route resolves the SAME data
  // root the stores use. This suite points DSH_HOME at a temp directory, so the
  // old `includes('.dsh')` assertion only passed because the route hardcoded
  // `~/.dsh/dsh-imagegen` — it certified the bug, not the behaviour. Anything
  // that pins the literal home path would pass here while ignoring DSH_HOME and
  // a custom localStoragePath, which is exactly the defect being guarded.
  const dataRoot = process.env.DSH_HOME
  assert.ok(dataRoot !== undefined && dataRoot !== '', 'this suite must set DSH_HOME')
  assert.ok(
    String(body.path).startsWith(dataRoot),
    `resolved path stays under DSH_HOME (got ${String(body.path)}, DSH_HOME=${dataRoot})`,
  )
  assert.ok(String(body.path).endsWith('dsh-imagegen'), 'resolved path is the dsh-imagegen data dir')
})

await check('C7 Agent tool-result image route serves durable attachments without a session-log image reference', async () => {
  const query = new URLSearchParams({
    attachment_id: agentPreviewRef.attachmentId,
    media_type: agentPreviewRef.mediaType,
    bytes: String(agentPreviewRef.bytes),
    width: String(agentPreviewRef.width),
    height: String(agentPreviewRef.height),
  })
  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?${query}`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), agentPreviewImage)
  const invalid = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?attachment_id=bad`)
  assert.equal(invalid.status, 400)
})

await check('C8 composer images can be staged for the direct edit_image command', async () => {
  const staged = await post('/api/dsh-imagegen/conversation-image', {
    sessionId: 'session-staged',
    dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
    name: 'staged.png',
  })
  assert.equal(staged.body.ok, true)
  assert.equal(pendingConversationImages.has('session-staged'), true)
  assert.equal(pendingConversationImages.get('session-staged').mediaType, 'image/png')
})

await check('C10 canvas file upload accepts arbitrary bytes and serves them as an attachment', async () => {
  const bytes = Buffer.from('name,role\nalice,admin\n', 'utf8')
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=people.csv`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: bytes,
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.equal(body.asset.kind, 'file')
  assert.equal(body.asset.name, 'people.csv')
  assert.equal(body.asset.bytes, bytes.length)
  assert.equal(body.asset.mime, 'text/csv')
  assert.match(body.asset.url, /^\/api\/dsh-imagegen\/canvas\/asset\/[a-f0-9]{64}\.csv$/)

  // Non-image assets download rather than render inline.
  const served = await fetch(`http://127.0.0.1:${port}${body.asset.url}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'application/octet-stream')
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
  assert.match(served.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal(await served.text(), bytes.toString('utf8'))
})

await check('C10b canvas file upload refuses executable extensions with an actionable message', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=payload.exe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('MZ'),
  })
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(String(body.message), /不支持|not supported|\.exe/i)

  // Uploads carry no byte limit inside the raw-body reader other than the cap:
  // a name that sanitizes to nothing still lands under a safe fallback.
  const odd = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=${encodeURIComponent('../..\\evil.txt')}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('ok'),
  })
  const oddBody = await odd.json()
  assert.equal(oddBody.ok, true, JSON.stringify(oddBody))
  assert.equal(oddBody.asset.name.includes('/'), false)
  assert.equal(oddBody.asset.name.includes('\\'), false)
})

await check('C10c a file node round-trips through canvas save with its asset intact', async () => {
  const asset = recordCanvasFile(Buffer.from('报告正文\n', 'utf8'), 'text/plain', 'report.txt')
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'files' })
  const document = created.body.document
  assert.equal(document.background, 'lines', 'new canvases default to the lightweight grid background')
  const fileNode = {
    id: 'node-file-1',
    type: 'file',
    title: 'report.txt',
    x: 40,
    y: 60,
    width: 300,
    height: 170,
    metadata: { asset, fileKind: 'text' },
  }
  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, nodes: [...document.nodes, fileNode] },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
  const storedNode = saved.body.document.nodes.find(node => node.id === 'node-file-1')
  assert.equal(storedNode.type, 'file')
  assert.equal(storedNode.metadata.asset.assetId, asset.assetId)
  assert.equal(storedNode.metadata.fileKind, 'text')
})

await check('C10c3 a video node round-trips through canvas save (every CanvasNodeType must)', async () => {
  // WHY this exists: the canvas node guard used to accept only image/text/file/
  // config, while `CanvasNodeType` (protocol.ts) also declares 'video'. That
  // mismatch did not reject a document — it made every canvas holding a video
  // node UNSAVABLE ('malformed canvas document'). No suite caught it because
  // the canvas-video suite answers /canvas/save with a stub that records the
  // payload, so the real guard never ran on a video node. This check goes
  // through the real route and the real store, like C10c does for file nodes.
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'video nodes' })
  const document = created.body.document

  // The three states a video node legitimately has: a finished clip, one still
  // rendering, and one that failed. Only the reference is validated, and its
  // absence must not make the document malformed.
  const nodes = [
    {
      id: 'node-video-clip', type: 'video', title: '视频节点', x: 40, y: 40, width: 240, height: 240,
      metadata: { status: 'success', videoMode: 'text', video: { url: '/api/dsh-imagegen/video/file/clip.mp4', mime: 'video/mp4', duration: 5, bytes: 1024, entryId: 'entry-1' } },
    },
    {
      id: 'node-video-rendering', type: 'video', title: '视频节点', x: 40, y: 340, width: 240, height: 240,
      metadata: { status: 'generating', taskId: 'vt-1', prompt: 'still rendering', model: 'agnes-video-2.5-flash', videoMode: 'text' },
    },
    {
      id: 'node-video-failed', type: 'video', title: '视频节点', x: 340, y: 40, width: 240, height: 240,
      metadata: { status: 'error', error: '上游拒绝了这个请求', videoMode: 'image' },
    },
  ]
  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, nodes: [...document.nodes, ...nodes] },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, `a canvas with video nodes must save: ${JSON.stringify(saved.body)}`)
  const stored = saved.body.document.nodes.filter(node => node.type === 'video')
  assert.equal(stored.length, 3, 'all three video nodes survive the save')
  const clip = stored.find(node => node.id === 'node-video-clip')
  assert.equal(clip.metadata.video.url, '/api/dsh-imagegen/video/file/clip.mp4')
  assert.equal(clip.metadata.video.entryId, 'entry-1')
  assert.equal(clip.metadata.videoMode, 'text')

  // Read it back through the list route too: the guard runs on the way in AND
  // on the way out, and a node that only survived one direction is still broken.
  const reopened = await post('/api/dsh-imagegen/canvas/read', { id: document.id })
  assert.equal(reopened.body.ok, true)
  assert.equal(
    reopened.body.document.nodes.filter(node => node.type === 'video').length, 3,
    'the video nodes are still there when the canvas is reopened',
  )
})

await check('C10c4 a poster recipe round-trips, and a broken one is refused', async () => {
  // The poster editor (ported from upstream v1.7.0) writes its layer recipe into
  // `metadata.poster`. The recipe is host-validated rather than trusted, because
  // it comes back from the browser and drives a canvas the host then paints.
  // Without this check the guard's two directions are unproven: a valid recipe
  // could be rejected (posters never save) and an invalid one accepted (a
  // document that fails to render, or renders something the user never drew).
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'poster recipe' })
  const document = created.body.document
  // The recipe may only point at immutable host canvas assets: a content-hashed
  // id, the host's own asset URL, a whitelisted image MIME. That rule is why a
  // recipe can be replayed later without the image changing under it.
  const assetId = `${'a'.repeat(64)}.png`
  const asset = { assetId, url: `/api/dsh-imagegen/canvas/asset/${assetId}`, mime: 'image/png', width: 1200, height: 1600, bytes: 2048 }
  const poster = {
    version: 1,
    width: 1200,
    height: 1600,
    background: asset,
    layers: [
      {
        id: 'layer-text', type: 'text', x: 80, y: 120, width: 900,
        text: '秋季新品', fontSize: 128, fontFamily: 'sans-serif', color: '#111111', bold: true, align: 'left',
      },
      { id: 'layer-logo', type: 'image', x: 980, y: 60, width: 160, height: 160, asset },
    ],
  }
  const node = { id: 'node-poster', type: 'image', title: '海报成品', x: 40, y: 40, width: 300, height: 400, metadata: { status: 'success', asset, poster } }

  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, nodes: [...document.nodes, node] },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, `a canvas with a poster recipe must save: ${JSON.stringify(saved.body)}`)
  const stored = saved.body.document.nodes.find(candidate => candidate.id === 'node-poster')
  assert.equal(stored.metadata.poster.layers.length, 2, 'both layers survive the round trip')
  assert.equal(stored.metadata.poster.layers[0].type, 'text')
  assert.equal(stored.metadata.poster.width, 1200)

  const reopened = await post('/api/dsh-imagegen/canvas/read', { id: document.id })
  assert.equal(reopened.body.document.nodes.find(candidate => candidate.id === 'node-poster').metadata.poster.layers.length, 2,
    'the recipe is intact when the canvas is read back')

  // Two refusals, both of which would otherwise corrupt a stored poster: a
  // recipe with no layers array (the renderer iterates it), and one pointing at
  // a remote URL instead of a host asset (it would break the moment the remote
  // file moves, and the host never agreed to fetch it).
  const broken = await post('/api/dsh-imagegen/canvas/save', {
    document: {
      ...reopened.body.document,
      nodes: [{ ...node, metadata: { ...node.metadata, poster: { version: 1, width: 1200, height: 1600, background: asset } } }],
    },
    expectedRevision: reopened.body.document.revision,
  })
  assert.equal(broken.body.ok, false, `a recipe without layers must be refused: ${JSON.stringify(broken.body)}`)
  const remote = await post('/api/dsh-imagegen/canvas/save', {
    document: {
      ...reopened.body.document,
      nodes: [{
        ...node,
        metadata: {
          ...node.metadata,
          poster: { ...poster, background: { ...asset, url: 'https://example.com/elsewhere.png' } },
        },
      }],
    },
    expectedRevision: reopened.body.document.revision,
  })
  assert.equal(remote.body.ok, false, `a recipe pointing off-host must be refused: ${JSON.stringify(remote.body)}`)

  // The whole guard, not just two of its edges: each entry below is a recipe the
  // renderer would either crash on or draw something the user never made, so a
  // save that accepts one of them corrupts a stored poster instead of failing.
  const unchanged = { id: 'legacy-image', type: 'image', title: '旧节点', x: 0, y: 0, width: 240, height: 240, metadata: { asset, status: 'success' } }
  const withLegacy = { ...reopened.body.document, nodes: [unchanged, node] }
  const baseline = await post('/api/dsh-imagegen/canvas/save', { document: withLegacy, expectedRevision: reopened.body.document.revision })
  assert.equal(baseline.body.ok, true, `a legacy image node beside a poster still saves: ${JSON.stringify(baseline.body)}`)
  assert.deepEqual(baseline.body.document.nodes[0], unchanged, 'a recipe never rewrites the plain image node beside it')
  const revision = baseline.body.document.revision
  const layer = poster.layers[0]
  for (const [label, broken] of [
    ['width 0', { ...poster, width: 0 }],
    ['height past the cap', { ...poster, height: 999999 }],
    ['null font size', { ...poster, layers: [{ ...layer, fontSize: null }] }],
    ['4001-character text', { ...poster, layers: [{ ...layer, text: 'x'.repeat(4001) }] }],
    ['a remote image layer', { ...poster, layers: [{ ...poster.layers[1], asset: { ...asset, url: 'https://example.test/logo.png' } }] }],
    ['41 layers', { ...poster, layers: Array.from({ length: 41 }, (_, index) => ({ ...layer, id: `text-${index}` })) }],
  ]) {
    const result = await post('/api/dsh-imagegen/canvas/save', {
      document: { ...withLegacy, nodes: [unchanged, { ...node, metadata: { ...node.metadata, poster: broken } }] },
      expectedRevision: revision,
    })
    assert.equal(result.body.ok, false, `a recipe with ${label} must be refused: ${JSON.stringify(result.body)}`)
  }
  // None of those refusals may have replaced the document that is on disk.
  const afterRefusals = await post('/api/dsh-imagegen/canvas/read', { id: document.id })
  assert.deepEqual(afterRefusals.body.document.nodes.find(candidate => candidate.id === 'legacy-image'), unchanged)
  assert.deepEqual(
    afterRefusals.body.document.nodes.find(candidate => candidate.id === node.id).metadata.poster,
    poster,
    'an invalid save leaves the stored recipe intact',
  )
})

await check('C10c5 deleting a canvas keeps the assets a poster recipe still points at', async () => {
  // `sweepAssets` collects references from the node graph, and a poster node
  // only *carries* the flattened composite in `metadata.asset`. Its background
  // and its logo layers live in `metadata.poster`, which no node points at
  // directly -- yet the editor re-renders from exactly those files. Without
  // counting them, the first canvas a user deletes wipes the base image behind
  // every poster they made, and re-opening one shows an empty stage with the
  // layers floating on it. The sweep itself must keep working: an asset nothing
  // references still has to go.
  const upload = async (bytes, width, height) => {
    const uploaded = await post('/api/dsh-imagegen/canvas/asset/upload', {
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width, height, origin: 'upload',
    })
    assert.equal(uploaded.body.ok, true, JSON.stringify(uploaded.body))
    return uploaded.body.asset
  }
  const background = await upload(pngBytes, 640, 640)
  const logo = await upload(Buffer.concat([pngBytes, Buffer.from('a logo, hashed apart')]), 96, 96)
  const composite = await upload(Buffer.concat([pngBytes, Buffer.from('the flattened poster')]), 640, 640)
  const orphan = await upload(Buffer.concat([pngBytes, Buffer.from('nothing points here')]), 32, 32)

  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'poster assets' })
  const document = created.body.document
  const poster = {
    version: 1, width: 640, height: 640, background,
    layers: [{ id: 'layer-logo', type: 'image', asset: logo, x: 16, y: 16, width: 96, height: 96 }],
  }
  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: {
      ...document,
      nodes: [{
        id: 'node-poster-assets', type: 'image', title: '海报成品', x: 0, y: 0, width: 640, height: 640,
        metadata: { asset: composite, status: 'success', poster },
      }],
    },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, `the poster canvas must save: ${JSON.stringify(saved.body)}`)

  // Any canvas deletion runs the sweep; use a throwaway page so the poster
  // canvas above is the only thing holding those references.
  const doomed = await post('/api/dsh-imagegen/canvas/create', { title: 'doomed canvas' })
  const removed = await post('/api/dsh-imagegen/canvas/remove', { id: doomed.body.document.id })
  assert.equal(removed.body.ok, true, JSON.stringify(removed.body))

  const served = async asset => (await fetch(`http://127.0.0.1:${port}${asset.url}`)).status
  assert.equal(await served(background), 200, 'the poster background was deleted by the sweep')
  assert.equal(await served(logo), 200, 'the poster logo layer was deleted by the sweep')
  assert.equal(await served(composite), 200, 'the flattened composite was deleted by the sweep')
  assert.equal(await served(orphan), 404, 'an asset nothing references is still collected')

  await post('/api/dsh-imagegen/canvas/remove', { id: document.id })
})

await check('C10c2 canvas favorites persist across saves and project lists', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'favorite canvas' })
  const document = created.body.document
  const before = await post('/api/dsh-imagegen/canvas/list', {})
  assert.equal(before.body.projects.find(project => project.id === document.id)?.favorite, undefined)

  const favorited = await post('/api/dsh-imagegen/canvas/favorite', { id: document.id, favorite: true })
  assert.equal(favorited.body.ok, true, JSON.stringify(favorited.body))
  assert.equal(favorited.body.projects.find(project => project.id === document.id)?.favorite, true)

  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, title: 'favorite canvas saved' },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
  const after = await post('/api/dsh-imagegen/canvas/list', {})
  assert.equal(after.body.projects.find(project => project.id === document.id)?.favorite, true, 'saving must preserve the favorite marker')

  const unfavorited = await post('/api/dsh-imagegen/canvas/favorite', { id: document.id, favorite: false })
  assert.equal(unfavorited.body.ok, true, JSON.stringify(unfavorited.body))
  assert.equal(unfavorited.body.projects.find(project => project.id === document.id)?.favorite, undefined)
  await post('/api/dsh-imagegen/canvas/remove', { id: document.id })
})

/** Upload one file through the real route, exactly like the browser does. */
const uploadCanvasFile = async (name, mime, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': mime },
    body,
  })
  const parsed = await response.json()
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  return parsed.asset
}

/** Ask the host for one asset's structured preview (node metadata as hints). */
const canvasFilePreview = async asset => {
  const response = await post('/api/dsh-imagegen/canvas/file/preview', { assetId: asset.assetId, name: asset.name, mime: asset.mime })
  assert.equal(response.body.ok, true, JSON.stringify(response.body))
  return response.body.preview
}

await check('C10d a canvas file preview decodes text, tables and office documents', async () => {
  const textPreview = await canvasFilePreview(await uploadCanvasFile('notes.txt', 'text/plain', Buffer.from('line one\nline two\n', 'utf8')))
  assert.equal(textPreview.kind, 'text')
  assert.match(textPreview.text, /line two/)
  assert.ok(textPreview.lines >= 2, 'line count reported')

  const tablePreview = await canvasFilePreview(await uploadCanvasFile('people.csv', 'text/csv', Buffer.from('name,role\nalice,admin\nbob,viewer\n', 'utf8')))
  assert.equal(tablePreview.kind, 'table')
  assert.deepEqual(tablePreview.rows[0], ['name', 'role'])
  assert.deepEqual(tablePreview.rows[2], ['bob', 'viewer'])
  assert.equal(tablePreview.totalRows, 3)
  assert.equal(tablePreview.truncated, false)

  // RFC4180 quoting: separators and newlines inside quotes stay in one cell.
  const quotedPreview = await canvasFilePreview(await uploadCanvasFile('quoted.csv', 'text/csv', Buffer.from('a,b\n"x,1","y\n2"\n', 'utf8')))
  assert.deepEqual(quotedPreview.rows[1], ['x,1', 'y\n2'])

  // DOCX: the OOXML body is inflated and its paragraphs keep their order.
  const docx = buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'word/document.xml', body: '<w:document><w:body><w:p><w:r><w:t>季度报告</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>' },
  ])
  const docxPreview = await canvasFilePreview(await uploadCanvasFile('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx))
  assert.equal(docxPreview.kind, 'document')
  assert.equal(docxPreview.format, 'docx')
  assert.equal(docxPreview.blocks.length, 2, 'both paragraphs survive as blocks')
  assert.equal(docxPreview.blocks[0].type, 'paragraph')
  assert.match(docxPreview.blocks[0].runs.map(run => run.text).join(''), /季度报告/)
  assert.match(docxPreview.blocks[1].runs.map(run => run.text).join(''), /Second paragraph/)

  // XLSX: shared strings resolve into a grid instead of a wall of XML.
  const xlsx = buildZip([
    { name: 'xl/sharedStrings.xml', body: '<sst><si><t>Name</t></si><si><t>Score</t></si><si><t>Ada</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', body: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>97</v></c></row></sheetData></worksheet>' },
  ])
  const sheetPreview = await canvasFilePreview(await uploadCanvasFile('scores.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx))
  assert.equal(sheetPreview.kind, 'table')
  assert.deepEqual(sheetPreview.rows[0], ['Name', 'Score'])
  assert.deepEqual(sheetPreview.rows[1], ['Ada', '97'])

  // Markdown decodes whole so the client can render it as rich text.
  const mdPreview = await canvasFilePreview(await uploadCanvasFile('readme.md', 'text/markdown', Buffer.from('# 计划\n\n**加粗** and `code`\n', 'utf8')))
  assert.equal(mdPreview.kind, 'markdown')
  assert.match(mdPreview.markdown, /# 计划/)
  assert.equal(mdPreview.truncated, false)

  const missing = await post('/api/dsh-imagegen/canvas/file/preview', { assetId: 'nope.csv' })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'not-found')
})

await check('C10d2 rich previews reconstruct html / svg / docx layouts and pptx slides', () => {
  // The upload gate keeps HTML/SVG out of the store, so these go straight to
  // the preview builder — the same function the route calls with store bytes.
  const preview = (name, mime, data) => host.buildFilePreview({ data, mime, name, url: 'asset-url' })

  // HTML is handed over untouched: the client renders it in a sandboxed iframe.
  const html = preview('page.html', 'text/html', Buffer.from('<!doctype html><html><body><h1>你好</h1><script>alert(1)</script></body></html>', 'utf8'))
  assert.equal(html.kind, 'html')
  assert.match(html.html, /<h1>你好<\/h1>/)
  assert.match(html.html, /<script>/)

  // SVG likewise; the browser renders it through an `<img>` (no script runs).
  const svg = preview('logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', 'utf8'))
  assert.equal(svg.kind, 'svg')
  assert.match(svg.svg, /<rect/)

  // DOCX layout: heading level, bold/italic runs, numbered list, table grid.
  const richDocx = preview('plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'word/numbering.xml', body: '<w:numbering><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>' },
    { name: 'word/document.xml', body: '<w:document><w:body>'
      + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目计划</w:t></w:r></w:p>'
      + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>'
      + '<w:p/>' // Word-style empty spacer paragraph between blocks
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '</w:body></w:document>' },
  ]))
  assert.equal(richDocx.kind, 'document')
  const [heading, paragraph, list, table] = richDocx.blocks
  assert.deepEqual(heading, { type: 'heading', level: 1, runs: [{ text: '项目计划' }] })
  assert.equal(paragraph.type, 'paragraph')
  assert.deepEqual(paragraph.runs, [{ text: '加粗', bold: true }, { text: '斜体', italic: true }])
  assert.deepEqual(list, { type: 'list', ordered: true, items: [[{ text: '第一项' }], [{ text: '第二项' }]] })
  assert.deepEqual(table, { type: 'table', rows: [['A1', 'B1']] })

  // PPTX: one card per slide, title placeholder split from body lines, and
  // embedded raster pictures ride along as data URLs.
  const deck = preview('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', body: '<p:sld><p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度回顾</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>'
      + '<a:p><a:r><a:t>营收增长</a:t></a:r></a:p><a:p><a:r><a:t>成本下降</a:t></a:r></a:p>'
      + '</p:txBody></p:sp>'
      + '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>'
      + '</p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', body: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>' },
    { name: 'ppt/media/image1.png', body: pngBytes },
    { name: 'ppt/slides/slide2.xml', body: '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>结尾页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
  ]))
  assert.equal(deck.kind, 'slides')
  assert.equal(deck.format, 'pptx')
  assert.equal(deck.slides.length, 2)
  assert.equal(deck.slides[0].title, '季度回顾')
  assert.deepEqual(deck.slides[0].lines, ['营收增长', '成本下降'])
  assert.equal(deck.slides[0].images.length, 1)
  assert.equal(deck.slides[0].images[0].mime, 'image/png')
  assert.equal(deck.slides[0].images[0].data, `data:image/png;base64,${pngBytes.toString('base64')}`)
  assert.deepEqual(deck.slides[1], { lines: ['结尾页'], images: [] })

  // Vector metafiles (EMF) cannot render in an <img>, so they are dropped.
  const emfDeck = preview('legacy.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', body: '<p:sld><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', body: '<Relationships><Relationship Id="rId2" Target="../media/image1.emf"/></Relationships>' },
    { name: 'ppt/media/image1.emf', body: '\u0001\u0002emf' },
  ]))
  assert.equal(emfDeck.kind, 'slides')
  assert.equal(emfDeck.slides[0].images.length, 0)
})

await check('C10e a canvas file preview lists archives and reports opaque binaries', async () => {
  const archive = buildZip([
    { name: 'docs/', body: '' },
    { name: 'docs/a.txt', body: 'hello' },
    { name: 'b.bin', body: 'xxxxx' },
  ])
  const archivePreview = await canvasFilePreview(await uploadCanvasFile('bundle.zip', 'application/zip', archive))
  assert.equal(archivePreview.kind, 'archive')
  assert.equal(archivePreview.totalEntries, 3)
  assert.deepEqual(archivePreview.entries.map(entry => entry.name), ['docs/', 'docs/a.txt', 'b.bin'])
  assert.equal(archivePreview.entries[0].dir, true)
  assert.equal(archivePreview.entries[1].size, 5)
  assert.equal(archivePreview.truncated, false)

  // A PDF and media ask the browser to render the asset itself.
  const pdfPreview = await canvasFilePreview(await uploadCanvasFile('paper.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8')))
  assert.equal(pdfPreview.kind, 'media')
  assert.equal(pdfPreview.media, 'pdf')
  assert.match(pdfPreview.url, /\?inline=1$/)

  const audioPreview = await canvasFilePreview(await uploadCanvasFile('track.mp3', 'audio/mpeg', Buffer.from('ID3fakeaudio')))
  assert.equal(audioPreview.kind, 'media')
  assert.equal(audioPreview.media, 'audio')

  // An opaque binary says so, with a machine-readable reason for the browser.
  const blob = await canvasFilePreview(await uploadCanvasFile('blob.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 3])))
  assert.equal(blob.kind, 'none')
  assert.equal(blob.reason, 'unsupported')
  assert.equal(typeof blob.format, 'string')
})

await check('C10f previewable assets serve inline with byte ranges, markup never does', async () => {
  const base = `http://127.0.0.1:${port}`
  const bytes = Buffer.from('%PDF-1.4\nsecond page\n%%EOF\n', 'utf8')
  const pdf = await uploadCanvasFile('inline.pdf', 'application/pdf', bytes)
  const png = await uploadCanvasFile('inline.png', 'image/png', pngBytes)
  assert.match(png.url, /\.png$/)
  const inlinePng = await fetch(`${base}${png.url}`)
  assert.equal(inlinePng.headers.get('content-type'), 'image/png')
  assert.match(inlinePng.headers.get('content-disposition') ?? '', /^inline/)
  assert.deepEqual(Buffer.from(await inlinePng.arrayBuffer()), pngBytes)

  // Plain requests keep the attachment contract the upload path promises.
  const download = await fetch(`${base}${pdf.url}`)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment/)

  // ?inline=1 unlocks the browser's own renderer for the documented types.
  const inline = await fetch(`${base}${pdf.url}?inline=1`)
  assert.equal(inline.headers.get('content-type'), 'application/pdf')
  assert.match(inline.headers.get('content-disposition') ?? '', /^inline/)
  assert.equal(inline.headers.get('accept-ranges'), 'bytes')
  assert.equal(await inline.text(), bytes.toString('utf8'))

  // Media seeking needs real range answers.
  const ranged = await fetch(`${base}${pdf.url}?inline=1`, { headers: { range: 'bytes=0-7' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${bytes.length}`)
  assert.equal(await ranged.text(), '%PDF-1.4')

  // A range that cannot be satisfied is told so (RFC 7233) instead of silently
  // receiving the whole body with a 200.
  const unsatisfiable = await fetch(`${base}${pdf.url}?inline=1`, { headers: { range: 'bytes=999999-' } })
  assert.equal(unsatisfiable.status, 416)
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${bytes.length}`)

  // Text-shaped assets travel as JSON previews, never as an inline response.
  const csv = await uploadCanvasFile('inline.csv', 'text/csv', Buffer.from('a,b\n', 'utf8'))
  const csvInline = await fetch(`${base}${csv.url}?inline=1`)
  assert.equal(csvInline.headers.get('content-type'), 'application/octet-stream')
  assert.match(csvInline.headers.get('content-disposition') ?? '', /^attachment/)

  // An HTML-shaped payload may sit in the store (a declared type can slip past
  // the name check) but can never render in the app's origin.
  const markup = await uploadCanvasFile('evil.txt', 'text/html', Buffer.from('<html><script>alert(1)</script></html>', 'utf8'))
  const markupInline = await fetch(`${base}${markup.url}?inline=1`)
  assert.equal(markupInline.headers.get('content-type'), 'application/octet-stream')
  assert.match(markupInline.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal(markupInline.headers.get('x-content-type-options'), 'nosniff')
})

await check('C11 the skill catalog merges built-ins with local skills and tiers external ones', async () => {
  skillRegistrySkills.length = 0
  skillRegistrySkills.push(
    { name: 'image-to-editable-ppt', description: 'Rebuild slides as an editable deck', path: 'C:/skills/ppt/SKILL.md' },
    { name: 'summarize-notes', description: 'Turn notes into a short brief', metadata: { tier: 'light' } },
  )
  const listed = await post('/api/dsh-imagegen/canvas/skills/list', {})
  assert.equal(listed.body.ok, true, JSON.stringify(listed.body))
  const ids = listed.body.skills.map(skill => skill.id)
  assert.ok(ids.includes('polish.text'), `missing polish.text in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('ppt.fromImages'), `missing ppt.fromImages in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('skill:image-to-editable-ppt'), `missing ppt skill in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('skill:summarize-notes'), `missing summarize-notes in ${JSON.stringify(ids)}`)
  const ppt = listed.body.skills.find(skill => skill.id === 'skill:image-to-editable-ppt')
  assert.equal(ppt.tier, 'heavy', JSON.stringify(ppt))
  assert.equal(ppt.origin, 'external', JSON.stringify(ppt))
  const notes = listed.body.skills.find(skill => skill.id === 'skill:summarize-notes')
  assert.equal(notes.tier, 'light', JSON.stringify(notes))
  assert.equal(listed.body.agentAvailable, true, JSON.stringify(listed.body))
  assert.equal(listed.body.registryAvailable, true, JSON.stringify(listed.body))
})

await check('C11a the host registry adapter hides user-only skills and narrows summaries', async () => {
  const adapter = host.createSkillRegistryBackend({
    async list() {
      return [
        { name: 'visible', description: 'a model-invocable skill', invocation: { modelInvocable: true, userInvocable: true }, metadata: { tier: 'heavy' }, path: 'C:/s/visible/SKILL.md' },
        { name: 'user-only', description: 'slash command only', invocation: { modelInvocable: false, userInvocable: true } },
        { name: 'undeclared', description: 'provider omitted the policy', extra: 'dropped' },
      ]
    },
    async get(name) {
      return name === 'visible' ? { name, content: '# visible', metadata: { canvasTier: 'light' } } : undefined
    },
  })
  const listed = await adapter.list()
  assert.deepEqual(listed.map(skill => skill.name), ['visible', 'undeclared'])
  assert.equal(listed[0].path, 'C:/s/visible/SKILL.md')
  assert.deepEqual(listed[0].metadata, { tier: 'heavy' })
  assert.equal('extra' in listed[1], false)
  const body = await adapter.get('visible')
  assert.equal(body.content, '# visible')
  assert.deepEqual(body.metadata, { canvasTier: 'light' })
  assert.equal(await adapter.get('user-only'), undefined)
})

await check('C11b a lightweight skill run answers through the chat model and drafts a text node', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'polish' })
  const document = created.body.document
  const textNode = {
    id: 'node-text-1', type: 'text', title: 'draft', x: 0, y: 0, width: 280, height: 150,
    metadata: { text: 'hello world', fontSize: 14 },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [textNode] })
  const before = chatCalls
  chatReply = 'Hello, world.'
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'polish.text',
    nodeIds: ['node-text-1'],
    params: { style: 'formal' },
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  // The run-card rebuild path: tasks carry their input ids and a machine phase.
  assert.deepEqual(run.body.task.nodeIds, ['node-text-1'])
  assert.equal(['queued', 'running'].includes(run.body.task.phase), true, JSON.stringify(run.body.task))
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 80 && snapshot.status !== 'completed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  // The finished snapshot keeps nodeIds so a reload can still rebuild context.
  assert.deepEqual(snapshot.nodeIds, ['node-text-1'])
  // A canvas-scoped listing only reports unfinished runs.
  const drained = await post('/api/dsh-imagegen/canvas/skills/task', { canvasId: document.id })
  assert.equal(drained.body.ok, true)
  assert.deepEqual(drained.body.tasks, [], 'finished runs are not listed as live')
  const unknown = await post('/api/dsh-imagegen/canvas/skills/task', { canvasId: 'canvas-none' })
  assert.deepEqual(unknown.body.tasks, [])
  assert.equal(chatCalls, before + 1)
  const produced = snapshot.output.nodes[0]
  assert.equal(produced.type, 'text')
  assert.equal(produced.metadata.text, 'Hello, world.')
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, ['node-text-1'])
  assert.equal(snapshot.output.connections[0].fromNodeId, 'node-text-1')
  assert.equal(snapshot.output.connections[0].toNodeId, produced.id)
})

await check('C11c extract.content reads an uploaded text file without spending a chat call', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'extract' })
  const document = created.body.document
  const asset = recordCanvasFile(Buffer.from('第一行\n第二行\n', 'utf8'), 'text/plain', 'notes.txt')
  const fileNode = {
    id: 'node-file-2', type: 'file', title: 'notes.txt', x: 0, y: 0, width: 300, height: 170,
    metadata: { asset, fileKind: 'text' },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [fileNode] })
  const before = chatCalls
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'extract.content',
    nodeIds: ['node-file-2'],
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 80 && snapshot.status !== 'completed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  assert.equal(chatCalls, before)
  assert.equal(snapshot.output.nodes[0].type, 'text')
  assert.match(snapshot.output.nodes[0].metadata.text, /第一行/)
})

await check('C11d heavy skills refuse to start without the agent runtime, then produce a file node', async () => {  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'deck' })
  const document = created.body.document
  const imageNode = {
    id: 'node-image-1', type: 'image', title: 'slide-1', x: 0, y: 0, width: 240, height: 240,
    metadata: {
      asset: { assetId: 'img-1', url: '/api/dsh-imagegen/canvas/asset/' + 'a'.repeat(64) + '.png', mime: 'image/png', bytes: pngBytes.length, width: 1, height: 1, origin: 'upload', kind: 'image', name: 'img-1.png' },
      status: 'success',
    },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [imageNode] })

  // The built-in deck conversion disappears from the catalog when the agent
  // runtime is not available, so the run fails instead of silently no-oping.
  heavySkillAllowed = false
  const disabled = await post('/api/dsh-imagegen/canvas/skills/list', {})
  assert.equal(disabled.body.agentAvailable, false)
  heavySkillAllowed = true

  const before = heavyRunsStarted
  // The run materializes its input images on disk, so the stub store needs the
  // bytes the node's asset points at.
  // The run materializes its input images on disk, so the stub store needs the
  // bytes the node's asset points at (`<assetId>.<extension>`).
  canvasBlobs.set('img-1.png', { data: pngBytes, mime: 'image/png' })
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'ppt.fromImages',
    nodeIds: ['node-image-1'],
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 200 && snapshot.status !== 'completed' && snapshot.status !== 'failed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  assert.equal(heavyRunsStarted, before + 1)
  const produced = snapshot.output.nodes.find(node => node.type === 'file')
  assert.ok(produced !== undefined, 'the deck artifact became a file node')
  assert.match(String(produced.metadata.asset.name), /\.pptx$/)
})

await check('C11d2 an unpublishable artifact is skipped, not a lost run', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'deck-with-junk' })
  const document = created.body.document
  const imageNode = {
    id: 'node-image-2', type: 'image', title: 'slide-1', x: 0, y: 0, width: 240, height: 240,
    metadata: {
      asset: { assetId: 'img-2', url: '/api/dsh-imagegen/canvas/asset/' + 'b'.repeat(64) + '.png', mime: 'image/png', bytes: pngBytes.length, width: 1, height: 1, origin: 'upload', kind: 'image', name: 'img-2.png' },
      status: 'success',
    },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [imageNode] })
  canvasBlobs.set('img-2.png', { data: pngBytes, mime: 'image/png' })

  // A skill that writes an executable-shaped artifact beside its real one: the
  // store refuses the `.svg`, and before the per-file catch that refusal
  // unwound the whole run — the deck was thrown away and the task failed.
  heavyArtifacts = [['chart.svg', Buffer.from('<svg/>', 'utf8')]]
  try {
    const run = await post('/api/dsh-imagegen/canvas/skills/run', {
      canvasId: document.id,
      skillId: 'ppt.fromImages',
      nodeIds: ['node-image-2'],
    })
    assert.equal(run.body.ok, true, JSON.stringify(run.body))
    const taskId = run.body.task.id
    let snapshot = run.body.task
    for (let attempt = 0; attempt < 200 && snapshot.status !== 'completed' && snapshot.status !== 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
    }
    assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
    const names = snapshot.output.nodes.filter(node => node.type === 'file').map(node => String(node.metadata.asset.name))
    assert.deepEqual(names, ['deck.pptx'], `the good artifact still landed: ${JSON.stringify(names)}`)
    const skipped = snapshot.output.warnings.find(line => line.includes('chart.svg'))
    assert.ok(skipped !== undefined, `the skipped artifact is reported: ${JSON.stringify(snapshot.output.warnings)}`)
    assert.match(skipped, /chart\.svg/)
  } finally {
    heavyArtifacts = []
  }
})

await check('C11e an unknown skill id and a missing canvas fail with copy, not a crash', async () => {
  const unknown = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: 'nope', skillId: 'skill:does-not-exist', nodeIds: [],
  })
  assert.equal(unknown.body.ok, false)
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'gone' })
  const missing = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: `missing-${created.body.document.id}`, skillId: 'polish.text', nodeIds: ['x'],
  })
  assert.equal(missing.body.ok, false)
  assert.ok(typeof missing.body.message === 'string' && missing.body.message.length > 0)
})

await check('C11f skill routes answer in the caller language and reject unknown hints', async () => {
  const zh = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'zh' })
  const en = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'en' })
  const bogus = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'not-a-locale' })
  const nameOf = (body, id) => body.skills.find(skill => skill.id === id).name
  assert.equal(nameOf(zh.body, 'polish.text'), '文本润色')
  assert.equal(nameOf(en.body, 'polish.text'), 'Polish text')
  // An unknown/absent hint falls back to the host resolver, never a raw key.
  assert.equal(nameOf(bogus.body, 'polish.text'), '文本润色')
  assert.ok(zh.body.reason === undefined || !String(zh.body.reason).includes('canvas.skills.'))
})

await check('C11g a scope-blind host registry still offers the local skill library', async () => {
  // The user's exact situation: the skill is installed under the local root,
  // while the registry the host-plane plugin can query answers nothing (on the
  // Web surface a preset owns local discovery, so the global layer is empty).
  const previous = [...skillRegistrySkills]
  skillRegistrySkills.length = 0
  const bundle = (name, body) => {
    mkdirSync(join(skillRegistryRoot, name), { recursive: true })
    writeFileSync(join(skillRegistryRoot, name, 'SKILL.md'), body)
  }
  const names = ['image-to-editable-ppt', 'local-worker', 'Bad_Name', 'user-only-thing']
  try {
    bundle('image-to-editable-ppt', '---\nname: image-to-editable-ppt\ndescription: Rebuild slides\n---\n\n# Deck\n')
    bundle('local-worker', '---\nname: local-worker\ndescription: Local notes worker\n---\n\n# Local\n\nlocal body marker\n')
    // Entries the host registry would drop: never offered to a node.
    bundle('Bad_Name', '---\nname: Bad_Name\ndescription: Wrong name shape\n---\n\n# Bad\n')
    bundle('user-only-thing', '---\nname: user-only-thing\ndescription: Slash command only\ndisable-model-invocation: true\n---\n\n# Human\n')

    const listed = await post('/api/dsh-imagegen/canvas/skills/list', {})
    const ids = listed.body.skills.map(skill => skill.id)
    assert.ok(ids.includes('skill:image-to-editable-ppt'), `missing the installed deck skill in ${JSON.stringify(ids)}`)
    assert.ok(ids.includes('skill:local-worker'), `missing the local skill in ${JSON.stringify(ids)}`)
    assert.equal(ids.includes('skill:Bad_Name'), false, `a non-kebab name must not be offered: ${JSON.stringify(ids)}`)
    assert.equal(ids.includes('skill:user-only-thing'), false, `a user-only skill must not be offered: ${JSON.stringify(ids)}`)
    // The built-in deck action keys its install hint off this list: the skill IS
    // installed, so the picker must stop telling the user to install it.
    assert.deepEqual([...listed.body.installed].sort(), ['image-to-editable-ppt', 'local-worker'])

    // The body loads from disk too, so a run is not silently instruction-less.
    const adapter = host.createSkillRegistryBackend({ async list() { return [] }, async get() { return undefined } }, { root: () => skillRegistryRoot })
    const definition = await adapter.get('local-worker')
    assert.equal(definition.name, 'local-worker')
    assert.match(definition.content, /local body marker/)
    assert.equal(await adapter.get('Bad_Name'), undefined)
    // A registry entry still wins a name collision (deployment outranks a user install).
    const merged = host.createSkillRegistryBackend({
      async list() { return [{ name: 'local-worker', description: 'registry wins', path: 'C:/repo/local-worker/SKILL.md' }] },
      async get() { return { name: 'local-worker', content: 'registry body' } },
    }, { root: () => skillRegistryRoot })
    assert.equal((await merged.list()).find(skill => skill.name === 'local-worker').description, 'registry wins')
    assert.equal((await merged.get('local-worker')).content, 'registry body')
  } finally {
    for (const name of names) rmSync(join(skillRegistryRoot, name), { recursive: true, force: true })
    skillRegistrySkills.push(...previous)
    // Leave the catalog a later check sees as the registry-only one again.
    const restored = await post('/api/dsh-imagegen/canvas/skills/list', {})
    assert.equal(restored.body.skills.some(skill => skill.id === 'skill:local-worker'), false)
  }
})

await check('C11h a heavy run composes its agent with the preset roster and a model route', async () => {
  // Creating an agent is not enough: on the Web surface every model-facing row
  // lives behind a preset, and the model route is not implied by the request.
  const seen = { sections: [] }
  const created = await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        seen.options = options
        // The real factory runs setup before it publishes the agent.
        await options.setup({
          systemPrompt: { section: input => seen.sections.push(input) },
        })
        return {
          agent: {
            session: { deriveMessages: () => [] },
            followup() { seen.delivered = true },
            async whenIdle() {},
            cancel(cause) { seen.cancelled = cause },
          },
          async dispose() {},
        }
      },
    },
    presets: {
      async resolve(id) { seen.resolvedWith = id; return { id: 'standard' } },
      async mount(_ctx, id) { seen.mounted = id; return { id } },
    },
    defaultModel: { currentSelection: () => ({ provider: 'packyapi', model: 'deepseek-flash' }) },
    agentPreset: '',
    sessionId: 'skillagent-smoke',
    cwd: 'C:/runs/smoke',
    systemPrompt: 'SKILL BODY',
    fail: key => `copy:${key}`,
  })
  assert.equal(seen.resolvedWith, undefined, 'an empty setting must ask for the deployment default')
  assert.deepEqual(seen.options.agentOptions, { provider: 'packyapi', model: 'deepseek-flash' })
  assert.equal(seen.options.meta.agentPreset, 'standard')
  assert.equal(seen.options.meta.origin, 'subagent')
  assert.equal(seen.options.meta.cwd, 'C:/runs/smoke')
  assert.equal(seen.mounted, 'standard', 'the agent must join the preset, or it runs tool-less')
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.sections[0].text, 'SKILL BODY')
  assert.equal(seen.sections[0].name, 'plugin:dsh-imagegen:canvas-skill')
  // Driving the handle narrows the DSH agent to what a run needs.
  created.followup('go')
  assert.equal(seen.delivered, true)
  created.cancel()
  assert.deepEqual(seen.cancelled, { kind: 'user' })
  await created.dispose()

  // A configured preset name wins over the deployment default.
  const named = {}
  await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        await options.setup({ systemPrompt: { section() {} } })
        return { agent: { session: { deriveMessages: () => [] }, followup() {}, async whenIdle() {}, cancel() {} }, async dispose() {} }
      },
    },
    presets: {
      async resolve(id) { named.resolvedWith = id; return { id: id ?? 'standard' } },
      async mount(_ctx, id) { named.mounted = id; return { id } },
    },
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPreset: 'deck-runner',
    sessionId: 'x',
    cwd: 'c',
    systemPrompt: 's',
    fail: key => key,
  })
  assert.equal(named.resolvedWith, 'deck-runner')
  assert.equal(named.mounted, 'deck-runner')

  // Without a default model the run fails with copy instead of starting a
  // model-less agent that dies on its first step.
  await assert.rejects(
    () => host.createCanvasSkillAgent({
      agents: { async create() { throw new Error('must not be reached') } },
      defaultModel: { currentSelection: () => ({}) },
      agentPreset: '',
      sessionId: 'x',
      cwd: 'c',
      systemPrompt: 's',
      fail: key => `copy:${key}`,
    }),
    /copy:canvas\.skills\.needModel/,
  )
})

await check('C11i a contained host Agent failure is surfaced instead of a missing-file error', async () => {
  // The driver contains a failed turn: `whenIdle` resolves normally and the
  // reason only exists as a retained event. Reading it is what turns
  // "the skill produced no final PPTX" into "the model API returned 401" —
  // and the key inside that message must not reach the panel.
  let listener
  const marker = '401 ' + ['sk', 'fake', '123456789'].join('-')
  const created = await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        await options.setup({
          on(name, callback) { if (name === 'agent/error') listener = callback },
          systemPrompt: { section() {} },
        })
        return {
          agent: {
            session: { deriveMessages: () => [] },
            followup() {},
            async whenIdle() {
              listener({ agent: { id: 'failure-test' }, error: new Error(`Model API returned ${marker}`) })
            },
            cancel() {},
          },
          async dispose() {},
        }
      },
    },
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPreset: '',
    sessionId: 'failure-test',
    cwd: 'c',
    systemPrompt: 's',
  })
  await assert.rejects(
    created.whenIdle(),
    error => {
      assert.match(error.message, /401/, 'the model error survives instead of being replaced by "no output"')
      assert.ok(!error.message.includes(marker), 'the key inside the model error is redacted')
      return true
    },
  )
  await created.dispose()
})

// Two reports from real use, both invisible to a jsdom render:
//  1. A multi-line prompt showed up as one squashed line, so the user could not
//     read back what they had generated from.
//  2. Dropping an image into the edit-reference strip left the host's drag
//     overlay ("drop files here") stuck on screen: the host counts dragenter/
//     dragleave on document and only resets when document receives the drop, so
//     a stopPropagation() in between leaves that counter permanently above zero.
await check('C15 history prompts keep their line breaks and plugin drops reach the host', async () => {
  const panelCss = readFileSync(new URL('../src/client/panel.module.css', import.meta.url), 'utf8')
  const promptRule = panelCss.slice(panelCss.indexOf('.historyPrompt {'), panelCss.indexOf('.historyMeta')) || ''
  assert.ok(promptRule !== '', 'the history prompt rule is findable')
  assert.match(promptRule, /-webkit-line-clamp:\s*2/, 'the sidebar history prompt is clamped to 2 lines to keep cards balanced')
  const resultPromptRule = panelCss.slice(panelCss.indexOf('.canvasPromptText {'), panelCss.indexOf('.grid {')) || ''
  assert.ok(resultPromptRule !== '', 'the canvas prompt rule above the result image is findable')
  assert.match(resultPromptRule, /white-space:\s*pre-wrap/, 'the result image prompt line preserves user newlines')
  // A real drag is not reproducible in jsdom, so the invariant is what gets
  // checked: every drop handler this plugin registers lets the event bubble.
  for (const file of ['ReferenceImages.tsx', 'ReplicaWorkspace.tsx', 'PptWorkspace.tsx', 'ImageGenPanel.tsx']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/onDrop=\{[^}]*\}/g)) {
      assert.ok(!/stopPropagation/.test(match[0]), `${file} drop handlers must not stop propagation (the host drag overlay would never reset)`)
    }
  }
})

// PPT checkpoints and live progress: the deck pipeline needs two guarantees —
// a Windows replacement lock can never lose a checkpoint, and the progress card
// reports only what the upstream run directory actually recorded.
await check('C11ppt-progress exposes real host activity and validated page records without model reasoning or tool output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppt-progress-'))
  const events = []
  const session = { get seq() { return events.length }, eventAt(index) { return events[index] }, deriveMessages: () => [] }
  const task = { id: 'skillrun-progress', canvasId: 'ppt', startedAt: Date.now(), pptImages: [{}, {}] }
  const monitor = new host.PptProgressMonitor(task, session, root, host.canvasSkillCopy('zh'))
  try {
    events.push({ type: 'step/start', data: { turn: 1, step: 1 } }, { type: 'tool/call', data: { callId: 'shell-1', name: 'shell', arguments: JSON.stringify({ command: 'editppt page hints --token sk-secret-do-not-show' }) } })
    await monitor.refresh()
    assert.match(task.progress.currentOperation, /shell/)
    assert.match(task.progress.currentOperation, /文字提示/)
    events.push({ type: 'tool/result', data: { message: { callId: 'shell-1', isError: true, content: [{ type: 'text', text: 'tool-secret-output' }] } } }, { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private-model-reasoning' }] } } })
    await monitor.refresh()
    assert.ok(task.progress.events.some(event => event.state === 'warning'))
    const jobs = { pages: [{ status: 'recorded', result: { validation_passed: true } }, { status: 'dispatched', result: { validation_passed: false } }] }
    writeFileSync(join(root, 'page_jobs.json'), JSON.stringify(jobs))
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({ status: 'pages_dispatched' }))
    await monitor.refresh()
    assert.deepEqual(task.progress.pages.map(page => page.state), ['validated', 'running'])
    assert.equal(task.progress.upstreamStage, 'pages_dispatched')
    const count = task.progress.events.length, activity = task.progress.lastActivityAt
    await monitor.refresh()
    assert.equal(task.progress.events.length, count, 'polling unchanged files does not invent progress')
    assert.equal(task.progress.lastActivityAt, activity, 'polling does not reset the last actual activity time')
    jobs.pages[1] = { status: 'accepted', result: { validation_passed: true } }
    writeFileSync(join(root, 'page_jobs.json'), JSON.stringify(jobs))
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({ status: 'deck_validated' }))
    await monitor.refresh()
    assert.equal(task.progress.pages.filter(page => page.state === 'validated').length, 2)
    assert.equal(task.status, undefined, 'upstream page records cannot mark the overall task completed')
    const serialized = JSON.stringify(task.progress)
    for (const secret of ['sk-secret', 'tool-secret-output', 'private-model-reasoning']) assert.ok(!serialized.includes(secret))
    assert.ok(!serialized.includes('%'), 'there is no fabricated percentage')
    await monitor.stop()
    const stoppedCount = task.progress.events.length
    events.push({ type: 'step/start', data: {} })
    await monitor.refresh()
    assert.equal(task.progress.events.length, stoppedCount, 'cancelled or settled monitors cannot emit late progress')
  } finally { await monitor.stop(); rmSync(root, { recursive: true, force: true }) }
})
await check('C11ppt-store immutable checkpoints survive Windows replacement locks, overlapping writes and partial files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppt-checkpoint-'))
  let activeWrites = 0, maximumWrites = 0, renames = 0
  const io = { ...fsPromises,
    async rename() { renames++; throw Object.assign(new Error('Windows destination sharing violation'), { code: 'EPERM' }) },
    async writeFile(...args) { activeWrites++; maximumWrites = Math.max(maximumWrites, activeWrites); try { await new Promise(r => setTimeout(r, 10)); return await fsPromises.writeFile(...args) } finally { activeWrites-- } },
  }
  const store = new host.PptTaskStore(() => root, io)
  const task = { id: 'skillrun-lock-test', canvasId: 'ppt', skillId: 'ppt.fromImages', label: 'PPT', tier: 'heavy', status: 'queued', startedAt: 1 }
  try {
    mkdirSync(join(root, 'ppt-tasks'))
    writeFileSync(join(root, 'ppt-tasks', task.id + '.json'), JSON.stringify(task))
    const first = store.write(task)
    task.status = 'running'
    const second = store.write(task)
    task.status = 'completed'; task.finishedAt = 3
    const third = store.write(task)
    await Promise.all([first, second, third])
    assert.equal(renames, 0, 'PPT persistence must not replace a locked Windows destination')
    assert.equal(maximumWrites, 1, 'writes for the same task are serialized')
    const names = await fsPromises.readdir(join(root, 'ppt-tasks'))
    const snapshots = await Promise.all(names.filter(n => n !== task.id + '.json').sort().map(n => fsPromises.readFile(join(root, 'ppt-tasks', n), 'utf8').then(JSON.parse)))
    assert.deepEqual(snapshots.map(t => t.status), ['queued', 'running', 'completed'], 'each queued write captures its own immutable state')
    writeFileSync(join(root, 'ppt-tasks', `${task.id}.${Date.now()+60000}.dead-beef.json`), '{"status":')
    writeFileSync(join(root, 'ppt-tasks', `${task.id}.json.dead-beef.tmp`), '{"status":')
    const restored = await new host.PptTaskStore(() => root).list()
    assert.equal(restored.length, 1)
    assert.equal(restored[0].status, 'completed', 'partial checkpoints cannot hide the preceding complete snapshot')
    assert.equal(JSON.parse(readFileSync(join(root, 'ppt-tasks', task.id+'.json'), 'utf8')).status, 'queued', 'the legacy record was never overwritten')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

await check('C11ppt standalone PPT validates input, preserves order, persists results and rejects incomplete outputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppt-conversion-'))
  const assets = ['first.png', 'second.png'].map(assetId => ({
    assetId, url: `/api/dsh-imagegen/canvas/asset/${assetId}`, mime: 'image/png',
    bytes: pngBytes.length, width: 1, height: 1, origin: 'upload', name: assetId,
  }))
  let mode = 'ok'
  let stopped = 0
  let recordedPrompt = ''
  const recordedInputs = []
  let release
  const backend = {
    ...canvasBackend,
    async readAsset(id) {
      return assets.some(asset => asset.assetId === id) ? { data: pngBytes, mime: 'image/png' } : undefined
    },
    async materialize(asset, target) {
      recordedInputs.push([asset.assetId, target])
      writeFileSync(target, pngBytes)
    },
  }
  const options = {
    backend: { canvas: backend },
    enabled: () => true,
    heavyEnabled: () => true,
    allowlist: () => [],
    runRoot: () => root,
    dataRoot: () => root,
    heavyTimeoutMs: () => 30_000,
    pptCommand: async () => '/test/python/bin/editppt',
  }
  const runner = new host.SkillRunner(options)
  const registry = {
    async list() { return [{ name: 'image-to-editable-ppt', description: 'PPT skill', path: '/upstream/image-to-editable-ppt/SKILL.md' }] },
    async get() { return { name: 'image-to-editable-ppt', content: '# upstream body\nFollow upstream commands.' } },
  }
  runner.attach({
    registry,
    agents: {
      available: () => true,
      async create(createOptions) {
        recordedPrompt = createOptions.systemPrompt
        return {
          session: {
            get seq() { return mode === 'agent-error' ? 1 : 0 },
            eventAt() {
              return { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'Provider unavailable sk-private123456789' } } } }
            },
            deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'agent result' }] }],
          },
          followup() {},
          async whenIdle() {
            if (mode === 'hold') await new Promise(resolve => { release = resolve })
            if (mode === 'no-deck' || mode === 'agent-error') return
            const slides = mode === 'wrong-count' ? 1 : 2
            const deck = mode === 'bad-zip' ? Buffer.from('not-a-pptx') : buildZip([
              { name: 'ppt/presentation.xml', body: '<p:presentation/>' },
              ...Array.from({ length: slides }, (_, index) => ({ name: `ppt/slides/slide${index + 1}.xml`, body: '<p:sld><p:sp>Editable text</p:sp></p:sld>' })),
            ])
            if (mode === 'upstream-final' || mode === 'unvalidated-final') {
              // The editppt skill finalizes outside the output dir this runner
              // hands it; only a completed, validated run may be collected.
              const final = join(createOptions.cwd, 'output', 'upstream-run', 'final')
              mkdirSync(final, { recursive: true })
              writeFileSync(join(final, 'deck_edited.pptx'), deck)
              writeFileSync(join(final, 'validation.json'), JSON.stringify({ passed: mode === 'upstream-final' }))
              writeFileSync(join(final, 'run_summary.json'), JSON.stringify({
                status: 'complete', page_count: 2, output: join(final, 'deck_edited.pptx'), validation: join(final, 'validation.json'),
              }))
            } else writeFileSync(join(createOptions.cwd, 'output', 'final.pptx'), deck)
          },
          cancel() { stopped += 1; release?.() },
          async dispose() {},
        }
      },
    },
  })
  const wait = async task => {
    for (let index = 0; index < 200 && ['running', 'queued'].includes(task.status); index++) await new Promise(resolve => setTimeout(resolve, 10))
    return task
  }
  try {
    await assert.rejects(runner.runPpt({ images: [], offlineOcr: true }), /1.?12|图片|images/)
    await assert.rejects(runner.runPpt({ images: [{ ...assets[0], assetId: 'missing' }], offlineOcr: true }), /图片|image/i)
    const task = await wait(await runner.runPpt({ images: assets, offlineOcr: true, language: 'zh' }))
    assert.equal(task.status, 'completed', JSON.stringify(task))
    assert.deepEqual(recordedInputs.slice(0, 2).map(([id]) => id), ['first.png', 'second.png'], 'slide order follows the upload order')
    assert.match(recordedPrompt, /upstream body/)
    assert.match(recordedPrompt, /\/upstream\/image-to-editable-ppt\/SKILL.md/)
    assert.match(recordedPrompt, /\/test\/python\/bin\/editppt/)
    assert.match(recordedPrompt, /prepare --no-text-hints/, 'the offline OCR choice reaches the skill untouched')
    assert.ok(task.output.nodes.some(node => node.metadata.asset?.name === 'final.pptx'))
    // Final persistence finishes just after the terminal status becomes visible.
    await new Promise(resolve => setTimeout(resolve, 30))
    const restarted = new host.SkillRunner(options)
    const restored = await restarted.pptTasks()
    assert.equal(restored[0].id, task.id)
    assert.equal(restored[0].status, 'completed')
    assert.ok(restored[0].agentSessionId?.startsWith('skillagent-'), 'the conversion history names its agent session')
    assert.ok(restored[0].runDirectory?.includes(task.id), 'the conversion history names its run directory')
    assert.equal(restored[0].output.nodes[0].metadata.asset.name, 'final.pptx')
    for (const bad of ['bad-zip', 'wrong-count', 'no-deck']) {
      mode = bad
      const failed = await wait(await runner.runPpt({ images: assets, offlineOcr: false, language: 'en' }))
      assert.equal(failed.status, 'failed', bad)
      assert.ok(failed.error, `${bad} reports why it failed`)
    }
    mode = 'upstream-final'
    const recovered = await wait(await runner.runPpt({ images: assets, offlineOcr: true, language: 'zh' }))
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered))
    assert.ok(recovered.output.nodes.some(node => node.metadata.asset?.name === 'deck_edited.pptx'), 'the skill final deck is collected')
    mode = 'unvalidated-final'
    const unvalidated = await wait(await runner.runPpt({ images: assets, offlineOcr: true }))
    assert.equal(unvalidated.status, 'failed', 'a final deck without a passing validation report must not become successful')
    mode = 'agent-error'
    const providerError = await wait(await runner.runPpt({ images: assets, offlineOcr: true, language: 'zh' }))
    assert.equal(providerError.status, 'failed')
    assert.match(providerError.error, /NO_ADAPTER/)
    assert.ok(!providerError.error.includes('sk-private123456789'), 'provider error secrets are redacted')
    mode = 'hold'
    const live = await runner.runPpt({ images: assets, offlineOcr: true })
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const queued = await runner.runPpt({ images: assets, offlineOcr: true })
    assert.equal(await runner.cancel(queued.id), true)
    assert.equal(queued.status, 'cancelled')
    assert.equal(await runner.cancel(live.id), true)
    assert.equal(live.status, 'cancelled')
    assert.equal(stopped, 1, 'the running agent is cancelled exactly once')
    await new Promise(resolve => setTimeout(resolve, 30))
    // A run interrupted by a restart is reported as interrupted, not left running.
    writeFileSync(join(root, 'ppt-tasks', 'skillrun-interrupted.json'), JSON.stringify({ ...task, id: 'skillrun-interrupted', status: 'running' }))
    const afterRestart = await restarted.pptTasks()
    assert.equal(afterRestart.find(item => item.id === 'skillrun-interrupted').status, 'failed')
    assert.ok(afterRestart.find(item => item.id === 'skillrun-interrupted').error)
    const noAgent = new host.SkillRunner(options)
    await assert.rejects(noAgent.runPpt({ images: assets, offlineOcr: true }))
  } finally {
    release?.()
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C11ppt routes refuse bad sources and expose durable conversion history', async () => {
  for (const body of [{ images: [], offlineOcr: true }, { images: [{ assetId: '../escape' }], offlineOcr: true }, { images: [{ assetId: 'x.png' }] }]) {
    const result = await post('/api/dsh-imagegen/ppt/run', body)
    assert.equal(result.body.ok, false, JSON.stringify(body))
    assert.equal(result.body.code, 'bad-request')
  }
  const list = await post('/api/dsh-imagegen/ppt/tasks', {})
  assert.equal(list.body.ok, true)
  assert.ok(Array.isArray(list.body.tasks))
})

// ------------------------------------------- C12. local skill library

/** Minimal stored-method ZIP writer (the reader validates structure, not CRC). */
function buildZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body, 'utf8')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(0, 14) // crc (unused by the reader)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, body)
    const head = Buffer.alloc(46 + name.length)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0, 8)
    head.writeUInt16LE(0, 10) // stored
    head.writeUInt32LE(0, 16)
    head.writeUInt32LE(body.length, 20)
    head.writeUInt32LE(body.length, 24)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE(0, 38)
    head.writeUInt32LE(offset, 42)
    name.copy(head, 46)
    central.push(head)
    offset += local.length + body.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

await check('C12 install sources are classified without touching the network', () => {
  assert.deepEqual({ ...host.classifySource('https://github.com/ningzimu/image-to-editable-ppt-skill') }, {
    kind: 'github', owner: 'ningzimu', repo: 'image-to-editable-ppt-skill', ref: '', subpath: '',
  })
  // A blob/tree URL keeps its ref and subfolder so the bundle (not the file) installs.
  assert.deepEqual({ ...host.classifySource('https://github.com/o/r/tree/main/skills/deck') }, {
    kind: 'github', owner: 'o', repo: 'r', ref: 'main', subpath: 'skills/deck',
  })
  const raw = host.classifySource('https://raw.githubusercontent.com/o/r/main/SKILL.md')
  assert.equal(raw.kind, 'raw')
  assert.equal(raw.name, 'SKILL')
  assert.equal(host.classifySource('https://example.com/bundle.zip').kind, 'archive')
  assert.equal(host.classifySource('https://git.example.com/team/skill.git').kind, 'git')
  // Names are folder names: anything path-like is refused.
  assert.equal(host.isValidSkillName('image-to-editable-ppt'), true)
  assert.equal(host.isValidSkillName('../escape'), false)
  assert.equal(host.isValidSkillName(''), false)

  // Skill root resolution: DSH_SKILLS_HOME takes precedence over DSH_HOME and default homedir.
  const previousSkillsHome = process.env.DSH_SKILLS_HOME
  const previousDshHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_SKILLS_HOME
    process.env.DSH_HOME = '/custom/dsh'
    assert.equal(host.skillsRoot(), join('/custom/dsh', 'skills'))

    process.env.DSH_SKILLS_HOME = '  /custom/isolated/skills  '
    // `skillsRoot()` resolves an explicit skills home, and `path.resolve` is
    // host-specific: on Windows it prefixes the current drive, so the expected
    // value has to be resolved the same way instead of compared as a POSIX
    // literal.
    assert.equal(host.skillsRoot(), resolve('/custom/isolated/skills'))

    // DSH_SKILLS_HOME also overrides explicit dshHome argument
    assert.equal(host.skillsRoot('/explicit/dsh'), resolve('/custom/isolated/skills'))
  } finally {
    if (previousSkillsHome === undefined) delete process.env.DSH_SKILLS_HOME
    else process.env.DSH_SKILLS_HOME = previousSkillsHome
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})

await check('C12a the library lists, installs from an archive, replaces and removes', async () => {
  // A flat `<name>.md` skill and a bundle folder both count as installed.
  writeFileSync(join(skillLibraryRoot, 'flat-skill.md'), '---\nname: flat-skill\ndescription: A flat one\n---\n\n# Flat\n')
  mkdirSync(join(skillLibraryRoot, 'bundle-skill'), { recursive: true })
  writeFileSync(join(skillLibraryRoot, 'bundle-skill', 'SKILL.md'), '---\nname: bundle-skill\ndescription: A bundled one\n---\n\n# Bundle\n')

  const listed = await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  assert.equal(listed.networkAvailable, false)
  assert.deepEqual(listed.entries.map(entry => entry.name).sort(), ['bundle-skill', 'flat-skill'])
  assert.equal(listed.entries.find(entry => entry.name === 'bundle-skill').description, 'A bundled one')
  assert.ok(listed.catalog.some(source => source.name === 'image-to-editable-ppt'))

  // GitHub-shaped archive: one wrapper folder, bundle a level deeper.
  const archive = buildZip([
    { name: 'repo-main/', body: '' },
    { name: 'repo-main/SKILL.md', body: '---\nname: deck-maker\ndescription: Makes decks\n---\n\n# Deck\n' },
    { name: 'repo-main/scripts/run.py', body: 'print(1)\n' },
  ])
  assert.equal(host.readZipDirectory(archive).length, 3)
  const installed = await host.installFromArchive(archive, skillLibraryRoot, 'repo', false)
  assert.equal(installed, 'deck-maker')
  assert.equal(readFileSync(join(skillLibraryRoot, 'deck-maker', 'scripts', 'run.py'), 'utf8'), 'print(1)\n')
  // Without force a second install refuses instead of clobbering.
  await assert.rejects(
    () => host.installFromArchive(archive, skillLibraryRoot, 'repo', false),
    /已经安装/,
  )
  assert.equal(await host.installFromArchive(archive, skillLibraryRoot, 'repo', true), 'deck-maker')

  // An archive with no SKILL.md anywhere is rejected, not half-installed.
  const empty = buildZip([{ name: 'repo-main/README.md', body: 'nothing here\n' }])
  await assert.rejects(() => host.installFromArchive(empty, skillLibraryRoot, 'nope', true), /SKILL\.md/)

  assert.equal(await host.removeSkill('flat-skill', skillLibraryRoot), 'flat-skill')
  await assert.rejects(() => host.removeSkill('flat-skill', skillLibraryRoot), /没有找到/)
  await assert.rejects(() => host.removeSkill('../escape', skillLibraryRoot), /不合法/)
  const after = await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  assert.deepEqual(after.entries.map(entry => entry.name).sort(), ['bundle-skill', 'deck-maker'])
})

await check('C12b the library routes list, install from an upload, and remove', async () => {
  const initial = await post('/api/dsh-imagegen/canvas/skills/library', { language: 'zh' })
  assert.equal(initial.status, 200)
  assert.equal(initial.body.ok, true)
  assert.equal(initial.body.library.root, skillLibraryRoot)

  // The browser uploads the archive first (same route as a file node), then
  // installs it by asset reference.
  const archive = buildZip([{ name: 'bundle/SKILL.md', body: '---\nname: routed-skill\ndescription: From a route\n---\n\n# Routed\n' }])
  const uploaded = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=routed.zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: archive,
  })
  const upload = await uploaded.json()
  assert.equal(upload.ok, true, JSON.stringify(upload))

  const install = await post('/api/dsh-imagegen/canvas/skills/install', {
    asset: upload.asset, name: 'routed', force: true, language: 'zh',
  })
  assert.equal(install.body.ok, true, JSON.stringify(install.body))
  assert.deepEqual(install.body.installed, ['routed-skill'])
  assert.ok(install.body.library.entries.some(entry => entry.name === 'routed-skill'))

  // An empty install request is a bad request, not a crash.
  const empty = await post('/api/dsh-imagegen/canvas/skills/install', {})
  assert.equal(empty.body.ok, false)
  assert.equal(empty.body.code, 'bad-request')

  const removed = await post('/api/dsh-imagegen/canvas/skills/remove', { name: 'routed-skill' })
  assert.equal(removed.body.ok, true, JSON.stringify(removed.body))
  assert.ok(!removed.body.library.entries.some(entry => entry.name === 'routed-skill'))
  const missing = await post('/api/dsh-imagegen/canvas/skills/remove', { name: 'never-installed' })
  assert.equal(missing.body.ok, false)
})

await check('C12c an install the host registry would ignore is refused with copy', async () => {
  // A non-kebab frontmatter name is dropped by the host provider: installing it
  // would look successful and stay unusable in every node.
  const badName = buildZip([{ name: 'b/SKILL.md', body: '---\nname: Bad_Name\ndescription: Wrong shape\n---\n\n# Bad\n' }])
  await assert.rejects(() => host.installFromArchive(badName, skillLibraryRoot, 'b', true), /kebab-case/)
  // Same for a bundle with no description at all.
  const noBlurb = buildZip([{ name: 'b/SKILL.md', body: '---\nname: no-blurb\n---\n\n# No blurb\n' }])
  await assert.rejects(() => host.installFromArchive(noBlurb, skillLibraryRoot, 'b', true), /description/)
  // A user-only skill is a legitimate install: the canvas just cannot run it.
  const userOnly = buildZip([{ name: 'b/SKILL.md', body: '---\nname: human-only\ndescription: Slash command\ndisable-model-invocation: true\n---\n\n# Human\n' }])
  assert.equal(await host.installFromArchive(userOnly, skillLibraryRoot, 'b', true), 'human-only')
  assert.equal(await host.removeSkill('human-only', skillLibraryRoot), 'human-only')

  // The panel explains the same verdicts it would otherwise leave silent.
  const issueRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-issue-'))
  try {
    mkdirSync(join(issueRoot, 'bad-name'), { recursive: true })
    writeFileSync(join(issueRoot, 'bad-name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: Wrong shape\n---\n\n# Bad\n')
    writeFileSync(join(issueRoot, 'loose.md'), '# No frontmatter at all\n')
    const listed = await host.listLibrary({
      root: issueRoot,
      networkAvailable: false,
      issueText: (issue, name) => `${issue}:${name}`,
    })
    const byName = new Map(listed.entries.map(entry => [entry.name, entry]))
    assert.equal(byName.get('Bad_Name').issue, 'bad-name:Bad_Name')
    assert.equal(byName.get('loose').issue, 'no-frontmatter:loose')
    // The disk scan still offers the loadable ones, and only those.
    assert.deepEqual((await host.listLocalSkills(issueRoot)).map(skill => skill.name), [])
  } finally {
    rmSync(issueRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------- C13. per-skill configuration surface

await check('C13a a skill.config.json is validated, bounded and versioned', () => {
  const parsed = host.parseSkillConfigManifest({
    version: 1,
    note: 'secrets stay local',
    fields: [
      { id: 'api-key', label: 'Key', type: 'secret', required: true, expose: true },
      { id: 'base-url', type: 'string', default: 'https://x/v1', expose: true },
      { id: 'Bad_Id', type: 'string' },
      { id: 'mode', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b' }] },
    ],
    apply: [
      { kind: 'command', argv: ['tool', '--key', '{api-key}'], cwd: 'skill' },
      { kind: 'file', path: '~/.x/config.json', content: '{"url":"{base-url}"}' },
      { kind: 'nonsense' },
    ],
  })
  assert.equal(parsed.issue, undefined)
  // A bad field id and an unknown step kind are dropped, not fatal.
  assert.deepEqual(parsed.manifest.fields.map(field => field.id), ['api-key', 'base-url', 'mode'])
  // A secret can never be expository, whatever the declaration says.
  assert.equal(parsed.manifest.fields[0].expose, undefined)
  assert.equal(parsed.manifest.fields[1].expose, true)
  assert.equal(parsed.manifest.steps.length, 2)
  assert.equal(parsed.manifest.steps[0].cwd, 'skill')
  assert.equal(parsed.manifest.note, 'secrets stay local')

  assert.equal(host.parseSkillConfigManifest({ version: 2, fields: [{ id: 'a' }] }).issue, 'unsupported-version')
  assert.equal(host.parseSkillConfigManifest({ version: 1 }).issue, 'empty')
  assert.equal(host.parseSkillConfigManifest('nope').issue, 'unreadable')
  // Caps: only the first 32 fields survive.
  const many = host.parseSkillConfigManifest({
    version: 1,
    fields: Array.from({ length: 40 }, (_value, index) => ({ id: `f${index}` })),
  })
  assert.equal(many.manifest.fields.length, 32)

  // File targets: `~` expands, escapes and DSH control files are refused.
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  assert.equal(host.resolveConfigTarget('~/.editppt/config.yaml').path, join(homedir(), '.editppt', 'config.yaml'))
  assert.equal(host.resolveConfigTarget('relative/path').issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(`${home}/../outside/config.yaml`).issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(join(home, 'settings.yaml')).issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(join(home, 'profiles', 'web', 'package.json')).issue, 'refused-path')
})

await check('C13b apply steps substitute values, honor guards and mask secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-config-'))
  try {
    const parsed = host.parseSkillConfigManifest({
      version: 1,
      fields: [
        { id: 'api-key', label: 'Key', type: 'secret', required: true },
        { id: 'base-url', label: 'URL', type: 'string' },
        { id: 'ocr-token', label: 'OCR', type: 'secret' },
        { id: 'endpoint', label: 'Endpoint', type: 'string', required: true },
      ],
      apply: [
        { kind: 'command', argv: [process.execPath, '-e', 'console.log("echo " + process.argv[1])', '{api-key}'] },
        { kind: 'file', path: join(root, 'out', 'config.json'), content: '{"base":"{base-url}"}' },
        { kind: 'command', argv: [process.execPath, '-e', 'process.exit(9)'], when: { field: 'ocr-token', set: true } },
      ],
    })
    const declaration = { manifest: parsed.manifest, source: 'skill' }
    const values = host.valuesFor(declaration, { values: { 'deck/base-url': 'https://x/v1' }, secrets: { 'deck/api-key': 'sk-super-secret' } }, 'deck')
    assert.equal(values.get('api-key'), 'sk-super-secret')
    assert.deepEqual(host.missingFields(declaration, values), ['Endpoint'])

    const steps = await host.applySkillConfigSteps(declaration, values, { runRoot: root })
    assert.equal(steps.length, 3)
    // The secret is never echoed back to the panel.
    assert.equal(steps[0].ok, true)
    assert.equal(steps[0].detail.includes('sk-super-secret'), false)
    assert.equal(steps[0].output.includes('sk-super-secret'), false)
    assert.match(steps[0].output, /•••/)
    assert.equal(steps[1].ok, true)
    assert.equal(readFileSync(join(root, 'out', 'config.json'), 'utf8'), '{"base":"https://x/v1"}')
    // The guarded step is skipped: its field has no value.
    assert.equal(steps[2].detail, 'skipped')

    // A missing required value stops that step with copy, not a crash.
    const empty = host.valuesFor(declaration, { values: {}, secrets: {} }, 'deck')
    const failed = await host.applySkillConfigSteps(declaration, empty, { runRoot: root })
    assert.equal(failed[0].ok, false)
    assert.match(failed[0].output, /api-key/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C13c the built-in recipe covers image-to-editable-ppt and a sidecar wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-recipe-'))
  try {
    const recipe = await host.readCanvasSkillConfig({ name: 'image-to-editable-ppt', root, store: { values: {}, secrets: {} } })
    assert.equal(recipe.declaration.source, 'plugin')
    assert.deepEqual(recipe.declaration.manifest.fields.map(field => field.id), ['image-api-key', 'image-base-url', 'image-model', 'paddle-ocr-token'])
    // The image API key is optional: a host that already has Codex OAuth does
    // not need one, so nothing is reported missing on a fresh install.
    assert.deepEqual(recipe.view.missing, [])
    assert.equal(recipe.view.applicable, true)
    // The declared command is exactly what the skill documents, and it only runs
    // once a key is actually set — otherwise it would write an empty secret.
    assert.ok(recipe.declaration.manifest.steps[0].argv.includes('editppt'))
    assert.ok(recipe.declaration.manifest.steps[0].argv.includes('{image-api-key}'))
    assert.deepEqual(recipe.declaration.manifest.steps[0].when, { field: 'image-api-key', set: true })
    assert.deepEqual(recipe.declaration.manifest.steps[1].when, { field: 'paddle-ocr-token', set: true })

    // A skill's own sidecar takes over, and a broken one reports why.
    mkdirSync(join(root, 'image-to-editable-ppt'), { recursive: true })
    writeFileSync(join(root, 'image-to-editable-ppt', 'skill.config.json'), JSON.stringify({
      version: 1,
      fields: [{ id: 'own-field', label: 'Own', type: 'string' }],
      apply: [{ kind: 'file', path: join(root, 'own.txt'), content: '{own-field}' }],
    }))
    const own = await host.readCanvasSkillConfig({
      name: 'image-to-editable-ppt',
      entryPath: join(root, 'image-to-editable-ppt', 'SKILL.md'),
      root,
      store: { values: { 'image-to-editable-ppt/own-field': 'x' }, secrets: {} },
    })
    assert.equal(own.declaration.source, 'skill')
    assert.deepEqual(own.declaration.manifest.fields.map(field => field.id), ['own-field'])
    writeFileSync(join(root, 'image-to-editable-ppt', 'skill.config.json'), '{ not json')
    const broken = await host.readCanvasSkillConfig({
      name: 'image-to-editable-ppt',
      entryPath: join(root, 'image-to-editable-ppt', 'SKILL.md'),
      root,
      store: { values: {}, secrets: {} },
      issueText: issue => `copy:${issue}`,
    })
    assert.equal(broken.declaration, undefined)
    assert.equal(broken.view.issue, 'copy:unreadable')

    // A skill with no declaration and no recipe gets no configuration surface.
    const none = await host.readCanvasSkillConfig({ name: 'whatever-skill', root, store: { values: {}, secrets: {} } })
    assert.equal(none.view, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C13d the config routes save and apply through the library backend', async () => {
  const seen = {}
  const previous = { save: skillLibraryFake.configSave, apply: skillLibraryFake.configApply }
  skillLibraryFake.configSave = async request => {
    seen.saved = request
    return { ok: true, library: await skillLibraryFake.list() }
  }
  skillLibraryFake.configApply = async request => {
    seen.applied = request
    return { ok: true, library: await skillLibraryFake.list(), steps: [{ kind: 'command', detail: 'editppt config --api-key •••', ok: true }] }
  }
  try {
    const saved = await post('/api/dsh-imagegen/canvas/skills/config/save', {
      name: 'image-to-editable-ppt',
      values: [{ id: 'image-api-key', value: 'sk-1' }, { bad: true }, { id: 'x' }],
      language: 'zh',
    })
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
    assert.deepEqual(seen.saved, { name: 'image-to-editable-ppt', values: [{ id: 'image-api-key', value: 'sk-1' }], language: 'zh' })

    const applied = await post('/api/dsh-imagegen/canvas/skills/config/apply', { name: 'image-to-editable-ppt', language: 'zh' })
    assert.equal(applied.body.ok, true, JSON.stringify(applied.body))
    assert.equal(applied.body.steps[0].kind, 'command')
    assert.equal(seen.applied.name, 'image-to-editable-ppt')

    const nameless = await post('/api/dsh-imagegen/canvas/skills/config/save', { values: [] })
    assert.equal(nameless.body.ok, false)
    assert.equal(nameless.body.code, 'bad-request')
  } finally {
    skillLibraryFake.configSave = previous.save
    skillLibraryFake.configApply = previous.apply
  }
})

await check('C14 product-link fetching refuses every internal or literal host', async () => {
  for (const url of [
    'http://127.0.0.1:8791/v1/models',
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/x',
    'http://192.168.1.10/x',
    'http://172.20.0.9/x',
    'http://[::1]/x',
    'http://0.0.0.0/x',
    'http://metadata.google.internal/x',
    'http://93.184.216.34/x',
    'file:///etc/passwd',
    'gopher://example.com/x',
  ]) {
    const blocked = await post('/api/dsh-imagegen/ecommerce/fetch-link', { url })
    assert.equal(blocked.status, 200, `${url} answers as a normal envelope`)
    assert.equal(blocked.body.ok, false, `${url} is refused`)
    assert.equal(blocked.body.reason, 'blocked-host', `${url} is refused as an internal host`)
  }
  const empty = await post('/api/dsh-imagegen/ecommerce/fetch-link', {})
  assert.equal(empty.status, 400, 'a missing url is a bad request')
})

await check('C14b product markup extraction prefers JSON-LD and falls back to og', async () => {
  const { extractProductLink } = await import(new URL('src/link-extract.ts', root).href)
  const jsonLd = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"陶瓷杯","image":["/cup.png"],"offers":{"price":"9.9"},"description":"轻。耐热。"}</script>'
  const graph = '<script type="application/ld+json">{"@graph":[{"@type":"WebSite","name":"shop"},{"@type":"Product","name":"玻璃碗","image":"https://cdn.example.com/bowl.jpg","offers":{"price":"19"}}]}</script>'
  const og = '<meta property="og:title" content="帆布包" /><meta property="og:image" content="/bag.jpg" /><meta property="og:description" content="厚实。能装。" />'
  const fromJsonLd = extractProductLink(`<html><head>${jsonLd}</head></html>`, 'https://shop.example.com/p/1')
  assert.equal(fromJsonLd.ok, true, 'a Product node is understood')
  assert.equal(fromJsonLd.title, '陶瓷杯')
  assert.deepEqual(fromJsonLd.images, ['https://shop.example.com/cup.png'], 'relative images resolve against the page')
  assert.equal(fromJsonLd.price, '9.9')
  assert.equal(fromJsonLd.source, 'json-ld')
  const fromGraph = extractProductLink(`<html><head>${graph}</head></html>`, 'https://shop.example.com/p/2')
  assert.equal(fromGraph.title, '玻璃碗', 'a Product node inside @graph is found')
  assert.deepEqual(fromGraph.images, ['https://cdn.example.com/bowl.jpg'])
  const fromOg = extractProductLink(`<html><head>${og}</head></html>`, 'https://shop.example.com/p/3')
  assert.equal(fromOg.ok, true, 'og tags are the fallback')
  assert.equal(fromOg.title, '帆布包')
  assert.deepEqual(fromOg.images, ['https://shop.example.com/bag.jpg'])
  assert.equal(fromOg.source, 'og')
  const nothing = extractProductLink('<html><head></head><body>hello</body></html>', 'https://shop.example.com/p/4')
  assert.equal(nothing.ok, false, 'a page without product markup is refused')
  assert.equal(nothing.reason, 'no-product-data')
  const titleOnly = extractProductLink('<html><head><title>只有标题</title></head></html>', 'https://shop.example.com/p/5')
  assert.equal(titleOnly.title, '只有标题', 'a bare document title is still usable as a name')
})

await new Promise(resolve => server.close(resolve))

// -------------------------------------------------- D. client bundle shape
await check('D1 client bundle registers via __ModuleLoader__ and exposes the canvas raster and conversation-draft helpers', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (h) => { handoff = h } },
    },
  }
  sandbox.window.window = sandbox.window
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined, 'load() was called')
  assert.equal(handoff.id, '@q253595422/dsh-imagegen-video')
  assert.equal(typeof handoff.factory, 'function')
  // Evaluate the factory with stubbed platform modules; only the exports
  // surface is exercised (apply never runs without a real DOM). The react
  // stub needs the top-level APIs the inlined lucide-react icons touch.
  const stubs = {
    'react': {
      Fragment: 'Fragment',
      createContext: (value) => ({ Provider: () => null, Consumer: () => null, _currentValue: value }),
      createElement: () => null,
      forwardRef: (render) => ({ $$typeof: Symbol.for('react.forward_ref'), render }),
      memo: (fn) => ({ $$typeof: Symbol.for('react.memo'), type: fn }),
      useContext: () => ({}),
      useMemo: (factory) => factory(),
      useRef: () => ({ current: null }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    'react-dom': {},
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: (initial) => ({
      getSnapshot: () => initial,
      set: () => {},
      update: () => {},
      subscribe: () => () => {},
    }) },
  }
  const required = []
  const exportsOf = handoff.factory((spec) => {
    required.push(spec)
    const stub = stubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })
  assert.equal([...new Set(required)].sort().join(','), Object.keys(stubs).sort().join(','))
  assert.equal(typeof exportsOf.apply, 'function')
  // Cross-realm array (VM context): compare contents, not identity.
  assert.equal([...exportsOf.inject].join(','), 'slots,locale,connection,sessions,conversation')

  // --- canvas raster helpers (image-ops.ts), reachable only through the bundle
  // Cross-realm values (VM context): spread into local objects before comparing.
  const { containRect, rectBetween, rectToPixels, removeBackground, autoRemoveBackground, transparencyRatio, drawAnnotation, compositeAnnotatedResult } = exportsOf
  const { conversationInput, createConversationDrafts, releaseConversationDrafts, addConversationAttachments, removeConversationAttachment } = exportsOf
  // Letterbox: a 200x100 image inside a 100x100 node body.
  assert.deepEqual({ ...containRect(100, 100, 200, 100) }, { left: 0, top: 25, width: 100, height: 50 })
  // Dragging across the letterboxed image yields the full normalized rect.
  assert.deepEqual(
    { ...rectBetween({ x: 0, y: 25 }, { x: 100, y: 75 }, { left: 0, top: 25, width: 100, height: 50 }) },
    { x: 0, y: 0, width: 1, height: 1 },
  )
  // Drags that leave the image clamp to [0,1] instead of going negative.
  assert.deepEqual(
    { ...rectBetween({ x: -50, y: -50 }, { x: 10, y: 37.5 }, { left: 0, top: 25, width: 100, height: 50 }) },
    { x: 0, y: 0, width: 0.1, height: 0.25 },
  )
  // Normalized rect -> pixels, kept inside the canvas bounds.
  assert.deepEqual({ ...rectToPixels({ x: 0.5, y: 0.5, width: 0.75, height: 0.75 }, 200, 100) }, { x: 100, y: 50, width: 100, height: 50 })

  // Minimal 2D canvas mock: enough of the API for the matting, annotation and
  // composite helpers (createElement/getImageData/putImageData/drawImage/fillRect
  // plus destination-out erasing) to run headless.
  const makeCanvas = (width = 0, height = 0, fill) => {
    let pixels = null
    const canvas = { width, height }
    const ensure = () => {
      const size = canvas.width * canvas.height * 4
      if (pixels === null || pixels.length !== size) {
        pixels = new Uint8ClampedArray(size)
        if (fill !== undefined) fill(pixels, canvas.width, canvas.height)
      }
      return pixels
    }
    // `_data` mirrors a real canvas: allocated lazily, filled by drawImage.
    Object.defineProperty(canvas, '_data', { get: () => ensure(), set: next => { pixels = next } })
    const drawImage = (source, ...args) => {
      const dest = ensure()
      const src = source?._data
      if (src === undefined) return
      const sourceWidth = source.width
      const sourceHeight = source.height
      let sx = 0
      let sy = 0
      let sWidth = sourceWidth
      let sHeight = sourceHeight
      let dx = 0
      let dy = 0
      let dWidth = canvas.width
      let dHeight = canvas.height
      if (args.length === 2) { dx = args[0]; dy = args[1] }
      else if (args.length === 4) { dx = args[0]; dy = args[1]; dWidth = args[2]; dHeight = args[3] }
      else if (args.length === 8) { [sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = args }
      for (let y = 0; y < dHeight; y += 1) {
        const sourceY = Math.min(sourceHeight - 1, sy + Math.floor((y * sHeight) / dHeight))
        for (let x = 0; x < dWidth; x += 1) {
          const sourceX = Math.min(sourceWidth - 1, sx + Math.floor((x * sWidth) / dWidth))
          const from = (sourceY * sourceWidth + sourceX) * 4
          const to = ((dy + y) * canvas.width + dx + x) * 4
          if (to < 0 || to + 3 >= dest.length) continue
          const alpha = src[from + 3] / 255
          if (alpha === 0) continue
          for (let channel = 0; channel < 3; channel += 1) {
            dest[to + channel] = Math.round(src[from + channel] * alpha + dest[to + channel] * (1 - alpha))
          }
          dest[to + 3] = Math.round((alpha + (dest[to + 3] / 255) * (1 - alpha)) * 255)
        }
      }
    }
    const fillRect = (x, y, w, h) => {
      const dest = ensure()
      const erase = canvas.__composite === 'destination-out'
      const hex = /^#([0-9a-f]{6})$/i.exec(String(canvas.__fillStyle ?? ''))
      const red = hex === null ? 0 : parseInt(hex[1].slice(0, 2), 16)
      const green = hex === null ? 0 : parseInt(hex[1].slice(2, 4), 16)
      const blue = hex === null ? 0 : parseInt(hex[1].slice(4, 6), 16)
      for (let py = Math.max(0, Math.round(y)); py < Math.min(canvas.height, Math.round(y + h)); py += 1) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(canvas.width, Math.round(x + w)); px += 1) {
          const offset = (py * canvas.width + px) * 4
          if (erase) { dest[offset] = 0; dest[offset + 1] = 0; dest[offset + 2] = 0; dest[offset + 3] = 0 }
          else { dest[offset] = red; dest[offset + 1] = green; dest[offset + 2] = blue; dest[offset + 3] = 255 }
        }
      }
    }
    canvas.getContext = () => ({
      getImageData: () => ({ data: ensure(), width: canvas.width, height: canvas.height }),
      putImageData: image => { ensure().set(image.data) },
      drawImage,
      fillRect,
      save() {}, restore() {}, strokeRect() {}, fillText() {},
      measureText: () => ({ width: 8 }),
      get fillStyle() { return canvas.__fillStyle ?? '#000000' },
      set fillStyle(value) { canvas.__fillStyle = value },
      get globalCompositeOperation() { return canvas.__composite ?? 'source-over' },
      set globalCompositeOperation(value) { canvas.__composite = value },
    })
    canvas.toDataURL = () => 'data:image/png;base64,AAAA'
    ensure()
    return canvas
  }
  // White backdrop with a red square in the middle.
  const subjectCanvas = makeCanvas(64, 64, (data, width) => {
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const offset = (y * width + x) * 4
        const subject = x >= 20 && x < 44 && y >= 20 && y < 44
        data[offset] = subject ? 220 : 255
        data[offset + 1] = subject ? 40 : 255
        data[offset + 2] = subject ? 60 : 255
        data[offset + 3] = 255
      }
    }
  })
  // image-ops reads globalThis.document inside the VM realm, so the stub has
  // to live on the sandbox global, not on this module's globalThis.
  sandbox.document = { createElement: () => makeCanvas() }
  try {
    const removed = removeBackground(subjectCanvas)
    assert.ok(removed.removedRatio > 0.5 && removed.removedRatio < 0.95, `border backdrop removed, got ${removed.removedRatio}`)
    const output = removed.canvas._data
    assert.equal(output[0 * 4 + 3], 0, 'the corner is fully transparent')
    assert.equal(output[(32 * 64 + 32) * 4 + 3], 255, 'the subject stays opaque')
    assert.equal(output[(32 * 64 + 32) * 4], 220, 'the subject keeps its color')
    assert.equal(output[(0 * 64 + 32) * 4 + 3], 0, 'the top edge is transparent')
    assert.ok(transparencyRatio(removed.canvas) > 0.4, 'the cut-out is detected as transparent')
    // A uniform image has no distinguishable background: nothing is removed.
    const flat = makeCanvas(32, 32, data => data.fill(200))
    assert.equal(autoRemoveBackground(flat).removedRatio, 0, 'a flat image is left untouched')
    // Annotation marks are burned into a copy, not the source.
    const marked = drawAnnotation(subjectCanvas, [{ rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, index: 0 }])
    assert.equal(marked.width, 64)
    assert.equal(marked._data[(0 * 64 + 0) * 4], 255, 'outside the box the pixels are unchanged')
    assert.equal(subjectCanvas._data[(20 * 64 + 20) * 4], 220, 'the source image is not modified')

    // 标注 composite: the model's "result" keeps the marker everywhere, but the
    // final image must show generated pixels only inside the box and the clean
    // original outside it.
    const modelResult = makeCanvas(64, 64, data => { for (let i = 0; i < data.length; i += 4) { data[i] = 7; data[i + 1] = 7; data[i + 2] = 7; data[i + 3] = 255 } })
    const cleanOriginal = makeCanvas(64, 64, data => { for (let i = 0; i < data.length; i += 4) { data[i] = 200; data[i + 1] = 200; data[i + 2] = 200; data[i + 3] = 255 } })
    const composited = compositeAnnotatedResult(modelResult, cleanOriginal, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], 0)
    const pixels = composited._data
    const at = (x, y) => pixels[(y * 64 + x) * 4]
    assert.equal(at(32, 32), 7, 'inside the box the generated content is kept')
    assert.equal(at(4, 4), 200, 'outside the box the clean original is restored')
    assert.equal(at(60, 60), 200, 'the marker in the result is overwritten outside the box')
    // The inset shaves the marker stroke that sits on the box border.
    const inset = compositeAnnotatedResult(modelResult, cleanOriginal, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], 4)._data
    assert.equal(inset[(16 * 64 + 16) * 4], 200, 'the inset restores the pixels right on the box edge')
  } finally {
    delete sandbox.document
  }

  // --- conversation draft bridge (conversation-sync.ts)
  // DSH renamed the image-only draft verbs to attachment-wide ones in 0.1.5
  // (`createDrafts` / `releaseDraftAttachments` / `input.addAttachments`), so
  // the panel must drive whichever pair the running shell exposes instead of
  // calling a verb that no longer exists (#18).
  const modernCalls = []
  const modernInput = {
    addAttachments: (ids) => { modernCalls.push(`add:${ids.join(',')}`); return true },
    removeAttachment: (id) => { modernCalls.push(`remove:${id}`) },
    addImages: () => { throw new Error('the legacy verb was called on a 0.1.5+ shell') },
  }
  const modern = {
    createDrafts: (sessionId, files) => {
      modernCalls.push(`create:${sessionId}:${files.length}`)
      return [{ id: 'draft-1', kind: 'image' }]
    },
    releaseDraftAttachments: (drafts) => { modernCalls.push(`release:${drafts.length}`) },
    createDraftImages: () => { throw new Error('the legacy verb was called on a 0.1.5+ shell') },
  }
  const modernDrafts = createConversationDrafts(modern, 'session-1', ['file'])
  assert.equal(modernDrafts.map(draft => draft.id).join(','), 'draft-1', 'a 0.1.5+ shell hands the drafts back')
  assert.equal(addConversationAttachments(conversationInput(modernInput), modernDrafts.map(draft => draft.id)), true)
  removeConversationAttachment(conversationInput(modernInput), 'draft-1')
  releaseConversationDrafts(modern, modernDrafts)
  assert.equal(modernCalls.join(' | '), 'create:session-1:1 | add:draft-1 | remove:draft-1 | release:1')

  // A 0.1.2 shell keeps the image-only names; the bridge must not reach for the
  // newer verbs there either.
  const legacyCalls = []
  const legacy = {
    createDraftImages: (files) => {
      legacyCalls.push(`createImages:${files.length}`)
      return [{ id: 'legacy-1' }]
    },
    releaseDraftImages: (drafts) => { legacyCalls.push(`releaseImages:${drafts.length}`) },
  }
  const legacyInput = {
    addImages: (ids) => { legacyCalls.push(`addImages:${ids.join(',')}`); return true },
    removeImage: (id) => { legacyCalls.push(`removeImage:${id}`) },
  }
  const legacyDrafts = createConversationDrafts(legacy, 'session-1', ['file'])
  assert.equal(addConversationAttachments(conversationInput(legacyInput), legacyDrafts.map(draft => draft.id)), true)
  removeConversationAttachment(conversationInput(legacyInput), 'legacy-1')
  releaseConversationDrafts(legacy, legacyDrafts)
  assert.equal(legacyCalls.join(' | '), 'createImages:1 | addImages:legacy-1 | removeImage:legacy-1 | releaseImages:1')

  // A shell exposing neither pair reports the gap (the panel shows its
  // localized "unavailable" copy) and release stays a no-op instead of throwing
  // the `releaseDraftImages is not a function` TypeError that masked the real
  // failure in #18.
  assert.equal(createConversationDrafts({}, 'session-1', ['file']), undefined)
  assert.equal(addConversationAttachments(conversationInput({}), ['draft-1']), undefined)
  releaseConversationDrafts({}, [])
  releaseConversationDrafts({}, [{ id: 'draft-1' }])
})

await check('D2 the client bundle ships the canvas skill + file-node surface', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Copy: the skill picker, the polish menu and the file-node strings all ride
  // the same dictionary as every other panel label.
  for (const needle of [
    'canvas.skills.pickerTitle',
    'canvas.skills.fileNode',
    'canvas.skills.pptDesc',
    'canvas.skills.libraryTitle',
    'canvas.skills.installNow',
    'canvas.polish.formal',
    'settings.skillsEnabled',
    'canvas.preview.expand',
    'canvas.preview.textTruncated',
    'canvas.preview.reason.unreadable',
  ]) {
    assert.ok(source.includes(needle), `client bundle is missing ${needle}`)
  }
  // Endpoints: the browser half must call the exact routes the host registers.
  for (const route of [
    '/api/dsh-imagegen/canvas/file/upload',
    '/api/dsh-imagegen/canvas/file/preview',
    '/api/dsh-imagegen/canvas/skills/list',
    '/api/dsh-imagegen/canvas/skills/run',
    '/api/dsh-imagegen/canvas/skills/task',
    '/api/dsh-imagegen/canvas/skills/cancel',
    '/api/dsh-imagegen/canvas/skills/library',
    '/api/dsh-imagegen/canvas/skills/install',
    '/api/dsh-imagegen/canvas/skills/remove',
  ]) {
    assert.ok(source.includes(route), `client bundle is missing route ${route}`)
  }
  // The heavy-tier confirmation and the batch cap are UI-side gates.
  assert.ok(source.includes('canvas.skills.confirmBody'))
  assert.ok(source.includes('canvas.skills.batchTooMany'))
})

/**
 * A DOM node stand-in for the jsdom-free registration check below: enough for
 * the bundle's factory-time stylesheet injection and for `apply`'s
 * document-level marks, and nothing that could stand in for a rendered tree.
 */
function fakeDomNode(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    textContent: '',
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    appendChild(child) { this.children.push(child); return child },
    append(...nodes) { this.children.push(...nodes) },
    insertBefore(child) { return child },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    contains: () => false,
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
}

/** The document the bundle needs before any component renders. */
function fakeDocument() {
  return {
    head: fakeDomNode('head'),
    body: fakeDomNode('body'),
    documentElement: fakeDomNode('html'),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => fakeDomNode(tag),
    createElementNS: (_namespace, tag) => fakeDomNode(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
  }
}

// ------------------- D3 the client surface registers two shell slots, nothing else
await check('D3 the client surface registers the sidebar row and the keyed main panel', async () => {
  // The plugin appears in the shell ONLY through `sidebar.panellist` (the id
  // `imagegen` row) and the keyed `main` panel. Both are registered by
  // `src/client/slot-surface.tsx`, so this applies the REAL built client module
  // against a fake slot registry and reads what it registered. No jsdom: the
  // registry is the whole surface under test, and a DOM tree would only add a
  // second, unrelated way to fail.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (handler) => { handoff = handler } },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: (fn) => setTimeout(fn, 0),
      clearTimeout: (id) => clearTimeout(id),
    },
    // Only the boot path runs here: nothing is rendered, so the document is
    // queried and marked but never painted. The bundle's own entry (the flow
    // adapter's stylesheet) still calls `createElement`/`head.appendChild` at
    // factory time, so the stub answers those too.
    document: fakeDocument(),
    console,
  }
  sandbox.window.window = sandbox.window
  // The settings bridge is unreachable on purpose: an unavailable scope mounts
  // the surface (it is the composition default), so the registrations do not
  // depend on a stubbed host document.
  sandbox.fetch = async () => { throw new Error('no bridge in this check') }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined, 'the client bundle called __ModuleLoader__.load()')
  // Structured stubs, not `() => null`: the registered components are CALLED
  // below, so the element tree has to come back as data.
  const element = (type, props) => ({ type, props: props ?? {} })
  const stubs = {
    'react': {
      Fragment: 'Fragment',
      createContext: (value) => ({ Provider: () => null, Consumer: () => null, _currentValue: value }),
      createElement: element,
      forwardRef: (render) => ({ $$typeof: Symbol.for('react.forward_ref'), render }),
      memo: (fn) => ({ $$typeof: Symbol.for('react.memo'), type: fn }),
      useContext: () => ({}),
      useMemo: (factory) => factory(),
      useRef: () => ({ current: null }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-dom': {},
    'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    // A real snapshot store: the settings scope settles asynchronously and the
    // mount is driven by a notification from it, so a store whose `update` never
    // fans out would leave the surface unregistered and pass for the wrong
    // reason (nothing to see).
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: (initial) => {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        set: (next) => {
          snapshot = next
          for (const fn of [...listeners]) fn()
        },
        update: (mutate) => {
          const draft = { ...snapshot }
          mutate(draft)
          snapshot = draft
          for (const fn of [...listeners]) fn()
        },
        subscribe: (fn) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      }
    } },
  }
  const exportsOf = handoff.factory((spec) => {
    const stub = stubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })
  /** Registrations the fake registry holds right now. */
  const registrations = []
  /** Disposers handed back for each slot key, in registration order. */
  const disposers = new Map()
  const slots = {
    inject(key, callback) {
      // The registry drains what the callback returns at INJECT time: the tool
      // views hand back a generator, the two shell slots one disposer each.
      const result = callback()
      const own = []
      if (typeof result === 'function') own.push(result)
      else if (result !== undefined && result !== null) for (const dispose of result) own.push(dispose)
      disposers.set(key, own)
      return () => { for (const dispose of own) dispose() }
    },
    register(options, component) {
      const row = {
        name: options.name,
        id: options.id,
        key: options.key,
        order: options.order,
        label: options.label,
        component,
      }
      registrations.push(row)
      return () => {
        const at = registrations.indexOf(row)
        if (at >= 0) registrations.splice(at, 1)
      }
    },
  }
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
    locale: {
      register: () => () => {},
      addLanguage: () => () => {},
      getLocale: () => ({ active: 'zh', locales: [], revision: 0 }),
      subscribe: () => () => {},
    },
    slots,
  }
  exportsOf.apply(ctx)
  const ofSlot = name => registrations.filter(row => row.name === name)
  assert.ok(
    await waitUntil(() => ofSlot('sidebar.panellist').length === 1 && ofSlot('main').length === 1),
    `both shell slots register once the scope settles (saw: ${registrations.map(row => row.name).join(', ') || 'nothing'})`,
  )

  // Exactly two shell-slot registrations, with the ids the shell dispatches on.
  const shellSlots = registrations.filter(row => row.name === 'sidebar.panellist' || row.name === 'main')
  assert.equal(shellSlots.length, 2, 'the client registers exactly the sidebar row and the main panel')
  const [row] = ofSlot('sidebar.panellist')
  assert.equal(row.id, 'imagegen', 'the sidebar row carries the panel id the shell dispatches on')
  assert.equal(row.order, 20, 'the row sorts after the shell rows 0 and 10, i.e. right after 任务')
  assert.equal(row.label(), '创作', 'the sidebar row is the 创作 entry')
  const [main] = ofSlot('main')
  assert.equal(main.key, 'imagegen', 'the main panel is keyed by the same id')
  assert.equal(main.label(), '创作', 'the main panel is labelled 创作 too')
  // Nothing else may claim a shell seat: the column, the sidebar region and the
  // conversation are the shell's own surfaces.
  const allowed = new Set(['sidebar.panellist', 'main', 'settings.section', 'tool.call.toolview'])
  assert.deepEqual(
    [...new Set(registrations.map(row => row.name))].filter(name => !allowed.has(name)),
    [],
    'the client registers no other slot',
  )

  // The row's icon is a bare SVG on the shell's own 16px grid: no wrapper
  // element (the shell renders the returned node into its row), one colour, and
  // the 创作 glyph — a rounded picture frame with a sparkle on its top-right.
  assert.equal(typeof row.component, 'function', 'the sidebar row registers a component')
  const icon = row.component({})
  assert.equal(icon.type, 'svg', 'the row component returns the SVG itself, with no wrapper element')
  assert.equal(icon.props.viewBox, '0 0 16 16')
  assert.equal(icon.props.width, 16, 'the icon defaults to 16px')
  assert.equal(icon.props.height, 16)
  assert.equal(icon.props['aria-hidden'], 'true', 'the icon is decorative: the row carries the label')
  assert.equal(icon.props.stroke, 'currentColor', 'one colour, inherited from the shell row')
  const shapes = icon.props.children.flat(Infinity).filter(child => child !== null && typeof child === 'object')
  const frame = shapes.find(child => child.type === 'rect')
  const sparkle = shapes.find(child => child.type === 'path')
  assert.ok(frame !== undefined && Number(frame.props.rx) > 0, 'the glyph draws a rounded picture frame')
  assert.ok(sparkle !== undefined, 'the glyph draws its sparkle')
  assert.equal(sparkle.props.fill, 'currentColor', 'the sparkle is filled with the same currentColor')

  // Disposing the surface must release both seats, or a disabled plugin leaves a
  // dead row and a panel the shell can never unload.
  for (const key of ['sidebar.panellist', 'main']) {
    for (const dispose of disposers.get(key) ?? []) dispose()
  }
  assert.deepEqual(
    registrations.filter(row => row.name === 'sidebar.panellist' || row.name === 'main').map(row => row.name),
    [],
    'the two disposers remove both registrations',
  )
})

// ------------------------------- D6 plugin display title (the plugin details page)
await check('D6 the plugin declares its own display title in both locales', () => {
  // WHY: the plugin details page draws the title from `locale/<lang>.json`'s
  // `meta.title`, NOT from the package name. The host falls back to the full
  // specifier (`@scope/dsh-imagegen-video`) when no locale declares one, which
  // is exactly what the page showed before this title existed: a wall of
  // package name where the product name belongs. Dropping `meta.title` again
  // silently restores that -- nothing else in the suite would notice, because
  // the field is display-only and no runtime path reads it.
  const read = lang => JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'))
  const zh = read('zh')
  const en = read('en')
  for (const [lang, file] of [['zh', zh], ['en', en]]) {
    assert.equal(typeof file.meta?.title, 'string', `${lang}.json declares meta.title`)
    assert.ok(file.meta.title.trim() !== '', `${lang}.json's meta.title is not blank`)
    assert.equal(typeof file.meta?.description, 'string', `${lang}.json still declares meta.description`)
  }
  assert.equal(zh.meta.title, '创作', 'the Chinese plugin page shows the product name, not the package name')
  // The host builds `{ en: <manifest name>, ...languageEntries }`, so `en.json`
  // must win over that fallback rather than repeat it.
  assert.doesNotMatch(en.meta.title, /^@|dsh-imagegen/, 'the English title is a product name, not the package specifier')
  // The name the user sees has to be the name the panel and the sidebar show.
  const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  assert.ok(locales.includes("'panel.title': '创作'"), 'the studio panel header carries the same name')
  assert.ok(locales.includes("'entry.creative': '创作'"), 'the sidebar entry carries the same name')
})

// --------------- E. full client apply in jsdom (boot path + tool views)
await check('E1 client apply registers the tool views and the settings section (jsdom)', async () => {
  const { JSDOM } = await import('jsdom')
  // The shell DOM the plugin boots against. The plugin itself renders only into
  // the two slots (D3 owns that registration contract); what this fixture adds
  // is the shell chrome `apply` reaches for: the settings dialog's trigger and
  // its section navigation.
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN"><head></head><body>'
    + '<div data-pane="sidebar"><div class="logoRow"><button class="newSession">New session</button></div></div>'
    + '</body></html>',
    { pretendToBeVisual: true },
  )
  const jsdomWindow = dom.window
  const jsdomDocument = jsdomWindow.document
  let confirmationCalls = 0
  // The copy is recorded, not just counted: a confirmation that names the wrong
  // number ("delete 0 assets") is a real defect that a call count cannot see.
  // `confirmationAnswer` is what the stub returns, so a check that needs the
  // action to actually run can opt in for one click.
  const confirmationMessages = []
  let confirmationAnswer = false
  let nativeNewSessionCalls = 0
  const nativeNewSession = jsdomDocument.querySelector('.newSession')
  nativeNewSession.addEventListener('click', () => { nativeNewSessionCalls += 1 })
  jsdomWindow.confirm = (message) => {
    confirmationCalls += 1
    confirmationMessages.push(String(message ?? ''))
    return confirmationAnswer
  }
  // jsdom has no ResizeObserver; the canvas measures its viewport with one.
  jsdomWindow.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // Pointer capture is a no-op here; the annotation drag only needs the events.
  jsdomWindow.Element.prototype.setPointerCapture = function setPointerCapture() {}
  jsdomWindow.Element.prototype.releasePointerCapture = function releasePointerCapture() {}
  jsdomWindow.Element.prototype.hasPointerCapture = function hasPointerCapture() { return true }
  // Headless 2D canvas: white backdrop with a red square, nearest-neighbour
  // drawImage (source rect aware, like the real API) and a fixed PNG data URL.
  const paintSample = (data, width, height) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        const subject = x >= width * 0.3 && x < width * 0.7 && y >= height * 0.3 && y < height * 0.7
        data[offset] = subject ? 220 : 255
        data[offset + 1] = subject ? 40 : 255
        data[offset + 2] = subject ? 60 : 255
        data[offset + 3] = 255
      }
    }
  }
  jsdomWindow.HTMLCanvasElement.prototype.getContext = function getContext(type) {
    // WebGL backgrounds opt out (the real jsdom build has no GL either).
    if (type !== '2d') return null
    const canvas = this
    const ensure = () => {
      const size = Math.max(1, canvas.width * canvas.height * 4)
      if (canvas.__pixels === undefined || canvas.__pixels.length !== size) {
        canvas.__pixels = new Uint8ClampedArray(size)
        if (canvas.__painted === true) paintSample(canvas.__pixels, canvas.width, canvas.height)
      }
      return canvas.__pixels
    }
    const drawImage = (source, ...args) => {
      const dest = ensure()
      const src = source?.__pixels
      if (src === undefined) {
        canvas.__painted = true
        paintSample(dest, canvas.width, canvas.height)
        return
      }
      let sx = 0
      let sy = 0
      let sWidth = source.width
      let sHeight = source.height
      let dx = 0
      let dy = 0
      let dWidth = canvas.width
      let dHeight = canvas.height
      if (args.length === 2) { dx = args[0]; dy = args[1] }
      else if (args.length === 4) { dx = args[0]; dy = args[1]; dWidth = args[2]; dHeight = args[3] }
      else if (args.length === 8) { [sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = args }
      for (let y = 0; y < dHeight; y += 1) {
        const sourceY = Math.min(source.height - 1, sy + Math.floor((y * sHeight) / dHeight))
        for (let x = 0; x < dWidth; x += 1) {
          const sourceX = Math.min(source.width - 1, sx + Math.floor((x * sWidth) / dWidth))
          const from = (sourceY * source.width + sourceX) * 4
          const to = ((dy + y) * canvas.width + dx + x) * 4
          if (to < 0 || to + 3 >= dest.length) continue
          // Source-over compositing: fully transparent source pixels leave the
          // destination untouched (the real canvas does the same).
          const alpha = src[from + 3] / 255
          if (alpha === 0) continue
          for (let channel = 0; channel < 3; channel += 1) {
            dest[to + channel] = Math.round(src[from + channel] * alpha + dest[to + channel] * (1 - alpha))
          }
          dest[to + 3] = Math.round((alpha + (dest[to + 3] / 255) * (1 - alpha)) * 255)
        }
      }
    }
    const fillRect = (x, y, w, h) => {
      const dest = ensure()
      const hex = /^#([0-9a-f]{6})$/i.exec(String(canvas.__fillStyle ?? ''))
      const red = hex === null ? 0 : parseInt(hex[1].slice(0, 2), 16)
      const green = hex === null ? 0 : parseInt(hex[1].slice(2, 4), 16)
      const blue = hex === null ? 0 : parseInt(hex[1].slice(4, 6), 16)
      const erase = canvas.__composite === 'destination-out'
      for (let py = Math.max(0, Math.round(y)); py < Math.min(canvas.height, Math.round(y + h)); py += 1) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(canvas.width, Math.round(x + w)); px += 1) {
          const offset = (py * canvas.width + px) * 4
          if (erase) { dest[offset] = 0; dest[offset + 1] = 0; dest[offset + 2] = 0; dest[offset + 3] = 0 }
          else { dest[offset] = red; dest[offset + 1] = green; dest[offset + 2] = blue; dest[offset + 3] = 255 }
        }
      }
    }
    return {
      getImageData: () => ({ data: ensure(), width: canvas.width, height: canvas.height }),
      putImageData: image => { ensure().set(image.data) },
      drawImage,
      fillRect,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
      strokeRect() {}, clearRect() {}, fillText() {}, scale() {},
      measureText: () => ({ width: 8 }),
      strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '', lineCap: '', lineJoin: '',
      get fillStyle() { return canvas.__fillStyle ?? '#000000' },
      set fillStyle(value) { canvas.__fillStyle = value },
      get globalCompositeOperation() { return canvas.__composite ?? 'source-over' },
      set globalCompositeOperation(value) { canvas.__composite = value },
    }
  }
  jsdomWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,QUJD'

  // Stateful bridge stub: describe + mutate (same wire shapes as the routes).
  // The redacted view never returns the key; the secrets sidecar tracks it.
  const keyState = { set: false, ids: {} }
  const configState = {
    enabled: true,
    announceToAgent: true,
    channels: [{
      id: 'default',
      preset: '',
      name: 'Default',
      apiUrl: 'https://example.test/v1',
      models: [
        { alias: 'gpt-image-2', id: 'gpt-image-2' },
        { alias: 'gpt-image-2-alt', id: 'gpt-image-2' },
      ],
      videoModels: [
        { alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' },
      ],
    }],
    defaultChannelId: 'default',
    defaultModel: 'gpt-image-2-alt',
    defaultVideoModel: 'agnes-video-2.5-flash',
    promptModel: 'chat-test',
  }
  const channelSecrets = () => [{ path: ['channelSecrets', 'default'], set: keyState.set }]
  const mutateCalls = []
  let rejectNextSettingsMutation = false
  const ecommerceSubmissions = []
  /** Replica submissions are kept separate so its queue lifecycle can be
   * asserted without borrowing the ecommerce fixture's completion rules. */
  const replicaSubmissions = []
  const replicaTasks = []
  const replicaTaskListReads = []
  const replicaTaskGetReads = []
  /** Canvas generation requests submitted from the workspace composer. */
  const canvasTasks = []
  /** Documents the workspace persisted through /canvas/save. */
  const canvasSaves = []
  /** 宿主真正接受（返回 ok）的画布写入。和 `canvasSaves` 的区别是：撞冲突和
   *  被拒的请求也会进 `canvasSaves`，所以「有没有把内容写进去」只能看这一份。 */
  const canvasCommitted = []
  /** Every gallery mutation the panel issued, in order (see the gallery stubs). */
  const galleryMutations = []
  const galleryAppends = []
  const conversationImageStages = []
  /** Video tasks the panel sees when polling, and submissions it makes. */
  const videoTasks = []
  const videoSubmissions = []
  // #38: the record the shared diagnostics panel reads. The video studio opens
  // the SAME buffer the image tray does, so the fixture is one entry whose phase
  // names a video leg -- if the panel reached a different surface, or reached
  // nothing, this is what would show it.
  const diagnosticsEntries = [{
    id: 'diag-1',
    at: Date.now(),
    phase: 'video-submit',
    channel: 'Default',
    model: 'agnes-video-2.5-flash',
    mode: 'text',
    url: 'https://example.test/v1/videos',
    method: 'POST',
    status: 400,
    failureCode: 'video-submit-failed',
    message: '视频提交失败（HTTP 400）',
    durationMs: 12,
    hadAuth: true,
  }]
  let diagnosticsListCalls = 0
  // L0: the behaviour report the signals panel reads. One bucket with a real
  // sample, one that is deliberately under MIN_SAMPLE -- the second is the
  // state that must render as "no verdict" rather than as a healthy row.
  const signalsReport = {
    generatedAt: Date.now(),
    total: 40,
    windowDays: 90,
    byKind: { retry: 30, delete: 6, failure: 4, rating: 0 },
    byPipeline: { image: 30, video: 10, canvas: 0, skill: 0 },
    buckets: [
      {
        pipeline: 'image', model: 'gpt-image-2', mode: 'text', promptBucket: 'medium', hasReference: false,
        total: 30, retry: 18, delete: 3, failure: 2, rating: 0,
        retryRate: 0.6, deleteRate: 0.1, failureRate: 0.067, ratingRate: 0,
        verdict: 'warn', verdictMetric: 'retry',
        reasons: { unlike: 0, text: 0, slow: 0, misread: 0 },
      },
      {
        pipeline: 'video', model: 'agnes-video-2.5-flash', mode: 'text', promptBucket: 'short', hasReference: false,
        total: 10, retry: 3, delete: 1, failure: 0, rating: 0,
        retryRate: 0.3, deleteRate: 0.1, failureRate: 0, ratingRate: 0,
        verdict: 'unknown', verdictMetric: '',
        reasons: { unlike: 0, text: 0, slow: 0, misread: 0 },
      },
    ],
    findings: [{
      id: 'retry:image:gpt-image-2:text:medium',
      severity: 'warn',
      metric: 'retry',
      scope: 'image · gpt-image-2 · text · prompt:medium · no-ref',
      value: 0.6,
      sample: 30,
      zh: '重试率 60%（18/30）——提示词长度档 medium 下，这个组合的结果经常要再来一次',
      en: 'Retry rate 60% (18/30) — results for this combination are often asked for twice',
    }],
    gaps: { monthsRead: 1, truncated: [] },
    issue: { title: 'signal', body: '# signal', url: 'https://github.com/x/y/issues/new?title=signal&body=%23%20signal' },
  }
  let signalsReportCalls = 0
  /** Clip history the sidebar must merge with the image history. */
  const videoHistoryEntries = [
    {
      id: 'clip-new', createdAt: 6, mode: 'text', model: 'agnes-video-2.5-flash',
      prompt: 'a clip newest', aspectRatio: '16:9', resolution: '720P', seconds: 5,
      videos: [{ url: '/api/dsh-imagegen/video/file/clip-new-0.mp4', mime: 'video/mp4', duration: 5 }],
    },
    {
      id: 'clip-mid', createdAt: 3, mode: 'text', model: 'agnes-video-2.5-flash',
      prompt: 'a clip middle', aspectRatio: '9:16', resolution: '1080P', seconds: 10,
      videos: [{ url: '/api/dsh-imagegen/video/file/clip-mid-0.mp4', mime: 'video/mp4', duration: 10 }],
    },
  ]
  const videoHistoryRemovals = []
  /** How many times the client asked for the clip list. The sidebar loads it
   *  once behind initialDataRequestedRef, so any second read proves the
   *  completion-triggered refetch ran (a finished clip used to stay invisible
   *  until the whole app was reloaded). */
  let videoHistoryListCalls = 0
  /** How many times the client asked for the video task queue. Counted so a
   *  check can prove the video tab's submit/cancel goes through the PARENT's
   *  single poller (one extra read) instead of the tab starting its own. */
  let videoTaskListCalls = 0
  /** Ids the video tab asked the host to cancel, in order. */
  const videoCancellations = []
  /** Canvas video runs, recorded so the canvas test can assert the request. */
  const canvasVideoSubmissions = []
  /** Assets the canvas uploaded during a frame grab. */
  const canvasGrabUploads = []
  const canvasImageAsset = {
    assetId: `${'a'.repeat(64)}.png`,
    url: `/api/dsh-imagegen/canvas/asset/${'a'.repeat(64)}.png`,
    mime: 'image/png',
    bytes: 128,
    width: 64,
    height: 64,
    origin: 'upload',
  }
  let canvasUploads = 0
  /** One stored text file, addressed the way the real content-addressed store is. */
  const canvasFileAsset = {
    assetId: `${'c'.repeat(64)}.txt`,
    url: `/api/dsh-imagegen/canvas/asset/${'c'.repeat(64)}.txt`,
    mime: 'text/plain',
    bytes: 48,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name: 'notes.txt',
    textPreview: '文件预览正文',
  }
  /** One stored PDF, the document type the browser renders itself. */
  const canvasPdfAsset = {
    assetId: `${'d'.repeat(64)}.pdf`,
    url: `/api/dsh-imagegen/canvas/asset/${'d'.repeat(64)}.pdf`,
    mime: 'application/pdf',
    bytes: 1024,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name: 'paper.pdf',
  }
  /** Preview requests the canvas file nodes issued (assetId + hints). */
  const previewRequests = []
  /** Every fetch path the client issued (debug aid for the canvas tools). */
  const requestPaths = []
  /** Canvases the client asked the host to create. A brand-new canvas is a
   *  DRAFT until the first edit, so this must stay empty on a first-run screen
   *  and become exactly one entry on the first node. */
  const canvasCreations = []
  /** When true, `/canvas/list` answers with an empty library — the state a fresh
   *  install is in. */
  let canvasLibraryEmpty = false
  const canvasDocument = {
    version: 2,
    id: 'canvas-smoke',
    title: 'Smoke canvas',
    revision: 1,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'dots',
    nodes: [],
    connections: [],
    createdAt: 1,
    updatedAt: 1,
  }
  /** A second canvas the project switch can land on. */
  const canvasDocument2 = {
    ...canvasDocument,
    id: 'canvas-two',
    title: 'Second canvas',
    nodes: [{ id: 'node-second', type: 'text', title: 'second', x: 0, y: 0, width: 280, height: 150, metadata: { text: 'second canvas' } }],
  }
  /** Saves the check parks mid-flight, so a superseded answer can be released
   *  on demand instead of racing a real timer. */
  const heldSaves = []
  let heldSaveBudget = 0
  /** While > 0, canvas saves answer with a failure instead of committing. Used
   *  to pin the "a failed save stops retrying" rule (F13). */
  let failSaveBudget = 0
  /** How many save requests answered with a failure. */
  let failedSaveAttempts = 0
  /**
   * 另一个窗口在这张画布上的改动。设了之后，`/canvas/read` 返回它而不是 fixture，
   * 且前 `conflictSaveBudget` 次 `/canvas/save` 一律回 `canvas-conflict`——这正是
   * 浏览器在上面那个窗口里保存过、宿主 revision 已经变了的样子。
   *
   * 用「先撞一次冲突、再读回」复现真实现场：服务端不是拒绝写入，而是一个窗口的
   * 保存把 revision 推到了另一个窗口看不见的地方。
   */
  let remoteCanvas = null
  let conflictSaveBudget = 0
  /**
   * 有多少次保存被判定为与另一个窗口冲突。和 `failedSaveAttempts` 分开：冲突
   * 会有后续读回和一次重试，混在一起数就看不出「是不是真的合并了」。
   */
  let conflictAttempts = 0
  /** PPT conversions this run submitted / sources it uploaded / tasks it lists. */
  const pptSubmissions = []
  const pptUploaded = []
  let pptClientTasks = []
  /** Requests the deck preview issued for `/canvas/file/preview`. */
  const deckPreviewRequests = []
  const fetchStub = async (input, init) => {
    const path = String(input)
    requestPaths.push(path)
    // Tool-result attachments are served as bytes by the host route; the tool
    // view then turns the blob into an object URL. Without this branch the
    // view shows its load error instead of the generated image.
    if (path.startsWith('/api/dsh-imagegen/agent-image?')) {
      return { ok: true, blob: async () => new Blob([pngBytes], { type: 'image/png' }) }
    }
    // The outfit workspace reads its draft on mount and keeps its fields
    // disabled until that read settles. Without this branch the read threw,
    // `draftLoaded` stayed false, the whole `<fieldset>` stayed disabled — and
    // every outfit assertion then ran against dead controls: a click on
    // 角色搭配 was swallowed by the browser because the button was disabled,
    // so `aria-checked` never moved and E1 failed for a reason that had nothing
    // to do with the mode switch it was meant to cover. `null` is the honest
    // answer here: this sandbox has no saved draft.
    if (path.endsWith('/outfit/draft')) {
      // Both directions answer `null`: there is no saved draft here, and a
      // later save in this sandbox has nothing to read back.
      return { ok: true, json: async () => ({ ok: true, value: null }) }
    }
    if (path.endsWith('/settings/describe')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            namespaces: [{
              ns: 'dsh-imagegen',
          value: configState,
          revision: 0,
          secrets: channelSecrets(),
            }],
            writable: true,
          },
        }),
      }
    }
    if (path.endsWith('/video/tasks/list')) {
      videoTaskListCalls += 1
      // Completed tasks expose the served clip (mirroring the host summary), so
      // the canvas can fill its placeholder without a second round trip.
      const tasks = videoTasks.map(task => task.status === 'completed'
        ? {
            ...task,
            resultAvailable: true,
            resultUrl: '/api/dsh-imagegen/video/file/vt-1-0.mp4',
            resultVideo: { url: '/api/dsh-imagegen/video/file/vt-1-0.mp4', mime: 'video/mp4', duration: 5 },
            resultEntryId: 'video-entry-1',
          }
        : { ...task, resultAvailable: false })
      return { ok: true, json: async () => ({ ok: true, tasks }) }
    }
    // #38: the two diagnostics routes the shared panel reads. They live on the
    // same client as the video studio, so the stub has to answer them or the
    // panel's own open action throws instead of showing the record.
    if (path.endsWith('/diagnostics/list')) {
      diagnosticsListCalls += 1
      return { ok: true, json: async () => ({ ok: true, entries: diagnosticsEntries }) }
    }
    if (path.endsWith('/diagnostics/clear')) {
      diagnosticsEntries.length = 0
      return { ok: true, json: async () => ({ ok: true }) }
    }
    // L0: the behaviour report. `windowDays` is echoed back from the request so
    // the panel's active-window button and the numbers it shows cannot drift.
    if (path.endsWith('/signals/report')) {
      signalsReportCalls += 1
      const days = Number(init?.body === undefined ? 90 : JSON.parse(String(init.body)).windowDays ?? 90)
      return { ok: true, json: async () => ({ ok: true, report: { ...signalsReport, windowDays: days } }) }
    }
    if (path.endsWith('/signals/record')) {
      return { ok: true, json: async () => ({ ok: true, entry: undefined }) }
    }
    if (path.endsWith('/signals/list')) {
      return { ok: true, json: async () => ({ ok: true, months: [], entries: [] }) }
    }
    if (path.endsWith('/signals/clear')) {
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (path.endsWith('/video/history/list')) {
      videoHistoryListCalls += 1
      // One clip, interleaved chronologically with the image fixture below:
      // createdAt 6 (newer than every image entry) and createdAt 3 (between the
      // comparison group at 2 and the ecommerce set at 4/5).
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: videoHistoryEntries,
        }),
      }
    }
    if (path.endsWith('/video/history/remove')) {
      const body = JSON.parse(init.body)
      videoHistoryRemovals.push(body.id)
      const index = videoHistoryEntries.findIndex(entry => entry.id === body.id)
      if (index >= 0) videoHistoryEntries.splice(index, 1)
      return { ok: true, json: async () => ({ ok: true, entries: videoHistoryEntries }) }
    }
    if (path.endsWith('/video/history/clear')) {
      videoHistoryEntries.length = 0
      return { ok: true, json: async () => ({ ok: true, entries: [] }) }
    }
    if (path.endsWith('/gallery/video')) {
      return { ok: true, json: async () => ({ ok: true, entries: [], added: true }) }
    }
    // The clip bytes themselves, so "add to chat" can build a real File. Both
    // clip routes are covered: the gallery's favorites and the video store's
    // history clips (the sidebar row uses the latter).
    if (path.includes('/gallery/video-file/') || path.includes('/video/file/')) {
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' }),
      }
    }
    if (path.endsWith('/code/probe')) {
      // The composer asks this before a code run so it can warn about a missing
      // ffmpeg BEFORE a chat call is spent. Report it as available here; the
      // warning branch is covered by its own case in the code-render suite.
      return { ok: true, json: async () => ({ ok: true, probe: { width: 1280, height: 720, fps: 30, seconds: 5, frames: 150, ffmpegAvailable: true, ffmpegPath: '/usr/local/bin/ffmpeg' } }) }
    }
    if (path.endsWith('/video/tasks/submit')) {
      const body = JSON.parse(init.body)
      videoSubmissions.push(body)
      // A canvas-originated run is recorded separately so the canvas test can
      // assert its lineage without confusing it with a studio submission.
      if (body.canvas !== undefined) canvasVideoSubmissions.push(body)
      const task = { id: `vt-${videoSubmissions.length}`, request: body, status: 'queued', createdAt: Date.now() }
      videoTasks.push(task)
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/video/tasks/cancel')) {
      const body = JSON.parse(init.body)
      videoCancellations.push(body.id)
      const task = videoTasks.find(entry => entry.id === body.id)
      if (task !== undefined) task.status = 'cancelled'
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/settings/mutate')) {
      const payload = JSON.parse(init.body)
      mutateCalls.push(payload)
      if (rejectNextSettingsMutation) {
        rejectNextSettingsMutation = false
        return {
          ok: true,
          json: async () => ({ ok: false, code: 'revision-conflict', message: 'settings changed; reload and retry' }),
        }
      }
      for (const op of payload.ops) {
        if (op.path[0] === 'channels' && op.op === 'set') configState.channels = op.value
        if (op.path[0] === 'defaultChannelId') {
          if (op.op === 'set') configState.defaultChannelId = op.value
          else delete configState.defaultChannelId
        }
        if (op.path[0] === 'defaultModel') {
          if (op.op === 'set') configState.defaultModel = op.value
          else delete configState.defaultModel
        }
        if (op.path[0] === 'defaultVideoModel') {
          if (op.op === 'set') configState.defaultVideoModel = op.value
          else delete configState.defaultVideoModel
        }
        // Every channel id, not just `default`: a delete has to clear the
        // removed id's entry, and the stub must show that it really went away.
        if (op.path[0] === 'channelSecrets') {
          const id = op.path[1]
          if (op.op === 'set') keyState.ids[id] = op.value
          else delete keyState.ids[id]
          if (id === 'default') keyState.set = op.op === 'set'
        }
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            ns: 'dsh-imagegen',
            value: configState,
            revision: 1,
            secrets: channelSecrets(),
          },
        }),
      }
    }
    if (path.endsWith('/history/list')) {
      const comparisonHistory = {
        comparisonId: 'client-comparison',
        comparisonModels: ['gpt-image-2', 'grok-imagine-image'],
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          // Newest-first, exactly like the host: history-store prepends each new
          // entry ([entry, ...readIndex()]), so array order is insertion order,
          // newest first. A fixture in ascending order would misrepresent the
          // contract the sidebar's two-list merge relies on.
          entries: [
            { id: 'history-plain', createdAt: 7, mode: 'text', model: 'gpt-image-2', prompt: 'plain image prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/plain.png', mime: 'image/png' }] },
            { id: 'hist-ecom-2', createdAt: 5, mode: 'text', model: 'gpt-image-2', prompt: 'product selling point', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/ecom2.png', mime: 'image/png' }], workflow: 'ecommerce', projectId: 'project-hist', projectName: '历史保温杯', slotKey: 'sp-1', slotLabel: '卖点图' },
            { id: 'hist-ecom-1', createdAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'product main image', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/ecom1.png', mime: 'image/png' }], workflow: 'ecommerce', projectId: 'project-hist', projectName: '历史保温杯', slotKey: 'main-1', slotLabel: '主图' },
            { id: 'history-grok', createdAt: 2, mode: 'text', model: 'grok-imagine-image', prompt: 'compare prompt', size: '1:1', quality: '4k', detail: '', n: 1, images: [{ url: '/history/grok.png', mime: 'image/png' }], ...comparisonHistory },
            { id: 'history-gpt', createdAt: 1, mode: 'text', model: 'gpt-image-2', prompt: 'compare prompt', size: '1:1', quality: '4k', detail: '', n: 1, images: [{ url: '/history/gpt.png', mime: 'image/png' }], ...comparisonHistory },
          ],
        }),
      }
    }
    if (path.endsWith('/gallery/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { id: 'gallery-one', createdAt: 3, mode: 'text', model: 'gpt-image-2', prompt: 'gallery prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/gallery.png', mime: 'image/png' }] },
            { id: 'gallery-two', createdAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'wide gallery prompt', size: '4:3', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/wide.png', mime: 'image/png' }] },
            // A favorited clip: the host stores it by reference, with NO images.
            {
              id: 'gallery-clip', createdAt: 8, mode: 'video', model: 'agnes-video-2.5-flash',
              prompt: 'favorited clip', size: '16:9', quality: '', detail: '', n: 1, images: [],
              video: { url: '/api/dsh-imagegen/gallery/video-file/gallery-clip-0.mp4', mime: 'video/mp4', duration: 5 },
            },
          ],
          // Two soft-deleted entries. Two, not one, because the restore check
          // below brings one back and the trash section unmounts when the last
          // entry leaves it -- with a single fixture the purge button would have
          // been gone by the time the purge check looked for it, which reads as
          // "purge is not rendered" rather than as a fixture that ran out.
          trash: [
            { id: 'gallery-trashed', createdAt: 2, deletedAt: 9, mode: 'text', model: 'gpt-image-2', prompt: 'trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed.png', mime: 'image/png' }] },
            { id: 'gallery-trashed-2', createdAt: 1, deletedAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'older trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed2.png', mime: 'image/png' }] },
          ],
        }),
      }
    }
    if (path.endsWith('/gallery/append')) {
      const payload = JSON.parse(init.body).entry
      galleryAppends.push(payload)
      return {
        ok: true,
        json: async () => ({
          ok: true,
          added: true,
          entries: [{ ...payload, id: `gallery-appended-${galleryAppends.length}`, images: [{ url: '/api/dsh-imagegen/gallery/image/appended.png', mime: payload.images[0]?.mime ?? 'image/png' }] }],
        }),
      }
    }
    if (path.endsWith('/conversation-image')) {
      conversationImageStages.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    // Every gallery mutation answers with the same { entries, trash } pair. The
    // stubs used to be absent, so a client calling one of these threw, the
    // caller's catch swallowed it, and the test stayed green while the UI showed
    // nothing — a silent hole rather than a failure.
    if (path.endsWith('/gallery/remove') || path.endsWith('/gallery/restore') || path.endsWith('/gallery/purge') || path.endsWith('/gallery/clear') || path.endsWith('/gallery/tags')) {
      galleryMutations.push({ path: path.split('/').pop(), body: init?.body ?? null })
      const trashed = { id: 'gallery-trashed', createdAt: 2, deletedAt: 9, mode: 'text', model: 'gpt-image-2', prompt: 'trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed.png', mime: 'image/png' }] }
      // The sibling stays in the trash after the other one is restored, so the
      // purge check still has a rendered section to find its button in.
      const sibling = { id: 'gallery-trashed-2', createdAt: 1, deletedAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'older trashed prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/trashed2.png', mime: 'image/png' }] }
      const purged = path.endsWith('/gallery/purge')
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: path.endsWith('/gallery/restore') ? [trashed, { id: 'gallery-one', createdAt: 3, mode: 'text', model: 'gpt-image-2', prompt: 'gallery prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/gallery.png', mime: 'image/png' }] }] : [],
          trash: purged ? [] : path.endsWith('/gallery/restore') ? [sibling] : [trashed, sibling],
        }),
      }
    }
    if (path.endsWith('/canvas/list')) {
      const summaryOfCanvas = doc => ({ id: doc.id, title: doc.title, revision: doc.revision, nodeCount: doc.nodes.length, createdAt: 1, updatedAt: 1 })
      // A brand-new install has no canvases at all. Only the first-run check
      // flips this: every other case assumes the two fixtures are there.
      const projects = canvasLibraryEmpty
        ? []
        : [summaryOfCanvas(canvasDocument), summaryOfCanvas(canvasDocument2), ...canvasCreations.map(summaryOfCanvas)]
      return { ok: true, json: async () => ({ ok: true, projects }) }
    }
    if (path.endsWith('/canvas/read')) {
      const requested = JSON.parse(init.body).id
      if (remoteCanvas !== null && requested === remoteCanvas.id) {
        return { ok: true, json: async () => ({ ok: true, document: remoteCanvas }) }
      }
      const found = requested === canvasDocument2.id ? canvasDocument2 : canvasDocument
      return { ok: true, json: async () => ({ ok: true, document: found }) }
    }
    if (path.endsWith('/canvas/create')) {
      const payload = JSON.parse(init.body ?? '{}')
      const created = {
        version: 2,
        id: `canvas-created-${canvasCreations.length + 1}`,
        title: payload.title ?? '未命名画布',
        revision: 1,
        viewport: { x: 0, y: 0, k: 1 },
        background: 'lines',
        nodes: [],
        connections: [],
        createdAt: 1,
        updatedAt: 1,
      }
      canvasCreations.push(created)
      return { ok: true, json: async () => ({ ok: true, document: created }) }
    }
    if (path.endsWith('/canvas/bundle/export')) {
      // The client turns the bundle into a Blob and clicks a download link; this
      // sandbox only needs the route answered so the flow completes.
      const payload = JSON.parse(init.body ?? '{}')
      return {
        ok: true,
        json: async () => ({
          ok: true,
          bundle: { version: 1, document: canvasSaves.at(-1) ?? { ...canvasDocument, id: payload.id }, assets: {}, unresolved: [] },
        }),
      }
    }
    if (path.endsWith('/canvas/save')) {
      const payload = JSON.parse(init.body)
      canvasSaves.push(payload.document)
      if (failSaveBudget > 0) {
        failSaveBudget -= 1
        failedSaveAttempts += 1
        // A plain failure, not a conflict: the conflict path reads the canvas
        // back and retries once, which would muddy the count below.
        return { ok: true, json: async () => ({ ok: false, code: 'write-failed', message: '宿主写入失败' }) }
      }
      if (conflictSaveBudget > 0) {
        conflictSaveBudget -= 1
        conflictAttempts += 1
        return { ok: true, json: async () => ({ ok: false, code: 'canvas-conflict', message: '画布已在其他窗口修改' }) }
      }
      // Recorded before the hold: a check can see the request landed while its
      // answer is still parked.
      if (heldSaveBudget > 0) {
        heldSaveBudget -= 1
        await new Promise(resolve => { heldSaves.push(resolve) })
      }
      // 只有真的被宿主接受的写入才进这里。`canvasSaves` 记的是「请求发出去了」，
      // 撞冲突和被拒的请求同样在里面；判断「这一笔到底落没落盘」必须看这份。
      canvasCommitted.push(payload.document)
      return { ok: true, json: async () => ({ ok: true, document: { ...payload.document, revision: payload.document.revision + 1 } }) }
    }
    if (path.endsWith('/ppt/tasks')) {
      return { ok: true, json: async () => ({ ok: true, tasks: pptClientTasks }) }
    }
    if (path.endsWith('/ppt/run')) {
      const payload = JSON.parse(init.body)
      pptSubmissions.push(payload)
      // The conversion drops the source images from its result: the panel shows
      // the produced deck, never the uploads.
      const task = {
        id: 'ppt-client-1', canvasId: 'ppt', skillId: 'ppt.fromImages', label: 'PPT',
        tier: 'heavy', status: 'completed', startedAt: Date.now(), pptImages: payload.images,
        output: {
          nodes: [{
            id: 'ppt-file', type: 'file', title: 'final.pptx',
            metadata: { asset: { assetId: 'deck.pptx', url: '/api/dsh-imagegen/canvas/asset/deck.pptx', name: 'final.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: 12, width: 0, height: 0, origin: 'upload' } },
          }],
          connections: [], warnings: [],
        },
      }
      pptClientTasks = [task]
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/canvas/skills/list')) {
      return { ok: true, json: async () => ({ ok: true, skills: [], installed: ['image-to-editable-ppt'], agentAvailable: true, registryAvailable: true }) }
    }
    if (path.endsWith('/canvas/skills/library')) {
      return { ok: true, json: async () => ({ ok: true, library: { entries: [] } }) }
    }
    if (path.includes('/canvas/file/upload?')) {
      const name = new URL(path, 'http://localhost').searchParams.get('name')
      const asset = {
        assetId: `${pptUploaded.length + 1}.png`,
        url: `/api/dsh-imagegen/canvas/asset/${pptUploaded.length + 1}.png`,
        mime: init.headers['content-type'], name, bytes: 12, width: 12, height: 12, origin: 'upload',
      }
      pptUploaded.push(asset)
      return { ok: true, json: async () => ({ ok: true, asset }) }
    }
    if (path.endsWith('/canvas/file/preview')) {
      // The real host decodes the asset; the fixture stands in with the decoded
      // shape so the reader can be exercised end to end.
      const payload = JSON.parse(init.body)
      previewRequests.push(payload)
      // A deck decodes to one card per slide; everything else stays text. The
      // PPT panel reads THIS shape (it previews the produced PPTX, not the
      // source images), so returning text for a .pptx would leave its viewer
      // empty and the check would pass on nothing.
      if (payload.assetId === 'preview-retry.pptx') deckPreviewRequests.push(payload)
      const slides = payload.assetId === 'deck.pptx' || payload.assetId === 'preview-retry.pptx'
      return {
        ok: true,
        json: async () => ({
          ok: true,
          preview: slides
            ? {
                kind: 'slides',
                format: 'pptx',
                slides: [
                  { title: 'AI PLATFORM ROADMAP', lines: ['第一页可编辑内容'], images: [] },
                  { title: 'NEXT STEPS', lines: ['第二页可编辑内容'], images: [] },
                ],
                truncated: false,
              }
            : { kind: 'text', format: 'txt', text: '文件预览正文\nsecond line\nthird line', truncated: false, lines: 3 },
        }),
      }
    }
    if (path.endsWith('/canvas/asset/upload')) {
      canvasUploads += 1
      const payload = JSON.parse(init.body)
      return {
        ok: true,
        json: async () => ({
          ok: true,
          asset: {
            assetId: `${String(canvasUploads).padStart(64, 'b')}.png`,
            url: `/api/dsh-imagegen/canvas/asset/${String(canvasUploads).padStart(64, 'b')}.png`,
            mime: 'image/png',
            bytes: 64,
            width: payload.width,
            height: payload.height,
            origin: payload.origin ?? 'upload',
          },
        }),
      }
    }
    if (path.endsWith('/canvas/layers')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          plan: {
            layers: [
              { kind: 'background', label: '背景' },
              { kind: 'object', label: '人物', rect: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } },
              { kind: 'text', label: '标题', rect: { x: 0.1, y: 0.08, width: 0.6, height: 0.12 }, text: '夏日限定', color: '#ffee00' },
            ],
          },
        }),
      }
    }
    if (path.startsWith('/api/dsh-imagegen/canvas/asset/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.startsWith('/history/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.startsWith('/api/dsh-imagegen/gallery/image/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.endsWith('/templates/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          sourceId: 'vibeui',
          cases: [{
            id: 1,
            title: 'Template poster',
            prompt: 'A reusable template prompt',
            category: 'Posters & Typography',
            categoryZh: '海报与排版',
            styles: [],
            scenes: [],
            sourceLabel: '@author',
            sourceUrl: '',
            githubUrl: '',
            image: '',
            featured: false,
          }],
          total: 1,
          origin: 'bundled',
          repository: 'example/templates',
          fetchedAt: '2026-08-19T00:00:00.000Z',
        }),
      }
    }
    if (path.endsWith('/templates/favorites/list')) {
      return { ok: true, json: async () => ({ ok: true, favorites: [] }) }
    }
    if (path.endsWith('/templates/sample')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          samples: [{
            sourceId: 'vibeui',
            case: { id: 1, title: 'Template poster', prompt: 'A reusable template prompt', category: 'Posters & Typography', categoryZh: '海报与排版', styles: [], scenes: [], sourceLabel: '@author', sourceUrl: '', githubUrl: '', image: '', featured: false },
          }],
        }),
      }
    }
    if (path.endsWith('/tasks/submit')) {
      const payload = JSON.parse(init.body)
      if (payload.refName === 'shot.png') {
        replicaSubmissions.push(payload)
        const task = {
          id: `replica-task-${replicaSubmissions.length}`,
          request: payload,
          status: 'queued',
          createdAt: Date.now(),
        }
        replicaTasks.push(task)
        return { ok: true, json: async () => ({ ok: true, task }) }
      }
      ecommerceSubmissions.push(payload)
      if (payload.canvas !== undefined) canvasTasks.push(payload)
      // Freeze the id eagerly: the json() closure runs after all concurrent
      // submits pushed, so a lazy template literal would hand every response
      // the same id.
      const task = { id: `ecommerce-task-${ecommerceSubmissions.length}`, request: payload, status: 'queued', createdAt: 1 }
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/tasks/get')) {
      const requestedId = JSON.parse(init.body).id
      const replicaMatch = /^replica-task-(\d+)$/.exec(requestedId)
      if (replicaMatch !== null) {
        const payload = replicaSubmissions[Number(replicaMatch[1]) - 1]
        replicaTaskGetReads.push(requestedId)
        // A hydration can fail once while the host task keeps running. The
        // replica pane must retry instead of abandoning a healthy render.
        if (replicaTaskGetReads.filter(id => id === requestedId).length === 1) {
          return { ok: true, json: async () => ({ ok: false, code: 'temporary', message: 'temporary poll failure' }) }
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            task: {
              id: requestedId,
              request: payload,
              status: 'completed',
              createdAt: Date.now(),
              result: { images: [{ b64: pngBytes.toString('base64'), mime: 'image/png' }] },
            },
          }),
        }
      }
      const match = /^ecommerce-task-(\d+)$/.exec(requestedId)
      const index = match === null ? -1 : Number(match[1]) - 1
      const payload = index < 0 ? undefined : ecommerceSubmissions[index]
      if (payload === undefined) {
        return { ok: true, json: async () => ({ ok: false, code: 'not-found', message: 'task not found' }) }
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          task: {
            id: requestedId,
            request: payload,
            status: index === 0 ? 'completed' : 'queued',
            createdAt: 1,
            ...index === 0 ? { result: { images: [{ b64: 'cG5nLWRhdGE=', mime: 'image/png' }] } } : {},
          },
        }),
      }
    }
    if (path.endsWith('/tasks/list')) {
      if (replicaTasks.length > 0) replicaTaskListReads.push(Date.now())
      const replicaSummaries = replicaTasks.map(task => {
        const elapsed = Date.now() - task.createdAt
        task.status = elapsed < 1200 ? 'queued' : elapsed < 2200 ? 'running' : 'completed'
        const request = { ...task.request }
        delete request.image
        delete request.images
        return {
          ...task,
          request,
          resultAvailable: task.status === 'completed',
        }
      })
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: [
            ...ecommerceSubmissions.map((payload, index) => {
              const request = { ...payload }
              delete request.image
              delete request.images
              return {
                id: `ecommerce-task-${index + 1}`,
                request,
                status: index === 0 ? 'completed' : 'queued',
                createdAt: 1,
                resultAvailable: index === 0,
              }
            }),
            ...replicaSummaries,
          ],
        }),
      }
    }
    // The two routes the form workspaces submit to. Answered here so a submit
    // click completes instead of landing on the catch-all below: the checks that
    // count requests need the request to be recorded, and a throw here would
    // also paint an error into the workspace a later check reads.
    if (path.endsWith('/generate')) {
      return { ok: true, json: async () => ({ ok: true, images: [{ mime: 'image/png', b64: pngBytes.toString('base64') }] }) }
    }
    if (path.endsWith('/prompt-enhance')) {
      return { ok: true, json: async () => ({ ok: true, prompt: JSON.stringify({ title: '促销标题', body: '促销正文', tags: ['好物'] }) }) }
    }
    throw new Error(`unexpected fetch: ${path}`)
  }

  // Evaluate the bundle in a jsdom-backed sandbox.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  // react-flow（d3-zoom 读 navigator、updateNodeInternals 读 DOMMatrixReadOnly、
  // 节点测量需 ResizeObserver 真报尺寸）需要这些裸全局；jsdom 默认没有。
  jsdomWindow.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe(target) { setTimeout(() => this.callback([{ target, contentRect: { width: 200, height: 100 }, borderBoxSize: [{ inlineSize: 200, blockSize: 100 }] }], this), 0) }
    unobserve() {}
    disconnect() {}
  }
  jsdomWindow.DOMMatrixReadOnly = class { constructor() { this.m11 = 1; this.m22 = 1; this.m41 = 0; this.m42 = 0; this.a = 1; this.d = 1; this.e = 0; this.f = 0 } }
  jsdomWindow.DOMMatrix = jsdomWindow.DOMMatrixReadOnly
  const sandbox = {
    window: jsdomWindow,
    document: jsdomDocument,
    MutationObserver: jsdomWindow.MutationObserver,
    ResizeObserver: jsdomWindow.ResizeObserver,
    navigator: jsdomWindow.navigator,
    DOMMatrixReadOnly: jsdomWindow.DOMMatrixReadOnly,
    DOMMatrix: jsdomWindow.DOMMatrix,
    setTimeout: jsdomWindow.setTimeout.bind(jsdomWindow),
    clearTimeout: jsdomWindow.clearTimeout.bind(jsdomWindow),
    requestAnimationFrame: jsdomWindow.requestAnimationFrame?.bind(jsdomWindow) ?? (cb => setTimeout(() => cb(Date.now()), 0)),
    cancelAnimationFrame: jsdomWindow.cancelAnimationFrame?.bind(jsdomWindow) ?? clearTimeout,
    getComputedStyle: jsdomWindow.getComputedStyle?.bind(jsdomWindow),
    CustomEvent: jsdomWindow.CustomEvent,
    HTMLElement: jsdomWindow.HTMLElement,
    FileReader: jsdomWindow.FileReader,
    // Generated-image conversation actions decode base64 before handing a
    // browser File to the host. vm contexts do not inherit Node's web globals,
    // so expose the same codecs a real browser provides.
    atob,
    btoa,
    // image-ops decodes asset URLs through `new Image()`; jsdom never loads
    // resources, so the stub resolves onload on the next tick.
    Image: class SmokeImage {
      constructor() { this.naturalWidth = 0; this.naturalHeight = 0 }
      set src(value) {
        this._src = value
        setTimeout(() => {
          this.naturalWidth = 64
          this.naturalHeight = 64
          this.onload?.()
        }, 0)
      }
      get src() { return this._src }
    },
    fetch: fetchStub,
    // The tool view turns a fetched blob into an <img> source. jsdom ships
    // neither, and the bundle reads them off the global scope.
    URL: class SmokeURL extends URL {
      static createObjectURL() { return 'blob:image-toolview-smoke' }
      static revokeObjectURL() {}
    },
    URLSearchParams,
    console,
  }
  // jsdom's window.window is a getter-only property; only plain-object
  // sandboxes need the self-reference.
  if (!('window' in sandbox.window)) sandbox.window.window = sandbox.window
  sandbox.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined)

  const registered = []
  // Locale runtime stub: register/addLanguage/subscribe + a snapshot, mirroring
  // the dsh-client-locale face the plugin bridges into.
  const localeListeners = new Set()
  // Records what the composer rail receives, so the clip-attachment path can be
  // asserted without a real GUI.
  const conversationDrafts = []
  const conversationInputs = []
  const conversationPromptDrafts = []
  const conversationStub = {
    createDrafts: (sessionId, files) => files.map((file, index) => {
      conversationDrafts.push({ sessionId: String(sessionId), name: file.name, type: file.type, size: file.size })
      return { id: `draft-${index + 1}`, kind: /^image\//.test(file.type) ? 'image' : 'file' }
    }),
    releaseDraftAttachments: () => {},
    input: {
      for: () => ({
        addAttachments: (ids) => { conversationInputs.push(...ids); return true },
        removeAttachment: () => {},
        state: { getSnapshot: () => ({ draft: '' }) },
        setDraft: (value) => { conversationPromptDrafts.push(value) },
      }),
    },
  }
  /**
   * Session-list feed in the host's REAL snapshot shape, plus one deliberate
   * extra.
   *
   * `SessionListState` is `{ ids, byId, phase, projectionsBySession }` — it has
   * no `current`, so the old stub's `{ current: 'session-smoke' }` was inventing
   * a field no host has. That made this suite green while "add to conversation"
   * was unreachable in the app.
   *
   * The `current` below is NOT a host field: it is the stub's stand-in for
   * "there is a reachable session to target", which the real host does expose
   * through a different door (the `main`-slot session binding, not
   * `sessions.list`). The panel still reads `current`; with it absent the flow
   * degrades to the picker and every assertion here would be testing the
   * degrade path instead. Pinned by `session-picker` assertions below, and
   * flagged in `src/client/session-target.ts` as the open gap.
   */
  const sessionsStub = {
    list: {
      getSnapshot: () => ({
        ids: ['session-smoke'],
        byId: { 'session-smoke': { sessionId: 'session-smoke', cwd: '/tmp/session-smoke', running: false, blank: false, agentAvailable: true, updatedAt: 0, displayTitle: 'smoke session' } },
        phase: 'ready',
        projectionsBySession: {},
        current: 'session-smoke',
      }),
      subscribe: () => () => {},
    },
    scope: () => ({ sessionId: 'session-smoke' }),
  }
  const ctx = {
    effect(fn) { return fn() },
    on() { return () => {} },
    get(name) {
      // A page served through a loopback reverse proxy is NOT a loopback
      // authority in the browser (the address bar carries the LAN/public
      // hostname), yet its requests reach the host from 127.0.0.1. The
      // settings card must probe the bridge instead of pre-blocking on this
      // flag; every settings assertion below is the regression guard for that.
      if (name === 'connection') return { isLoopback: false }
      // The panel reads the conversation service from the context; without it
      // the "add to chat" actions cannot be exercised at all.
      if (name === 'conversation') return conversationStub
      // The panel resolves the current session through `sessions`, and its
      // chat-attachment actions no-op without one. Supplying a minimal list
      // feed is what makes those actions reachable at all.
      if (name === 'sessions') return sessionsStub
      return undefined
    },
    locale: {
      register() {},
      addLanguage() { return () => {} },
      getLocale() { return { active: 'zh', locales: [], revision: 0 } },
      subscribe(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn) },
    },
    slots: {
      // The Web UI plugin group slot is already declared.
      // `inject` may return an iterable of disposers (the tool-view registrations
      // yield one per tool), and `register` takes the component as a second
      // argument — a stub that dropped it made every toolview check vacuous.
      inject(key, callback) {
        const result = callback()
        if (result?.[Symbol.iterator]) for (const _dispose of result) { /* drain */ }
        return () => {}
      },
      register(options, component) { registered.push({ ...options, component }); return () => {} },
    },
  }
  // react-dom (outer realm) reads the bare `window`/`document` globals at
  // render time (dev-branch event priority, event delegation); expose the
  // jsdom ones for the render.
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = jsdomWindow
  globalThis.document = jsdomDocument
  const react = await import('react')
  const moduleStubs = {
    'react': react,
    'react/jsx-runtime': await import('react/jsx-runtime'),
    'react-dom': await import('react-dom'),
    'react-dom/client': await import('react-dom/client'),
    // Minimal functional stubs for the system primitives (the real GUI loads
    // the genuine platform module from the module table).
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: ({ variant, size, className, children, ...rest }) =>
        react.createElement('button', { type: 'button', className, ...rest }, children),
      Pill: ({ active, className, children, onClick, ...rest }) =>
        react.createElement(onClick ? 'button' : 'span', {
          type: 'button',
          className,
          ...(onClick !== undefined ? { onClick } : {}),
          ...rest,
        }, children),
      SegmentedControl: ({ id, value, options, onChange, label, disabled = false, className }) =>
        react.createElement('div', { role: 'tablist', 'aria-label': label, className },
          options.map(option => react.createElement('button', {
            key: option.value,
            id: `${id}-${option.value}`,
            type: 'button',
            role: 'tab',
            'aria-selected': option.value === value,
            tabIndex: option.value === value ? 0 : -1,
            disabled: disabled || option.disabled === true,
            title: option.title,
            onClick: () => { if (option.value !== value) onChange(option.value) },
          }, option.label))),
      useModalLayer: () => {},
      IconListPenOutlineRegular: () => null,
      IconCloseOutlineRegular: () => null,
    },
    // The real runtime module touches `window` at import time and cannot load
    // in a bare Node realm; this minimal store mirrors the snapshot-store
    // contract (mutable-draft update, wholesale set, subscriber fan-out) that
    // the plugin's scope lifecycle depends on.
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: (initial) => {
        let snapshot = initial
        const listeners = new Set()
        return {
          getSnapshot: () => snapshot,
          set: (next) => {
            snapshot = next
            for (const fn of [...listeners]) fn()
          },
          update: (mutator) => {
            const draft = { ...snapshot }
            mutator(draft)
            snapshot = draft
            for (const fn of [...listeners]) fn()
          },
          subscribe: (fn) => {
            listeners.add(fn)
            return () => { listeners.delete(fn) }
          },
        }
      },
    },
  }
  const exportsOf = handoff.factory((spec) => {
    const stub = moduleStubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })

  exportsOf.apply(ctx)
  // In-app prompts must open Settings through its rendered dialog affordances
  // and select the image-generation section.
  const settingsTrigger = jsdomDocument.createElement('button')
  settingsTrigger.setAttribute('aria-haspopup', 'dialog')
  settingsTrigger.setAttribute('aria-label', '设置')
  const settingsNavButton = jsdomDocument.createElement('button')
  settingsNavButton.textContent = '生图 / 生视频'
  let settingsSectionClicks = 0
  settingsNavButton.addEventListener('click', () => { settingsSectionClicks += 1 })
  settingsTrigger.addEventListener('click', () => {
    const dialog = jsdomDocument.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = jsdomDocument.createElement('nav')
    nav.append(settingsNavButton)
    dialog.append(nav)
    jsdomDocument.body.append(dialog)
  })
  jsdomDocument.body.append(settingsTrigger)
  jsdomWindow.dispatchEvent(new jsdomWindow.CustomEvent('dsh-imagegen:open-config'))
  assert.ok(await waitUntil(() => settingsSectionClicks === 1), 'in-app configure prompts select the settings.section entry')
  jsdomDocument.querySelector('[role="dialog"]')?.remove()
  settingsTrigger.remove()
  // The panel itself is the shell's `main` slot from here on; what the surface
  // registers (and nothing more) is D3's subject. This check stops at the boot
  // path: the locale dictionaries, the tool views, the settings section and the
  // in-app configure prompt all mounted against the real bundle.
  await new Promise(resolve => setTimeout(resolve, 25))
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
})

await new Promise(resolve => upstream.close(resolve))

// ------------------------------------------------------------------ summary
console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST OK')
process.exit(process.exitCode === 1 ? 1 : 0)
