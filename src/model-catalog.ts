/**
 * Model catalog: protocol-family detection and capability annotation shared by
 * the engine, the settings card, and the panel. Known id patterns map onto the
 * OpenAI-compatible image protocol families this plugin shapes requests for;
 * anything unrecognized falls back to the generic OpenAI protocol (best
 * effort) and is flagged as unknown so the UI can warn without blocking.
 *
 * Framework-free (pure data + regex), safe for the client bundle to inline.
 */

/**
 * The family union now lives in `model-baseline.ts`, which is the data layer
 * this file reads. Re-exported here so the ~dozen existing imports of
 * `ModelFamily` from this module keep resolving to one declaration rather
 * than a second copy that could drift.
 */
export type { ModelFamily, ModelLifecycle } from './model-baseline.ts'
import { baselineEntry, normalizeModelId, type ModelFamily, type ModelLifecycle } from './model-baseline.ts'
export type { ModelBaselineEntry } from './model-baseline.ts'

/** Capability/identity annotation for one model id. */
export interface ModelCatalogEntry {
  /** Family the request is shaped for. */
  family: ModelFamily
  /** Short badge label (en). */
  label: string
  /** Short badge label (zh). */
  labelZh: string
  /** Whether the family is known (false = best-effort OpenAI protocol). */
  known: boolean
  /** Whether the family supports image-to-image edits. */
  supportsEdit: boolean
  /** Whether the family natively takes aspect-ratio dials. */
  supportsAspectRatio: boolean
  /** Quality tiers the family interprets natively. */
  qualityTiers: string[]
  /**
   * Where this exact id sits in its life, from the built-in baseline.
   *
   * Absent means "active" for a family we recognize — the table only records
   * exceptions, so the ordinary case costs nothing. `unknown` families report
   * `active` too: not knowing an id is not evidence that upstream retired it,
   * and guessing `deprecated` here would nag users on every gateway whose
   * naming we have not seen yet.
   *
   * This is a NOTICE, never a gate: no request is blocked or rewritten
   * because of it. See `model-baseline.ts` for why no shutdown dates are
   * recorded.
   */
  lifecycle: ModelLifecycle
  /** Id to suggest instead, when `lifecycle` is `deprecated` or `removed`. */
  replacement?: string
}

const ENTRIES: Record<Exclude<ModelFamily, 'unknown'>, Omit<ModelCatalogEntry, 'family' | 'lifecycle' | 'replacement'>> = {
  'gpt-image': {
    label: 'gpt-image',
    labelZh: 'GPT 图像',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: false,
    qualityTiers: ['1K', '2K', '4K'],
  },
  'dall-e': {
    label: 'DALL·E',
    labelZh: 'DALL·E',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: false,
    qualityTiers: ['auto'],
  },
  // 部署自家网关的 MiniMax-H3 图像走了 OpenAI 形状的 /images/generations 与
  // /images/edits，但尺寸只认 `size: WIDTHxHEIGHT`：32 像素对齐、面积落在
  // 2K 档 4.0–4.3MP 或 16MP 档 16.5–16.9MP（±15% 容差）、比例不超过 3:1，
  // 低于 2K 直接 400 而不是静默升档。所以 `supportsAspectRatio` 为 false —
  // 比例只在面板上做选择，真正发出去的是像素尺寸。
  'h3-image': {
    label: 'H3 Image',
    labelZh: 'H3 图像',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: false,
    qualityTiers: ['2K'],
  },
}

/** Documented upstream prompt hard limits (UTF-16 code units). The engine
 *  fast-fails on these before any network call and the panel counter shows
 *  them live; families absent here have no documented limit. */
const PROMPT_CHAR_LIMITS: Partial<Record<Exclude<ModelFamily, 'unknown'>, number>> = {
  // 部署自家网关的 H3 图像文档给的是 7000 字符。
  'h3-image': 7000,
}

/** The documented prompt character limit for a model id, or null when the
 *  family has no known limit. Single source of truth for engine enforcement
 *  and the panel's live counter. */
export function promptCharLimit(model: string): number | null {
  const { family } = describeModel(model)
  return (family !== 'unknown' ? PROMPT_CHAR_LIMITS[family] : undefined) ?? null
}

/** Classify one upstream model id into its request-shaping family.
 *
 * Three tiers, in this order, and the order is the whole point:
 *
 *   1. **Exact baseline** (`model-baseline.ts`). An id we have written down
 *      is answered by what we know about that id, never by a pattern that
 *      happens to match its name. This is also the only tier that can report
 *      a lifecycle, because it is the only one backed by a recorded source.
 *   2. **Family pattern.** Unlisted ids in a family we recognize. Upstream
 *      ships new suffixes (`-sunburst`, `-vip`, date stamps) faster than any
 *      table can be maintained, so the pattern is what keeps a fresh id from
 *      falling to `unknown` and losing its request shape.
 *   3. **`unknown`**, which still sends a best-effort OpenAI request.
 *
 * Both the raw id and the vendor-stripped one are tried at every tier: an
 * aggregator gateway addresses `google/gemini-3-pro-image`, and a leading
 * vendor segment describes who publishes the model, not how to call it.
 */
export function describeModel(model: string): ModelCatalogEntry {
  const id = normalizeModelId(model)
  // Tier 1: exact, with lifecycle. `entry.family` is already a known family
  // by construction of the baseline type, so ENTRIES always has its row.
  const entry = baselineEntry(model)
  if (entry !== undefined) {
    return {
      family: entry.family,
      ...ENTRIES[entry.family],
      lifecycle: entry.lifecycle ?? 'active',
      ...entry.replacement === undefined ? {} : { replacement: entry.replacement },
    }
  }
  // Tier 2: family by naming convention.
  // `chatgpt-image-latest` is the gateway's moving alias for its current
  // default image model. It is not pinned in the baseline (the alias moves),
  // but it speaks the same /images/generations + /images/edits contract.
  if (/^(?:gpt-image|chatgpt-image)/i.test(id)) return { family: 'gpt-image', ...ENTRIES['gpt-image'], lifecycle: 'active' }
  if (/^dall-e/i.test(id)) return { family: 'dall-e', ...ENTRIES['dall-e'], lifecycle: 'active' }
  // 部署自家网关的 H3 图像族：裸模型 `minimax-h3-image` 与聚合模型
  // `minimax-h3-image-enhanced` 都走 OpenAI 形状，尺寸只认 `size`。
  if (/^minimax[-_.]?h3[-_.]?image(?:$|[-_.])/i.test(id)) return { family: 'h3-image', ...ENTRIES['h3-image'], lifecycle: 'active' }
  // Tier 3.
  return { family: 'unknown', label: 'unknown', labelZh: '未知协议', known: false, supportsEdit: true, supportsAspectRatio: false, qualityTiers: [], lifecycle: 'active' }
}

/**
 * Whether this model id can answer with an animated GIF.
 *
 * GPT Image 2.6 (Sunburst / Flare) is the first family that takes
 * `output_format: 'gif'` plus `frame_count` / `frame_duration_ms` on
 * /images/generations. Earlier gpt-image versions and every other family here
 * reject the parameter, so the panel only offers the switch when this returns
 * true; sending the fields anywhere else would be a request the upstream
 * refuses. Gateway re-packagers append their own tags (`-web`, `-vip`): the
 * VIP tier of 2.6 is documented as NOT producing GIFs, so it stays excluded.
 */
export function supportsGifOutput(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (!/^gpt-image-2\.6(?:$|[-_.])/.test(id) && id !== 'chatgpt-image-latest') return false
  return !/(?:^|[-_.])vip(?:$|[-_.])/.test(id)
}

/** Documented GIF frame limits. The guide says 2-64 while the API reference
 *  says 2-16; 16 is the only ceiling both first-party sources agree on, so the
 *  host clamps to it instead of guessing which page is stale. */
export const GIF_FRAME_MIN = 2
export const GIF_FRAME_MAX = 16
export const GIF_FRAME_DEFAULT = 9
/** Documented default per-frame delay, in milliseconds. */
export const GIF_FRAME_MS_DEFAULT = 200

/**
 * Effective GIF frame count, shared by the engine, the panel's submit and the
 * panel's duration hint so all three answer with the same number.
 *
 * An empty number input arrives as 0, which is not a frame count the user
 * chose: it means "unset", so it falls back to the default exactly like
 * undefined does. Clamping 0 to the minimum instead made the hint promise the
 * default duration while the request asked for the shortest one.
 */
export function clampGifFrameCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return GIF_FRAME_DEFAULT
  return Math.min(GIF_FRAME_MAX, Math.max(GIF_FRAME_MIN, Math.round(value)))
}

/**
 * Effective per-frame GIF delay in milliseconds: at least 20ms, on the 10ms
 * grid the encoder uses. Unset (undefined / NaN / an emptied input's 0) means
 * the documented default, for the same reason as the frame count above.
 */
export function clampGifFrameDurationMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return GIF_FRAME_MS_DEFAULT
  return Math.max(20, Math.round(value / 10) * 10)
}

/** The family a model id routes its request through. */
export function modelFamily(model: string): ModelFamily {
  return describeModel(model).family
}

/** Which copy key explains a lifecycle state, or `null` to say nothing.
 *
 *  Split out from the panel so the mapping is testable without rendering, and
 *  so the "no notice" case is an explicit answer rather than a missing branch.
 *  Returns the key rather than the translated string because the caller owns
 *  the locale.
 *
 *  The return type is the literal union rather than `string` on purpose: the
 *  panel feeds it straight to `tt`, which only accepts real copy keys, and a
 *  bare `string` would force a cast at the call site — turning a compile-time
 *  guarantee into a runtime surprise the day a key is renamed. */
export type LifecycleNoticeKey =
  | 'model.deprecated'
  | 'model.deprecatedNoReplacement'
  | 'model.removed'
  | 'model.removedNoReplacement'

export function lifecycleNoticeKey(entry: Pick<ModelCatalogEntry, 'lifecycle' | 'replacement'>): LifecycleNoticeKey | null {
  if (entry.lifecycle === 'active') return null
  const hasReplacement = entry.replacement !== undefined && entry.replacement !== ''
  if (entry.lifecycle === 'removed') return hasReplacement ? 'model.removed' : 'model.removedNoReplacement'
  return hasReplacement ? 'model.deprecated' : 'model.deprecatedNoReplacement'
}
