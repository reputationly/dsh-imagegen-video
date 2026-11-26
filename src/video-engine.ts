/**
 * Video generation engine: the async submit → poll → download contract for
 * each supported video family.
 *
 * Video is fundamentally different from the synchronous image engine next to
 * this file:
 *  - the upstream call returns a *task id*, not pixels, so the engine polls
 *    until the provider reports a terminal state;
 *  - the finished asset is a clip served from a URL, so the engine downloads
 *    the bytes instead of returning base64 (a 5s clip base64-inflated would
 *    be far too large to keep in a JSON response).
 *
 * Family request/response shapes below are recorded from measured upstream
 * behavior, not from provider documentation — the docs are wrong in three
 * places that are noted inline at the code that compensates for them.
 *
 * Framework-free apart from the platform fetch/AbortSignal, so the host route
 * layer can drive it directly.
 */

import type { UpstreamConfig } from './engine.ts'
import {
  clampVideoSeconds,
  describeVideoModel,
  normalizeVideoResolution,
} from './video-model-catalog.ts'
import {
  bodyByteLength,
  bodyShapeOf,
  diagnoseNonJsonBody,
  excerptOf,
  networkErrorFields,
  readResponseText,
  recordDiagnostic,
  type DiagnosticPhase,
} from './diagnostics-store.ts'
import { recordSignal } from './signal-store.ts'
import type { VideoGenerateRequest } from './protocol.ts'

/** A video generation failure with a user-presentable message. */
export class VideoGenError extends Error {
  /** Stable wire code. */
  readonly code: string
  /**
   * Whether retrying the exact same request could plausibly succeed. Only the
   * poll loop reads this: a transient status (5xx / rate limit) is retried
   * against the same deadline, everything else is surfaced as-is.
   */
  readonly retryable: boolean
  /**
   * The HTTP status, when the failure came with one.
   *
   * Carried on the error because the poll loop only ever sees the error, never
   * the response: a retryable status that does NOT recover still has to be
   * recorded with its wire code, and "503 five times running" and "429 five
   * times running" are different conversations (#38, video parity).
   */
  readonly status?: number

  constructor(message: string, code = 'video-failed', retryable = false, status?: number) {
    super(message)
    this.name = 'VideoGenError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

/**
 * Whether a family can stop a render on the PROVIDER's side (#10-2).
 *
 * Every entry is `'unsupported'` on purpose, and this is measured rather than
 * lazy:
 *
 *  - The request shapes in this file were recorded from observed upstream
 *    behaviour; the repository has never seen a cancel/delete call from any of
 *    these providers, so there is no path to copy.
 *  - OpenAI's Videos API is the one family whose documentation we could check
 *    from a primary source: `DELETE /videos/{id}` is documented as
 *    "permanently delete a completed or failed video and its stored assets" —
 *    it removes an artifact that already exists, it does not abort a render in
 *    progress. Calling it on a running task is therefore not a cancel, and
 *    claiming otherwise would let the user believe the billing stopped.
 *
 * Consequence, and the reason this table exists as data rather than as an `if`:
 * adding a real endpoint for a family is a one-line change here plus a branch in
 * {@link cancelRemoteVideo}; nothing in the queue or the panel has to learn a new
 * concept.
 */
const REMOTE_CANCEL: Record<string, 'supported' | 'unsupported'> = {
  'openai-video': 'unsupported',
  'h3-v2': 'unsupported',
  unknown: 'unsupported',
}

/** The families this build knows how to cancel remotely (none, today). */
export function cancelableFamilies(): string[] {
  return Object.keys(REMOTE_CANCEL).filter(family => REMOTE_CANCEL[family] === 'supported')
}

/**
 * Ask the provider to stop one render, when this build knows how.
 *
 * Returns the honest outcome: `'unsupported'` means no request was made and the
 * provider is very likely still rendering and billing, `'stopped'` means the
 * provider acknowledged, `'unconfirmed'` means the request failed or its answer
 * was unusable. It never throws — the caller has already told the user the task
 * is cancelled locally, and a cancel that fails must not resurrect it.
 *
 * @param upstream credentials for the channel the render was submitted through.
 * @param target the provider task id plus its family and model, for diagnostics.
 */
export async function cancelRemoteVideo(
  upstream: VideoUpstreamConfig,
  target: { taskId: string; family: string; model: string; mode: string; signal?: AbortSignal },
): Promise<'stopped' | 'unconfirmed' | 'unsupported'> {
  if (target.taskId.trim() === '') return 'unsupported'
  if ((REMOTE_CANCEL[target.family] ?? 'unsupported') !== 'supported') return 'unsupported'
  // 每个协议族都是 'unsupported' 时这里走不到。等某一天真测到了取消端点，
  // 把那个族改成 'supported'，再在这里补发请求并把结果映射成
  // 'stopped' / 'unconfirmed'——不要在那之前先写一段猜出来的 DELETE。
  return 'unsupported'
}

/** Upstream credentials for one video request (mirrors the image upstream). */
export type VideoUpstreamConfig = UpstreamConfig

/** One downloaded clip, ready for the store to persist. */
export interface VideoBytes {
  bytes: Buffer
  mime: string
  /**
   * The provider's own result URL. Retained so a local persistence failure
   * still leaves the user a playable link for a render they already paid for.
   */
  sourceUrl: string
  duration?: number
  poster?: string
  revisedPrompt?: string
}

/** Successful engine outcome. */
export interface VideoEngineResult {
  videos: VideoBytes[]
}

/** Total budget for one submit call (submitting is fast; rendering is not). */
const SUBMIT_TIMEOUT_MS = 120_000

/** Budget for downloading one finished clip. */
const DOWNLOAD_TIMEOUT_MS = 300_000

/** Cap on one downloaded clip, in bytes (safety valve against a bad URL). */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024

/**
 * Status codes worth one more poll. Rendering takes minutes, and the status
 * endpoint is a third party: a 5xx or a rate limit there says "ask again",
 * not "this render failed". Everything else — notably 401/403/404 — is a
 * permanent answer and must reach the user unchanged.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * Poll budgets per family. Rendering a short clip is slow: a 5s render measured
 * several minutes, so the poll deadline is generous and the interval is
 * family-tuned rather than shared with the image path.
 */
const POLL_POLICY: Record<string, { intervalMs: number; deadlineMs: number }> = {
  'openai-video': { intervalMs: 5_000, deadlineMs: 20 * 60_000 },
  // 部署自家网关的 H3：单实例串行，768P 一段 5 秒约 3 分钟，2K 聚合还要再走一遍
  // 超分，排队另计，所以给 40 分钟——比别的族更宽，但不至于让用户干等一小时。
  'h3-v2': { intervalMs: 5_000, deadlineMs: 40 * 60_000 },
  unknown: { intervalMs: 5_000, deadlineMs: 20 * 60_000 },
}

/** Whether a model id is a wired-up video family (the route/tool gate). */
export function isVideoModel(model: string): boolean {
  const family = describeVideoModel(model).family
  return family !== 'unknown'
}

/** Reference frames a request carries, decoded from data URLs. */
interface DecodedReferences {
  /** Single primary reference (image / first frame). */
  primary?: { mime: string; base64: string }
  /** All reference frames in order. */
  all: Array<{ mime: string; base64: string }>
}

/** Reject a data URL we cannot send upstream. */
function requireDataUrl(value: string, what: string): { mime: string; base64: string } {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(value.trim())
  if (match === null || match[2] === undefined || match[2] === '') {
    throw new VideoGenError(`${what}不是有效的 base64 图片数据`, 'video-bad-reference')
  }
  return { mime: match[1] ?? 'image/png', base64: match[2] }
}

/** Decode the reference frames this request's mode actually uses. */
function referencesOf(request: VideoGenerateRequest): DecodedReferences {
  const all: Array<{ mime: string; base64: string }> = []
  const push = (value: string | undefined, what: string): void => {
    if (value === undefined || value.trim() === '') return
    all.push(requireDataUrl(value, what))
  }
  switch (request.mode) {
    case 'image':
      push(request.image, '参考图片')
      break
    case 'keyframe':
      push(request.firstFrame, '首帧图片')
      push(request.lastFrame, '尾帧图片')
      break
    case 'reference':
      push(request.image, '参考图片')
      for (const extra of request.images ?? []) push(extra, '参考图片')
      break
    default:
      break
  }
  return { ...all.length > 0 ? { primary: all[0]! } : {}, all }
}

/** Resolve the request URL: base URL + path, or the exact configured URL. */
function endpointUrl(upstream: VideoUpstreamConfig, baseUrl: string, path: string): string {
  // `apiUrlFull` means "this is the exact submit URL". It used to apply only to
  // the `/videos` path, which made the switch silently do nothing for a family
  // whose submit path differs (xAI's `/videos/generations`).
  return upstream.apiUrlFull === true ? baseUrl : `${baseUrl}${path}`
}

/**
 * Submit and status paths for one family.
 *
 * An empty table means every remaining family speaks the generic
 * `POST /videos` + `GET /videos/{id}` pair.
 */
const VIDEO_PATHS: Record<string, { submit: string; status: string }> = {}

/**
 * The status URL for a task id.
 *
 * `apiUrlFull` names the exact SUBMIT url, so the status url is derived from it
 * rather than from the base: without this, a user who configured
 * `https://gateway.example/v1/videos/special` got polled at
 * `…/videos/generations/videos/{id}`, which is a 404 every time (#5).
 */
function statusUrlFor(upstream: VideoUpstreamConfig, baseUrl: string, family: string, taskId: string): string {
  const path = (VIDEO_PATHS[family]?.status ?? '/videos/{id}').replace('{id}', encodeURIComponent(taskId))
  if (upstream.apiUrlFull !== true) return `${baseUrl}${path}`
  // Trim the submit path off the configured URL; its origin+prefix is the base.
  const configured = baseUrl.replace(/\/+$/, '')
  const submitPath = VIDEO_PATHS[family]?.submit ?? '/videos'
  const base = configured.endsWith(submitPath)
    ? configured.slice(0, configured.length - submitPath.length)
    : configured
  return `${base}${path}`
}

/**
 * Resolve a provider-supplied result URL against the configured API base.
 *
 * Most families answer with an absolute CDN URL, but some (Muse) answer with a
 * RELATIVE path such as `/v1/videos/{id}/content` meant to be resolved against
 * whichever host issued the task. Left relative it breaks twice: the download
 * `fetch` cannot parse it at all, and the same-origin check throws inside
 * `new URL` and silently drops the key that endpoint requires (401).
 */
function resolveResultUrl(value: string, apiUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  try {
    return new URL(value, apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`).href
  } catch {
    return value
  }
}

/** Whether a URL lives on the same origin as the configured API base. */
function isSameOriginAsApi(value: string, apiUrl: string): boolean {
  try {
    return new URL(value).origin === new URL(apiUrl).origin
  } catch {
    return false
  }
}

/** One abort signal with a budget, disposed by the caller. */
function requestSignal(source: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromSource = (): void => { controller.abort(source?.reason) }
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

/** Sleep that rejects immediately when the caller aborts. */
function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(new VideoGenError('视频生成已取消', 'video-cancelled')); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new VideoGenError('视频生成已取消', 'video-cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Pull a human error string out of any provider error shape. */
function errorTextOf(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error
  if (typeof error === 'string' && error !== '') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message !== '') return message
  }
  for (const key of ['message', 'msg', 'detail']) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return fallback
}

/**
 * Read a JSON body AND keep its raw text for the diagnostics record.
 *
 * The body can only be consumed once, so the two consumers share one read:
 * parsing needs the RAW text, and the record needs a redacted excerpt of the
 * same text. Reading it twice would silently return an empty excerpt for every
 * non-2xx response, which is exactly the case the record exists for.
 */
async function readJsonWithText(response: Response): Promise<{ payload: Record<string, unknown>; text: string; bodyIsJson: boolean }> {
  const text = await readResponseText(response)
  if (text.trim() === '') return { payload: {}, text, bodyIsJson: true }
  try {
    const parsed: unknown = JSON.parse(text)
    return {
      payload: parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {},
      text,
      bodyIsJson: true,
    }
  } catch {
    // A non-JSON body is either an HTML error page or — the case measured
    // against a gateway whose base URL omitted `/v1` — the site's own homepage
    // served with 200. The shape comes from the shared classifier so this engine
    // cannot disagree with the image engine on what "HTML" means; the message
    // below keeps the paragraph for the generic error path, while
    // `nonJsonVideoFailure` builds the full sentence (with the address) for
    // callers that know which URL they called (#48).
    const shape = bodyShapeOf(text, response.headers.get('content-type') ?? '')
    return {
      payload: {
        message: shape === 'html'
          ? '返回的是网页而不是接口响应，通常是渠道的 API 地址少了路径（例如末尾缺 /v1）'
          : text.slice(0, 300),
      },
      text,
      bodyIsJson: false,
    }
  }
}

/**
 * The failure for a body that is not JSON, naming the address and the shape.
 *
 * Video is the pipeline where a wrong base URL is easiest to mistake for a
 * provider fault: the submit answers 200 with the site's homepage, so nothing
 * looks broken until the task id is missing. `code` stays the caller's —
 * "the render never started" and "the status endpoint stopped answering" are
 * different conversations and the panel groups by them.
 */
function nonJsonVideoFailure(attempt: VideoAttempt, response: Response, text: string, code: string, label: string, retryable = false): VideoGenError {
  return new VideoGenError(
    diagnoseNonJsonBody({
      label,
      url: attempt.url,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text,
    }),
    code,
    retryable,
    response.status,
  )
}

/** The URL actually handed to fetch, with any query string dropped (#38). */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] ?? url
  }
}

/**
 * One leg of the video pipeline, ready to be recorded.
 *
 * Video is submit → poll → download rather than a single call, so the phase is
 * what tells the reader WHICH leg failed: a render that never started looks
 * nothing like a status endpoint that stopped answering, and the panel has to
 * say which one happened (#38, video parity).
 */
interface VideoAttempt {
  phase: DiagnosticPhase
  channel: string
  model: string
  mode: string
  url: string
  method: string
  hadAuth: boolean
  apiUrlFull?: boolean
  requestBytes?: number
  startedAt: number
}

/** Build the attempt context for one video request. */
function videoAttempt(
  upstream: VideoUpstreamConfig,
  request: VideoGenerateRequest,
  model: string,
  phase: DiagnosticPhase,
  url: string,
  method: string,
  body?: BodyInit,
): VideoAttempt {
  return {
    phase,
    channel: upstream.channelName?.trim() || '默认渠道',
    model,
    mode: request.mode,
    url: displayUrl(url),
    method,
    // Never the key itself, only whether one was sent -- the record is meant to
    // be pasted into a public issue.
    hadAuth: upstream.apiKey.trim() !== '',
    ...upstream.apiUrlFull === true ? { apiUrlFull: true } : {},
    ...body === undefined ? {} : { requestBytes: bodyByteLength(body) },
    startedAt: Date.now(),
  }
}

/**
 * Record one failed video attempt against the shared diagnostics buffer.
 *
 * The same buffer the image chain writes to: the panel is one surface, and a
 * user whose image call works and whose video call does not must be able to see
 * both in one place.
 */
function recordVideoFailure(attempt: VideoAttempt, error: VideoGenError, options: {
  status?: number
  bodyExcerpt?: string
  requestExcerpt?: string
  responseBytes?: number
} = {}): void {
  const network = networkErrorFields(error)
  recordDiagnostic({
    phase: attempt.phase,
    channel: attempt.channel,
    model: attempt.model,
    mode: attempt.mode,
    url: attempt.url,
    method: attempt.method,
    // The error carries its own status when the caller did not pass one, which
    // is how a retryable status recorded by the poll loop keeps its wire code.
    status: options.status ?? error.status,
    errorCode: network.errorCode,
    failureCode: error.code,
    message: error.message,
    bodyExcerpt: options.bodyExcerpt,
    requestExcerpt: options.requestExcerpt,
    requestBytes: attempt.requestBytes,
    responseBytes: options.responseBytes,
    durationMs: Date.now() - attempt.startedAt,
    hadAuth: attempt.hadAuth,
    apiUrlFull: attempt.apiUrlFull,
  })
  // Same rule as the image chain: diagnostics for this attempt, a signal for
  // the aggregate, and neither allowed to break the other.
  void recordSignal({
    kind: 'failure',
    pipeline: 'video',
    model: attempt.model,
    channel: attempt.channel,
    mode: attempt.mode,
    failureCode: error.code,
    source: 'auto',
  }).catch(() => { /* the diagnostics row above is the durable record of truth */ })
}

/**
 * Record the poll loop giving up on a status endpoint that kept failing.
 *
 * Only the exhausted budget is recorded: one blip is not worth a row (writing
 * every one would bury the failure that matters), but an endpoint that failed
 * the whole budget is exactly the "it just sat there" report this buffer
 * exists to answer. It is recorded as `video-status-failed` -- the transient
 * reading is over by then -- while still naming the task and the retries.
 */
function recordPollExhausted(statusAttempt: VideoAttempt, error: unknown, taskId: string, family: string, retries: number): void {
  const network = networkErrorFields(error)
  recordVideoFailure(
    statusAttempt,
    new VideoGenError(
      error instanceof VideoGenError
        ? error.message
        : `视频状态查询连续失败：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 请求地址 ${statusAttempt.url}`,
      'video-status-failed',
      false,
      error instanceof VideoGenError ? error.status : undefined,
    ),
    { requestExcerpt: excerptOf({ taskId, family, retries }) },
  )
}

/**
 * The submit body worth keeping. Reference frames are data URLs measured in
 * megabytes, so they are replaced by their count: the panel shows what was
 * asked for without shipping the payload into the buffer.
 */
function videoRequestExcerpt(request: VideoGenerateRequest, body: Record<string, unknown>): string {
  const shapes = ['image_url', 'image', 'images', 'first_frame', 'last_frame']
  const shape: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (shapes.includes(key)) {
      shape[`${key}<omitted>`] = Array.isArray(value) ? value.length : 1
    } else {
      shape[key] = value
    }
  }
  return excerptOf(shape) ?? ''
}

/** POST one submit request and return the parsed JSON body. */
async function postJson(attempt: VideoAttempt, request: VideoGenerateRequest, url: string, apiKey: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const excerpt = videoRequestExcerpt(request, body)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    // A rejected fetch means the request never reached the provider: the URL
    // and the socket code are the only evidence, so both go into the message
    // AND the record. A cancellation is the caller's own decision and is not a
    // failure to explain, so it is passed through unrecorded.
    if (signal.aborted) throw error
    const network = networkErrorFields(error)
    const failure = new VideoGenError(
      `无法连接视频接口：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 请求地址 ${attempt.url}`,
      'video-unreachable',
    )
    recordVideoFailure(attempt, failure, { requestExcerpt: excerpt })
    throw failure
  }
  const { payload, text, bodyIsJson } = await readJsonWithText(response)
  // A body that is not JSON never contains a task id, so the generic
  // "未返回任务 ID" is the wrong conversation: it hides that the address
  // answered with a webpage (#48).
  if (!bodyIsJson) {
    const failure = nonJsonVideoFailure(attempt, response, text, 'video-submit-failed', '视频接口')
    recordVideoFailure(attempt, failure, {
      status: response.status,
      requestExcerpt: excerpt,
      bodyExcerpt: excerptOf(text),
    })
    throw failure
  }
  if (!response.ok) {
    const failure = new VideoGenError(
      `${errorTextOf(payload, `视频提交失败（HTTP ${response.status}）`)}（HTTP ${response.status} · ${attempt.url}）`,
      'video-submit-failed',
    )
    recordVideoFailure(attempt, failure, {
      status: response.status,
      requestExcerpt: excerpt,
      // The raw body is what says WHY the gateway refused, so it is kept.
      bodyExcerpt: excerptOf(text),
      responseBytes: Buffer.byteLength(text, 'utf8'),
    })
    throw failure
  }
  return payload
}

/**
 * GET one status request and return the parsed JSON body.
 *
 * A status code that is worth retrying is flagged on the error (see
 * `RETRYABLE_STATUS`) so the poll loop can swallow one blip instead of failing
 * a render the provider is still working on. Every other status keeps the wire
 * code the route layer already reported.
 */
async function getJson(attempt: VideoAttempt, url: string, apiKey: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  // A transport failure here is usually transient and the poll loop retries
  // it, so it is judged (and, if the retries run out, recorded) THERE rather
  // than here: recording every blip would bury the one failure that matters.
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  })
  const { payload, text, bodyIsJson } = await readJsonWithText(response)
  if (!bodyIsJson) {
    // Keep the retry semantics: a 429/5xx that also answers with an HTML page
    // is still worth another try within the same deadline.
    const retryable = RETRYABLE_STATUS.has(response.status)
    const failure = nonJsonVideoFailure(
      attempt,
      response,
      text,
      retryable ? 'video-status-transient' : 'video-status-failed',
      '视频状态查询接口',
      retryable,
    )
    if (!retryable) {
      recordVideoFailure(attempt, failure, {
        status: response.status,
        bodyExcerpt: excerptOf(text),
        responseBytes: Buffer.byteLength(text, 'utf8'),
      })
    }
    throw failure
  }
  if (!response.ok) {
    const retryable = RETRYABLE_STATUS.has(response.status)
    const failure = new VideoGenError(
      errorTextOf(payload, `视频状态查询失败（HTTP ${response.status}）`),
      retryable ? 'video-status-transient' : 'video-status-failed',
      retryable,
      response.status,
    )
    // A permanent status is the end of the render: record it now. A transient
    // one is only recorded if the loop exhausts its retries.
    if (!retryable) {
      recordVideoFailure(attempt, failure, {
        status: response.status,
        bodyExcerpt: excerptOf(text),
        responseBytes: Buffer.byteLength(text, 'utf8'),
      })
    }
    throw failure
  }
  return payload
}

/** Extract the task id from any of the submit response shapes we have seen. */
function taskIdOf(payload: Record<string, unknown>): string {
  // The poll route is `GET <base>/videos/{id}`, so the id must be the RESOURCE
  // id, never the task id: some submit bodies return both in one flat body,
  // and polling by `task_id` would 404. Resource ids come first; `task_id` is
  // only a last resort for relays that return nothing else.
  //
  // Bodies differ between gateways (a flat `{"id","status","task_id"}`, a
  // nested `{"task":{"id":…}}`, a `video_id`/`task_id` pair), so every shape
  // is accepted rather than trusting one.
  const nested = payload.task
  const candidates = [
    payload.video_id,
    payload.id,
    // Some gateways answer a submit with `{ request_id }` and nothing else.
    payload.request_id,
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>).id : undefined,
    payload.task_id,
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>).task_id : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate === 'number') return String(candidate)
  }
  return ''
}

/**
 * Where the finished clip comes from once the task reaches a terminal state.
 *
 * Every family measured so far puts a URL in the poll body. OpenAI's video API
 * — and the OpenAI-compatible relays that copy it — do not: a completed task
 * carries no `url` anywhere, and the bytes are only served from
 * `GET /videos/{id}/content` (#9).
 */
type VideoClipSource =
  | { kind: 'url'; url: string }
  | { kind: 'content'; url: string }

/** Terminal state read from one poll response. */
type PollOutcome =
  | { kind: 'pending' }
  | { kind: 'done'; url: string; duration?: number; poster?: string }
  /** Finished, but the body had no URL: fetch the bytes from `/content`. */
  | { kind: 'done-content'; duration?: number; poster?: string }
  | { kind: 'failed'; message: string }

/**
 * Interpret one poll response.
 *
 * Status vocabularies differ and gateways document them incompletely: one
 * reports `completed`/`failed`, another adds a `processing` state its docs
 * omit. Treat the union as canonical and resolve the URL from either the nested
 * metadata or the flat top level.
 */
function readPoll(payload: Record<string, unknown>): PollOutcome {
  const status = String(payload.status ?? '').toLowerCase().trim()
  if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status)) {
    const message = errorTextOf(payload, status === 'expired' ? '视频任务已过期' : '视频生成失败')
    // A gateway may put a machine-readable category beside the human message.
    // Keep both: the panel can show one line, but "content_blocked" is what
    // tells a caller whether editing the prompt is worth trying.
    const errorClass = typeof payload.error_class === 'string' ? payload.error_class.trim() : ''
    return {
      kind: 'failed',
      message: errorClass === '' || message.includes(errorClass) ? message : `${message}（${errorClass}）`,
    }
  }
  const metadata = payload.metadata !== null && typeof payload.metadata === 'object'
    ? payload.metadata as Record<string, unknown>
    : undefined
  // xAI nests the finished clip under `video.url`.
  const video = payload.video !== null && typeof payload.video === 'object'
    ? payload.video as Record<string, unknown>
    : undefined
  // Some gateways put the result at the top level (`url`); the deployed
  // gateway nests it under `metadata.url`; others nest it under
  // `content.video_url` (and optionally `content.last_frame_url`). Accept every
  // shape regardless of which family we are polling.
  const content = payload.content !== null && typeof payload.content === 'object'
    ? payload.content as Record<string, unknown>
    : undefined
  // A gateway task reader may put the authoritative address in `output_url`
  // and repeat it in `data[]` (and, for some task types, `result.videos[]`).
  const result = payload.result !== null && typeof payload.result === 'object'
    ? payload.result as Record<string, unknown>
    : undefined
  const firstData = Array.isArray(payload.data)
    ? payload.data.find(row => row !== null && typeof row === 'object') as Record<string, unknown> | undefined
    : undefined
  const firstResultVideo = Array.isArray(result?.videos)
    ? result.videos.find(row => row !== null && typeof row === 'object') as Record<string, unknown> | undefined
    : undefined
  const urlCandidates = [
    payload.output_url,
    payload.url,
    payload.result_url,
    payload.video_url,
    firstData?.url,
    firstResultVideo?.url,
    content?.video_url,
    metadata?.url,
    video?.url,
  ]
  const url = urlCandidates.find(candidate => typeof candidate === 'string' && candidate.trim() !== '')
  if (['completed', 'succeeded', 'success', 'done', 'finished'].includes(status)) {
    const duration = typeof payload.duration === 'number' ? payload.duration
      : typeof metadata?.duration === 'number' ? metadata.duration as number
        : typeof video?.duration === 'number' ? video.duration as number
          : undefined
    // Ark reports the tail frame separately when `return_last_frame` was set;
    // it is a still, not the clip, so it is used as a poster rather than as the
    // result URL.
    const poster = typeof payload.poster === 'string' ? payload.poster
      : typeof metadata?.poster === 'string' ? metadata.poster as string
        : typeof content?.last_frame_url === 'string' ? content.last_frame_url
          : undefined
    // A terminal task with no URL is NOT a failure: the OpenAI video contract
    // keeps the clip behind `GET /videos/{id}/content`, so the poll loop turns
    // this into a content fetch instead of dropping a render the user paid for.
    if (typeof url !== 'string') {
      return {
        kind: 'done-content',
        ...duration === undefined ? {} : { duration },
        ...poster === undefined ? {} : { poster },
      }
    }
    return {
      kind: 'done',
      url,
      ...duration === undefined ? {} : { duration },
      ...poster === undefined ? {} : { poster },
    }
  }
  // Anything else (queued / processing / running / pending / in_progress) is
  // still in flight. A body that already carries a URL alongside a non-terminal
  // status is treated as done, because some relays only flip the status later.
  if (typeof url === 'string' && status === '') return { kind: 'done', url }
  return { kind: 'pending' }
}

/**
 * Delay before poll number `attempt` (0-based).
 *
 * Polling is quick-start then steady: the first few checks come fast so a fast
 * render (or an immediate rejection) surfaces in seconds, and the cadence then
 * settles into the family interval. A flat interval would make every user wait
 * the full 6-8s before even the first status, which is the worst case for the
 * common "provider rejected it instantly" path.
 */
function pollDelayMs(policy: { intervalMs: number }, attempt: number): number {
  if (attempt === 0) return 1_500
  if (attempt === 1) return 3_000
  return policy.intervalMs
}

/**
 * How many poll requests in a row may fail transiently before the loop gives
 * up. The retries share the family deadline, so a dead endpoint still ends in
 * `video-timeout` instead of retrying forever.
 */
const MAX_POLL_TRANSIENT_RETRIES = 4

/** Short backoff before re-asking a status endpoint that just failed. */
function pollRetryDelayMs(retry: number): number {
  const steps = [300, 700, 1_500, 3_000]
  return steps[Math.min(retry, steps.length) - 1] ?? 3_000
}

/**
 * The `/content` address for a finished task.
 *
 * OpenAI's video API serves the finished clip as a binary stream from
 * `GET /videos/{id}/content` and never puts a URL in the poll body. Appending
 * to the status URL keeps the `apiUrlFull`-derived base and the family's own
 * status path in one place, so a relay with a prefix polls and fetches through
 * the same prefix.
 */
function contentUrlFor(statusUrl: string): string {
  return `${statusUrl.replace(/\/+$/, '')}/content`
}

/**
 * Poll one task until terminal or the family deadline passes.
 *
 * `since.submittedAt` shifts the whole deadline: the budget belongs to the
 * RENDER, not to this process, so a resume starts with whatever is left. A
 * resume whose budget is already spent still gets one poll — a finished clip
 * must never be thrown away because the host happened to restart late.
 */
async function pollUntilDone(
  attempt: VideoAttempt,
  upstream: VideoUpstreamConfig,
  baseUrl: string,
  taskId: string,
  family: string,
  signal?: AbortSignal,
  since: { submittedAt?: number } = {},
): Promise<{ source: VideoClipSource; duration?: number; poster?: string }> {
  const policy = POLL_POLICY[family] ?? POLL_POLICY.unknown!
  const already = since.submittedAt === undefined ? 0 : Math.max(0, Date.now() - since.submittedAt)
  const deadline = since.submittedAt === undefined ? Date.now() + policy.deadlineMs : since.submittedAt + policy.deadlineMs
  // At least one poll even when the elapsed time already exceeds the budget:
  // the render may have finished while this process was down, and dropping it
  // would waste the exact money the resume path exists to save.
  let mustPollOnce = already >= policy.deadlineMs
  const statusUrl = statusUrlFor(upstream, baseUrl, family, taskId)
  const statusAttempt: VideoAttempt = {
    ...attempt,
    phase: 'video-poll',
    url: displayUrl(statusUrl),
    method: 'GET',
  }
  let attemptCount = 0
  // Consecutive transient poll failures. A render takes minutes, so one 5xx or
  // a dropped connection from the status endpoint must not fail a task the
  // provider is still working on; the retries stay inside the family deadline.
  let transientRetries = 0
  while (mustPollOnce || Date.now() < deadline) {
    mustPollOnce = false
    await waitForPoll(pollDelayMs(policy, attemptCount), signal)
    attemptCount += 1
    const budget = requestSignal(signal, SUBMIT_TIMEOUT_MS)
    try {
      const payload = await getJson(statusAttempt, statusUrl, upstream.apiKey, budget.signal)
      transientRetries = 0
      const outcome = readPoll(payload)
      if (outcome.kind === 'done') {
        return {
          source: { kind: 'url', url: outcome.url },
          ...outcome.duration === undefined ? {} : { duration: outcome.duration },
          ...outcome.poster === undefined ? {} : { poster: outcome.poster },
        }
      }
      // Finished with no URL in the body: the clip is behind `/content` (#9).
      // The bytes are fetched by the download leg like any other result, so the
      // same-origin key forwarding and the size cap still apply.
      if (outcome.kind === 'done-content') {
        return {
          source: { kind: 'content', url: contentUrlFor(statusUrl) },
          ...outcome.duration === undefined ? {} : { duration: outcome.duration },
          ...outcome.poster === undefined ? {} : { poster: outcome.poster },
        }
      }
      if (outcome.kind === 'failed') {
        // The provider ran the render and reported it failed: record the task
        // id and its own words, which is the only place the cause exists.
        const failure = new VideoGenError(outcome.message, 'video-failed')
        recordVideoFailure(statusAttempt, failure, {
          requestExcerpt: excerptOf({ taskId, family, ...payload }),
        })
        throw failure
      }
    } catch (error) {
      // Cancellation is the caller's decision: pass it straight through.
      if (signal?.aborted === true) throw error
      // A transient poll error is one the same request could survive: a
      // retryable status, a per-request budget timeout (the budget aborts with
      // a TimeoutError DOMException), or a transport failure (which node's
      // fetch reports as a TypeError). A provider failure that `readPoll`
      // recognised is a VideoGenError and never retryable, so it is surfaced
      // immediately; so is anything else unexpected.
      const transient = error instanceof VideoGenError
        ? error.retryable
        : error instanceof TypeError
          || (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      if (!transient) throw error
      transientRetries += 1
      if (transientRetries > MAX_POLL_TRANSIENT_RETRIES) {
        // The loop is giving up on a status endpoint that keeps failing. This
        // is the moment to record it: one transient blip is not worth a row,
        // an exhausted retry budget is exactly what the user needs to see.
        recordPollExhausted(statusAttempt, error, taskId, family, transientRetries)
        throw error
      }
      // Never spend the backoff past the family deadline: the retries are meant
      // to stay inside it, so a dead endpoint still ends in `video-timeout`
      // instead of running one more wait the deadline already passed.
      if (Date.now() + pollRetryDelayMs(transientRetries) >= deadline) break
      // Swallow the blip and ask the same endpoint again after a short backoff.
      await waitForPoll(pollRetryDelayMs(transientRetries), signal)
    } finally {
      budget.dispose()
    }
  }
  const timeout = new VideoGenError(`视频生成超时（已等待 ${Math.round(policy.deadlineMs / 60_000)} 分钟）`, 'video-timeout')
  // A timeout is the most common "it just sat there" report, so the record
  // carries which task was being polled and how far the polls got.
  recordVideoFailure(statusAttempt, timeout, {
    requestExcerpt: excerptOf({ taskId, family, polls: attemptCount, waitedMs: policy.deadlineMs }),
  })
  throw timeout
}

/** Download the finished clip, forwarding the key only to the API's origin. */
async function downloadVideo(attempt: VideoAttempt, upstream: VideoUpstreamConfig, rawUrl: string, signal?: AbortSignal): Promise<VideoBytes> {
  const budget = requestSignal(signal, DOWNLOAD_TIMEOUT_MS)
  // Some providers name the clip by a path relative to their own API base; it
  // has to be absolute before it can be fetched or origin-checked.
  const url = resolveResultUrl(rawUrl, upstream.apiUrl)
  // The recorded address is the RESOLVED one: a bare `/v1/videos/x/content`
  // in a failure row tells the reader nothing about which host was asked.
  const shown = displayUrl(url)
  try {
    // The upstream Bearer key is only attached for the provider's own origin;
    // a third-party CDN URL must not be able to harvest it.
    const headers: Record<string, string> = isSameOriginAsApi(url, upstream.apiUrl)
      ? { authorization: `Bearer ${upstream.apiKey}` }
      : {}
    let response: Response
    try {
      response = await fetch(url, { headers, signal: budget.signal })
    } catch (error) {
      if (signal?.aborted === true) throw error
      const network = networkErrorFields(error)
      const failure = new VideoGenError(
        `无法下载生成的视频：${network.detail}${network.errorCode === undefined ? '' : ` [${network.errorCode}]`} · 视频地址 ${shown}`,
        'video-download-failed',
      )
      recordVideoFailure(attempt, failure)
      throw failure
    }
    if (!response.ok) {
      const failure = new VideoGenError(`无法下载生成的视频（HTTP ${response.status} · ${shown}）`, 'video-download-failed')
      recordVideoFailure(attempt, failure, { status: response.status })
      throw failure
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0) {
      const failure = new VideoGenError('生成的视频内容为空', 'video-download-failed')
      recordVideoFailure(attempt, failure, { status: response.status, responseBytes: 0 })
      throw failure
    }
    if (buffer.byteLength > MAX_VIDEO_BYTES) {
      const failure = new VideoGenError('生成的视频超出了单文件体积上限', 'video-too-large')
      // The size is the whole point here: it is what says the URL returned
      // something other than the clip that was asked for.
      recordVideoFailure(attempt, failure, { status: response.status, responseBytes: buffer.byteLength })
      throw failure
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    return { bytes: buffer, mime: videoMimeOf(contentType, url), sourceUrl: url }
  } finally {
    budget.dispose()
  }
}

/** Pick a video MIME type from the response header, falling back to the URL. */
function videoMimeOf(contentType: string | undefined, url: string): string {
  if (contentType !== undefined && /^video\/[a-z0-9.+-]+$/i.test(contentType)) return contentType
  const match = /\.([a-z0-9]+)(?:$|[?#])/i.exec(url)
  switch (match?.[1]?.toLowerCase()) {
    case 'webm': return 'video/webm'
    case 'mov': return 'video/quicktime'
    case 'mkv': return 'video/x-matroska'
    default: return 'video/mp4'
  }
}

/** 参考图上限：网关的参考族（r2va）最多吃 9 张图。 */
const MAX_H3_REFERENCES = 9

/**
 * 网关的参考素材上传入口，相对 API base 解析。
 *
 * 不放进 {@link VIDEO_PATHS}：那张表只描述 submit/status 成对出现的路径，
 * 上传两者都不是。跟 status 一样按 base 解析，`apiUrlFull` 场景才不会指错主机。
 */
const H3_UPLOAD_PATH = '/ov/files'

/** 参考图的文件扩展名，由 mime 决定（网关按扩展名判容器）。 */
function h3ReferenceExtension(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/heic') return 'heic'
  if (mime === 'image/heif') return 'heif'
  return 'jpg'
}

/**
 * 把一张参考图上传到网关素材库，返回可直接放进任务 metadata 的 URL。
 *
 * 网关对参考素材只保证「签名 URL 可用」，任务体里的图片字段按 URL 取素材，
 * 所以本地 data URL 必须先换 URL 再提交。上传失败就是提交失败：拿不到 URL
 * 还去提交只会让用户等一个注定 400 的任务。
 */
async function uploadH3Reference(
  upstream: VideoUpstreamConfig,
  baseUrl: string,
  reference: { mime: string; base64: string },
  index: number,
  signal: AbortSignal,
): Promise<string> {
  const url = endpointUrl(upstream, baseUrl, H3_UPLOAD_PATH)
  const form = new FormData()
  form.append(
    'file',
    new Blob([Buffer.from(reference.base64, 'base64')], { type: reference.mime }),
    `reference-${index + 1}.${h3ReferenceExtension(reference.mime)}`,
  )
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${upstream.apiKey}` },
    body: form,
    signal,
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new VideoGenError(
      `参考素材上传失败（HTTP ${response.status} · ${displayUrl(url)}）：${text.slice(0, 200)}`,
      'video-bad-reference',
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (_notJson: unknown) {
    throw new VideoGenError('参考素材上传返回的不是 JSON', 'video-bad-reference')
  }
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const uploaded = typeof record.url === 'string' ? record.url.trim() : ''
  if (uploaded === '') throw new VideoGenError('参考素材上传没有返回 url', 'video-bad-reference')
  return uploaded
}

/**
 * 构造自家 MaaS 网关的提交体。
 *
 * 契约见网关的 `docs/video-client-integration.md`：
 *
 *  - 提交 `POST <base>/videos`，`metadata.image_mode` 区分玩法
 *    （`text-to-video` / `first-last-frame` / `reference`），成品在轮询返回的
 *    `metadata.url`；
 *  - 分辨率固定 768P —— 2K 是网关侧「生成 768P + 超分」的聚合模型行为，
 *    客户端传 2K 没有意义；
 *  - 首尾帧走顶层 `image` / `images`，参考图**不能**放顶层（那会被当成首帧），
 *    必须放 `metadata.src_ref_images`；
 *  - 音轨由引擎直接混进 mp4，`metadata.generate_audio` 默认 true。
 */
async function h3v2SubmitBody(
  upstream: VideoUpstreamConfig,
  request: VideoGenerateRequest,
  model: string,
  references: DecodedReferences,
  baseUrl: string,
  seconds: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const wireModel = (request.upstream ?? request.model).trim()
  if (request.prompt.trim() === '') {
    // 放在任何上传之前：空提示词会被网关 400，而上传的时间已经白花了。
    throw new VideoGenError('提示词不能为空：网关要求文本项非空', 'video-bad-prompt')
  }
  const metadata: Record<string, unknown> = { resolution: '768P', generate_audio: true }
  if (request.aspectRatio.trim() !== '') metadata.ratio = request.aspectRatio
  const body: Record<string, unknown> = {
    model: wireModel,
    prompt: request.prompt,
    duration: seconds,
    metadata,
  }

  if (request.mode === 'keyframe') {
    // 首尾帧：`image_mode` 让网关按 flf2v 处理；只给一张时它按 i2v 处理，
    // 所以这里不需要替它判断「一张算不算首尾帧」。
    metadata.image_mode = 'first-last-frame'
    const frames = references.all.slice(0, 2)
    const urls: string[] = []
    for (const [index, frame] of frames.entries()) {
      urls.push(await uploadH3Reference(upstream, baseUrl, frame, index, signal))
    }
    if (urls.length === 1) body.image = urls[0]
    else if (urls.length > 1) body.images = urls
    return body
  }

  if (request.mode === 'reference') {
    if (references.all.length === 0) {
      throw new VideoGenError('参考族至少要给一张参考图', 'video-bad-reference')
    }
    if (references.all.length > MAX_H3_REFERENCES) {
      throw new VideoGenError(
        `网关的参考族最多支持 ${String(MAX_H3_REFERENCES)} 张参考图，本次是 ${String(references.all.length)} 张`,
        'video-bad-reference',
      )
    }
    metadata.image_mode = 'reference'
    const urls: string[] = []
    for (const [index, reference] of references.all.entries()) {
      urls.push(await uploadH3Reference(upstream, baseUrl, reference, index, signal))
    }
    metadata.src_ref_images = urls
    return body
  }

  if (references.primary !== undefined) {
    body.image = await uploadH3Reference(upstream, baseUrl, references.primary, 0, signal)
  }
  return body
}

/**
 * Build the submit body of the generic OpenAI-style video endpoint: best
 * effort, widened parameters.
 *
 * The H3 family never reaches this function — `h3v2SubmitBody` owns it, because
 * its references have to be uploaded to gateway media storage first.
 */
function submitBody(request: VideoGenerateRequest, references: DecodedReferences): Record<string, unknown> {
  const seconds = clampVideoSeconds(request.seconds)
  // Capabilities belong to the UPSTREAM id, not the alias: a channel maps an
  // alias onto the id the gateway expects.
  const wireModel = (request.upstream ?? request.model).trim()
  const body: Record<string, unknown> = {
    model: wireModel,
    prompt: request.prompt,
    seconds: String(seconds),
    size: normalizeVideoResolution(wireModel, request.resolution),
  }
  if (request.aspectRatio.trim() !== '') body.aspect_ratio = request.aspectRatio
  if (references.primary !== undefined) {
    body.image = `data:${references.primary.mime};base64,${references.primary.base64}`
  }
  return body
}

/**
 * A submit that landed: the only moment the provider task id exists (#10-1).
 *
 * Emitted so the host queue can persist the id without this module knowing how
 * video tasks are stored, and without `generation-runtime.ts` having to forward
 * anything. The listener is matched to its task by the `AbortSignal` the queue
 * created for that run, because the queue is the only place that knows the local
 * task id and it already owns that signal.
 */
export interface VideoSubmitEvent {
  /** The signal the caller passed to `generateVideo` (undefined for direct calls). */
  signal?: AbortSignal
  /** The provider's task id — the value a restart needs. */
  remoteTaskId: string
  family: string
  /** The upstream model id that was submitted. */
  model: string
  submittedAt: number
  upstream: VideoUpstreamConfig
  request: VideoGenerateRequest
}

const submitListeners = new Set<(event: VideoSubmitEvent) => void>()

/**
 * Observe successful submits (used by the task queue to persist the remote id).
 *
 * An observer that throws must not fail a render the user has already paid for,
 * so listener errors are swallowed — the same rule the queue applies to its own
 * listeners.
 *
 * @returns an unsubscribe function.
 */
export function onVideoSubmitted(listener: (event: VideoSubmitEvent) => void): () => void {
  submitListeners.add(listener)
  return () => { submitListeners.delete(listener) }
}

function publishSubmit(event: VideoSubmitEvent): void {
  for (const listener of submitListeners) {
    try {
      listener(event)
    } catch {
      // Observers are bookkeeping; the render is the product.
    }
  }
}

/**
 * Poll one already-submitted render and download its clip.
 *
 * This is the restart path (#10-1): it never submits, so reattaching a render
 * costs nothing beyond the polls. Shared with {@link generateVideo}'s tail so
 * both paths download and shape the result identically.
 *
 * `submittedAt` is the ONLY clock used for the deadline. Counting from the
 * restart instead would hand a render that has already run 35 minutes a fresh
 * 40-minute budget, so an abandoned task could sit in the queue for over an
 * hour.
 *
 * @returns the finished clip, ready for the store to persist.
 */
export async function resumeVideo(
  upstream: VideoUpstreamConfig,
  request: VideoGenerateRequest,
  resume: { taskId: string; family: string; submittedAt?: number },
  options: { signal?: AbortSignal } = {},
): Promise<VideoEngineResult> {
  const model = (request.upstream ?? request.model).trim()
  if (model === '') throw new VideoGenError('未指定视频模型', 'video-no-model')
  const family = resume.family.trim() === '' ? describeVideoModel(model).family : resume.family
  const baseUrl = upstream.apiUrl.replace(/\/+$/, '')
  const statusUrl = statusUrlFor(upstream, baseUrl, family, resume.taskId)
  const attempt = videoAttempt(upstream, request, model, 'video-poll', statusUrl, 'GET')
  const finished = await pollUntilDone(
    attempt,
    upstream,
    baseUrl,
    resume.taskId,
    family,
    options.signal,
    resume.submittedAt === undefined ? {} : { submittedAt: resume.submittedAt },
  )
  const downloadAttempt: VideoAttempt = {
    ...attempt,
    phase: 'video-download',
    url: displayUrl(resolveResultUrl(finished.source.url, upstream.apiUrl)),
    method: 'GET',
  }
  const downloaded = await downloadVideo(downloadAttempt, upstream, finished.source.url, options.signal)
  return {
    videos: [{
      ...downloaded,
      ...finished.duration === undefined ? {} : { duration: finished.duration },
      ...finished.poster === undefined ? {} : { poster: finished.poster },
    }],
  }
}

/**
 * Generate one video: submit, poll to a terminal state, download the clip.
 *
 * `family` may be forced by the caller (the runtime passes the resolved
 * upstream family), otherwise it is derived from the model alias.
 */
export async function generateVideo(
  upstream: VideoUpstreamConfig,
  request: VideoGenerateRequest,
  options: { signal?: AbortSignal; family?: string } = {},
): Promise<VideoEngineResult> {
  const model = (request.upstream ?? request.model).trim()
  if (model === '') throw new VideoGenError('未指定视频模型', 'video-no-model')
  const entry = describeVideoModel(model)
  const family = options.family ?? entry.family
  if (entry.family === 'unknown' && options.family === undefined) {
    throw new VideoGenError(`无法识别视频模型「${model}」的协议族，请在渠道中改用已知的视频模型`, 'video-unknown-model')
  }
  if (family === 'unknown') {
    throw new VideoGenError(`视频模型「${model}」的协议族未知，无法生成`, 'video-unknown-model')
  }
  // Resume FIRST, before the reference-frame guards: a restarted render no
  // longer carries its frames (they were deliberately not persisted), so those
  // checks would reject a request that is perfectly valid — the provider
  // already has the frames and only polling is left.
  if (request.resume !== undefined) return await resumeVideo(upstream, request, request.resume, options)
  const references = referencesOf(request)
  if (request.mode === 'keyframe' && references.all.length === 0) {
    throw new VideoGenError('首尾帧模式至少需要一张首帧图片', 'video-bad-reference')
  }
  // Both image-bearing modes need at least one frame. `reference` used to slip
  // through: the panel only required a frame for `image`, so a reference-mode
  // submit with nothing attached reached the provider and came back as an
  // unexplained rejection instead of "this mode needs a reference image".
  if ((request.mode === 'image' || request.mode === 'reference') && references.primary === undefined) {
    throw new VideoGenError(
      request.mode === 'reference' ? '参考图模式至少需要一张参考图片' : '图生视频需要一张参考图片',
      'video-bad-reference',
    )
  }

  const baseUrl = upstream.apiUrl.replace(/\/+$/, '')
  const url = endpointUrl(upstream, baseUrl, VIDEO_PATHS[family]?.submit ?? '/videos')
  // One budget for the whole "get this render started" leg: for the H3 family
  // that includes parking each reference frame in gateway media storage, and a
  // task created after the uploads outlive their own deadline is useless.
  const submitBudget = requestSignal(options.signal, SUBMIT_TIMEOUT_MS)
  let submitAttempt: VideoAttempt
  let taskId = ''
  try {
    // H3 builds its body asynchronously because references upload first.
    const body = family === 'h3-v2'
      ? await h3v2SubmitBody(
        upstream,
        request,
        model,
        references,
        baseUrl,
        clampVideoSeconds(request.seconds),
        submitBudget.signal,
      )
      : submitBody(request, references)
    // The submit leg's own context: every failure from here to the task id is a
    // "the render never started" report, which is a different problem from a
    // render that started and then failed.
    submitAttempt = videoAttempt(upstream, request, model, 'video-submit', url, 'POST', JSON.stringify(body))
    const payload = await postJson(submitAttempt, request, url, upstream.apiKey, body, submitBudget.signal)
    taskId = taskIdOf(payload)
    if (taskId === '') {
      // A 2xx that carries no task id is just as unrecoverable as a rejection,
      // and the body is the only place the provider explains itself.
      const failure = new VideoGenError(errorTextOf(payload, '视频接口未返回任务 ID'), 'video-submit-failed')
      recordVideoFailure(submitAttempt, failure, { requestExcerpt: excerptOf(payload) })
      throw failure
    }
  } finally {
    submitBudget.dispose()
  }

  // The remote id exists only from here on. Publish it before polling so a
  // crash during the (minutes-long) poll still leaves the record a restart can
  // reattach — that gap is exactly what #10-1 reported.
  publishSubmit({
    ...options.signal === undefined ? {} : { signal: options.signal },
    remoteTaskId: taskId,
    family,
    model,
    submittedAt: Date.now(),
    upstream,
    request,
  })

  const finished = await pollUntilDone(submitAttempt, upstream, baseUrl, taskId, family, options.signal)
  // The download leg gets its own phase and its own URL: the clip usually
  // comes from a CDN, so "the status worked but the bytes did not" is a
  // distinct failure the address alone makes obvious. A `/content` source is
  // the same leg — only the address differs — which is what keeps the key
  // forwarding and the size cap in one place (#9).
  const downloadAttempt: VideoAttempt = {
    ...submitAttempt,
    phase: 'video-download',
    url: displayUrl(resolveResultUrl(finished.source.url, upstream.apiUrl)),
    method: 'GET',
  }
  const downloaded = await downloadVideo(downloadAttempt, upstream, finished.source.url, options.signal)
  return {
    videos: [{
      ...downloaded,
      ...finished.duration === undefined ? {} : { duration: finished.duration },
      ...finished.poster === undefined ? {} : { poster: finished.poster },
    }],
  }
}
