/**
 * Rendered checks for the interactions the panel and its canvas own.
 *
 * The panel is mounted the way the shell mounts it -- through the `main#imagegen`
 * slot registration -- and then driven with real pointer, keyboard and change
 * events. Everything asserted here is a behaviour a user can lose without any
 * source-level trace: a marquee that eats a click on the empty-state cards, a
 * Space key that stops activating the focused button, a composer that ends up
 * inside the scrolling viewport.
 *
 * What it proves:
 *
 *   P1  the empty canvas offers six quick-start cards, and the first node
 *       removes them (they are an empty state, not chrome)
 *   P2  a background drag starts a marquee, a held Space/Control leaves the
 *       pointer to the pan gesture, and a `data-canvas-no-zoom` surface is
 *       never read as background
 *   P3  Space activates the focused control instead of arming the pan tool,
 *       and is still claimed on the canvas itself
 *   P4  the composer is outside the viewport, so a click on its margin cannot
 *       clear the selection that opened it
 *   P5  the shortcut table opens from the dock and from `?`, Escape closes it,
 *       and the undo control names its key
 *   P6  Escape closes the in-canvas video preview and the timeline editor
 *   P7  pinning an identity reaches the saved document, not just the badge
 *   P8  the trash restores each entry by its own id, states its count once, and
 *       says how many entries a purge will drop
 *   P9  the video studio offers the diagnostics record and the behaviour
 *       report even with zero tasks
 *   P10 the outfit form stays interactive when no draft can be read
 *   P11 one click on promo's submit issues exactly one generation
 *   P12 two touch pointers moving apart zoom in (pinch is the only zoom a touch
 *       device has)
 *   P13 the inspiration wall yields to a clip that is playing
 *
 * It drives the BUILT `lib/client.js`, so `pnpm build` has to have run
 * (`pnpm test` builds before this suite does). Offline and deterministic: every
 * host route is answered by the fetch stub below, no network or host process is
 * involved, and the jsdom window plus the temp data root are torn down at the
 * end of the file.
 *
 * Run: node scripts/smoke-panel-interactions.mjs   (from the package root)
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'

const results = []

/**
 * Uncaught errors raised inside jsdom callbacks, captured where jsdom reports
 * them: React errors in an observer or an event handler are handed to the
 * window's virtual console as `jsdomError`, never rethrown into Node, so a
 * render that dies after the assertions would otherwise pass silently.
 */
const { VirtualConsole } = await import('jsdom')
const collectedConsole = new VirtualConsole()
const domErrors = []
collectedConsole.on('jsdomError', (error) => { domErrors.push(error) })

const check = createCheckHarness({ results })

/** The data root this suite points the plugin at, removed in the teardown below. */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-imagegen-panel-'))

const cleanups = []

/* ------------------------------------------------------------------ fixture */

const { JSDOM } = await import('jsdom')
const dom = new JSDOM(
  '<!doctype html><html lang="zh-CN"><head></head><body>'
  + '<div data-pane="sidebar"><div class="logoRow"><button class="newSession">New session</button></div></div>'
  + '<div data-pane="conversation"><div data-slot="conversation"><div data-conversation-scroll></div></div></div>'
  + '<div class="smoke_centerCol">'
  + '<div data-slot="main" style="display: contents">'
  + '<div data-slot="main.conversation" style="display: contents"><div class="smoke_root" data-phase="hero"></div></div>'
  + '</div>'
  + '</div>'
  + '</body></html>',
  { pretendToBeVisual: true, virtualConsole: collectedConsole },
)
const jsdomWindow = dom.window
const jsdomDocument = dom.window.document

// jsdom ships no layout or observer machinery; the canvas measures itself, and
// react-flow reads both of these while placing nodes.
jsdomWindow.ResizeObserver = class {
  constructor (callback) { this.callback = callback }
  observe (target) { setTimeout(() => this.callback([{ target, contentRect: { width: 200, height: 100 }, borderBoxSize: [{ inlineSize: 200, blockSize: 100 }] }], this), 0) }
  unobserve () {}
  disconnect () {}
}
jsdomWindow.DOMMatrixReadOnly = class { constructor () { this.m11 = 1; this.m22 = 1; this.m41 = 0; this.m42 = 0; this.a = 1; this.d = 1; this.e = 0; this.f = 0 } }
jsdomWindow.DOMMatrix = jsdomWindow.DOMMatrixReadOnly
jsdomWindow.Element.prototype.setPointerCapture = function setPointerCapture () {}
jsdomWindow.Element.prototype.releasePointerCapture = function releasePointerCapture () {}
jsdomWindow.Element.prototype.hasPointerCapture = function hasPointerCapture () { return true }
// A headless 2D context: the sketch and raster helpers must not throw on mount.
jsdomWindow.HTMLCanvasElement.prototype.getContext = function getContext (type) {
  if (type !== '2d') return null
  return {
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData () {}, drawImage () {}, fillRect () {}, clearRect () {},
    save () {}, restore () {}, beginPath () {}, moveTo () {}, lineTo () {}, stroke () {},
    arc () {}, fill () {}, strokeRect () {}, fillText () {}, scale () {},
    measureText: () => ({ width: 8 }),
    strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '', lineCap: '', lineJoin: '',
    fillStyle: '#000000', globalCompositeOperation: 'source-over',
  }
}
jsdomWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,QUJD'

/** Confirmations the panel asked for, in order, and the answer it got. */
const confirmationMessages = []
let confirmationAnswer = false
jsdomWindow.confirm = (message) => {
  confirmationMessages.push(String(message ?? ''))
  return confirmationAnswer
}

const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex')

/** Every request path the panel issued, for the "one click, one request" checks. */
const requestPaths = []

/** Gallery shelf + trash the panel reads. Two trash rows: one is restored, and
 *  the purge button must still be rendered for the second one afterwards. */
const galleryState = {
  entries: [
    {
      id: 'gallery-one', createdAt: 3, mode: 'text', model: 'gpt-image-2', prompt: 'gallery prompt',
      size: '1:1', quality: '2k', detail: '', n: 1,
      images: [{ url: '/api/dsh-imagegen/gallery/image/gallery.png', mime: 'image/png' }],
    },
  ],
  trash: [
    {
      id: 'gallery-trashed', createdAt: 2, deletedAt: 9, mode: 'text', model: 'gpt-image-2', prompt: 'trashed prompt',
      size: '1:1', quality: '2k', detail: '', n: 1,
      images: [{ url: '/api/dsh-imagegen/gallery/image/trashed.png', mime: 'image/png' }],
    },
    {
      id: 'gallery-trashed-2', createdAt: 1, deletedAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'older trashed prompt',
      size: '1:1', quality: '2k', detail: '', n: 1,
      images: [{ url: '/api/dsh-imagegen/gallery/image/trashed2.png', mime: 'image/png' }],
    },
  ],
}
/** Every gallery mutation the panel issued, in order. */
const galleryMutations = []

/** One finished clip in the unified history: opening it must NOT leave the
 *  inspiration wall painted over the player. */
const videoHistoryEntries = [{
  id: 'clip-one',
  createdAt: 6,
  mode: 'text',
  model: 'agnes-video-2.5-flash',
  prompt: 'a clip in the history',
  aspectRatio: '16:9',
  resolution: '720P',
  seconds: 5,
  videos: [{ url: '/api/dsh-imagegen/video/file/clip-one-0.mp4', mime: 'video/mp4', duration: 5 }],
}]

/** The canvas the host serves. Mutable: a check may empty it or add clips. */
const canvasDocument = {
  version: 2,
  id: 'canvas-one',
  title: 'Canvas one',
  revision: 1,
  viewport: { x: 0, y: 0, k: 1 },
  background: 'lines',
  nodes: [
    { id: 'node-image', type: 'image', title: '图片节点', x: 0, y: 0, width: 220, height: 180, metadata: { asset: { assetId: 'img.png', url: '/api/dsh-imagegen/canvas/asset/img.png', mime: 'image/png', bytes: 8, width: 32, height: 32, origin: 'upload' } } },
    { id: 'node-config', type: 'config', title: '生成配置', x: 300, y: 0, width: 320, height: 260, metadata: { config: { mode: 'text', model: 'gpt-image-2', prompt: 'a cat' } } },
  ],
  connections: [],
}
/** Documents the workspace persisted through `/canvas/save`. */
const canvasSaves = []

/** The gateway catalog: the panel's only model source. */
const gatewaySnapshot = {
  status: 'ready',
  version: 'smoke-v1',
  fetchedAt: 0,
  image: [{ model: 'gpt-image-2', label: 'gpt-image-2', isDefault: true }],
  video: [{ model: 'agnes-video-2.5-flash', label: 'agnes-video-2.5-flash', isDefault: true }],
}
const configState = {
  enabled: true,
  announceToAgent: true,
  defaultModel: 'gpt-image-2',
  defaultVideoModel: 'agnes-video-2.5-flash',
}

const json = value => ({ ok: true, status: 200, json: async () => value, blob: async () => new jsdomWindow.Blob([]) })

const fetchStub = async (input, init) => {
  const path = String(input)
  requestPaths.push(path)
  if (path.endsWith('/gateway/catalog')) return json({ ok: true, snapshot: gatewaySnapshot })
  if (path.endsWith('/gateway/refresh')) return json({ ok: true, snapshot: gatewaySnapshot })
  if (path.endsWith('/settings/describe')) {
    return json({ ok: true, value: { namespaces: [{ ns: 'dsh-imagegen', value: configState, revision: 0, secrets: [] }], writable: true } })
  }
  if (path.endsWith('/outfit/draft')) return json({ ok: true, value: null })
  if (path.endsWith('/templates/sample')) {
    return json({
      ok: true,
      samples: [{
        sourceId: 'vibeui',
        case: { id: 1, title: 'Template poster', prompt: 'A reusable template prompt', category: 'Posters & Typography', categoryZh: '海报与排版', styles: [], scenes: [], sourceLabel: '@author', sourceUrl: '', githubUrl: '', image: '', featured: false },
      }],
    })
  }
  if (path.endsWith('/templates/list')) return json({ ok: true, sourceId: 'vibeui', cases: [], total: 0, origin: 'bundled', repository: '', fetchedAt: '' })
  if (path.endsWith('/templates/favorites/list')) return json({ ok: true, favorites: [] })
  if (path.endsWith('/video/tasks/list')) return json({ ok: true, tasks: [] })
  if (path.endsWith('/video/history/list')) return json({ ok: true, entries: videoHistoryEntries })
  if (path.endsWith('/history/list')) return json({ ok: true, entries: [] })
  if (path.endsWith('/diagnostics/list')) return json({ ok: true, entries: [] })
  if (path.endsWith('/signals/report')) return json({ ok: true, report: { windowDays: 90, totals: {} } })
  if (path.endsWith('/signals/list')) return json({ ok: true, months: [], entries: [] })
  if (path.endsWith('/gallery/list')) return json({ ok: true, entries: galleryState.entries, trash: galleryState.trash })
  if (path.endsWith('/gallery/remove') || path.endsWith('/gallery/restore') || path.endsWith('/gallery/purge')) {
    galleryMutations.push({ path: path.split('/').pop(), body: init?.body ?? null })
    const name = path.split('/').pop()
    if (name === 'restore') {
      const restored = galleryState.trash.shift()
      if (restored !== undefined) galleryState.entries.push({ ...restored, deletedAt: undefined })
    }
    if (name === 'purge') galleryState.trash.length = 0
    return json({ ok: true, entries: galleryState.entries, trash: galleryState.trash })
  }
  if (path.endsWith('/canvas/list')) {
    return json({ ok: true, projects: [{ id: canvasDocument.id, title: canvasDocument.title, revision: canvasDocument.revision, nodeCount: canvasDocument.nodes.length, createdAt: 1, updatedAt: 1 }] })
  }
  if (path.endsWith('/canvas/read')) return json({ ok: true, document: canvasDocument })
  if (path.endsWith('/canvas/save')) {
    const payload = JSON.parse(init.body)
    canvasSaves.push(payload.document)
    return json({ ok: true, document: { ...payload.document, revision: payload.document.revision + 1 } })
  }
  if (path.endsWith('/canvas/skills/list')) {
    return json({ ok: true, skills: [], installed: [], agentAvailable: true, registryAvailable: true })
  }
  if (path.includes('/video/file/') || path.includes('/gallery/video-file/')) {
    return { ok: true, status: 200, blob: async () => new jsdomWindow.Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' }) }
  }
  if (path.endsWith('/generate')) {
    return json({ ok: true, images: [{ mime: 'image/png', b64: pngBytes.toString('base64') }] })
  }
  if (path.endsWith('/prompt-enhance')) {
    return json({ ok: true, prompt: JSON.stringify({ title: '促销标题', body: '促销正文', tags: ['好物'] }) })
  }
  // Anything else: an empty, valid envelope. Listed explicitly so an unexpected
  // route shows up in `requestPaths` instead of crashing the run.
  return json({ ok: true, entries: [], tasks: [], projects: [], models: [], cases: [], favorites: [] })
}

/* -------------------------------------------------------------------- mount */

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let handoff
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
  atob,
  btoa,
  Image: class SmokeImage {
    constructor () { this.naturalWidth = 0; this.naturalHeight = 0 }
    set src (value) { this._src = value; setTimeout(() => { this.naturalWidth = 64; this.naturalHeight = 64; this.onload?.() }, 0) }
    get src () { return this._src }
  },
  fetch: fetchStub,
  console,
}
if (!('window' in sandbox.window)) sandbox.window.window = sandbox.window
sandbox.window.__ModuleLoader__ = { load: handler => { handoff = handler } }
const vm = await import('node:vm')
vm.runInNewContext(source, sandbox, { filename: 'client.js' })
assert.ok(handoff !== undefined, 'the client bundle registered via __ModuleLoader__')

const conversationStub = {
  createDrafts: () => [],
  releaseDraftAttachments: () => {},
  input: {
    for: () => ({
      addAttachments: () => true,
      removeAttachment: () => {},
      state: { getSnapshot: () => ({ draft: '' }) },
      setDraft: () => {},
    }),
  },
}
/** Slot registrations the plugin makes; the suite renders the `main#imagegen` one. */
const registrations = []
const ctx = {
  effect (fn) { return fn() },
  provide () {},
  on () { return () => {} },
  get (name) {
    if (name === 'connection') return { isLoopback: true }
    if (name === 'conversation') return conversationStub
    if (name === 'sessions') {
      return {
        list: {
          getSnapshot: () => ({
            ids: ['session-smoke'],
            byId: { 'session-smoke': { sessionId: 'session-smoke', cwd: '/tmp/session-smoke', running: false, blank: false, agentAvailable: true, updatedAt: 0 } },
          }),
          subscribe: () => () => {},
        },
        scope: () => ({ sessionId: 'session-smoke' }),
      }
    }
    return undefined
  },
  locale: {
    register () {}, addLanguage () { return () => {} },
    getLocale () { return { active: 'zh', locales: [], revision: 0 } },
    subscribe () { return () => {} },
  },
  slots: {
    inject (key, callback) {
      const result = callback()
      if (result?.[Symbol.iterator]) for (const dispose of result) void dispose
      return () => {}
    },
    register (options, component) { registrations.push({ options, component }); return () => {} },
  },
}

// react-dom reads the bare `window`/`document` globals at render time, so the
// jsdom ones have to be in scope for the render.
const previousWindow = globalThis.window
const previousDocument = globalThis.document
globalThis.window = jsdomWindow
globalThis.document = jsdomDocument
cleanups.push(async () => {
  await new Promise(resolve => setTimeout(resolve, 25))
  jsdomWindow.close()
  await new Promise(resolve => setTimeout(resolve, 25))
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
})

const react = await import('react')
const moduleStubs = {
  'react': react,
  'react/jsx-runtime': await import('react/jsx-runtime'),
  'react-dom': await import('react-dom'),
  'react-dom/client': await import('react-dom/client'),
  '@deepseek-ai/dsh-client-ui-primitives': {
    Button: ({ variant, size, className, children, ...rest }) => react.createElement('button', { type: 'button', className, ...rest }, children),
    Pill: ({ active, className, children, onClick, ...rest }) => react.createElement(onClick ? 'button' : 'span', { type: 'button', className, ...(onClick !== undefined ? { onClick } : {}), ...rest }, children),
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
  '@deepseek-ai/dsh-client-store': {
    createSnapshotStore: (initial) => {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        set: (next) => { snapshot = next; for (const fn of [...listeners]) fn() },
        update: (mutator) => { const draft = { ...snapshot }; mutator(draft); snapshot = draft; for (const fn of [...listeners]) fn() },
        subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      }
    },
  },
}
const exportsOf = handoff.factory((spec) => {
  const stub = moduleStubs[spec]
  if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
  return stub
})

const waitUntil = async (predicate, timeout = 4000) => {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  return predicate()
}
const waitForSelector = async (scope, selector, timeout = 4000) => {
  const found = await waitUntil(() => scope.querySelector(selector) !== null, timeout)
  assert.ok(found, `selector did not render: ${selector}`)
}
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))
const press = (target, key, extra = {}) => {
  const event = new jsdomWindow.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}
const pointerDown = (target, extra = {}) => {
  const event = new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, ...extra })
  target.dispatchEvent(event)
  return event
}

exportsOf.apply(ctx)

/** The rendered panel root; set by the mount check, used by every check after it. */
let view

await check('P0 the panel mounts through the shell\u2019s keyed main seat', async () => {
  const registered = await waitUntil(() => registrations.some(entry => entry.options.name === 'main' && entry.options.key === 'imagegen'))
  assert.ok(registered, 'the surface registers the keyed main seat')
  const seat = registrations.find(entry => entry.options.name === 'main' && entry.options.key === 'imagegen')
  assert.ok(seat !== undefined, 'the keyed main seat is addressable')
  const { createRoot } = await import('react-dom/client')
  view = jsdomDocument.createElement('div')
  jsdomDocument.body.append(view)
  const root = createRoot(view)
  root.render(react.createElement(seat.component))
  cleanups.push(async () => { root.unmount(); view.remove() })
  await waitForSelector(view, '[role="tablist"]')
})

/* -------------------------------------------------------------- the checks */

/** The mounted canvas workspace, or a failure saying why there is none. */
const canvasWorkspace = () => {
  const workspace = view.querySelector('[data-canvas-workspace]')
  assert.ok(workspace !== null, 'the canvas workspace is mounted')
  return workspace
}

/** Click the top-nav entry whose label contains `text`. The tabs re-render on
 *  every workspace switch, so the button is always looked up fresh. */
const openWorkspace = async (text) => {
  const button = [...view.querySelectorAll('[role="tablist"] button')].find(entry => (entry.textContent ?? '').includes(text))
  assert.ok(button !== undefined, `the top nav offers 「${text}」`)
  button.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  await tick(120)
}

/** Leave the canvas and come back: the workspace reads its document on mount,
 *  so a document change only reaches it through a remount. */
const remountCanvas = async () => {
  await openWorkspace('普通生图')
  await openWorkspace('无限画布')
  await waitForSelector(view, '[data-canvas-workspace]')
}

await check('P1 an empty canvas offers six quick-start cards and drops them after the first node', async () => {
  const savedNodes = canvasDocument.nodes
  const savedConnections = canvasDocument.connections
  canvasDocument.nodes = []
  canvasDocument.connections = []
  await remountCanvas()

  await waitForSelector(canvasWorkspace(), '[data-quick-card]')
  const cards = [...view.querySelectorAll('[data-canvas-workspace] [data-quick-card]')]
  assert.equal(cards.length, 6, 'empty canvas shows the six quick-start cards')

  const savesBefore = canvasSaves.length
  const textCard = cards.find(card => card.getAttribute('data-quick-card') === 'text')
  assert.ok(textCard !== undefined, 'the quick-start row offers a text card')
  textCard.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.ok(await waitUntil(() => view.querySelector('[data-canvas-workspace] [data-node-id]') !== null), 'clicking a quick card creates a node')
  assert.ok(await waitUntil(() => view.querySelector('[data-canvas-workspace] [data-quick-card]') === null), 'quick cards leave once the canvas has a node')
  assert.ok(await waitUntil(() => canvasSaves.length > savesBefore), 'the card lands in the saved document')

  canvasDocument.nodes = savedNodes
  canvasDocument.connections = savedConnections
  await remountCanvas()
})

await check('P2 holding Space or Control hands the pointer to the pan gesture', async () => {
  const viewportEl = canvasWorkspace().querySelector('[class*="viewport"]')
  assert.ok(viewportEl !== null, 'the canvas viewport is mounted')

  // Baseline first: with no key held, a drag on the background starts a marquee.
  // Without it the "pan must not claim the pointer" checks below could pass
  // because nothing claimed the pointer at all.
  const plain = pointerDown(viewportEl)
  assert.equal(plain.defaultPrevented, true, 'a plain background drag still starts the marquee')
  viewportEl.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 5, clientY: 5 }))
  await tick()

  for (const [label, key, code] of [['Space', ' ', 'Space'], ['Control', 'Control', 'ControlLeft']]) {
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
    await tick()
    const held = pointerDown(viewportEl)
    assert.equal(
      held.defaultPrevented,
      false,
      `holding ${label} leaves the pointer to d3-zoom, so the canvas can actually be dragged`,
    )
    viewportEl.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 5, clientY: 5 }))
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keyup', { key, code, bubbles: true }))
    await tick()
  }

  // A surface drawn on top of the canvas is marked `data-canvas-no-zoom`. The
  // marquee must not claim the pointer there: its preventDefault + capture
  // swallows the click of whatever the user actually aimed at.
  const dockSurface = canvasWorkspace().querySelector('[role="toolbar"]')
  assert.ok(dockSurface !== null, 'the dock is a no-zoom surface')
  const onControl = pointerDown(dockSurface)
  assert.equal(onControl.defaultPrevented, false, 'a pointerdown on a no-zoom surface is not treated as empty background')
})

await check('P3 Space on a focused control is left to the control, and claimed on the canvas', async () => {
  const dockButton = canvasWorkspace().querySelector('[role="toolbar"] button')
  assert.ok(dockButton !== null, 'the dock has a button to focus')
  const onButton = press(dockButton, ' ', { code: 'Space' })
  assert.equal(onButton.defaultPrevented, false, 'Space on a focused button is left to the button, not eaten by the pan tool')

  const viewportEl = canvasWorkspace().querySelector('[class*="viewport"]')
  assert.ok(viewportEl !== null, 'the canvas viewport is mounted')
  const onCanvas = press(viewportEl, ' ', { code: 'Space' })
  assert.equal(onCanvas.defaultPrevented, true, 'Space on the canvas background still arms the pan tool')
  jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))
  await tick()
})

await check('P4 the composer overlay stays outside the scrolling viewport', async () => {
  const configNode = view.querySelector('[data-node-id="node-config"]')
  assert.ok(configNode !== null, 'the config node is on the canvas')
  pointerDown(configNode)
  await waitUntil(() => view.querySelector('[data-canvas-no-zoom][class*="composer"]') !== null)
  const composer = view.querySelector('[data-canvas-no-zoom][class*="composer"]')
  assert.ok(composer !== null, 'selecting a config node opens its composer')
  // `=== null` rather than assert.equal: a failed equal() would run util.inspect
  // over a jsdom element, walking its React fiber until the process dies.
  assert.ok(composer.closest('[class*="viewport"]') === null, 'the composer sits outside the viewport, so its blank margin cannot clear the selection')
  pointerDown(composer)
  await tick(60)
  assert.ok(view.querySelector('[data-canvas-no-zoom][class*="composer"]') !== null, 'a pointerdown on the composer does not clear the selection that opened it')
})

await check('P5 the shortcut table opens from the dock and from the ? key, and the dock names its keys', async () => {
  const helpButton = [...canvasWorkspace().querySelectorAll('[role="toolbar"] button')]
    .find(button => (button.getAttribute('aria-label') ?? '') === '快捷键')
  assert.ok(helpButton !== undefined, 'the dock carries a shortcut entry')
  helpButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') !== null), 'the dock entry opens the shortcut table')
  const legend = view.querySelector('[data-shortcut-help]')
  assert.ok(legend.querySelectorAll('kbd').length >= 20, 'the table lists the real bindings, not a placeholder')
  press(jsdomWindow, 'Escape')
  assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') === null), 'Escape closes the shortcut table')

  const liveViewport = canvasWorkspace().querySelector('[class*="viewport"]')
  assert.ok(liveViewport !== null, 'the canvas viewport is still mounted')
  const question = press(liveViewport, '?')
  assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') !== null), '? opens the shortcut table too')
  assert.equal(question.defaultPrevented, true, '? is claimed by the table, not typed into the page')
  press(jsdomWindow, 'Escape')
  assert.ok(await waitUntil(() => view.querySelector('[data-shortcut-help]') === null), 'Escape closes the one ? opened')

  const undoLabel = [...canvasWorkspace().querySelectorAll('[role="toolbar"] button')]
    .map(button => button.getAttribute('aria-label') ?? '')
    .find(label => label.startsWith('撤销')) ?? ''
  assert.ok(undoLabel.includes('Ctrl/⌘+Z'), `the undo control names its key (got "${undoLabel}")`)
})

await check('P6 Escape closes the in-canvas video preview and the timeline editor', async () => {
  const savedNodes = canvasDocument.nodes
  canvasDocument.nodes = [
    ...savedNodes,
    { id: 'node-clip', type: 'video', title: 'clip.mp4', x: 0, y: 1200, width: 260, height: 160, metadata: { video: { url: 'data:video/mp4;base64,AAAA', mime: 'video/mp4', width: 320, height: 240, duration: 2 }, status: 'success' } },
    { id: 'node-clip-2', type: 'video', title: 'clip-2.mp4', x: 300, y: 1200, width: 260, height: 160, metadata: { video: { url: 'data:video/mp4;base64,AAAA', mime: 'video/mp4', width: 320, height: 240, duration: 3 }, status: 'success' } },
  ]
  await remountCanvas()
  await waitForSelector(canvasWorkspace(), '[data-node-id="node-clip"]')

  const clipNode = view.querySelector('[data-node-id="node-clip"]')
  const previewButton = [...clipNode.querySelectorAll('button')]
    .find(button => (button.getAttribute('aria-label') ?? '') === '放大预览')
  assert.ok(previewButton !== undefined, 'the clip node offers the in-canvas preview')
  previewButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitForSelector(view, '[data-video-preview]')
  press(jsdomWindow, 'Escape')
  assert.ok(await waitUntil(() => view.querySelector('[data-video-preview]') === null), 'Escape closes the in-canvas video preview')

  const timelineButton = canvasWorkspace().querySelector('[data-dock-item][data-label="时间线编辑"] button')
  assert.ok(timelineButton !== null, 'the dock carries a timeline entry')
  timelineButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.ok(await waitUntil(() => view.querySelector('[data-timeline-panel]') !== null), 'the timeline entry opens the editor')
  press(jsdomWindow, 'Escape')
  assert.ok(await waitUntil(() => view.querySelector('[data-timeline-panel]') === null), 'Escape closes the timeline editor')

  canvasDocument.nodes = savedNodes
  await remountCanvas()
})

await check('P7 pinning an identity reaches the saved document', async () => {
  await waitForSelector(canvasWorkspace(), '[data-node-id="node-image"]')
  const castNode = view.querySelector('[data-node-id="node-image"]')
  const savesBefore = canvasSaves.length
  castNode.dispatchEvent(new jsdomWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
  assert.ok(await waitUntil(() => view.querySelector('[role="menu"]') !== null), 'the node menu opens')
  const pinRow = [...view.querySelectorAll('[role="menu"] button[role="menuitem"]')]
    .find(button => (button.textContent ?? '').includes('钉为身份参考'))
  assert.ok(pinRow !== undefined, 'the node menu offers the identity pin')
  pinRow.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.ok(await waitUntil(() => view.querySelector('[data-cast-dialog]') !== null), 'the pin opens the naming dialog')
  view.querySelector('[data-cast-save]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.ok(await waitUntil(() => view.querySelector('[data-cast-badge]') !== null), 'the node shows it is pinned')
  assert.ok(
    await waitUntil(() => canvasSaves.slice(savesBefore).some(saved =>
      saved.nodes.some(node => node.id === 'node-image' && node.metadata?.cast?.role === 'character'))),
    'the pin reaches the saved document',
  )
})

await check('P8 the trash restores by its own id, states the count once, and says how many a purge will drop', async () => {
  await openWorkspace('素材库')
  await waitForSelector(view, '[data-gallery-trash-toggle]')
  const toggle = view.querySelector('[data-gallery-trash-toggle]')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the trash starts collapsed')
  toggle.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.ok(await waitUntil(() => view.querySelector('[data-gallery-trash]') !== null), 'opening the toggle renders the trash section')

  const section = view.querySelector('[data-gallery-trash]')
  // The heading is the toggle itself; printing the count again inside the body
  // reads as duplicated copy.
  assert.equal(section.querySelectorAll('strong').length, 0, 'the open trash does not repeat the count heading it already sits under')
  const restoreIds = [...section.querySelectorAll('[data-gallery-restore]')].map(button => button.getAttribute('data-gallery-restore'))
  assert.deepEqual(restoreIds, ['gallery-trashed', 'gallery-trashed-2'], 'every trashed row carries its own id, not one repeated id')

  // A purge that the user declines must not reach the host, and the question it
  // asked has to name how many entries go.
  confirmationAnswer = false
  const messagesBefore = confirmationMessages.length
  section.querySelector('[data-gallery-purge]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  await tick(60)
  assert.equal(galleryMutations.some(entry => entry.path === 'purge'), false, 'a declined purge reaches nothing')
  assert.equal(confirmationMessages.length, messagesBefore + 1, 'emptying the trash asks before it drops anything')
  assert.ok(
    (confirmationMessages.at(-1) ?? '').includes(String(galleryState.trash.length)),
    `the purge confirmation states how many entries will go (got "${confirmationMessages.at(-1) ?? ''}")`,
  )

  const restoreButton = view.querySelector('[data-gallery-restore="gallery-trashed"]')
  assert.ok(restoreButton !== null, 'the trash row offers a restore button for its own id')
  restoreButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.ok(await waitUntil(() => galleryMutations.some(entry => entry.path === 'restore')), 'restore reached the host')
  assert.equal(JSON.parse(galleryMutations.find(entry => entry.path === 'restore').body).id, 'gallery-trashed', 'restore names the trashed entry')
})

await check('P9 the video studio always offers the diagnostics record and the behaviour report', async () => {
  await openWorkspace('普通生图')
  const videoTab = [...view.querySelectorAll('[role="tablist"] button')].find(button => (button.textContent ?? '').includes('生视频'))
  assert.ok(videoTab !== undefined, 'the video mode entry is present')
  videoTab.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  await waitForSelector(view, '[data-diagnostics-button]')
  // Zero tasks is the state a fresh install is in, and it is the one the entry
  // used to vanish in: nothing else on this surface opens the record.
  assert.equal(view.querySelectorAll('[data-diagnostics-button]').length, 1, 'the video studio renders exactly one diagnostics entry')
  assert.equal(view.querySelectorAll('[data-signals-button]').length, 1, 'the video studio renders exactly one behaviour-report entry')
  const diagnostics = view.querySelector('[data-diagnostics-button]')
  diagnostics.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
  assert.ok(await waitUntil(() => requestPaths.some(path => path.endsWith('/diagnostics/list'))), 'the entry opens the diagnostics record without any task row present')
})

await check('P10 the outfit form is interactive when its draft read fails', async () => {
  await openWorkspace('服饰穿戴')
  await waitForSelector(view, '[data-outfit]')
  const outfit = view.querySelector('[data-outfit]')
  const fieldset = outfit.querySelector('fieldset')
  assert.ok(fieldset !== null, 'the outfit form has a fieldset')
  assert.equal(fieldset.disabled, false, 'the outfit form is interactive, not stuck waiting on a draft read')
  const modeGroup = outfit.querySelector('[role="radiogroup"][aria-label="搭配模式"]')
  assert.ok(modeGroup !== null, 'the outfit form offers a mode switch')
  const characterMode = [...modeGroup.querySelectorAll('button[role="radio"]')].find(button => (button.textContent ?? '').trim() === '角色搭配')
  assert.ok(characterMode !== undefined, 'the character mode is offered')
  assert.equal(characterMode.closest('fieldset')?.disabled ?? true, false, 'the mode pills sit in an enabled fieldset before they are clicked')
})

await check('P11 one click on promo\u2019s submit issues exactly one generation', async () => {
  await openWorkspace('带货图文')
  await waitForSelector(view, '[data-promo]')
  const promo = view.querySelector('[data-promo]')
  const nameField = promo.querySelector('input[placeholder="商品名称"]')
  assert.ok(nameField !== null, 'the promo workspace offers a product-name field')
  const setInput = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLInputElement.prototype, 'value').set
  setInput.call(nameField, '测试保温杯')
  nameField.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
  await tick(60)
  const submit = promo.querySelector('button[type="submit"]')
  assert.ok(submit !== null, 'the promo submit button is rendered')
  assert.equal(submit.disabled, false, 'the submit enables once a product name exists')
  const before = requestPaths.filter(path => path.endsWith('/generate')).length
  submit.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  await tick(150)
  const after = requestPaths.filter(path => path.endsWith('/generate')).length
  assert.equal(after - before, 1, `one click on promo's submit must issue one generation, not ${after - before}`)
})

await check('P12 two touch pointers moving apart zoom in', async () => {
  await openWorkspace('无限画布')
  await waitForSelector(canvasWorkspace(), '[class*="viewport"]')
  const viewportEl = canvasWorkspace().querySelector('[class*="viewport"]')
  const zoomPercent = () => Number((canvasWorkspace().querySelector('[class*="zoomValue"]')?.textContent ?? '0').replace('%', ''))
  const before = zoomPercent()
  // jsdom has no PointerEvent: the handler reads clientX/clientY/pointerId/
  // pointerType off the event, so a MouseEvent carrying those fields drives the
  // same code path.
  const touch = (type, id, x, y) => {
    const event = new jsdomWindow.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
    Object.assign(event, { pointerId: id, pointerType: 'touch' })
    viewportEl.dispatchEvent(event)
    jsdomWindow.dispatchEvent(event)
  }
  touch('pointerdown', 901, 100, 100)
  touch('pointerdown', 902, 200, 100)
  touch('pointermove', 902, 400, 100)
  await tick(80)
  assert.ok(zoomPercent() > before, `two touch pointers moving apart zoom in (${before}% -> ${zoomPercent()}%)`)
  touch('pointerup', 902, 400, 100)
  touch('pointerup', 901, 100, 100)
  await tick()
})

await check('P13 the inspiration wall is not drawn over a clip that is playing', async () => {
  await openWorkspace('普通生图')
  // The unified history loads from the host after the workspace renders, so the
  // clip row is awaited rather than read straight off the first paint.
  await waitForSelector(view, '[data-video-row]')
  const clipRow = view.querySelector('[data-video-row]')
  assert.ok(clipRow !== null, 'the clip row is in the unified history')
  clipRow.querySelector('[data-dsh-imagegen-history-main]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitForSelector(view, '[data-video-board]')
  assert.equal(
    view.querySelector('[aria-label="灵感案例"]') === null,
    true,
    'the inspiration wall yields to a clip that is on the board',
  )
})

/* ---------------------------------------------------------------- teardown */

for (const cleanup of cleanups.reverse()) await cleanup()
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const standing = domErrors.filter(error => !/Could not parse CSS/.test(String(error?.message ?? error)))
if (standing.length > 0) {
  for (const error of standing) process.stderr.write(`jsdom error: ${error?.message ?? error}\n`)
  results.push(`FAIL  the rendered panel raised ${standing.length} uncaught error(s)`)
  process.exitCode = 1
}

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nPANEL INTERACTION CHECK FAILED' : '\nPANEL INTERACTION CHECK OK')
process.exit(process.exitCode === 1 ? 1 : 0)
