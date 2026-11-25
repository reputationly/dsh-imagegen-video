/**
 * The DSH host's own conversation model, wired as a plain "ask one question,
 * get one answer" seam.
 *
 * Why this exists: the code-generation path draws whatever a chat model writes,
 * and the user already has a model in DSH — the one the conversation panel
 * talks to. Making them configure the plugin's prompt-enhancement endpoint as
 * well would be asking for the same thing twice, and on a normal install the
 * host model is the better one. This adapter reaches that model through the
 * host's own `agents` service, the same way the canvas heavy-skill tier does,
 * so no vendor SDK and no second credential is involved.
 *
 * A conversation model is not a raw completion endpoint, so the ask is a real
 * (headless) agent turn: compose one with the deployment's default provider and
 * model, mount the preset so the turn has a model route, put the drawing brief
 * in the system prompt, send one user message, wait for idle, and read the last
 * assistant text back. No tools are registered, so the turn is a completion in
 * everything but name.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { agentSessionFailure, lastAssistantText, type SkillAgentSession } from './skill-runner.ts'
import type { ChatPart } from './prompt-enhancer.ts'
import type { HostChatSeam } from './generation-runtime.ts'

/** The host `agents` service, narrowed to what one plain turn needs. */
export interface HostAgentsService {
  create: (options: {
    sessionId: string
    meta?: { cwd?: string; origin?: 'subagent'; agentPreset?: string }
    agentOptions?: { provider: string; model: string }
    signal?: AbortSignal
    setup?: (agentCtx: Context) => void | Promise<void>
  }) => Promise<{ agent: HostAgent; dispose: () => Promise<void> }>
}

/** One user-message block: the brief, or an image the model must look at. */
export type HostTurnBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }

/** One composed agent, narrowed to sending a turn and reading its answer. */
export interface HostAgent {
  session: SkillAgentSession
  followup: (message: { id: string; role: 'user'; content: HostTurnBlock[]; source: { kind: string } }) => void
  whenIdle: () => Promise<void>
  cancel: (reason: { kind: string }) => void
}

/** The deployment's default model selection (`ctx.agentDefaultModel`). */
export interface HostDefaultModel {
  currentSelection: () => { provider?: string; model?: string }
}

/** The preset roster; mounting one is what gives the turn a model route. */
export interface HostAgentPresets {
  resolve: (id?: string) => Promise<{ id: string }>
  mount: (agentCtx: Context, id?: string) => Promise<{ id: string }>
}

export interface HostChatOptions {
  agents?: HostAgentsService
  presets?: HostAgentPresets
  defaultModel?: HostDefaultModel
  /**
   * Attachment admission for image parts. Absent on hosts without the seam:
   * a text-only ask still works, an ask that carries an image then refuses
   * rather than dropping the picture the caller asked about.
   */
  saveImage?: (input: SaveImageAttachment) => Promise<ImageAttachmentRef>
  /** Working directory for the composed agent (the code render never reads it). */
  cwd: () => string
  /** Preset id to join; empty asks the roster for the deployment default. */
  preset: () => string
}

/** The media types attachment admission accepts from a data URL. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Decode one `data:<mime>;base64,<payload>` part into attachment input. */
function imageInputOf(part: { image_url: { url: string } }): SaveImageAttachment {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url.trim())
  if (match === null || match[1] === undefined || match[2] === undefined || match[2] === '') {
    throw new Error('图片输入必须是 base64 data URL')
  }
  const mediaType = match[1].trim().toLowerCase()
  const accepted = IMAGE_MEDIA_TYPES.find(type => type === mediaType)
  if (accepted === undefined) throw new Error(`对话模型不接受这种图片格式：${mediaType || 'unknown'}`)
  return { data: new Uint8Array(Buffer.from(match[2], 'base64')), mediaType: accepted }
}

/** Map a user-facing model name onto a filesystem-safe run id. */
function runId(): string {
  return `dsh-imagegen-code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build the seam.
 *
 * `available()` is checked per call, not cached at mount time: the host can
 * mount `agents` after this plugin, and the user can switch models without a
 * restart. Everything else is resolved at call time for the same reason.
 */
export function createHostChatSeam(options: HostChatOptions): HostChatSeam {
  const selection = (): { provider: string; model: string } | undefined => {
    const current = options.defaultModel?.currentSelection()
    const provider = current?.provider?.trim() ?? ''
    const model = current?.model?.trim() ?? ''
    return provider === '' || model === '' ? undefined : { provider, model }
  }
  /** Turn the seam's content into the user-message blocks one turn carries. */
  const blocksOf = async (content: string | readonly ChatPart[]): Promise<HostTurnBlock[]> => {
    if (typeof content === 'string') return [{ type: 'text', text: content }]
    const blocks: HostTurnBlock[] = []
    for (const part of content) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text })
        continue
      }
      const save = options.saveImage
      if (save === undefined) {
        throw new Error('当前部署没有图片附件服务：对话模型只能处理文字输入')
      }
      blocks.push({ type: 'image', attachment: await save(imageInputOf(part)) })
    }
    return blocks
  }
  return {
    available: () => options.agents !== undefined && selection() !== undefined,
    label: () => selection()?.model ?? '',
    complete: async ({ system, content, signal }) => {
      const agents = options.agents
      const chosen = selection()
      if (agents === undefined || chosen === undefined) {
        throw new Error('DSH 当前没有可用的对话模型：请先在对话面板里选择一个模型，或切回模型生成。')
      }
      // The preset is what carries the model route; resolving it first (rather
      // than inside setup) lets a missing roster report plainly instead of
      // composing an agent that has nothing to think with.
      const requested = options.preset().trim()
      const presetId = options.presets === undefined
        ? undefined
        : (await options.presets.resolve(requested === '' ? undefined : requested)).id
      const sessionId = runId()
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: options.cwd(),
          origin: 'subagent',
          ...presetId === undefined ? {} : { agentPreset: presetId },
        },
        agentOptions: chosen,
        ...signal === undefined ? {} : { signal },
        setup: async (agentCtx: Context) => {
          if (options.presets !== undefined && presetId !== undefined) await options.presets.mount(agentCtx, presetId)
          // The brief travels as a system section so the user turn stays the
          // request itself — the same shape the director uses for its prompt.
          agentCtx.systemPrompt.section({
            name: 'plugin:dsh-imagegen:code-render',
            order: 10,
            text: system,
          })
        },
      })
      const blocks = await blocksOf(content)
      const agent = handle.agent
      try {
        agent.followup({
          id: `${sessionId}-turn`,
          role: 'user',
          content: blocks,
          source: { kind: 'plugin:dsh-imagegen' },
        })
        await agent.whenIdle()
        if (signal?.aborted === true) throw new Error('代码生成已取消')
        // `whenIdle` resolves even when the turn failed; the durable ending is
        // where a dead key or an unreachable provider actually says so. Without
        // this the user would read "the model returned nothing" instead.
        const failure = agentSessionFailure(agent.session)
        if (failure !== undefined) throw new Error(`DSH 的对话模型调用失败：${failure}`)
        const answer = lastAssistantText(agent.session.deriveMessages())
        if (answer === undefined) throw new Error('DSH 的对话模型没有返回任何内容')
        return answer
      } finally {
        await handle.dispose().catch(() => { /* best effort: a failed turn is already reported */ })
      }
    },
  }
}
