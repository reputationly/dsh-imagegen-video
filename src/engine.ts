/**
 * Upstream proxy engine: forwards a generate request to the configured
 * OpenAI-compatible image endpoint (/images/generations for text-to-image,
 * /images/edits for image-to-image) and normalizes the response to base64
 * images so the browser never fetches the upstream itself.
 *
 * Framework-free (no cordis imports) so the route layer and tests can drive
 * it directly.
 */

import { isChatCompletionsUrl, resolveChannelProtocol, type ChannelProtocolPreference, type GeneratedImage, type GenerateRequest, type GenerateResult } from './protocol.ts'
import { detectImageMime } from './image-format.ts'
import { clampGifFrameCount, clampGifFrameDurationMs, modelFamily, supportsGifOutput } from './model-catalog.ts'
import { bodyByteLength, diagnoseNonJsonBody, excerptOf, networkErrorFields, readResponseExcerpt, readResponseText, recordDiagnostic, type DiagnosticPhase } from './diagnostics-store.ts'
import { recordSignal } from './signal-store.ts'

/** The upstream credentials one generation is submitted with. */
export interface UpstreamConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. https://gateway.example/v1 */
  apiUrl: string
  /** Bearer API key. */
  apiKey: string
  /** Use apiUrl verbatim as the generation endpoint instead of appending /images/*. */
  apiUrlFull?: boolean
  /** Request protocol; auto infers chat-completions from an exact chat URL. */
  protocol?: ChannelProtocolPreference
  /** Channel display name, recorded in diagnostics so a failure maps to a settings row. */
  channelName?: string
}

/** A generation failure with a user-presentable message. */
export class ImageGenError extends Error {
  /** Stable wire code. */
  readonly code: string

  constructor(message: string, code = 'generate-failed') {
    super(message)
    this.name = 'ImageGenError'
    this.code = code
  }
}

/** Total budget for the upstream generation call (image models are slow). */
const UPSTREAM_TIMEOUT_MS = 240_000

/** Total budget for downloading one result image URL, including retries. */
const IMAGE_FETCH_TIMEOUT_MS = 180_000

/** Budget for one attempt; a stalled CDN connection resumes with Range. */
const IMAGE_FETCH_ATTEMPT_TIMEOUT_MS = 45_000

/** A flaky result CDN may need several resumed attempts to finish. */
const IMAGE_FETCH_MAX_ATTEMPTS = 6

/** Pause before re-requesting a result URL. */
const IMAGE_FETCH_RETRY_DELAY_MS = 500

/** Cap on the reference image payload (edit mode), in bytes. */
const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024

/** Reference images one edit request may carry (the primary one included). */
const MAX_EDIT_REFERENCES = 5

/** Sizes dall-e-3 accepts; anything else falls back to its square default. */
const DALLE3_SIZES = new Set(['1024x1024', '1792x1024', '1024x1792'])

/** The wire model id for a request: `upstream` (host-filled alias mapping)
 *  wins, then the alias, then the family default. */
function wireModel(request: GenerateRequest): string {
  const upstream = request.upstream?.trim()
  if (upstream !== undefined && upstream !== '') return upstream
  const alias = request.model.trim()
  return alias === '' ? 'gpt-image-2' : alias
}

/** ModelScope's OpenAI-compatible image inference API always queues tasks. */
function isModelScopeInference(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api-inference.modelscope.cn'
  } catch {
    return false
  }
}

/** Normalize ModelScope's documented service-origin URL to its OpenAI API root. */
function normalizeModelScopeBaseUrl(baseUrl: string, apiUrlFull: boolean): string {
  if (apiUrlFull || !isModelScopeInference(baseUrl)) return baseUrl
  try {
    const url = new URL(baseUrl)
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1'
    return url.toString().replace(/\/$/, '')
  } catch {
    return baseUrl
  }
}

/** Recover the versioned API base when a channel stores the exact generation URL. */
function modelScopeTaskBaseUrl(baseUrl: string, apiUrlFull: boolean): string {
  if (!apiUrlFull) return baseUrl
  try {
    const url = new URL(baseUrl)
    url.pathname = url.pathname.replace(/\/images\/(?:generations|edits)\/?$/i, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return baseUrl
  }
}

/** The panel's aspect ratios mapped to the closest OpenAI pixel size
 *  (gpt-image-2 / generic OpenAI-compatible endpoints). */
const OPENAI_SIZE_BY_RATIO: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
  '3:4': '1024x1536',
  '4:3': '1536x1024',
  '9:16': '1024x1792',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
  '16:9': '1792x1024',
  '21:9': '1792x1024',
}

/**
 * 部署自家网关的 MiniMax-H3 图像尺寸表：只认 `size`，且必须落在 2K 计费档
 * （4.0–4.3MP、两边 32 的倍数、比例不超过 3:1）。低于 2K 网关直接 400，
 * 不会静默升档，所以面板上的比例必须在这里一次性换成交付尺寸。
 */
const H3_IMAGE_2K_SIZE_BY_RATIO: Readonly<Record<string, string>> = {
  '1:1': '2048x2048',
  '4:3': '2368x1760',
  '3:4': '1760x2368',
  '3:2': '2368x1760',
  '2:3': '1760x2368',
  '16:9': '2720x1536',
  '9:16': '1536x2720',
  '21:9': '3136x1344',
  '3:1': '3552x1184',
  '1:3': '1184x3552',
}

/** 没有比例或比例不在表内时的兜底：2K 档的正方形。 */
const H3_IMAGE_DEFAULT_SIZE = '2048x2048'

/** The panel's aspect ratios mapped to a FRAME size for GIF output.
 *  Every frame shares one image's pixel budget, so the 1024/1536 tiers above
 *  would leave each frame too small to read once 9+ frames are packed in.
 *  These are the documented working shape (512x512 for 9 frames) scaled by
 *  ratio; every edge stays a multiple of 16, which the API requires. */
const GIF_SIZE_BY_RATIO: Readonly<Record<string, string>> = {
  '1:1': '512x512',
  '3:4': '480x640',
  '4:3': '640x480',
  '9:16': '432x768',
  '2:3': '480x720',
  '3:2': '720x480',
  '16:9': '768x432',
  '21:9': '672x288',
}

/**
 * One request-scoped timeout that is cleared as soon as its fetch settles.
 * AbortSignal.timeout() cannot be disposed early; using it inside a long-lived
 * task queue leaves an otherwise idle Node process holding every timeout.
 */
function requestSignal(source: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromSource = () => { controller.abort(source?.reason) }
  if (source?.aborted === true) abortFromSource()
  else source?.addEventListener('abort', abortFromSource, { once: true })
  const timeout = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, timeoutMs)
  timeout.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      source?.removeEventListener('abort', abortFromSource)
    },
  }
}

/** Whether an error was produced by a requestSignal budget timeout. These can
 * surface from the fetch call itself or from reading the response body, so the
 * budget must stay armed until the body has been consumed. */
function isBudgetTimeout(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'TimeoutError'
}

/** Content-type extension hints for URL-fetched images. */function mimeOfExtension(path: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  if (match === null) return undefined
  switch (match[1]!.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return undefined
  }
}

/** Parse `data:<mime>;base64,<payload>` into its parts; undefined when malformed. */
function parseDataUrl(dataUrl: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim())
  if (match === null || match[3] === undefined) return undefined
  if (match[2] === undefined) {
    // Plain (non-base64) data URLs are not supported for reference images.
    return undefined
  }
  return { mime: match[1] ?? 'application/octet-stream', base64: match[3] }
}

/** Strip a data: prefix from an upstream b64 payload if a gateway added one. */
function bareBase64(value: string): string {
  const parsed = parseDataUrl(value)
  return parsed !== undefined && parsed.base64 !== undefined ? parsed.base64 : value
}

/** Whether a result URL carries cloud-storage signing credentials. */
function isPresignedUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const params = new Set(Array.from(url.searchParams.keys(), key => key.toLowerCase()))
  if (params.has('x-goog-signature') || params.has('x-goog-credential')) return true
  if (params.has('x-amz-signature') || params.has('x-amz-credential')) return true
  return params.has('signature') && (
    params.has('expires') || params.has('googleaccessid') || params.has('awsaccesskeyid')
  )
}

/** Resolve the request URL for a channel: base URL + path, or the exact URL. */
function endpointUrl(upstream: UpstreamConfig, baseUrl: string, path: string): string {
  return upstream.apiUrlFull === true ? baseUrl : `${baseUrl}${path}`
}

/**
 * Whether a result URL lives on the same origin as the configured API base.
 * The upstream Bearer key is only ever forwarded to this origin: a provider
 * (or a compromised relay) that hands back an image URL on a foreign host
 * must not be able to harvest the key through that download.
 */
function isSameOriginAsApi(value: string, apiUrl: string): boolean {
  try {
    return new URL(value).origin === new URL(apiUrl).origin
  } catch {
    return false
  }
}

/** Clamp the requested image count into the API-accepted range. */
function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(4, Math.max(1, Math.round(n)))
}

/**
 * Refuse a GIF request the upstream cannot serve, before any network call.
 *
 * Called from generateImage() ahead of the protocol dispatch, NOT from
 * effectiveParams(): the chat-completions and native-family branches return
 * before that point, so a gate placed there would let those requests through.
 *
 * Two hard limits: only gpt-image-2.6 takes `output_format: 'gif'`, and the
 * upstream guide states /images/edits does not produce GIF — an edit request
 * carrying the parameter would either be ignored or rejected, and either way
 * the user paid for a still they did not ask for. Saying so up front is the
 * only honest answer.
 */
function assertGifRequestSupported(request: GenerateRequest, model: string): void {
  if (request.outputFormat !== 'gif') return
  if (!supportsGifOutput(model)) {
    throw new ImageGenError('该模型不支持 GIF 动图，请切换到 gpt-image-2.6', 'gif-unsupported')
  }
  if (request.mode === 'edit') {
    throw new ImageGenError('GIF 动图只支持文字生成，参考图不参与动图请求', 'gif-edit-unsupported')
  }
}

/** Pick the effective per-model request parameters. Never includes `n`: the
 *  batch parameter is rejected by Responses-API-based gateways (tools[0].n),
 *  so the count is satisfied by parallel single-image requests instead. */
function effectiveParams(request: GenerateRequest): {
  model: string
  size?: string
  quality?: string
  detail?: string
  output_format?: string
  frame_count?: number
  frame_duration_ms?: number
} {
  const model = wireModel(request)
  // Animated GIF: only gpt-image-2.6 answers this, and only in generation
  // mode. The frame knobs travel next to the ordinary OpenAI fields, and the
  // per-frame size comes from GIF_SIZE_BY_RATIO because every frame shares one
  // image's pixel budget.
  if (request.outputFormat === 'gif') {
    return {
      model,
      ...request.size !== '' && request.size !== 'auto' && GIF_SIZE_BY_RATIO[request.size] !== undefined
        ? { size: GIF_SIZE_BY_RATIO[request.size] }
        : {},
      ...request.quality === '1k' ? { quality: 'low' } : {},
      ...request.quality === '2k' ? { quality: 'medium' } : {},
      ...request.quality === '4k' ? { quality: 'high' } : {},
      output_format: 'gif',
      frame_count: clampGifFrameCount(request.frameCount),
      frame_duration_ms: clampGifFrameDurationMs(request.frameDurationMs),
    }
  }
  // dall-e-3 has no quality/detail knobs and only produces one image.
  if (model === 'dall-e-3') {
    const pixel = OPENAI_SIZE_BY_RATIO[request.size]
    const size = (pixel !== undefined && DALLE3_SIZES.has(pixel)) ? pixel : '1024x1024'
    return { model, size }
  }
  // 部署自家网关的 MiniMax-H3 图像：只发 `size`。
  //
  // 两条必须分开处理：
  //  - 聚合模型（`-enhanced`）在网关侧用 PE 自动定画幅并映射到 2K 画布，
  //    但**只有客户端不传 size 时**才这么做；一旦传了 <2K 的尺寸，网关的
  //    尺寸策略会直接 400。所以聚合模型这里一个尺寸字段都不能发。
  //  - 裸模型（`minimax-h3-image`）必须由我们把面板比例换成 2K 档像素。
  if (modelFamily(model) === 'h3-image') {
    // 标注重绘按原图画幅给出的像素尺寸，两个 H3 模型都照发。
    if (request.annotationCanvas !== undefined) return { model, size: request.annotationCanvas }
    if (/-enhanced(?:$|[-_.])/i.test(model)) return { model }
    return {
      model,
      size: H3_IMAGE_2K_SIZE_BY_RATIO[request.size] ?? H3_IMAGE_DEFAULT_SIZE,
    }
  }
  // OpenAI-compatible endpoints: nearest pixel size, clarity tiers mapped to
  // the quality levels (1k→low / 2k→medium / 4k→high), detail passthrough.
  return {
    model,
    ...request.size !== '' && request.size !== 'auto' && OPENAI_SIZE_BY_RATIO[request.size] !== undefined
      ? { size: OPENAI_SIZE_BY_RATIO[request.size] }
      : {},
    ...request.quality === '1k' ? { quality: 'low' } : {},
    ...request.quality === '2k' ? { quality: 'medium' } : {},
    ...request.quality === '4k' ? { quality: 'high' } : {},
    ...request.detail !== '' ? { detail: request.detail } : {},
  }
}

/** How many single-image requests to issue for the requested image count. */
function effectiveCount(request: GenerateRequest): number {
  const model = wireModel(request)
  // One animated GIF per call: frame count, frame size and image count share a
  // single pixel budget upstream, so asking for four animations at 16 frames
  // would be rejected rather than produced.
  if (request.outputFormat === 'gif') return 1
  if (model === 'dall-e-3') return 1
  return clampCount(request.n)
}

/** Parse `Content-Range` for a resumed result download. */
function parseContentRange(value: string | null): { start?: number; total?: number } | undefined {
  if (value === null || value.trim() === '') return undefined
  const match = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(value.trim())
  if (match === null) return undefined
  const total = match[3] === undefined || match[3] === '*' ? undefined : Number(match[3])
  return {
    ...match[1] === undefined ? {} : { start: Number(match[1]) },
    ...total === undefined || !Number.isFinite(total) ? {} : { total },
  }
}

/** Whether an HTTP status is worth retrying for a result download. */
function retryableResultStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** Wait between result-download attempts, but wake immediately on cancel. */
async function waitForResultRetry(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ImageGenError('任务已取消', 'cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, IMAGE_FETCH_RETRY_DELAY_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Reject a URL result that ended cleanly but is visibly a truncated image. */
function resultLooksComplete(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  const mime = detectImageMime(buffer)
  if (mime === 'image/png') {
    return buffer.length >= 12 && buffer.subarray(-8, -4).toString('latin1') === 'IEND'
  }
  if (mime === 'image/webp') {
    return buffer.length >= 12
      && buffer.toString('latin1', 0, 4) === 'RIFF'
      && buffer.readUInt32LE(4) + 8 === buffer.length
  }
  if (mime === 'image/jpeg') {
    return buffer.length >= 2 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9
  }
  if (mime === 'image/gif') return buffer[buffer.length - 1] === 0x3b
  return true
}

/**
 * Download one result URL with ranged retries.
 *
 * Gateways commonly return a pre-signed or CDN URL instead of base64. That URL
 * can be slow or reset mid-body from some networks even while the generation
 * itself succeeded. A plain `arrayBuffer()` turns that into a paid failure:
 * every retry starts from byte zero, so a throttled 1.5 MB image never lands.
 * This path keeps every byte it already has and asks for the remainder, and it
 * turns a timeout into a diagnostic row instead of a raw `DOMException`.
 */
async function downloadResultImage(
  url: string,
  upstream: UpstreamConfig,
  signal: AbortSignal | undefined,
  context: AttemptContext,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const deadline = Date.now() + IMAGE_FETCH_TIMEOUT_MS
  const chunks: Buffer[] = []
  let received = 0
  let total: number | undefined
  let attempts = 0
  let lastStatus: number | undefined
  let lastBody: string | undefined
  let lastError: unknown
  let contentType: string | null = null
  const forwardKey = upstream.apiKey !== ''
    && !isPresignedUrl(url)
    && isSameOriginAsApi(url, upstream.apiUrl)

  while (attempts < IMAGE_FETCH_MAX_ATTEMPTS && Date.now() < deadline) {
    attempts += 1
    const remaining = deadline - Date.now()
    const budget = requestSignal(signal, Math.max(1, Math.min(IMAGE_FETCH_ATTEMPT_TIMEOUT_MS, remaining)))
    try {
      let response: Response
      try {
        response = await fetch(url, {
          headers: {
            accept: 'image/*',
            ...forwardKey ? { authorization: `Bearer ${upstream.apiKey}` } : {},
            ...received > 0 ? { range: `bytes=${received}-` } : {},
          },
          signal: budget.signal,
        })
      } catch (error) {
        lastError = error
        if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
        await waitForResultRetry(signal)
        continue
      }

      lastStatus = response.status
      const contentRange = parseContentRange(response.headers.get('content-range'))
      if (response.status === 416) {
        // The server says the requested range starts at/after EOF. If the
        // bytes already in hand cover its total, the download is complete.
        if (received > 0 && contentRange?.total !== undefined && received >= contentRange.total) {
          return { buffer: Buffer.concat(chunks, received), contentType }
        }
        lastError = new Error('result server rejected the resume range')
        break
      }
      if (!response.ok) {
        lastBody = await readResponseExcerpt(response)
        lastError = new Error(`HTTP ${response.status}`)
        if (!retryableResultStatus(response.status)) break
        await waitForResultRetry(signal)
        continue
      }

      // A 200 answer ignores Range and restarts the whole body; a 206 answer
      // continues it. Any unexpected 206 offset is safer to restart than to
      // append two different byte ranges together.
      const resumed = response.status === 206
      const rangeStart = contentRange?.start
      if (resumed && rangeStart !== undefined && rangeStart !== received) {
        lastError = new Error(`result server resumed at byte ${rangeStart}, expected ${received}`)
        await waitForResultRetry(signal)
        continue
      }
      if (!resumed) {
        chunks.length = 0
        received = 0
      }
      contentType = response.headers.get('content-type') ?? contentType
      if (resumed) {
        if (contentRange?.total !== undefined) total = contentRange.total
      } else {
        const length = Number(response.headers.get('content-length'))
        total = Number.isFinite(length) && length > 0 ? length : undefined
      }

      const reader = response.body?.getReader()
      if (reader === undefined) {
        const buffer = Buffer.from(await response.arrayBuffer())
        chunks.push(buffer)
        received += buffer.length
      } else {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value !== undefined) {
              const chunk = Buffer.from(value)
              chunks.push(chunk)
              received += chunk.length
            }
          }
        } catch (error) {
          lastError = error
          await reader.cancel().catch(() => undefined)
          if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
          await waitForResultRetry(signal)
          continue
        }
      }

      if (total !== undefined && received < total) {
        lastError = new Error(`result body ended early (${received}/${total} bytes)`)
        await waitForResultRetry(signal)
        continue
      }
      const buffer = Buffer.concat(chunks, received)
      if (!resultLooksComplete(buffer)) {
        lastError = new Error('downloaded image is incomplete')
        await waitForResultRetry(signal)
        continue
      }
      return { buffer, contentType }
    } finally {
      budget.dispose()
    }
  }

  if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
  const network = lastError === undefined ? undefined : networkErrorFields(lastError)
  const detail = [
    lastStatus === undefined ? '' : `HTTP ${lastStatus}`,
    network?.detail ?? (lastError === undefined ? 'no usable response' : ''),
  ].filter(part => part !== '').join(' · ')
  const progress = received > 0
    ? ` after ${received}${total === undefined ? '' : `/${total}`} bytes`
    : ''
  const failure = new ImageGenError(
    `failed to fetch the generated image url: ${detail === '' ? 'download failed' : detail}${progress} (${attempts} attempt${attempts === 1 ? '' : 's'})`,
  )
  recordFailure(context, failure, { status: lastStatus, bodyExcerpt: lastBody })
  throw failure
}

/** Normalize one upstream data item into a base64 image. */
async function normalizeItem(
  item: Record<string, unknown>,
  upstream: UpstreamConfig,
  signal?: AbortSignal,
): Promise<{ b64: string; mime: string; revisedPrompt?: string }> {
  const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
  if (typeof item.b64_json === 'string' && item.b64_json.trim() !== '') {
    const b64 = bareBase64(item.b64_json)
    if (b64.trim() !== '') {
      return { b64, mime: detectImageMime(Buffer.from(b64, 'base64')) ?? 'image/png', revisedPrompt }
    }
  }
  if (typeof item.url !== 'string' || item.url === '') {
    throw new ImageGenError('upstream image item has neither b64_json nor url')
  }
  const url = item.url
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) throw new ImageGenError('upstream returned a malformed data: url')
    return { b64: parsed.base64, mime: detectImageMime(Buffer.from(parsed.base64, 'base64')) ?? parsed.mime, revisedPrompt }
  }
  const resultContext: AttemptContext = {
    phase: 'fetch-result',
    channel: upstream.channelName?.trim() || '默认渠道',
    model: '',
    mode: 'result',
    url: displayUrl(url),
    method: 'GET',
    hadAuth: upstream.apiKey !== '' && !isPresignedUrl(url) && isSameOriginAsApi(url, upstream.apiUrl),
    startedAt: Date.now(),
  }
  const { buffer, contentType } = await downloadResultImage(url, upstream, signal, resultContext)
  const mime = detectImageMime(buffer)
    ?? (contentType !== null && contentType !== ''
    ? contentType.split(';')[0]!.trim()
    : mimeOfExtension(url) ?? 'image/png')
  return { b64: buffer.toString('base64'), mime, revisedPrompt }
}

/** Expand a provider image item whose URL may be a string or an array. */
function imageItemsOf(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string' && value.trim() !== '') return [{ url: value.trim() }]
  if (value === null || typeof value !== 'object') return []
  const item = value as Record<string, unknown>
  if (Array.isArray(item.url)) {
    return item.url.filter((url): url is string => typeof url === 'string' && url !== '').map(url => ({ ...item, url }))
  }
  return [item]
}

/** Return the data records from the response shapes shared by sync gateways. */
function dataRecordsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const data = Array.isArray(payload.data)
    ? payload.data
    : payload.data !== null && typeof payload.data === 'object'
      ? [payload.data]
      : Array.isArray(payload.images)
        ? payload.images
        : Array.isArray(payload.output)
          ? payload.output
          : undefined
  if (data === undefined) return undefined
  return data.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
}

/** Remove reasoning-model wrappers before treating chat content as a user-visible error. */
function stripChatReasoning(value: string): string {
  const withoutClosed = value.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const dangling = /<think>/i.exec(withoutClosed)
  return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim()
}

/** Whether a URL returned in chat content is plausibly an image resource. */
function isLikelyImageUrl(value: string): boolean {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true
  try {
    const url = new URL(value)
    if (mimeOfExtension(url.pathname) !== undefined) return true
    const signal = `${url.hostname}${url.pathname}${url.search}`.toLowerCase()
    return /(?:image|img|photo|picture|cdn|blob|cloudinary|googleusercontent|oaidalle|replicate|fal\.media|files\.oai)/.test(signal)
  } catch {
    return false
  }
}

/** Parse a complete or fenced JSON value embedded in chat text. */
function parseEmbeddedJson(value: string): unknown {
  const cleaned = stripChatReasoning(value).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  if (cleaned === '') return undefined
  const attempts = [cleaned]
  const objectStart = cleaned.indexOf('{')
  const objectEnd = cleaned.lastIndexOf('}')
  const arrayStart = cleaned.indexOf('[')
  const arrayEnd = cleaned.lastIndexOf(']')
  if (objectStart >= 0 && objectEnd > objectStart) attempts.push(cleaned.slice(objectStart, objectEnd + 1))
  if (arrayStart >= 0 && arrayEnd > arrayStart) attempts.push(cleaned.slice(arrayStart, arrayEnd + 1))
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch { /* try the next candidate */ }
  }
  return undefined
}

/** Collect image references from structured Chat Completions content. */
function collectChatImageItems(
  value: unknown,
  out: Array<Record<string, unknown>>,
  seen: Set<object>,
  depth = 0,
): void {
  if (depth > 6 || value === null || value === undefined) return
  if (typeof value === 'string') {
    const parsed = parseEmbeddedJson(value)
    if (parsed !== undefined && parsed !== value) collectChatImageItems(parsed, out, seen, depth + 1)
    const markdown = /!\[[^\]]*\]\((?:<)?(https?:\/\/[^)\s>]+|data:image\/[^)\s>]+)(?:>)?\)/gi
    for (const match of value.matchAll(markdown)) if (match[1] !== undefined) out.push({ url: match[1] })
    const html = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
    for (const match of value.matchAll(html)) if (match[1] !== undefined) out.push({ url: match[1] })
    const urls = value.match(/(?:https?:\/\/|data:image\/)[^\s"'<>)\]}]+/gi) ?? []
    for (const raw of urls) {
      const url = raw.replace(/[.,;:!?]+$/, '')
      if (isLikelyImageUrl(url)) out.push({ url })
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectChatImageItems(item, out, seen, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (seen.has(record)) return
  seen.add(record)

  if (typeof record.b64_json === 'string' && record.b64_json.trim() !== '') {
    out.push({ b64_json: record.b64_json })
  }
  for (const key of ['url', 'image_url', 'image', 'output_url']) {
    const item = record[key]
    if (typeof item === 'string' && item !== '') {
      if (key !== 'url' || isLikelyImageUrl(item)) out.push({ url: item })
    } else if (item !== null && typeof item === 'object') {
      const nested = item as Record<string, unknown>
      if (key !== 'url' && typeof nested.url === 'string' && nested.url !== '') out.push({ url: nested.url })
      else collectChatImageItems(item, out, seen, depth + 1)
    }
  }
  for (const key of ['images', 'content', 'message', 'data', 'output', 'result']) {
    if (key in record) collectChatImageItems(record[key], out, seen, depth + 1)
  }
}

/** Extract every image candidate from one Chat Completions response. */
function chatImageItemsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const seenValues = new Set<object>()
  const data = dataRecordsOf(payload)
  if (data !== undefined) {
    for (const record of data) collectChatImageItems(record, out, seenValues)
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue
    const message = (choice as Record<string, unknown>).message
    collectChatImageItems(message, out, seenValues)
    const delta = (choice as Record<string, unknown>).delta
    collectChatImageItems(delta, out, seenValues)
  }
  if (out.length === 0) collectChatImageItems(payload.images, out, seenValues)

  const unique = new Map<string, Record<string, unknown>>()
  for (const item of out) {
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    const b64 = typeof item.b64_json === 'string' ? item.b64_json.trim() : ''
    const key = url !== '' ? `url:${url}` : b64 !== '' ? `b64:${b64.slice(0, 128)}` : ''
    if (key !== '' && !unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()]
}

/** User-visible text from a Chat response, used only when no image was found. */
function chatErrorTextOf(payload: Record<string, unknown>): string | undefined {
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = choices[0]
  const content = first !== null && typeof first === 'object'
    ? (first as { message?: { content?: unknown } }).message?.content
    : undefined
  const pieces: string[] = []
  if (typeof content === 'string') pieces.push(stripChatReasoning(content))
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') pieces.push(stripChatReasoning(part))
      else if (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        pieces.push(stripChatReasoning((part as { text: string }).text))
      }
    }
  }
  if (pieces.join('\n').trim() !== '') return pieces.join('\n').trim()
  if (typeof payload.message === 'string' && payload.message.trim() !== '') return payload.message.trim()
  const error = payload.error
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message.trim()
  }
  return undefined
}

const ASYNC_PENDING_STATUSES = new Set(['submitted', 'pending', 'processing', 'running', 'in_progress', 'queued'])
const ASYNC_COMPLETED_STATUSES = new Set(['completed', 'succeeded', 'succeed', 'success', 'done'])
const ASYNC_FAILED_STATUSES = new Set(['failed', 'failure', 'cancelled', 'canceled', 'error'])
const ASYNC_POLL_MAX_MS = 240_000
const ASYNC_POLL_REQUEST_TIMEOUT_MS = 30_000

// new-api 的异步图片任务契约：提交返回 202 + image.generation.job，轮询
// GET /images/generations/{id}。大面积 2K 局部重绘经常超过同步接口的
// 240s 预算，不能把一次仍在正常排队/生成的任务误判成失败。
const IMAGE_JOB_OBJECT = 'image.generation.job'
const IMAGE_JOB_POLL_MAX_MS = 600_000
const IMAGE_JOB_POLL_REQUEST_TIMEOUT_MS = 30_000
const IMAGE_JOB_PENDING_STATUSES = new Set(['queued', 'in_progress', 'submitted', 'pending', 'processing', 'running'])

/** Read a provider error message from the common nested locations. */
function asyncErrorMessage(payload: unknown, fallback: string): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const candidates: unknown[] = [record.message, record.error]
    const data = record.data
    const entries = Array.isArray(data) ? data : [data]
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      candidates.push(item.message, item.error)
      const nested = item.error
      if (nested !== null && typeof nested === 'object') candidates.push((nested as Record<string, unknown>).message)
    }
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
      if (candidate !== null && typeof candidate === 'object') {
        const message = (candidate as Record<string, unknown>).message
        if (typeof message === 'string' && message.trim() !== '') return message
      }
    }
  }
  return fallback
}

/** Wait between async-provider polls, but wake immediately when cancelled. */
function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const done = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll an asynchronous provider task until it yields image records (including ModelScope response fields).
 * The total deadline is shared by every poll and the final image downloads;
 * local task cancellation propagates through every request and sleep.
 */
async function pollAsyncTask(
  baseUrl: string,
  upstream: UpstreamConfig,
  taskId: string,
  signal?: AbortSignal,
  modelScope = false,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + ASYNC_POLL_MAX_MS
  let delay = 1000
  const pollUrl = `${baseUrl}/tasks/${encodeURIComponent(taskId)}`
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const budget = requestSignal(signal, Math.min(ASYNC_POLL_REQUEST_TIMEOUT_MS, remaining))
    const context: AttemptContext = {
      phase: 'poll-task',
      channel: upstream.channelName?.trim() || '默认渠道',
      model: '',
      mode: 'poll',
      url: displayUrl(pollUrl),
      method: 'GET',
      hadAuth: upstream.apiKey.trim() !== '',
      startedAt: Date.now(),
    }
    try {
      let response: Response
      try {
        response = await fetch(pollUrl, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${upstream.apiKey.trim()}`,
            ...(modelScope ? { 'X-ModelScope-Task-Type': 'image_generation' } : {}),
          },
          signal: budget.signal,
        })
      } catch (error) {
        const failure = signal?.aborted === true
          ? new ImageGenError('任务已取消', 'cancelled')
          : isBudgetTimeout(error)
            ? new ImageGenError('上游异步任务轮询超时', 'upstream-timeout')
            : new ImageGenError(`无法轮询上游异步任务：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
        recordFailure(context, failure)
        throw failure
      }
      // Parsing reads the RAW body: a poll response carries the result images.
      const responseText = await readResponseText(response)
      let payload: unknown
      try {
        payload = JSON.parse(responseText)
      } catch (error) {
        const failure = isBudgetTimeout(error)
          ? new ImageGenError('上游异步任务轮询超时', 'upstream-timeout')
          : nonJsonFailure('上游任务接口', pollUrl, response, responseText)
        recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
        throw failure
      }
      if (!response.ok || payload === null || typeof payload !== 'object') {
        const failure = new ImageGenError(asyncErrorMessage(payload, `上游任务轮询失败（HTTP ${response.status}）`), 'upstream-rejected')
        recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
        throw failure
      }
      const record = payload as Record<string, unknown>
      const data = record.data
      const statusRecord = Array.isArray(data) ? data[0] : data !== null && typeof data === 'object' ? data : record
      const statusValue = statusRecord !== null && typeof statusRecord === 'object'
        ? ((statusRecord as Record<string, unknown>).task_status ?? (statusRecord as Record<string, unknown>).status)
        : undefined
      const status = typeof statusValue === 'string' ? statusValue.toLowerCase() : ''
      if (ASYNC_FAILED_STATUSES.has(status)) {
        throw new ImageGenError(asyncErrorMessage(payload, `上游异步任务失败（${status || 'unknown'}）`), 'upstream-rejected')
      }
      const nested = statusRecord !== null && typeof statusRecord === 'object' ? statusRecord as Record<string, unknown> : record
      const result = nested.result ?? (nested.output !== null && typeof nested.output === 'object' ? (nested.output as Record<string, unknown>).result : undefined) ?? record.result
      const resultRecord = result !== null && typeof result === 'object' ? result as Record<string, unknown> : undefined
      const images = resultRecord?.images
        ?? resultRecord?.output_images
        ?? nested.images
        ?? nested.output_images
        ?? record.images
        ?? record.output_images
      if (ASYNC_COMPLETED_STATUSES.has(status) || images !== undefined) {
        const items = Array.isArray(images) ? images.flatMap(imageItemsOf) : imageItemsOf(images)
        if (items.length > 0) return items
        if (ASYNC_COMPLETED_STATUSES.has(status)) throw new ImageGenError('上游异步任务完成但没有图片结果', 'upstream-empty')
      }
      if (status !== '' && !ASYNC_PENDING_STATUSES.has(status) && !ASYNC_COMPLETED_STATUSES.has(status)) {
        throw new ImageGenError(`上游返回了未知异步任务状态：${status}`, 'upstream-invalid')
      }
    } finally {
      budget.dispose()
    }
    await waitForPoll(Math.min(delay, Math.max(1, deadline - Date.now())), signal)
    delay = Math.min(5000, delay * 2)
  }
  throw new ImageGenError('上游异步任务轮询超时（240 秒）', 'upstream-timeout')
}

/** Whether one payload is new-api's asynchronous image-job envelope. */
function imageJobIdOf(record: Record<string, unknown>): string | undefined {
  if (record.object !== IMAGE_JOB_OBJECT) return undefined
  return typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : undefined
}

/** Derive the image-job polling URL when the gateway omitted Location. */
function imageJobUrlOf(requestUrl: string, upstream: UpstreamConfig, baseUrl: string, taskId: string): string {
  if (upstream.apiUrlFull !== true) return `${baseUrl}/images/generations/${encodeURIComponent(taskId)}`
  try {
    const url = new URL(requestUrl)
    url.pathname = url.pathname.replace(/\/images\/edits\/?$/i, `/images/generations/${encodeURIComponent(taskId)}`)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return `${baseUrl}/images/generations/${encodeURIComponent(taskId)}`
  }
}

/** Parse a Retry-After hint into a bounded poll delay. */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.min(15_000, Math.max(1_000, Math.round(seconds * 1000)))
}

/**
 * Poll a new-api asynchronous image job and return its data records.
 *
 * The job payload deliberately reuses the sync `data` shape when completed, so
 * the caller can hand the records to the same normalizer. This is the same
 * cancellation model as pollAsyncTask: local cancellation interrupts both the
 * active poll and the sleep, while upstream work continues server-side.
 */
async function pollImageJob(
  jobUrl: string,
  upstream: UpstreamConfig,
  signal: AbortSignal | undefined,
  firstDelayMs?: number,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + IMAGE_JOB_POLL_MAX_MS
  let delay = firstDelayMs ?? 2_000
  let first = true
  for (;;) {
    if (Date.now() >= deadline) throw new ImageGenError('上游异步图片任务轮询超时（600 秒）', 'upstream-timeout')
    if (first) first = false
    else await waitForPoll(Math.min(delay, Math.max(1, deadline - Date.now())), signal)
    const remaining = deadline - Date.now()
    const budget = requestSignal(signal, Math.min(IMAGE_JOB_POLL_REQUEST_TIMEOUT_MS, remaining))
    const context: AttemptContext = {
      phase: 'poll-task',
      channel: upstream.channelName?.trim() || '默认渠道',
      model: '',
      mode: 'poll',
      url: displayUrl(jobUrl),
      method: 'GET',
      hadAuth: upstream.apiKey.trim() !== '',
      startedAt: Date.now(),
    }
    try {
      let response: Response
      try {
        response = await fetch(jobUrl, {
          headers: { authorization: `Bearer ${upstream.apiKey.trim()}`, accept: 'application/json' },
          signal: budget.signal,
        })
      } catch (error) {
        const failure = signal?.aborted === true
          ? new ImageGenError('任务已取消', 'cancelled')
          : isBudgetTimeout(error)
            ? new ImageGenError('上游异步图片任务轮询超时', 'upstream-timeout')
            : new ImageGenError(`无法轮询上游异步图片任务：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
        recordFailure(context, failure)
        throw failure
      }
      const responseText = await readResponseText(response)
      let payload: unknown
      try {
        payload = JSON.parse(responseText)
      } catch (error) {
        const failure = isBudgetTimeout(error)
          ? new ImageGenError('上游异步图片任务轮询超时', 'upstream-timeout')
          : nonJsonFailure('上游图片任务接口', jobUrl, response, responseText)
        recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
        throw failure
      }
      if (!response.ok || payload === null || typeof payload !== 'object') {
        const failure = new ImageGenError(upstreamMessage(payload, response.status), 'upstream-rejected')
        recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
        throw failure
      }
      const record = payload as Record<string, unknown>
      const status = typeof record.status === 'string' ? record.status.toLowerCase() : ''
      const data = dataRecordsOf(record) ?? []
      if (status === 'completed' || data.length > 0) {
        if (data.length > 0) return data
        throw new ImageGenError('上游异步图片任务完成但没有图片结果', 'upstream-empty')
      }
      if (status === 'failed' || status === 'cancelled' || status === 'error' || status === 'failure') {
        throw new ImageGenError(upstreamMessage(record, response.status), status === 'cancelled' ? 'cancelled' : 'upstream-rejected')
      }
      if (status !== '' && !IMAGE_JOB_PENDING_STATUSES.has(status)) {
        throw new ImageGenError(`上游返回了未知异步图片任务状态：${status}`, 'upstream-invalid')
      }
      delay = Math.min(10_000, Math.max(delay, delay * 2))
    } finally {
      budget.dispose()
    }
  }
}

/**
 * Issue one single-image request (never sends `n`). The response is kept as a
 * list so a gateway that happens to return several images per call still works.
 */
async function requestOneImage(
  baseUrl: string,
  upstream: UpstreamConfig,
  request: GenerateRequest,
  params: ReturnType<typeof effectiveParams>,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const modelScope = isModelScopeInference(baseUrl)
  const headers: Record<string, string> = {
    authorization: `Bearer ${upstream.apiKey.trim()}`,
    ...(modelScope ? { 'X-ModelScope-Async-Mode': 'true' } : {}),
    // Multipart edits cannot carry the async switch in-body. The header is a
    // new-api extension and harmless to upstreams that ignore unknown headers.
    ...(request.mode === 'edit' ? { 'X-New-Api-Async': 'true' } : {}),
  }
  let body: BodyInit
  if (request.mode === 'edit') {
    if (typeof request.image !== 'string' || request.image === '') {
      throw new ImageGenError('图生图需要上传参考图片', 'edit-image-missing')
    }
    const decodeReference = (dataUrl: string): { bytes: Buffer; mime: string; filename: string } => {
      const parsed = parseDataUrl(dataUrl)
      if (parsed === undefined) throw new ImageGenError('参考图片格式无效', 'edit-image-invalid')
      let bytes: Buffer
      try {
        bytes = Buffer.from(parsed.base64, 'base64')
      } catch {
        throw new ImageGenError('参考图片数据无法解码', 'edit-image-invalid')
      }
      if (bytes.byteLength > MAX_EDIT_IMAGE_BYTES) {
        throw new ImageGenError('参考图片超过 10MB 上限', 'edit-image-too-large')
      }
      return { bytes, mime: parsed.mime, filename: `reference.${extensionOf(parsed.mime)}` }
    }
    const primary = decodeReference(request.image)
    // OpenAI-style multi-reference upload: repeat the image[] field so every
    // connected canvas reference reaches the gateway.
    const extras = (request.images ?? [])
      .filter(img => typeof img === 'string' && img !== '')
      .slice(0, MAX_EDIT_REFERENCES - 1)
      .map(decodeReference)
    const form = new FormData()
    if (extras.length > 0) {
      for (const [index, reference] of [primary, ...extras].entries()) {
        form.append('image[]', new Blob([reference.bytes], { type: reference.mime }), `reference-${index}.${extensionOf(reference.mime)}`)
      }
    } else {
      form.append('image', new Blob([primary.bytes], { type: primary.mime }), primary.filename)
    }
    form.append('prompt', request.prompt)
    form.append('model', params.model)
    if (params.size !== undefined) form.append('size', params.size)
    if (params.quality !== undefined) form.append('quality', params.quality)
    if (params.detail !== undefined) form.append('detail', params.detail)
    body = form
  } else {
    headers['content-type'] = 'application/json'
    body = JSON.stringify({ prompt: request.prompt, ...params } as Record<string, unknown>)
  }

  const budget = requestSignal(signal, UPSTREAM_TIMEOUT_MS)
  try {
    let response: Response
    const endpoint = request.mode === 'edit' ? '/images/edits' : '/images/generations'
    const requestUrl = endpointUrl(upstream, baseUrl, endpoint)
    const context = attemptContext(upstream, request, 'generate', requestUrl, 'POST', body, Date.now())
    try {
      response = await fetch(requestUrl, {
        method: 'POST',
        headers,
        body,
        signal: budget.signal,
      })
    } catch (error) {
      // A rejected fetch means the request never reached the application: the
      // URL and the network code are the only way to tell a wrong path from a
      // refused socket (#38). Both go into the message so the cause is visible
      // without opening diagnostics.
      const network = networkErrorFields(error)
      const failure = isBudgetTimeout(error)
        ? new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
        : signal?.aborted === true
          ? new ImageGenError('任务已取消', 'cancelled')
          : new ImageGenError(
            `无法连接上游接口：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 请求地址 ${displayUrl(requestUrl)}`,
            'upstream-unreachable',
          )
      recordFailure(context, failure)
      throw failure
    }

    let payload: unknown
    // Parsing reads the RAW body; redaction happens only when storing (#38).
    const responseText = await readResponseText(response)
    try {
      // The budget stays armed through the body read: a gateway that returns
      // headers but never completes the body must not hang the task forever.
      payload = JSON.parse(responseText)
    } catch (error) {
      const failure = isBudgetTimeout(error)
        ? new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
        : signal?.aborted === true
          ? new ImageGenError('任务已取消', 'cancelled')
          : nonJsonFailure('上游接口', requestUrl, response, responseText)
      recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
      throw failure
    }
    if (!response.ok || payload === null || typeof payload !== 'object') {
      // Carry the status and the address into the message: an upstream that
      // answers 404/405 is usually a URL-shape mismatch, and seeing which
      // address was called settles it without a second attempt (#38).
      const failure = new ImageGenError(
        `${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl(requestUrl)}）`,
        'upstream-rejected',
      )
      recordFailure(context, failure, {
        status: response.status,
        bodyExcerpt: responseText,
        responseBytes: Buffer.byteLength(responseText, 'utf8'),
      })
      throw failure
    }

    const record = payload as Record<string, unknown>
    const imageJobId = imageJobIdOf(record)
    if (imageJobId !== undefined) {
      const location = response.headers.get('location')
      const located = location !== null && location.trim() !== '' ? new URL(location, requestUrl).toString() : ''
      const jobUrl = located !== '' && isSameOriginAsApi(located, upstream.apiUrl)
        ? located
        : imageJobUrlOf(requestUrl, upstream, baseUrl, imageJobId)
      const data = await pollImageJob(jobUrl, upstream, signal, retryAfterMs(response.headers.get('retry-after')))
      return Promise.all(data.flatMap(imageItemsOf).map(item => normalizeItem(item, upstream, signal)))
    }
    const modelScopeTaskId = modelScope && typeof record.task_id === 'string' ? record.task_id.trim() : ''
    if (modelScopeTaskId !== '') {
      const taskBaseUrl = modelScopeTaskBaseUrl(baseUrl, upstream.apiUrlFull === true)
      const taskItems = await pollAsyncTask(taskBaseUrl, upstream, modelScopeTaskId, signal, true)
      if (taskItems.length === 0) throw new ImageGenError('魔搭异步任务已完成，但没有图片结果', 'upstream-empty')
      return Promise.all(taskItems.flatMap(imageItemsOf).map(item => normalizeItem(item, upstream, signal)))
    }
    const data = dataRecordsOf(record)
    if (data === undefined) {
      throw new ImageGenError('上游响应缺少 data 数组', 'upstream-invalid')
    }
    if (data.length === 0) {
      throw new ImageGenError('上游返回了 0 张图片', 'upstream-empty')
    }
    const asyncEntries = data.filter(entry => typeof entry.task_id === 'string' && entry.task_id.trim() !== '')
    if (asyncEntries.length > 0) {
      const asyncRecords = (await Promise.all(asyncEntries.map(entry => pollAsyncTask(baseUrl, upstream, entry.task_id as string, signal)))).flat()
      if (asyncRecords.length === 0) throw new ImageGenError('上游异步任务完成但没有图片结果', 'upstream-empty')
      return Promise.all(asyncRecords.flatMap(imageItemsOf).map(item => normalizeItem(item, upstream, signal)))
    }
    return Promise.all(data.flatMap(imageItemsOf).map(item => normalizeItem(item, upstream, signal)))
  } finally {
    budget.dispose()
  }
}

/** Resolve the exact Chat Completions endpoint for a channel. */
function chatEndpointUrl(upstream: UpstreamConfig, baseUrl: string): string {
  if (isChatCompletionsUrl(baseUrl)) return baseUrl
  if (upstream.apiUrlFull === true) return baseUrl
  return `${baseUrl}/chat/completions`
}

/** One chat-protocol image request; image count is satisfied by parallel calls. */
async function requestOneChatImage(
  upstream: UpstreamConfig,
  baseUrl: string,
  request: GenerateRequest,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const content = request.mode === 'edit'
    ? [
        { type: 'text', text: request.prompt },
        ...[request.image, ...(request.images ?? [])]
          .filter((value): value is string => typeof value === 'string' && value !== '')
          .slice(0, 5)
          .map(url => ({ type: 'image_url', image_url: { url } })),
      ]
    : request.prompt
  const budget = requestSignal(signal, UPSTREAM_TIMEOUT_MS)
  try {
    let response: Response
    const requestUrl = chatEndpointUrl(upstream, baseUrl)
    const requestBody = JSON.stringify({
      model: wireModel(request),
      messages: [{ role: 'user', content }],
      stream: false,
    })
    const context = attemptContext(upstream, request, 'chat', requestUrl, 'POST', requestBody, Date.now())
    try {
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${upstream.apiKey.trim()}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: requestBody,
        signal: budget.signal,
      })
    } catch (error) {
      const network = networkErrorFields(error)
      const failure = isBudgetTimeout(error)
        ? new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
        : signal?.aborted === true
          ? new ImageGenError('任务已取消', 'cancelled')
          : new ImageGenError(
            `无法连接上游接口：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 请求地址 ${displayUrl(requestUrl)}`,
            'upstream-unreachable',
          )
      recordFailure(context, failure)
      throw failure
    }

    let payload: unknown
    // Parsing reads the RAW body: a chat image response carries base64 images.
    const responseText = await readResponseText(response)
    try {
      payload = JSON.parse(responseText)
    } catch (error) {
      const failure = isBudgetTimeout(error)
        ? new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
        : signal?.aborted === true
          ? new ImageGenError('任务已取消', 'cancelled')
          : nonJsonFailure('上游接口', requestUrl, response, responseText)
      recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
      throw failure
    }
    if (!response.ok || payload === null || typeof payload !== 'object') {
      const failure = new ImageGenError(
        `${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl(requestUrl)}）`,
        'upstream-rejected',
      )
      recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
      throw failure
    }

    const items = chatImageItemsOf(payload as Record<string, unknown>)
    if (items.length === 0) {
      const detail = chatErrorTextOf(payload as Record<string, unknown>)
      const failure = new ImageGenError(detail?.slice(0, 1200) || 'Chat Completions 响应中没有可用的图片结果', 'upstream-empty')
      recordFailure(context, failure, { status: response.status, bodyExcerpt: responseText })
      throw failure
    }
    return await Promise.all(items.map(item => normalizeItem(item, upstream, signal)))
  } finally {
    budget.dispose()
  }
}

/** Run N parallel Chat Completions image calls and flatten the result. */
async function generateChatCompletionImages(
  upstream: UpstreamConfig,
  baseUrl: string,
  request: GenerateRequest,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const count = effectiveCount(request)
  const batches = await Promise.all(
    Array.from({ length: count }, () => requestOneChatImage(upstream, baseUrl, request, signal)),
  )
  return batches.flat()
}

/**
 * Forward one generate request to the configured endpoint. The requested image
 * count is satisfied with N parallel single-image requests (the `n` batch
 * parameter is never sent, because Responses-API-based gateways reject it as
 * `tools[0].n`), then the results are flattened in order.
 */
export async function generateImage(upstream: UpstreamConfig, request: GenerateRequest, options: { signal?: AbortSignal } = {}): Promise<GenerateResult> {
  const configuredBaseUrl = upstream.apiUrl.trim().replace(/\/+$/, '')
  const baseUrl = normalizeModelScopeBaseUrl(configuredBaseUrl, upstream.apiUrlFull === true)
  if (baseUrl === '') throw new ImageGenError('网关地址未配置：请确认部署的模型网关已经挂载', 'config-missing')
  const protocol = resolveChannelProtocol(baseUrl, upstream.protocol)
  if (upstream.apiKey.trim() === '') {
    throw new ImageGenError('网关密钥未就绪：请先登录部署账号后再试', 'config-missing')
  }
  assertGifRequestSupported(request, wireModel(request))
  if (protocol === 'chat-completions') {
    // This body carries only model/messages/stream — there is no output_format
    // to send — so even a GIF-capable model answers with a still here, and the
    // history would label that still as an animation the user paid for.
    if (request.outputFormat === 'gif') {
      throw new ImageGenError('当前渠道走 chat/completions 协议，不支持 GIF 动图：请改用 /images/generations 渠道', 'gif-protocol-unsupported')
    }
    return { images: await generateChatCompletionImages(upstream, baseUrl, request, options.signal) }
  }
  const params = effectiveParams(request)
  const count = effectiveCount(request)
  const batches = await Promise.all(
    Array.from({ length: count }, () => requestOneImage(baseUrl, upstream, request, params, options.signal)),
  )
  return { images: batches.flat() }
}

/**
 * The URL actually handed to fetch, with any query string dropped: the
 * diagnostics panel exists to answer "which address did it call", and a signed
 * query would leak credentials into a bug report.
 */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] ?? url
  }
}

/**
 * The failure for a body that would not parse as JSON, with the address and
 * the body's shape in the message (#48).
 *
 * Every parse site used to hand-build `（HTTP 404）`, which named neither the
 * URL that was called nor the fact that an HTML page came back — so a channel
 * whose base URL omitted `/v1` reported "non-JSON response" with nothing the
 * user could act on. The wording lives in `diagnostics-store.ts` so the image
 * engine and the video engine cannot drift apart again.
 *
 * The error CODE stays `upstream-invalid`: callers and the diagnostics panel
 * key off it, and this change is about the sentence, not the classification.
 */
function nonJsonFailure(label: string, url: string, response: Response, body: string): ImageGenError {
  return new ImageGenError(
    diagnoseNonJsonBody({
      label,
      url,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: body,
    }),
    'upstream-invalid',
  )
}

/**
 * Everything one attempt needs to be recorded on failure. The engine's request
 * sites all share this shape so every failure path lands in the diagnostics
 * buffer with the same fields — the reporter of #38 had no way to tell a bad
 * URL from a refused connection, and that distinction is the whole point.
 */
interface AttemptContext {
  phase: DiagnosticPhase
  channel: string
  model: string
  mode: string
  url: string
  method: string
  hadAuth: boolean
  apiUrlFull?: boolean
  requestExcerpt?: string
  requestBytes?: number
  startedAt: number
}

/** Record a failed attempt against the diagnostics buffer. */
function recordFailure(context: AttemptContext, error: ImageGenError, options: {
  status?: number
  bodyExcerpt?: string
  responseBytes?: number
} = {}): void {
  const network = networkErrorFields(error)
  recordDiagnostic({
    phase: context.phase,
    channel: context.channel,
    model: context.model,
    mode: context.mode,
    url: context.url,
    method: context.method,
    status: options.status,
    errorCode: network.errorCode,
    failureCode: error.code,
    message: error.message,
    bodyExcerpt: options.bodyExcerpt,
    requestExcerpt: context.requestExcerpt,
    requestBytes: context.requestBytes,
    responseBytes: options.responseBytes,
    durationMs: Date.now() - context.startedAt,
    hadAuth: context.hadAuth,
    apiUrlFull: context.apiUrlFull,
  })
  // The same moment, a second destination. Diagnostics answer "what happened";
  // this answers "how often does this combination fail", and the answer has to
  // outlive the process. Fire-and-forget: a signal write must never turn one
  // upstream failure into two.
  void recordSignal({
    kind: 'failure',
    pipeline: 'image',
    model: context.model,
    channel: context.channel,
    mode: context.mode,
    failureCode: error.code,
    source: 'auto',
  }).catch(() => { /* the diagnostics row above is the durable record of truth */ })
}

/** Build the attempt context for one upstream call. */
function attemptContext(
  upstream: UpstreamConfig,
  request: GenerateRequest,
  phase: DiagnosticPhase,
  url: string,
  method: string,
  body: BodyInit | undefined,
  startedAt: number,
): AttemptContext {
  return {
    phase,
    channel: upstream.channelName?.trim() || '默认渠道',
    model: wireModel(request),
    mode: request.mode,
    url: displayUrl(url),
    method,
    hadAuth: upstream.apiKey.trim() !== '',
    ...upstream.apiUrlFull === true ? { apiUrlFull: true } : {},
    requestExcerpt: requestExcerptFor(request, body),
    requestBytes: bodyByteLength(body),
    startedAt,
  }
}

/**
 * The request excerpt worth keeping. Reference images are stripped (they are
 * megabytes of base64 already summarised by requestBytes), keeping the shape
 * and the prompt so the panel shows what was actually asked for.
 */
function requestExcerptFor(request: GenerateRequest, body: BodyInit | undefined): string | undefined {
  if (typeof body === 'string') return excerptOf(body)
  // multipart edits: no cheap text to quote, so describe the request instead.
  const shape: Record<string, unknown> = {
    mode: request.mode,
    model: wireModel(request),
    prompt: request.prompt,
    size: request.size,
    quality: request.quality,
    n: request.n,
  }
  if (request.image !== undefined) shape.referenceImages = 1 + (request.images?.length ?? 0)
  return excerptOf(shape)
}

/** Human-readable failure message from an upstream error payload. */
function upstreamMessage(payload: unknown, status: number): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const error = record.error
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message !== '') return message
    }
    if (typeof record.message === 'string' && record.message !== '') return record.message
    if (typeof record.error === 'string' && record.error !== '') return record.error
  }
  return `上游接口拒绝请求（HTTP ${status}）`
}

/** File extension for a MIME type (multipart reference image). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/png':
    default: return 'png'
  }
}
