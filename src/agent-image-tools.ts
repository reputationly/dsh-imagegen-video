/** Image-edit submission shared by the /edit_image command, backed by the shared host queue. */

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { ImageGenError } from './engine.ts'
import { ImageGenerationRuntime, type RuntimeChannel } from './generation-runtime.ts'
import type { GenerationTask } from './protocol.ts'

export interface AgentImageToolConfig {
  enabled: boolean
  allowAgentImageGeneration: boolean
  channels: RuntimeChannel[]
  defaultChannelId: string
  defaultModel?: string
}

/** Agent calls stay pending until the provider and history write settle. */
const AGENT_GENERATION_TIMEOUT_MS = 300_000

export function ensureAgentImageConfigured(config: AgentImageToolConfig): void {
  if (!config.enabled) throw new ImageGenError('AI image generation is disabled. Open Settings → Image / Video and enable it.', 'plugin-disabled')
  if (!config.allowAgentImageGeneration) throw new ImageGenError('Agent image generation is disabled in Settings → Image / Video.', 'agent-generation-disabled')
  const usable = config.channels.some(channel => channel.apiUrl.trim() !== '' && channel.apiKey.trim() !== '')
  if (!usable) throw new ImageGenError('Image API credentials are not configured. Open Settings → Image / Video, add a model service and fill in its API URL and API key.', 'image-api-not-configured')
}

/** Resolve a configured image alias and its owning channel. */
export function resolveAgentImageModel(config: AgentImageToolConfig, requested: unknown): { channel: RuntimeChannel; alias: string; upstream: string } {
  const entries = config.channels.flatMap(channel => channel.models.map(model => ({ channel, alias: model.alias, upstream: model.id })))
  if (entries.length === 0) {
    throw new ImageGenError('This account has no image model available. Sign in to the Create workbench and check that the account may use an image model.', 'no-models-configured')
  }
  const wanted = typeof requested === 'string' && requested.trim() !== ''
    ? requested.trim()
    : (typeof config.defaultModel === 'string' ? config.defaultModel.trim() : '')
  if (wanted === '') {
    if (entries.length === 1) return entries[0]!
    const options = config.channels.flatMap(channel => channel.models.map(model => `"${channel.name} · ${model.alias}"`)).join(', ')
    throw new ImageGenError(`Multiple image models are available — ask the user which one to use, then call this tool again with that exact model name. Options: ${options}.`, 'model-choice-required')
  }
  // list_media_models 报的是模型名，面板里存的是展示名，两种都认。
  const hosting = entries.filter(entry => entry.alias === wanted || entry.upstream === wanted)
  if (hosting.length === 0) {
    const available = [...new Set(entries.map(entry => entry.alias))].join(', ')
    throw new ImageGenError(`Image model "${wanted}" is not available to this account. Choose one of: ${available}.`, 'image-model-not-configured')
  }
  const preferred = hosting.find(entry => entry.channel.id === config.defaultChannelId)
  return preferred ?? hosting[0]!
}

function findAgentImageTask(runtime: ImageGenerationRuntime, id: string): GenerationTask {
  const task = runtime.queue.list().find(candidate => candidate.id === id)
  if (task === undefined) throw new ImageGenError(`Image generation task ${id} was not found.`, 'task-not-found')
  return task
}

/** Wait for a queue task without sending anything through the chat model. */
export function waitForAgentImageTask(runtime: ImageGenerationRuntime, id: string, signal: AbortSignal | undefined): Promise<GenerationTask> {
  return new Promise<GenerationTask>((resolveTask, rejectTask) => {
    let settled = false
    let dispose = (): void => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = (): void => {}

    const cleanup = (): void => {
      dispose()
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const resolve = (task: GenerationTask): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveTask(task)
    }
    const reject = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectTask(error)
    }
    abort = (): void => {
      if (settled) return
      const reason = signal?.reason instanceof Error ? signal.reason : new Error('Image generation was cancelled.')
      settled = true
      cleanup()
      runtime.queue.cancel(id)
      rejectTask(reason)
    }
    const onChange = (updated: GenerationTask): void => {
      if (updated.id === id && isFinalTask(updated)) resolve(updated)
    }

    if (signal?.aborted === true) {
      abort()
      return
    }
    dispose = runtime.queue.subscribe(onChange)
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      if (settled) return
      const timeout = new ImageGenError(`Image generation task ${id} timed out after ${AGENT_GENERATION_TIMEOUT_MS / 1000} seconds.`, 'generation-timeout')
      settled = true
      cleanup()
      runtime.queue.cancel(id)
      rejectTask(timeout)
    }, AGENT_GENERATION_TIMEOUT_MS)
    let current: GenerationTask
    try {
      current = findAgentImageTask(runtime, id)
    } catch (error) {
      reject(error)
      return
    }
    if (isFinalTask(current)) resolve(current)
  })
}

/** Submit the same image-edit request used by the Agent tool. */
export async function submitAgentImageEdit(
  attachments: Pick<AttachmentStore, 'readImage'>,
  runtime: ImageGenerationRuntime,
  resolve: () => AgentImageToolConfig,
  input: { prompt: string; sourceImage: ImageAttachmentRef; signal?: AbortSignal },
): Promise<GenerationTask> {
  const config = resolve()
  ensureAgentImageConfigured(config)
  const reference = await attachments.readImage(input.sourceImage, input.signal)
  const defaultChannel = config.channels.find(channel => channel.id === config.defaultChannelId) ?? config.channels[0]
  const fallbackModel = defaultChannel?.models[0]?.alias ?? config.channels.flatMap(channel => channel.models)[0]?.alias ?? ''
  const picked = resolveAgentImageModel(config, config.defaultModel?.trim() || fallbackModel)
  const task = runtime.queue.submit({
    mode: 'edit',
    model: picked.alias,
    upstream: picked.upstream,
    channelId: picked.channel.id,
    channel: picked.channel.name,
    prompt: input.prompt.trim(),
    size: 'auto',
    quality: 'auto',
    n: 1,
    detail: '',
    image: imageDataUrl(reference),
    ...reference.ref.name === undefined ? {} : { refName: reference.ref.name },
  })
  return waitForAgentImageTask(runtime, task.id, input.signal)
}

function imageDataUrl(image: { data: Uint8Array; ref: ImageAttachmentRef }): string {
  return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

/** Register the global Agent tools and unregister them with the plugin lifecycle. */

function isFinalTask(task: GenerationTask): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
}
