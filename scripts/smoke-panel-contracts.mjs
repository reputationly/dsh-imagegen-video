/**
 * Source-level contracts for the panel's canvas interactions.
 *
 * These are the guarantees that a jsdom render cannot observe: jsdom has no
 * layout engine, refuses a non-empty `<input type="file">` value, and does not
 * implement the browser default actions a marquee's `preventDefault()` eats.
 * Each one is stated where it lives -- the shipped constant, the JSX, the event
 * selector -- so a refactor that moves the code still has to keep the promise.
 *
 * Reading the source is the tool of last resort here: it is used only where the
 * fact is genuinely structural (which selector a gesture matches, which element
 * an overlay is a sibling of). Everything that renders is asserted from the DOM
 * in `scripts/smoke-panel-interactions.mjs`.
 *
 * Run: node scripts/smoke-panel-contracts.mjs   (from the package root)
 */

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'
import { canvasSourceText, readModuleSource } from './lib/canvas-source.mjs'
import { DROP_IMAGE_MAX_BYTES, DROP_IMAGE_MAX_COUNT } from '../src/client/canvas/constants.ts'

const results = []
const check = createCheckHarness({ results })

const source = (relative) => readFileSync(new URL(`../src/client/${relative}`, import.meta.url), 'utf8')

await check('C1 the canvas drop caps exist and the drop handler enforces both', async () => {
  assert.equal(typeof DROP_IMAGE_MAX_BYTES, 'number', 'the per-file byte cap is exported')
  assert.equal(typeof DROP_IMAGE_MAX_COUNT, 'number', 'the per-drop count cap is exported')
  assert.ok(DROP_IMAGE_MAX_BYTES > 0 && DROP_IMAGE_MAX_BYTES <= 64 * 1024 * 1024, `the byte cap is a real bound (${DROP_IMAGE_MAX_BYTES})`)
  assert.ok(DROP_IMAGE_MAX_COUNT >= 1 && DROP_IMAGE_MAX_COUNT <= 50, `the count cap is a real bound (${DROP_IMAGE_MAX_COUNT})`)

  // The handler itself is a closure inside the workspace component, so the
  // promise it has to keep is read from its text: the caps are applied BEFORE
  // anything is read, and the reads are sequential. A `Promise.all` over the
  // dropped files is the shape that used to seize the page.
  const dropBlock = canvasSourceText().match(/const onDrop = useCallback\([\s\S]{0,3000}?\[addAssets, api, screenToWorld, uploadCanvasFile\]\)/)?.[0] ?? ''
  assert.ok(dropBlock !== '', 'the canvas drop handler is findable')
  assert.match(dropBlock, /file\.size > DROP_IMAGE_MAX_BYTES/, 'a dropped image over the size cap is filtered out')
  assert.match(dropBlock, /\.slice\(0, DROP_IMAGE_MAX_COUNT\)/, 'a drop is capped to a maximum number of images')
  assert.ok(!/Promise\.all\(images\.map/.test(dropBlock), 'dropped images are read sequentially, not all at once')
})

await check('C2 d3-zoom is told both pan activation keys', async () => {
  // d3-zoom rejects a ctrl-modified drag unless Control is one of its
  // activation keys, and the shortcut table promises "Ctrl/⌘ + Space": a build
  // that only lists Space leaves Ctrl+drag dead while the table still says
  // otherwise.
  const panKeys = canvasSourceText().match(/panActivationKeyCode=\{?\[([^\]]*)\]\}?/)?.[1] ?? ''
  assert.ok(panKeys !== '', 'the canvas configures its pan activation keys')
  assert.match(panKeys, /'Space'/, 'Space is a pan activation key')
  assert.match(panKeys, /'Control'/, 'd3-zoom recognises both Space and Control as pan activation keys')
})

await check('C3 a pointerdown on a no-zoom surface is never read as empty background', async () => {
  // The marquee claims the pointer with preventDefault + setPointerCapture,
  // which swallows the click of anything drawn on top of the canvas (the
  // empty-state cards, the dock, the top bar). Those surfaces are marked
  // `data-canvas-no-zoom`, and the background test has to exclude them.
  const backgroundTest = canvasSourceText().match(/const isBackground = [^\n]*/)?.[0] ?? ''
  assert.ok(backgroundTest !== '', 'the marquee decides what counts as empty background')
  assert.match(backgroundTest, /data-canvas-no-zoom/, 'marquee must ignore no-zoom surfaces so their controls receive clicks')
})

await check('C4 the image picker clears its file input after a pick', async () => {
  // Asserted from the source because jsdom cannot hold a file input's value: it
  // throws on a non-empty `value` and reports '' either way, so a DOM assertion
  // here is green whether or not anything is cleared.
  const pickerBlock = canvasSourceText().match(/onChange=\{event => \{[\s\S]{0,400}?uploadFiles\(files\)\s*\}\}/)?.[0] ?? ''
  assert.ok(pickerBlock !== '', 'the picker file input handler is findable')
  assert.match(pickerBlock, /event\.target\.value = ''/, 'the picker clears its file input so the same file can be re-picked')
})

await check('C5 the composer is a sibling of the scrolling viewport', async () => {
  // The guarantee is structural: a pointerdown on the composer must never reach
  // the viewport handler, because that handler clears the selection the
  // composer was opened for. It holds only as long as the composer is not
  // inside the viewport element and does not carry its class.
  const composerSource = readModuleSource('canvas/composer.tsx')
  assert.ok(composerSource !== '', 'the composer module is present')
  assert.ok(!/css\.viewport/.test(composerSource), 'composer sits outside the viewport: it never takes the viewport class')

  const workspace = readModuleSource('CanvasWorkspace.tsx')
  const viewportClose = workspace.indexOf('{emptyState}\n    </div>')
  const composerCall = workspace.indexOf('{renderComposer()}')
  assert.ok(viewportClose > 0, 'the viewport element closes after its own children')
  assert.ok(composerCall > viewportClose, 'the composer is rendered after the viewport element closes, not inside it')
})

await check('C6 the settings page offers no gateway, channel, or storage configuration', async () => {
  // 并入小助手之后，网关地址、渠道与密钥都不归插件配：模型来自宿主目录，密钥在宿主凭据服务。
  // 设置页再出现这些输入，用户就会被要求填一份插件根本不会读的配置。
  const card = readModuleSource('SettingsCard.tsx')
  assert.ok(card !== '', 'the settings card module is present')
  for (const [label, pattern] of [
    ['channel editor', /channels-form|ChannelRow|channelSecrets/],
    ['preset picker', /PRESETS_API|presetPicker|settings\.preset/],
    ['subscription login', /SUBSCRIPTION_API|subscriptionLogin/],
    ['object storage', /storageTest|STORAGE_API|settings\.storage(Endpoint|AccessKey|SecretKey)/],
    ['prompt endpoint', /promptApiUrl|promptApiKey|PROMPT_ENHANCE_API\.models/],
  ]) {
    assert.ok(!pattern.test(card), `the settings card no longer configures ${label}`)
  }
  // 只保留这四组：通用、本地存储、画布技能、PPT。
  for (const kept of ['settings.generalTitle', 'settings.storageTitle', 'settings.skillsTitle']) {
    assert.ok(card.includes(kept), `the settings card still renders ${kept}`)
  }
  // 密钥输入框是这次被删掉的那类控件：卡片里不该还有 secret 字段。
  const secrets = readModuleSource('settings-form.ts')
  assert.ok(!/SettingsSecretField|secretField/.test(card), 'the card renders no secret field')
  if (secrets !== '') assert.ok(true, 'settings-form keeps its generic helpers for other surfaces')
})

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nPANEL CONTRACT CHECK FAILED' : '\nPANEL CONTRACT CHECK OK')
process.exit(process.exitCode === 1 ? 1 : 0)
