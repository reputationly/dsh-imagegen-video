/**
 * Agent-facing catalog of the models this account can actually use.
 *
 * The system prompt is a fixed text: it must not grow with the catalog, or every
 * account switch and every catalog refresh would rewrite the prompt and drop the
 * provider's prompt cache. The model list therefore lives in one read-only tool
 * the model calls when it needs it. Its result is ordered and bounded, so the
 * same catalog always produces the same bytes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { GatewayEntry, GatewayStatus } from './gateway-catalog.ts'
import { displayNameOf } from './gateway-catalog.ts'

/** One tool-result budget: a model list longer than this is truncated with its total. */
export const MEDIA_MODELS_RESULT_LIMIT = 4_000

/** What the tool needs from the host. */
export interface MediaModelsToolConfig {
  /** Whether the plugin is on and may introduce itself to the Agent. */
  readonly enabled: boolean
  /** Whether the Agent may act on the workbench at all. */
  readonly announceToAgent: boolean
  /**
   * Read the gateway catalog.
   * @returns the catalog snapshot in effect.
   */
  readonly snapshot: () => { readonly status: GatewayStatus; readonly entries: readonly GatewayEntry[] }
}

/** Operations this tool reports, in the order the workbench shows them. */
const OPERATIONS: readonly { readonly operation: string; readonly title: string }[] = [
  { operation: 'generate_video', title: 'video' },
]

/** One line of the grouped listing. */
function lineOf(entry: GatewayEntry): string {
  const parts = [`- ${entry.model}`, `(${displayNameOf(entry)})`]
  if (entry.modes !== undefined && entry.modes.length > 0) {
    const modes = entry.modes.map(mode => mode.label.zh !== '' ? `${mode.id}=${mode.label.zh}` : mode.id)
    parts.push(`modes: ${modes.join(', ')}`)
  } else if (entry.taskTypes !== undefined && entry.taskTypes.length > 0) {
    parts.push(`task types: ${entry.taskTypes.join(', ')}`)
  }
  const parameters = entry.paramSchema?.properties
  if (parameters !== undefined) {
    const described = Object.entries(parameters).map(([name, parameter]) => {
      const values = parameter.enum
      return values === undefined ? name : `${name}(${values.join('|')})`
    })
    if (described.length > 0) parts.push(`params: ${described.join(', ')}`)
  }
  if (entry.default) parts.push('default')
  return parts.join(' ')
}

/**
 * Build the listing for one catalog.
 *
 * Ordering is `operation` then `model`, with the gateway's default entry first in its
 * operation: a set that only differs in order would otherwise produce a different tool
 * result for the same catalog.
 * @param snapshot - catalog snapshot in effect.
 * @returns the listing text, truncated to {@link MEDIA_MODELS_RESULT_LIMIT} characters.
 */
export function mediaModelsListing(snapshot: { readonly status: GatewayStatus; readonly entries: readonly GatewayEntry[] }): string {
  const sections: string[] = []
  let reported = 0
  for (const { operation, title } of OPERATIONS) {
    const entries = snapshot.entries
      .filter(entry => entry.operation === operation)
      .sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))
      .sort((left, right) => Number(right.default) - Number(left.default))
    if (entries.length === 0) continue
    reported += entries.length
    sections.push(`${title} (${String(entries.length)}):\n${entries.map(lineOf).join('\n')}`)
  }
  if (sections.length === 0) {
    return snapshot.status === 'ready'
      ? 'This account has no video model.'
      : `The catalog is not available (status: ${snapshot.status}). Ask the user to sign in to the Create workbench.`
  }
  const body = sections.join('\n\n')
  if (body.length <= MEDIA_MODELS_RESULT_LIMIT) return `${body}\n\nOmit "model" to use the default model of the operation.`
  // Truncating mid-line would hand the model a half model id; cut whole lines instead.
  const kept: string[] = []
  let used = 0
  for (const line of body.split('\n')) {
    if (used + line.length + 1 > MEDIA_MODELS_RESULT_LIMIT) break
    kept.push(line)
    used += line.length + 1
  }
  return `${kept.join('\n')}\n\n(list truncated; ${String(reported)} models in total)`
}

/**
 * Register the read-only media-model listing.
 * @param ctx - host context owning the tool registry.
 * @param config - plugin switches and the catalog reader.
 * @returns disposer for the registration.
 */
export function registerMediaModelsTool(ctx: Context, config: () => MediaModelsToolConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'list_media_models',
    description: 'List the video models this account can use, with display name, modes, and parameter choices. Call it before choosing a model instead of guessing names; omit the model argument of a generation tool to use that operation\'s default.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          listing: { type: 'string', description: 'One line per model, grouped by operation.' },
        },
        additionalProperties: false,
      },
      // 纯文本结果：模型读到的就是这段清单，界面按同一段文字展示。
      render: (_args, value) => [{ type: 'text', text: value.listing ?? '' }],
    },
    async execute() {
      const value = config()
      return { listing: mediaModelsListing(value.snapshot()) }
    },
  }))
}
