/**
 * Video model catalog: protocol-family detection and capability annotation for
 * the async video side of the plugin. Mirrors `model-catalog.ts`, but for the
 * submit/poll video contract rather than the synchronous image one.
 *
 * Two families remain:
 *  - `openai-video`: the generic OpenAI-style `POST /videos` + `GET /videos/{id}`.
 *  - `h3-v2`      : 部署自家网关的统一任务接口（`metadata.image_mode` 区分玩法，
 *                    成品在 `metadata.url`，参考图放 `metadata.src_ref_images`）。
 *
 * Framework-free (pure data + regex), safe for the client bundle to inline.
 */

import type { ModelMapping, VideoModelFamily, VideoMode, VideoResolution } from './protocol.ts'
import { VIDEO_DURATIONS } from './protocol.ts'

/** Capability/identity annotation for one video model id. */
export interface VideoCatalogEntry {
  /** Family the request is shaped for. */
  family: VideoModelFamily
  /** Short badge label (zh). */
  labelZh: string
  /** Short badge label (en). */
  label: string
  /** Whether the family is known (false = best-effort generic protocol). */
  known: boolean
  /** Video modes this family accepts. */
  modes: VideoMode[]
  /** Resolution tiers this family understands. */
  resolutions: VideoResolution[]
  /** Aspect ratios this family accepts (empty = send whatever the panel has). */
  aspectRatios: string[]
  /**
   * Concrete durations (seconds) the family accepts, when its wire values are
   * not the panel's default list. Empty/omitted = the panel's VIDEO_DURATIONS.
   */
  durations?: number[]
  /** Display label per aspect value, when the wire word is not human readable. */
  aspectLabels?: Record<string, string>
  /** Whether the family accepts a deterministic seed. */
  supportsSeed: boolean
  /** Whether the family requires at least one reference image in image mode. */
  requiresReference: boolean
}

/** Families whose request shape we know, keyed by family id. */
const ENTRIES: Record<Exclude<VideoModelFamily, 'unknown'>, Omit<VideoCatalogEntry, 'family'>> = {
  'openai-video': {
    label: 'openai-video',
    labelZh: '通用视频',
    known: true,
    modes: ['text', 'image'],
    resolutions: ['480P', '720P', '1080P'],
    aspectRatios: [],
    supportsSeed: false,
    requiresReference: false,
  },
  // 部署自家网关的统一任务接口（`docs/video-client-integration.md`）：
  // `POST <base>/videos` 提交，`GET <base>/videos/{id}` 轮询，成品在
  // `metadata.url`；`metadata.image_mode` 区分玩法（text-to-video /
  // first-last-frame / reference），参考图走 `metadata.src_ref_images`。
  //
  // 分辨率只有 768P 一档：网关的 2K 是"生成 768P + RelayVSR 超分"，由聚合
  // 模型（`minimax-h3-2k` / `minimax-h3-ref-2k`）在服务端完成，客户端不需要
  // 也不应该自己挑 2K。时长 1–20 秒，这里仍按 5/10/15 三档提供。
  'h3-v2': {
    label: 'MaaS H3',
    labelZh: 'MaaS H3 视频',
    known: true,
    modes: ['text', 'image', 'keyframe', 'reference'],
    resolutions: ['768P'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    durations: [5, 10, 15],
    supportsSeed: false,
    requiresReference: false,
  },
}

/** Classify one upstream video model id into its request-shaping family. */
export function describeVideoModel(model: string): VideoCatalogEntry {
  const id = model.trim()
  if (id === '') return unknownEntry()
  // 部署自家网关的 H3 视频：裸名 `minimax-h3` 与四个交付 id（含 `-2k` /
  // `-ref-2k` 聚合形态）。整个 `minimax-h3` 前缀都归这一族——本插件只对接部署
  // 自己的网关，那个前缀在网关侧就只有这一种契约。
  if (/^minimax[-_.]?h3(?:$|[-_.])/i.test(id)) {
    return { family: 'h3-v2', ...ENTRIES['h3-v2'] }
  }
  // A well-known generic-video naming convention: anything that is clearly a
  // video model but not one of the families above still gets the generic
  // shape, flagged as known-but-generic so the UI can warn without blocking.
  if (isLikelyVideoModelId(id)) return { family: 'openai-video', ...ENTRIES['openai-video'] }
  return unknownEntry()
}

/** Most permissive classification for a model the user explicitly configured. */
function unknownEntry(): VideoCatalogEntry {
  return {
    family: 'unknown',
    label: 'unknown',
    labelZh: '未知协议',
    known: false,
    modes: ['text'],
    resolutions: ['720P'],
    aspectRatios: [],
    supportsSeed: false,
    requiresReference: false,
  }
}

/** The family a video model id routes its request through. */
export function videoModelFamily(model: string): VideoModelFamily {
  return describeVideoModel(model).family
}

/** Conservative fallback for providers whose /models response only has ids. */
export function isLikelyVideoModelId(model: string): boolean {
  return /(?:^|[-_.])(?:video|t2v|i2v|motion|animate|sora|veo|kling|runway|pika|luma|haiper|minimax-h3)(?:$|[-_.])/i.test(model.trim())
}

/** Normalize a user-entered video model list, dropping blanks and duplicates. */
export function normalizeVideoModels(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : []
  const unique = new Set<string>()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const model = candidate.trim()
    if (model !== '') unique.add(model)
  }
  return [...unique]
}

/** Normalize a channel's video catalog (alias → upstream id), blanks dropped. */
export function normalizeVideoCatalog(value: unknown): ModelMapping[] {
  if (!Array.isArray(value)) return []
  const rows: ModelMapping[] = []
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object') continue
    const raw = candidate as Record<string, unknown>
    const alias = typeof raw.alias === 'string' ? raw.alias.trim() : ''
    if (alias === '') continue
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : alias
    rows.push({ alias, id })
  }
  return [...new Map(rows.map(row => [row.alias, row])).values()]
}

/**
 * The upstream id a channel alias actually resolves to.
 *
 * Capability checks (modes, resolutions, family) must describe the id the
 * provider RECEIVES, not the alias the user typed: a channel can map
 * `gateway-hd` → `minimax-h3-2k`, and only the latter decides the family.
 * Describing the alias would offer a tier the id rejects.
 *
 * Falls back to the alias itself when no channel maps it (a request built
 * outside the panel, or a catalog edited after selection).
 */
export function resolveVideoModelId(
  alias: string,
  channels: ReadonlyArray<{ videoModels?: ReadonlyArray<{ alias: string; id?: string }> }> | undefined,
): string {
  const wanted = alias.trim()
  if (wanted === '') return ''
  for (const channel of channels ?? []) {
    for (const row of channel.videoModels ?? []) {
      if (row.alias !== wanted) continue
      const upstream = (row.id ?? '').trim()
      return upstream === '' ? wanted : upstream
    }
  }
  return wanted
}


/**
 * Durations one catalog entry offers, in seconds.
 *
 * Families whose wire values are not the panel's own list (H3 speaks 5/10/15)
 * declare them on the entry; everything else falls back to the shared list, so
 * the pickers stay single-sourced here instead of each rendering its own
 * hardcoded copy.
 */
export function durationsOf(entry: VideoCatalogEntry): number[] {
  return entry.durations !== undefined && entry.durations.length > 0 ? [...entry.durations] : [...VIDEO_DURATIONS]
}

/** Durations the given model id offers (alias resolved by the caller). */
export function videoDurationsFor(model: string): number[] {
  return durationsOf(describeVideoModel(model))
}

/** Clamp a requested duration into what the family accepts. */
export function clampVideoSeconds(seconds: number): number {
  const rounded = Math.round(seconds)
  if (!Number.isFinite(rounded) || rounded <= 0) return 5
  return Math.min(30, Math.max(1, rounded))
}

/**
 * Ordered clarity tiers, lowest first.
 *
 * `768P` sits between 720P and 1080P: it is a real tier, not an alias, and it
 * must rank below 1080P so a model that only takes 768P degrades a 1080P ask
 * to it (and never up from 480P past a tier the caller asked for).
 */
const RESOLUTION_RANK: readonly VideoResolution[] = ['480P', '720P', '768P', '1080P']

/** Every tier the plugin can name on the wire, lowest first. */
export const VIDEO_RESOLUTIONS: readonly VideoResolution[] = ['480P', '720P', '768P', '1080P']

/**
 * Read one resolution off an untrusted request body.
 *
 * The route handlers used to spell the three old tiers out inline, which meant
 * a new tier had to be added in four places and silently became 720P if one was
 * missed. Parsing is centralised here: an unknown word still falls back to the
 * default (the request is never sent with a tier the panel cannot display), but
 * every tier the plugin understands is accepted as written.
 */
export function parseVideoResolution(value: unknown, fallback: VideoResolution = '720P'): VideoResolution {
  if (typeof value !== 'string') return fallback
  const wanted = value.trim().toUpperCase()
  return VIDEO_RESOLUTIONS.find(row => row === wanted) ?? fallback
}

/**
 * Position of one tier in `RESOLUTION_RANK`, or -1 for a word we do not know.
 *
 * Exported so the planner compares tiers with the same order the panel sorts
 * them by: two private copies of the list drifted apart the moment a tier was
 * added, and the drift showed up as a plan that "raised" quality.
 */
export function resolutionRank(resolution: string): number {
  return RESOLUTION_RANK.indexOf(resolution.trim().toUpperCase() as VideoResolution)
}

/**
 * Clamp one resolution to what the family understands.
 *
 * A model whose tier list was narrowed (Seedance fast/mini cap at 720p) must
 * degrade a too-high request to the best tier it does support — falling back
 * to the FIRST entry would turn a 1080P ask into 480P and quietly throw away
 * most of the picture. Requests below the supported floor still snap up to it.
 */
export function normalizeVideoResolution(model: string, resolution: string): VideoResolution {
  const entry = describeVideoModel(model)
  const wanted = resolution.trim().toUpperCase()
  const hit = entry.resolutions.find(row => row === wanted)
  if (hit !== undefined) return hit
  const ceiling = RESOLUTION_RANK.indexOf(wanted as VideoResolution)
  if (ceiling >= 0) {
    const below = entry.resolutions.filter(row => RESOLUTION_RANK.indexOf(row) <= ceiling)
    if (below.length > 0) {
      return below.reduce((best, row) => (RESOLUTION_RANK.indexOf(row) > RESOLUTION_RANK.indexOf(best) ? row : best))
    }
    const above = entry.resolutions.filter(row => RESOLUTION_RANK.indexOf(row) > ceiling)
    if (above.length > 0) {
      return above.reduce((best, row) => (RESOLUTION_RANK.indexOf(row) < RESOLUTION_RANK.indexOf(best) ? row : best))
    }
  }
  return entry.resolutions[0] ?? '720P'
}
