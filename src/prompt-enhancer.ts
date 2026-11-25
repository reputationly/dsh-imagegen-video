/**
 * Prompt editing that runs on the deployment's own conversation model.
 *
 * The plugin no longer owns a chat endpoint: enhancement, polishing, listing
 * copy and the canvas light skills all ask the host conversation model through
 * {@link HostChatClient}, which `generation-runtime.ts` re-exports as
 * `HostChatSeam`. This module therefore owns the prompt wording and the answer
 * cleanup only — no addresses, no keys, no HTTP.
 */

/** One multimodal chat part, in the OpenAI wire shape the seams speak. */
export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** One chat request as the seams hand it to the host model. */
export interface ChatOptions {
  /** System brief: the role the answer is written in. */
  system: string
  /** Either a plain string or multimodal parts (images ride as data URLs). */
  content: string | readonly ChatPart[]
  /**
   * Sampling hints. A conversation-model turn owns its own sampling, so a host
   * that cannot honour these ignores them rather than refusing the request.
   */
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * The host conversation model, narrowed to one question and one answer.
 *
 * `available()` is asked per call, never cached: the host can mount its agent
 * runtime after this plugin, and the user can switch models at any time.
 */
export interface HostChatClient {
  /** Whether a host model is currently reachable (services mounted + a model chosen). */
  available: () => boolean
  /** The label recorded on history entries (the model the host will use). */
  label: () => string
  /** Run one turn and return the assistant's visible text. */
  complete: (options: ChatOptions) => Promise<string>
}

/** What a code-render or planning call records as the model that answered. */
export interface ChatTarget {
  /** Model label; empty means no host model is reachable. */
  model: string
}

/** Remove reasoning-model artifacts from a chat model's visible content:
 *  complete `<think>…</think>` blocks first, then anything from a dangling
 *  unclosed `<think>` to the end of the text. Reasoning models inline these
 *  blocks in `message.content`; leaking them into the prompt box both pollutes
 *  the prompt and can push it past image models' length limits. */
export function stripReasoning(text: string): string {
  const withoutClosed = text.replace(/[\s\S]*?<\/think>/gi, '')
  const dangling = /<think/i.exec(withoutClosed)
  return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim()
}

/** Strip a fenced code block and pull the outermost JSON object/array out. */
export function jsonPayload(content: string): unknown {
  const cleaned = stripReasoning(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const objectStart = cleaned.indexOf('{')
  const objectEnd = cleaned.lastIndexOf('}')
  const arrayStart = cleaned.indexOf('[')
  const arrayEnd = cleaned.lastIndexOf(']')
  const useArray = arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart)
  const start = useArray ? arrayStart : objectStart
  const end = useArray ? arrayEnd : objectEnd
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(cleaned.slice(start, end + 1)) as unknown } catch { return undefined }
}

/** Refuse a chat call the host cannot answer, before any work is queued. */
function requireHostChat(chat: HostChatClient): void {
  if (!chat.available()) {
    throw new Error('当前没有可用的对话模型：请先在对话面板里选择一个模型')
  }
}

/**
 * Expand a concise image request into a production-ready image prompt.
 * @param chat - the host conversation model.
 * @param prompt - the user's short request.
 * @param signal - caller cancellation.
 * @returns the finished prompt with any reasoning artifacts removed.
 */
export async function enhancePrompt(chat: HostChatClient, prompt: string, signal?: AbortSignal): Promise<string> {
  requireHostChat(chat)
  const answer = await chat.complete({
    temperature: 0.7,
    system: 'You are an expert image-prompt editor. Expand the user request into one vivid, specific image-generation prompt. Preserve intent and language. Add only useful visual detail: subject, composition, lighting, materials, color, camera/style and quality. Return only the finished prompt, with no preface or markdown.',
    content: prompt,
    ...signal === undefined ? {} : { signal },
  })
  return stripReasoning(answer)
}

/**
 * Polish one existing generation prompt without changing its purpose.
 * @param chat - the host conversation model.
 * @param prompt - the prompt to rewrite.
 * @param signal - caller cancellation.
 * @returns the rewritten prompt with any reasoning artifacts removed.
 */
export async function polishPrompt(chat: HostChatClient, prompt: string, signal?: AbortSignal): Promise<string> {
  requireHostChat(chat)
  const answer = await chat.complete({
    temperature: 0.35,
    system: '你是电商生图提示词编辑。请在保持图片用途、商品事实、平台、语言和原有结构不变的前提下，润色文字并补充可执行的视觉细节，减少重复和空泛表达。只输出最终提示词，不要解释、标题或 Markdown。',
    content: prompt,
    ...signal === undefined ? {} : { signal },
  })
  return stripReasoning(answer)
}
