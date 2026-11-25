/**
 * Visual-acceptance entry for the image studio.
 *
 * Renders the REAL `ImageGenPanel` — the same component the plugin registers
 * into the shell's keyed `main` slot — with the REAL `Button`/`Pill` primitives
 * and the REAL DSH theme tokens. Only the host is stubbed: it answers with fixed
 * data instead of calling a model.
 *
 * WHY the primitives are bundled rather than stubbed: `scripts/smoke.mjs`
 * replaces `@deepseek-ai/dsh-client-ui-primitives` with
 * `react.createElement('button', …)` fakes. A screenshot of a fake button
 * cannot answer "does this look native", which is the only question this entry
 * exists to answer.
 *
 * The shell DOM (sidebar with its slot anchors, the centre column, the
 * conversation) is provided by the page; see `scripts/studio-preview-shot.mjs`.
 *
 * Build: `pnpm studio:preview` -> `.studio-preview/preview.js`
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { createRoot } from 'react-dom/client'
import type { ImageGenApi } from '../src/client/api.ts'
import type { ImageGenConfig, ImageGenScope } from '../src/client/settings-scope.ts'
import { ImageGenPanel } from '../src/client/ImageGenPanel.tsx'
import { tt } from '../src/client/helpers.ts'
import type { CanvasDocument, HistoryEntry, TemplateCase, TemplateSample } from '../src/protocol.ts'

/** An inline SVG poster, so thumbnails paint something instead of a broken box. */
function poster(hue: number, label: string): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">'
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue} 62% 62%)"/><stop offset="1" stop-color="hsl(${hue + 42} 58% 40%)"/>`
    + '</linearGradient></defs><rect width="240" height="240" fill="url(#g)"/>'
    + '<circle cx="172" cy="72" r="38" fill="rgba(255,255,255,.32)"/>'
    + '<path d="M0 176 L74 116 L138 176 L196 132 L240 168 L240 240 L0 240 Z" fill="rgba(0,0,0,.22)"/>'
    + `<text x="16" y="224" font-family="system-ui, sans-serif" font-size="15" fill="rgba(255,255,255,.86)">${label}</text>`
    + '</svg>'
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** One stored generation, shaped exactly as the host persists it. */
function historyEntry(index: number, prompt: string, model: string, size: string): HistoryEntry {
  return {
    id: `preview-${index}`,
    createdAt: Date.now() - index * 1000 * 60 * 47,
    mode: 'text',
    model,
    prompt,
    size,
    quality: 'high',
    detail: 'high',
    n: 1,
    images: [{ url: poster(196 + index * 37, size), mime: 'image/svg+xml' }],
  }
}

const HISTORY: HistoryEntry[] = [
  historyEntry(0, '雨夜霓虹街道，湿漉漉的柏油路面反光，35mm 胶片质感', 'gpt-image-2', '1:1'),
  historyEntry(1, '极简白底产品图，磨砂陶瓷杯，硬光，柔和投影', 'gpt-image-2', '1:1'),
  historyEntry(2, '中文海报：秋日市集，暖橘与赭石，纸张纹理', 'gpt-image-2-alt', '2:3'),
  historyEntry(3, '等距视角的桌面布置，笔记本与咖啡，柔光', 'gpt-image-2', '16:9'),
]

/** One template case for the inspiration wall. */
function templateCase(index: number): TemplateCase {
  return {
    id: `case-${index}`,
    title: ['电影感人像', '产品静物', '东方山水', '赛博城市', '复古胶片', '黏土风插画'][index % 6]!,
    prompt: `模板 ${index + 1}：光线柔和，构图平衡，细节丰富`,
    category: 'Photography',
    categoryZh: '摄影',
    styles: ['cinematic'],
    scenes: ['portrait'],
    sourceLabel: '@preview',
    sourceUrl: 'https://example.test/preview',
    githubUrl: 'https://example.test/preview',
    image: `tile-${index}.svg`,
    featured: index === 0,
  }
}

/** Settings the studio edits, filled the way a configured install looks. */
const CONFIG: ImageGenConfig = {
  enabled: true,
  announceToAgent: true,
  channels: [{
    id: 'default',
    preset: '',
    name: 'Default',
    apiUrl: 'https://api.openai.com/v1',
    apiUrlFull: false,
    models: [
      { alias: 'gpt-image-2', id: 'gpt-image-2' },
      { alias: 'gpt-image-2-alt', id: 'gpt-image-2' },
    ],
    videoModels: [{ alias: 'agnes-video-2.5-flash', id: 'agnes-video-2.5-flash' }],
  }],
  defaultChannelId: 'default',
  defaultModel: 'gpt-image-2',
  defaultVideoModel: 'agnes-video-2.5-flash',
  promptModel: 'deepseek-chat',
}

const EMPTY_GALLERY = { entries: [] as HistoryEntry[], trash: [] as HistoryEntry[] }

/**
 * A brand-new canvas, the same shape the host writes for `canvas/create`.
 *
 * Kept here rather than imported from the store: the store pulls in `node:fs`
 * and the preview is a browser page. The field set mirrors
 * `canvas-store.ts`'s `defaultDocument` — if that grows a required field, this
 * goes out of date silently. It carries no nodes on purpose: a brand-new canvas
 * is empty (the client draws its quick-start row over it), and nothing is
 * written to disk until the first edit.
 */
function previewCanvas(title?: string, id = 'preview-canvas'): CanvasDocument {
  const now = Date.now()
  return {
    version: 2,
    id,
    title: title ?? tt('canvas.untitled'),
    revision: 1,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'lines',
    nodes: [],
    connections: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The host bridge, answered from memory. Every route the panel reaches on mount
 * is implemented; the rest resolve to empty shapes so an unvisited surface
 * renders its own empty state instead of an error banner.
 */
const api = {
  historyList: async () => HISTORY,
  historyRemove: async () => HISTORY,
  historyClear: async () => [],
  galleryList: async () => EMPTY_GALLERY,
  galleryAppend: async () => ({ entries: [], added: false }),
  galleryAppendVideo: async () => [],
  galleryRemove: async () => EMPTY_GALLERY,
  galleryRestore: async () => EMPTY_GALLERY,
  galleryPurge: async () => EMPTY_GALLERY,
  galleryClear: async () => EMPTY_GALLERY,
  gallerySetTags: async () => EMPTY_GALLERY,
  videoHistoryList: async () => [],
  videoHistoryRemove: async () => [],
  videoHistoryClear: async () => [],
  videoTaskList: async () => [],
  taskList: async () => [],
  templatesSample: async (count: number): Promise<TemplateSample[]> => Array
    .from({ length: Math.min(count, 12) }, (_, index) => ({
      sourceId: 'preview',
      case: templateCase(index),
    })),
  templatesList: async (sourceId: string) => ({
    sourceId,
    cases: [],
    total: 0,
    origin: 'bundled' as const,
    repository: 'preview',
    fetchedAt: new Date().toISOString(),
  }),
  favoritesList: async () => [],
  diagnosticsList: async () => [],
  /**
   * An EMPTY library on purpose: the canvas then takes its "no projects yet,
   * create one" path on mount, which is exactly the first-run screen this
   * preview exists to show — the seed pair and the example prompt in it.
   * Answering with one saved canvas would open that and never render the seed.
   */
  canvasList: async () => [],
  canvasCreate: async (title?: string): Promise<CanvasDocument> => previewCanvas(title),
  canvasRead: async (id: string): Promise<CanvasDocument> => previewCanvas(undefined, id),
  canvasSave: async (document: CanvasDocument): Promise<CanvasDocument> => document,
  canvasRemove: async () => [],
  canvasProposals: async () => ({ proposals: [], counts: {} }),
  pptTasks: async () => [],
  canvasSkillsList: async () => ({ skills: [], installed: [] }),
  // PPT reads its saved OCR credentials before rendering the workspace. The
  // preview has no host bridge, so answer with the empty library instead of
  // letting an undefined stub crash the whole panel on tab switch.
  canvasSkillLibrary: async () => ({ entries: [] }),
  pptRuntime: async () => ({ available: false, message: 'preview' }),
  videoPlan: async () => ({ shots: [], notes: '' }),
  openDataFolder: async () => ({ ok: true }),
  storageTest: async () => ({ ok: true, ms: 1 }),
} as unknown as ImageGenApi

/** The settings scope the panel reads its configuration from. */
const scope = {
  getSnapshot: () => ({
    status: 'ready' as const,
    value: CONFIG,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }),
  subscribe: () => () => {},
  mutate: async () => {},
  set: async () => {},
  unset: async () => {},
  load: async () => {},
  mutateOps: async () => {},
  getKeySetSnapshot: () => true,
  subscribeKeySet: () => () => {},
  getSecretSetSnapshot: () => true,
  subscribeSecretSets: () => () => {},
} as unknown as ImageGenScope

/** The session feed; one fixed session, so the panel treats it as selected. */
const sessions = {
  list: {
    getSnapshot: () => ({ current: 'preview-session' }),
    subscribe: () => () => {},
  },
  scope: () => ({ sessionId: 'preview-session' }),
} as unknown as ISessions

// The shell owns the column and hands the panel its slot entry lifetime; this
// page stands in for that shell, so it renders the component into a container
// of its own. The marker lets the screenshot probe find the studio without
// depending on a CSS-module hash.

/** The container the harness page reserves for the studio. */
function hostNode(): HTMLDivElement {
  const element = document.createElement('div')
  element.dataset.studioPreviewRoot = ''
  document.body.append(element)
  return element
}

let host = hostNode()
let root = createRoot(host)
let mounted = true
const render = (): void => {
  root.render(<ImageGenPanel api={api} scope={scope} active sessions={sessions} />)
}
render()

// The shipped plugin's registrations are released by cordis. The harness has no
// lifecycle service, so it publishes the release instead — the acceptance probe
// calls it to prove the studio unmounts cleanly, and remounts afterwards.
const harness: {
  dispose: { panel: () => void }
  remount: () => void
} = {
  dispose: {
    panel: (): void => {
      if (!mounted) return
      mounted = false
      root.unmount()
      host.remove()
    },
  },
  remount: (): void => {
    if (mounted) return
    mounted = true
    // A fresh container and root: a React root cannot be rendered again after
    // it was unmounted, and the probe tears the studio down on purpose.
    host = hostNode()
    root = createRoot(host)
    render()
  },
}
Object.assign(window, { __studioDispose: harness.dispose, __studioRemount: harness.remount })
