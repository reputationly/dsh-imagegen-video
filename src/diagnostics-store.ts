/**
 * Host-side generation diagnostics: a bounded, in-memory ring buffer of the
 * request attempts behind every generation, so a failed call is explainable
 * after the fact (#38).
 *
 * The reporter of #38 reverse-engineered an image API, verified it against
 * new-api, and then watched every call from this plugin fail — while neither
 * side had a log entry, because the request never reached their gateway. The
 * plugin surfaced a single sentence ("无法连接上游接口") and kept no record, so
 * there was nothing to inspect: not the URL it actually called, not the HTTP
 * status, not the network error code, not the upstream body.
 *
 * Captures the facts that separate the usual causes:
 *   - the FINAL request URL (a missing /v1 or a stray "exact URL" toggle is the
 *     most common cause of "the request never arrived"),
 *   - HTTP status + a bounded, redacted body excerpt,
 *   - the network error code (ECONNREFUSED / ENOTFOUND / CERT_* / timeout),
 *   - elapsed time and the request body size (a huge multipart edit can be
 *     rejected before it reaches the application),
 *   - whether an Authorization header was sent, never its value.
 *
 * Secrets never enter this store: the API key is reduced to a boolean, and
 * every recorded string passes through redaction.
 */

import type { DiagnosticEntry, DiagnosticPhase } from './protocol.ts'

export type { DiagnosticEntry, DiagnosticPhase }

/** What the caller supplies when recording an attempt. */
export type DiagnosticInput = Omit<DiagnosticEntry, 'id' | 'at' | 'durationMs' | 'hadAuth'> & {
  durationMs?: number
  hadAuth?: boolean
}

/** How many attempts to retain. Bounded so a long session cannot grow. */
export const DIAGNOSTIC_MAX = 200

/** Cap on any recorded excerpt, in characters. */
export const DIAGNOSTIC_EXCERPT_MAX = 2000

/**
 * Mask anything that looks like a credential. The store is meant to be copied
 * into a public issue thread, so this runs on every string it keeps: Bearer
 * tokens, common key prefixes, query-string secrets and long base64 blobs
 * (image payloads would otherwise swamp the buffer).
 */
export function redactDiagnosticText(value: string, limit = DIAGNOSTIC_EXCERPT_MAX): string {
  let text = value
  // Authorization headers of every common shape.
  text = text.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
  text = text.replace(/\b(sk|rk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, '<redacted-key>')
  // Query-string and JSON secrets.
  text = text.replace(/([?&](?:api[_-]?key|key|token|access_token|apikey)=)[^&\s"']+/gi, '$1<redacted>')
  text = text.replace(/("(?:api[_-]?key|key|token|secret|authorization)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
  // Inline image data would dominate any excerpt; keep only its shape.
  text = text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (match) => {
    const header = match.slice(0, match.indexOf(','))
    return `${header},<${match.length} chars of base64 redacted>`
  })
  // A long unbroken base64 run outside a data URL (raw b64_json responses).
  text = text.replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{200,}(?![A-Za-z0-9+/=])/g, '<long-base64 redacted>')
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text
}

/** Bounded excerpt of a body value (object → JSON, string → as-is). */
function excerptOf(value: unknown, limit = DIAGNOSTIC_EXCERPT_MAX): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (Buffer.isBuffer(value)) return `<${value.byteLength} bytes of binary>`
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text === '') return undefined
  return redactDiagnosticText(text, limit)
}

/** Byte length of a request body without materialising it twice. */
export function bodyByteLength(body: unknown): number | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8')
  if (Buffer.isBuffer(body)) return body.byteLength
  // FormData / Blob / streams: the size is not cheaply known; skip rather than
  // force a conversion that would defeat the streaming upload.
  return undefined
}

/**
 * The process-wide diagnostics buffer. One instance per host: generation runs
 * in a single queue, so a module-level singleton keeps every entry reachable
 * from the routes without threading a dependency through the engine.
 */
class DiagnosticStore {
  private entries: DiagnosticEntry[] = []
  private sequence = 0

  /** Record one attempt and return the stored entry. */
  record(input: DiagnosticInput): DiagnosticEntry {
    this.sequence += 1
    const entry: DiagnosticEntry = {
      ...input,
      id: `diag-${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      at: Date.now(),
      durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
      hadAuth: input.hadAuth ?? false,
      ...input.bodyExcerpt === undefined ? {} : { bodyExcerpt: redactDiagnosticText(input.bodyExcerpt) },
      ...input.requestExcerpt === undefined ? {} : { requestExcerpt: redactDiagnosticText(input.requestExcerpt) },
      message: redactDiagnosticText(input.message),
    }
    // Newest first: the panel reads top-down and the newest failure matters most.
    this.entries.unshift(entry)
    if (this.entries.length > DIAGNOSTIC_MAX) this.entries.length = DIAGNOSTIC_MAX
    return entry
  }

  list(): DiagnosticEntry[] {
    return this.entries.map(entry => ({ ...entry }))
  }

  /** Drop everything; the panel's Clear action. */
  clear(): void {
    this.entries = []
  }
}

const store = new DiagnosticStore()

/** Record one upstream attempt. */
export function recordDiagnostic(input: DiagnosticInput): DiagnosticEntry {
  return store.record(input)
}

/** Snapshot the retained attempts, newest first. */
export function listDiagnostics(): DiagnosticEntry[] {
  return store.list()
}

/** Clear the retained attempts. */
export function clearDiagnostics(): void {
  store.clear()
}

/**
 * Pull the most useful diagnostic fields out of a thrown value. Fetch rejects
 * with an AggregateError whose `cause`/`errors` carry the real network code,
 * so the code has to be dug out rather than read off the top-level error.
 */
export function networkErrorFields(error: unknown): { errorCode?: string; detail: string } {
  const codes: string[] = []
  const messages: string[] = []
  const seen = new Set<unknown>()

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 4 || seen.has(value)) return
    if (typeof value === 'object') seen.add(value)
    if (typeof value === 'string') {
      if (value !== '') messages.push(value)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    for (const key of ['code', 'errno', 'name'] as const) {
      const field = record[key]
      if (typeof field === 'string' && field !== '') codes.push(field)
    }
    if (typeof record.message === 'string' && record.message !== '') messages.push(record.message)
    // undici aggregates every address it tried under `errors`; the cause chain
    // holds the same story for single-address failures.
    if (Array.isArray(record.errors)) for (const item of record.errors) visit(item, depth + 1)
    visit(record.cause, depth + 1)
  }

  visit(error, 0)
  // Prefer a real socket code over generic labels like 'Error' / 'TypeError'.
  const preferred = codes.find(code => /^[A-Z]+_?[A-Z0-9_]*$/.test(code) && code !== 'Error')
  const detail = [...new Set(messages)].join(' | ')
  return {
    ...preferred === undefined ? {} : { errorCode: preferred },
    detail: detail === '' ? String(error) : detail,
  }
}

/**
 * Read a Response body as text without consuming the stream twice.
 *
 * Returns the RAW text: callers parse it, so it must never be redacted here.
 * Redaction is applied only when the text is stored (see `redactDiagnosticText`
 * and `DiagnosticStore.record`), which keeps generated image payloads intact.
 */
export async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.clone().text()
  } catch {
    return ''
  }
}

/**
 * Read a bounded, REDACTED excerpt of a Response body for the diagnostics
 * record. Only for recording: never feed the result back into parsing.
 */
export async function readResponseExcerpt(response: Response, limit = DIAGNOSTIC_EXCERPT_MAX): Promise<string | undefined> {
  const text = await readResponseText(response)
  if (text === '') return undefined
  return redactDiagnosticText(text, limit)
}

export { excerptOf }

/** What a body we could not parse as JSON turned out to be. `html` is the one worth naming. */
export type BodyShape = 'html' | 'text' | 'empty' | 'binary'

/** Cap on the excerpt quoted back inside a non-JSON message, in characters. */
const NON_JSON_EXCERPT_MAX = 120

/**
 * Classify a body we failed to parse as JSON.
 *
 * Only the leading bytes matter: an HTML error page carries its doctype or a
 * `<html`/`<head`/`<body`/`<meta` tag within the first handful of characters,
 * and a gateway's homepage does the same. Anything else is reported as plain
 * text rather than guessed at.
 * @param text - the raw response body.
 * @param contentType - the response's `content-type` header, if any.
 * @returns the body shape the message should describe.
 */
export function bodyShapeOf(text: string, contentType = ''): BodyShape {
  const trimmed = text.trimStart()
  if (trimmed === '') return 'empty'
  if (/^\s*<(?:!doctype|html|head|body|meta)/i.test(trimmed)) return 'html'
  // A server that says text/html without a recognisable prologue (a bare
  // `<div>` 404 page) still is not an API response; the header settles it.
  if (/^text\/html\b/i.test(contentType.trim())) return 'html'
  // NUL or a high share of non-printable bytes: a truncated image or a binary
  // error payload, not prose.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f]/.test(trimmed.slice(0, 64))) return 'binary'
  return 'text'
}

/** Whitespace-collapsed, length-capped excerpt for the message body. */
function shortExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  return collapsed.length > NON_JSON_EXCERPT_MAX ? `${collapsed.slice(0, NON_JSON_EXCERPT_MAX)}…` : collapsed
}

/**
 * The media type alone: `text/html; charset=utf-8` → `text/html`.
 *
 * WHY not the whole header: the parameters are noise to a user reading one
 * sentence. `charset=` in particular made the video suite's "no markup is
 * pasted into the message" assertion fail on a message that contained no
 * markup at all — a guard tripping on the wrong thing is nearly as costly as
 * the bug it guards, so the sentence keeps only what identifies the body.
 */
function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0]?.trim() ?? ''
}

/** The address as the user can act on it: no query, no credentials. */
export function requestAddress(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] ?? url
  }
}

/** What a caller knows about a response whose body would not parse as JSON. */
export interface NonJsonDiagnosisInput {
  /** The exact URL handed to fetch. Query strings are dropped in the output. */
  url: string
  status: number
  contentType: string
  /** The raw body, already read (never already redacted). */
  text: string
  /** What this call was doing, e.g. 「上游接口」/「任务接口」. Chinese, like the rest. */
  label: string
}

/**
 * Build the user-facing sentence for a response that could not be parsed.
 *
 * The order is deliberate: what happened → which address → why it is usually
 * wrong. A user reads the first clause and stops; a user who pastes this into
 * an issue gets the address for free.
 * @param input - what the caller knows about the failed response.
 * @returns one actionable sentence, safe to show and to copy into a report.
 */
export function diagnoseNonJsonBody(input: NonJsonDiagnosisInput): string {
  const shape = bodyShapeOf(input.text, input.contentType)
  const mediaType = mediaTypeOf(input.contentType)
  const type = mediaType === '' ? '未声明 Content-Type' : mediaType
  const address = requestAddress(input.url)
  const head = `${input.label}返回了非 JSON 响应（HTTP ${input.status}, ${type}）：${address}`

  if (shape === 'html') {
    return `${head} —— 返回的是网页而不是接口响应，通常说明网关地址少了路径（例如末尾缺 /v1）或填成了站点首页`
  }
  if (shape === 'empty') {
    return `${head} —— 响应体是空的，上游可能只写了状态码；请确认该地址是否为 API 端点`
  }
  if (shape === 'binary') {
    return `${head} —— 响应体是二进制内容而不是 JSON，可能是出图流被当成了接口响应`
  }
  const excerpt = shortExcerpt(input.text)
  return excerpt === '' ? head : `${head} —— 响应内容：${excerpt}`
}
