/**
 * dsh-imagegen — host half. Mounts the plugin's settings section on the host
 * settings seam, the /api/dsh-imagegen route family (loopback-only settings
 * bridge + usage / image-generation proxy), and a system-prompt announcement.
 *
 * 渠道只有一个来源：宿主的网关能力清单（见 `gateway-catalog.ts`），密钥由宿主凭据
 * 服务持有、提交前现取。插件不再有自己的端点、预设、订阅账号或对象存储配置。
 * The browser half (./client) renders the sidebar entry and the split-pane
 * generation studio.
 */

import type { Context } from '@deepseek-ai/cordis'
import { COMPONENT_SERVICE, ROUTE_SERVICE, routeComponent, type Feature, type ComponentRuntime } from './components.ts'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { installSettingsSectionCompat, resolveSettingsNamespaceCompat, settingsNamespaceCompat } from './settings-compat.ts'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context merge (route registration).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the systemPrompt Context merge (announcement section).
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: pulls the human slash-command registry Context merge.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
// The skills + agents seams are reached through `ctx.inject` and read
// structurally (see CanvasSkillServices): the host half must not import those
// packages at runtime, and this deployment does not resolve them at
// type-check time either.
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  entriesOfKind, gatewayChannel, isCredentialRefName, modelOptionsOf, pluginSnapshotOf,
  selectDefaultAlias, type GatewayCatalogHost, type GatewayCredentialsHost, type GatewayEndpoint, type PluginSnapshot,
} from './gateway-catalog.ts'
import { IMAGEGEN_SETTINGS_NAMESPACE, isChannelProtocolPreference, type GatewayCatalogSnapshot, type CanvasSkillConfigApplyRequest, type CanvasSkillConfigApplyResult, type CanvasSkillConfigSaveRequest, type CanvasSkillConfigSaveResult, type CanvasSkillConfigView, type CanvasSkillInstallRequest, type CanvasSkillInstallResult, type CanvasSkillLibrary, type CanvasSkillRemoveResult, type ChannelConfig, type ModelMapping } from './protocol.ts'
import { makeRoutes, type SettingsSeam } from './routes.ts'
import { syncAllTemplates } from './templates-store.ts'

/**
 * The concrete driver contract behind `ctx.agents`. The registry's published
 * `Agent` type only guarantees an id (the driver augmentation lives in
 * `dsh-agent-loop`), so the canvas skill runner reads the driver surface it
 * actually needs and fails loudly at runtime if a host shells out a different
 * driver without it.
 */
interface CanvasSkillAgent {
  readonly session: { deriveMessages: () => readonly unknown[]; readonly seq?: number; eventAt?: (seq: number) => unknown }
  followup: (message: { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'plugin:dsh-imagegen' } }) => void
  whenIdle: () => Promise<void>
  /** Durable cancellation cause; `user` is the canvas cancel button. */
  cancel: (cause: { kind: 'user' }) => void
}

/**
 * Resolve one skill's configuration declaration and the view the panel renders.
 *
 * Sidecar first, built-in recipe second, nothing third — the plugin never
 * invents a configuration surface for a skill that declared none. Exported so
 * the smoke suite exercises the real lookup (sidecar parsing, recipe fallback,
 * value resolution) rather than a test double of it.
 * @param options - skill name, its library entry path, the skills root, and the
 *   live value store; `issueText` localizes an ignored declaration.
 */
export async function readCanvasSkillConfig(options: {
  name: string
  entryPath?: string
  root: string
  store: SkillConfigStore
  issueText?: (issue: SkillConfigIssue) => string
}): Promise<{ declaration?: SkillConfigDeclaration; issue?: SkillConfigIssue; view?: CanvasSkillConfigView }> {
  const candidates = [...new Set([bundleDirOf(options.entryPath), path.join(options.root, options.name)])]
    .filter((dir): dir is string => dir !== undefined)
  let declaration: SkillConfigDeclaration | undefined
  let issue: SkillConfigIssue | undefined
  for (const dir of candidates) {
    const found = await readSkillConfigFile(dir).catch(() => undefined)
    if (found === undefined) continue
    if (found.manifest === undefined) issue = found.issue ?? 'unreadable'
    else declaration = { manifest: found.manifest, source: 'skill' }
    break
  }
  if (declaration === undefined && issue === undefined) declaration = recipeFor(options.name)
  const values = declaration === undefined ? new Map<string, string>() : valuesFor(declaration, options.store, options.name)
  const view = configView(
    declaration,
    values,
    issue === undefined ? undefined : (options.issueText === undefined ? issue : options.issueText(issue)),
  )
  return {
    ...declaration === undefined ? {} : { declaration },
    ...issue === undefined ? {} : { issue },
    ...view === undefined ? {} : { view },
  }
}

/** The bundle directory a library entry points at, when it is a bundle. */
function bundleDirOf(entryPath: string | undefined): string | undefined {
  if (entryPath === undefined) return undefined
  return path.basename(entryPath).toLowerCase() === 'skill.md' ? path.dirname(entryPath) : undefined
}

/** Error text for user-facing copy (never a bare `[object Object]`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Structural view of the host services (skills registry, agents, presets). */
interface CanvasSkillServices {
  skills: {
    list: () => Promise<Array<{ name: string; description: string; whenToUse?: string; path?: string; invocation?: { modelInvocable?: boolean }; metadata?: Readonly<Record<string, unknown>> }>>
    get: (name: string) => Promise<{ name: string; content: string; metadata?: Readonly<Record<string, unknown>> } | undefined>
  }
  agents: {
    create: (options: {
      sessionId: string
      meta?: { cwd?: string; origin?: 'subagent'; agentPreset?: string }
      agentOptions?: { provider: string; model: string }
      signal?: AbortSignal
      setup?: (agentCtx: Context) => void | Promise<void>
    }) => Promise<{ agent: CanvasSkillAgent; dispose: () => Promise<void> }>
  }
}

/** The agent-preset roster a heavy skill joins (`ctx.agentPresets`). */
interface CanvasAgentPresets {
  /** Resolve the named preset, or the deployment default when omitted. */
  resolve: (id?: string) => Promise<{ id: string }>
  /** Compose a creating agent under that preset; resolves the composed preset. */
  mount: (agentCtx: Context, id?: string) => Promise<{ id: string }>
}

/** The deployment's default model selection (`ctx.agentDefaultModel`). */
interface CanvasDefaultModel {
  currentSelection: () => { provider?: string; model?: string }
}

/** Everything one canvas heavy run needs to compose its headless agent. */
export interface CanvasSkillAgentOptions {
  agents: CanvasSkillServices['agents']
  /** Absent on hosts that mount no preset roster (the heavy tier then refuses). */
  presets?: CanvasAgentPresets
  /** Absent on hosts that publish no default model (the heavy tier then refuses). */
  defaultModel?: CanvasDefaultModel
  /** Configured preset id; empty asks the roster for the deployment default. */
  agentPreset: string
  sessionId: string
  cwd: string
  systemPrompt: string
  signal?: AbortSignal
  /** Localizes a composition failure's copy key (the runner owns the language). */
  fail?: (key: string) => string
}

/**
 * Compose the headless agent one heavy skill run drives.
 *
 * Creating an agent is not enough to make it *useful*: on the Web surface every
 * model-facing row (tools, prompt sections) lives behind an agent preset, and a
 * model route is not implied by the request. DSH's own entry points therefore
 * always pass both — `dsh-api-session-controller` stamps `agentOptions` from the
 * deployment default and mounts the resolved preset in `setup`, and
 * `dsh-subagent` joins the parent's preset for the same reason ("a child that
 * joins no preset sees an empty tool registry and none of its parent's prompt
 * sections"). A skill pipeline that must run a CLI is exactly that case: without
 * the join the agent dies on its first step, and without the model route it has
 * nothing to think with, so the canvas fails the run up front with copy instead
 * of producing an empty result.
 * @param options - host seams plus the run's identity, workspace and skill body.
 * @returns the live agent handle narrowed to what a skill run drives.
 */
export async function createCanvasSkillAgent(options: CanvasSkillAgentOptions): Promise<SkillAgentHandle> {
  const requested = options.agentPreset.trim()
  const presetId = options.presets === undefined
    ? undefined
    : (await options.presets.resolve(requested === '' ? undefined : requested)).id
  const selection = options.defaultModel?.currentSelection()
  const provider = selection?.provider?.trim() ?? ''
  const model = selection?.model?.trim() ?? ''
  const fail = options.fail ?? (key => key)
  if (provider === '' || model === '') throw new Error(fail('canvas.skills.needModel'))
  let runtimeFailure: string | undefined
  const handle = await options.agents.create({
    sessionId: options.sessionId,
    meta: {
      cwd: options.cwd,
      origin: 'subagent',
      ...presetId === undefined ? {} : { agentPreset: presetId },
    },
    agentOptions: { provider, model },
    ...options.signal === undefined ? {} : { signal: options.signal },
    setup: async (agentCtx: Context) => {
      // The driver contains errors before whenIdle resolves; retain its reason.
      const events = agentCtx as unknown as { on: (name: string, listener: (payload: { agent?: { id?: string }; error?: unknown }) => void) => unknown }
      events.on?.('agent/error', payload => {
        if (payload.agent?.id !== options.sessionId) return
        const error = payload.error
        runtimeFailure = redactDiagnosticText(error instanceof Error ? error.message : String(error))
      })
      // Join the preset FIRST: its rows must exist before the skill body is
      // registered, so the body never shadows the composition it runs inside.
      if (options.presets !== undefined && presetId !== undefined) await options.presets.mount(agentCtx, presetId)
      agentCtx.systemPrompt.section({
        name: 'plugin:dsh-imagegen:canvas-skill',
        order: SECTION_ORDER,
        text: options.systemPrompt,
      })
    },
  })
  const agent = handle.agent
  return {
    session: agent.session,
    followup: body => {
      agent.followup({
        id: `canvas-skill-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: 'plugin:dsh-imagegen' },
      })
    },
    whenIdle: async () => {
      await agent.whenIdle()
      if (runtimeFailure !== undefined) throw new Error(runtimeFailure)
    },
    // The canvas cancel button is the human asking to stop.
    cancel: () => agent.cancel({ kind: 'user' }),
    dispose: () => handle.dispose(),
  }
}

/**
 * Wrap the host skill registry for the canvas runner: only model-invocable
 * skills are offered (the canvas runs every skill through a model, so a
 * user-only slash-command skill would fail halfway), and the summary is
 * narrowed to the fields the tier heuristic reads.
 *
 * The registry alone is not enough on the Web surface. There, a preset owns
 * local discovery: `skill-filesystem` mounts into the *preset's* layer while
 * this plugin is a host-plane bundle, and an unscoped `ctx.skills.list()` reads
 * the global layer alone (the base host row is disabled — see
 * `dsh-web-app/cordis.patch.yml`). Every skill the user installs into
 * `~/.dsh/skills` would therefore be invisible to the canvas, even though the
 * skill library panel lists it. So the local library is read straight from disk
 * as a second source, and both `list` and `get` consult it — the disk source is
 * also what makes a heavy run's body load without the agent's own scope.
 *
 * The canvas is one host surface shared by every session, so it deliberately
 * offers the union: registry entries win a name collision (a deployment-level
 * provider outranks a user install), and the local scan fills the rest.
 * @param skills - the injected `ctx.skills` service.
 * @param options - `root` resolves the local skill library root; omitted (as in
 *   narrow harnesses) leaves only the registry source.
 * @returns the runner's registry seam.
 */
export function createSkillRegistryBackend(
  skills: CanvasSkillServices['skills'],
  options: { root?: () => string } = {},
): SkillRegistryBackend {
  const localRoot = (): string | undefined => options.root?.()
  const localSkills = async (): Promise<LocalSkill[]> => {
    const root = localRoot()
    if (root === undefined) return []
    return await listLocalSkills(root).catch(() => [])
  }
  return {
    list: async () => {
      const listed = await skills.list()
      const merged = new Map<string, ExternalSkillSummary>()
      for (const skill of await localSkills()) {
        merged.set(skill.name, {
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          path: skill.path,
          source: 'filesystem',
        })
      }
      for (const summary of listed) {
        if (summary.invocation?.modelInvocable === false) continue
        merged.set(summary.name, {
          name: summary.name,
          description: summary.description,
          ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
          ...summary.path === undefined ? {} : { path: summary.path },
          ...summary.metadata === undefined ? {} : { metadata: summary.metadata },
        })
      }
      return [...merged.values()]
    },
    get: async name => {
      const definition = await skills.get(name)
      if (definition !== undefined) {
        return {
          name: definition.name,
          content: definition.content,
          ...definition.metadata === undefined ? {} : { metadata: definition.metadata },
        }
      }
      const root = localRoot()
      const local = root === undefined ? undefined : await readLocalSkill(root, name).catch(() => undefined)
      return local === undefined ? undefined : { name: local.name, content: local.content }
    },
  }
}

import { ImageGenerationRuntime, type ChannelsView, type HostChatSeam, type RuntimeChannel, type VideoDirectorSeam } from './generation-runtime.ts'
import { createHostChatSeam, type HostAgentPresets, type HostAgentsService, type HostDefaultModel } from './host-chat.ts'
import { registerAgentCanvasTools } from './agent-canvas-tools.ts'
import { registerMediaModelsTool } from './agent-media-models-tool.ts'
import { registerAgentVideoTools } from './agent-video-tools.ts'
import { registerEditImageCommand } from './edit-image-command.ts'
import { setImageDataRoot, imageDataRoot } from './image-storage-path.ts'
import type { ChatOptions, ChatTarget } from './prompt-enhancer.ts'
import { SkillRunner, setSkillTranslate, canvasSkillCopy, type SkillAgentBackend, type SkillAgentHandle, type SkillCanvasBackend, type SkillChatBackend, type SkillRegistryBackend } from './skill-runner.ts'
import { installFromArchive, installFromUrl, knownSkillUrl, listLibrary, listLocalSkills, readLocalSkill, removeSkill, SkillStoreError, skillsRoot, type LocalSkill, type LocalSkillIssue } from './skill-store.ts'
import { applySkillConfigSteps, asConfigDict, configNote, configView, missingFields, parseSkillConfigManifest, readSkillConfigFile, skillConfigKey, valuesFor, type SkillConfigDeclaration, type SkillConfigIssue, type SkillConfigStore } from './skill-config.ts'
import { recipeFor } from './skill-config-recipes.ts'
import { createClipComposer } from './clip-compose.ts'
import { PptRuntime } from './ppt-runtime.ts'
import { EDITABLE_PPT_SKILL, type ExternalSkillSummary } from './skills-catalog.ts'
import { recordDiagnostic, redactDiagnosticText } from './diagnostics-store.ts'
import { canvasStore } from './canvas-store.ts'
import { imageGenLanguageOf, interpolate } from './locale-tables.ts'

/** Stable cordis plugin name. */
export const name = 'imagegen'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt', 'commands']

// Internals re-exported for smoke tests and host-side debugging; the plugin
// contract only requires name / inject / Config / apply.
export { makeRoutes } from './routes.ts'
export { generateImage, ImageGenError } from './engine.ts'
export { generateVideo, VideoGenError, isVideoModel } from './video-engine.ts'
export { describeVideoModel, durationsOf, normalizeVideoResolution, parseVideoResolution, resolutionRank, resolveVideoModelId, videoDurationsFor, VIDEO_RESOLUTIONS } from './video-model-catalog.ts'
export { applyPlan, hasMotion, looksChinese, MAX_PLANNED_PROMPT_CHARS, MAX_PROMPT_CHARS, parsePlanAnswer, planVideo, planVideoLocally, requirePrompt, VideoPlanError, type ChatCompleter, type VideoPlan, type VideoPlanInput } from './video-director.ts'
export { appendVideoHistory, backfillVideoPosters, clearVideoHistory, listVideoHistory, readVideoFile, removeVideoHistory, VIDEO_HISTORY_MAX } from './video-store.ts'
export { VideoTaskQueue } from './video-task-queue.ts'
export { promptCharLimit } from './model-catalog.ts'
export { generateListingCopy, listingTitleLimit } from './listing-copy.ts'
export { analyzeLayers, normalizeLayerPlan, MAX_LAYER_IMAGE_BYTES } from './layer-analyzer.ts'
export { ImageGenerationRuntime, type HostChatSeam, type VideoDirectorSeam } from './generation-runtime.ts'
export { createHostChatSeam } from './host-chat.ts'
export { enhancePrompt, polishPrompt, stripReasoning, type ChatPart, type ChatTarget, type HostChatClient } from './prompt-enhancer.ts'
export { runCodeRender, codeRenderPlan, probeCodeRender, validateCodeInput, type CodeRenderInput, type CodeRenderOutcome, type CodeChatCompleter } from './code-render-runtime.ts'
export { renderCode, dimensionsFor, locateFfmpeg, extractRenderSource, looksLikeCode, CodeRenderError, MAX_CODE_CHARS, DEFAULT_RENDER_TIMEOUT_MS, type CodeRenderKind, type CodeRenderRequest, type CodeRenderResult } from './code-render.ts'
export { codeRenderSystemPrompt, codeRenderUserPrompt, readGeneratedCode, fallbackRendererSource, type CodeBrief, type CodeTarget } from './code-prompt.ts'
export { registerAgentCanvasTools } from './agent-canvas-tools.ts'
export { resolveAgentImageModel } from './agent-image-tools.ts'
export { mediaModelsListing, MEDIA_MODELS_RESULT_LIMIT, registerMediaModelsTool } from './agent-media-models-tool.ts'
export { registerAgentVideoTools, resolveAgentVideoModel, AGENT_VIDEO_TOOL_NAMES } from './agent-video-tools.ts'
export { latestSessionImage, registerEditImageCommand } from './edit-image-command.ts'
export { PptTaskStore } from './ppt-task-store.ts'
export { pptActivity, PptProgressMonitor } from './ppt-progress.ts'
export { appendGallery, appendGalleryVideo, clearGallery, GALLERY_TRASH_RETENTION_MS, listGallery, listGalleryTrash, purgeGallery, readGalleryImage, readGalleryVideo, removeGallery, restoreGallery, updateGalleryTags } from './gallery-store.ts'
export { listTemplates, readTemplateImage, refreshTemplates, sampleTemplates, syncAllTemplates, clearTemplateMemo } from './templates-store.ts'
export { addTemplateFavorite, clearTemplateFavoritesMemo, listTemplateFavorites, removeTemplateFavorite } from './template-favorites.ts'
export { agentSessionFailure, SkillRunner, setSkillTranslate, setSkillLanguage, canvasSkillCopy } from './skill-runner.ts'
export { builtinCanvasSkills, canvasSkillCatalog, EDITABLE_PPT_SKILL, findCanvasSkill, isEditablePptSkill, mergeExternalSkills, tierOfExternalSkill } from './skills-catalog.ts'
export { extractFileText, MAX_EXTRACTED_CHARS } from './file-text.ts'
export { buildFilePreview, MAX_PREVIEW_CHARS, type FilePreviewInput } from './file-preview.ts'
export { classifySource, inspectSkillMarkdown, installableSkillName, installFromArchive, installFromUrl, isDshSkillName, isValidSkillName, KNOWN_SKILL_SOURCES, knownSkillUrl, listLibrary, listLocalSkills, parseSkillFrontmatter, readLocalSkill, removeSkill, SkillStoreError, skillsRoot, MAX_SKILL_ARCHIVE_BYTES, type LocalSkill, type LocalSkillIssue } from './skill-store.ts'
export { applySkillConfigSteps, configNote, configView, missingFields, parseSkillConfigManifest, readSkillConfigFile, resolveConfigTarget, skillConfigKey, valuesFor, type SkillConfigDeclaration, type SkillConfigIssue, type SkillConfigStore } from './skill-config.ts'
export { recipeFor, recipeNames } from './skill-config-recipes.ts'
export { createClipComposer, findTool, localVideoToolDirs } from './clip-compose.ts'
export { isZipDirectory, readZipDirectory, readZipEntry } from './zip.ts'
export { canvasStore, isBlockedFileName, fileKindOf, MAX_CANVAS_FILE_BYTES, mimeFromFileName, safeFileName } from './canvas-store.ts'
export { ProposalStore, proposalStore } from './canvas-proposal-store.ts'
export { bodyShapeOf, clearDiagnostics, diagnoseNonJsonBody, listDiagnostics, networkErrorFields, redactDiagnosticText, recordDiagnostic, requestAddress, DIAGNOSTIC_MAX, type DiagnosticEntry } from './diagnostics-store.ts'

/** The branded settings namespace of this plugin (the card edits it). */
export const ImageGenSettingsNamespace = settingsNamespaceCompat(IMAGEGEN_SETTINGS_NAMESPACE)

/**
 * Plugin config, validated by the same-named schemastery schema.
 *
 * Everything the deployment itself owns — the gateway endpoint, its model
 * catalog and the credential that authenticates it — comes from the host's
 * gateway catalog, not from this document. The fields below that once carried
 * those values stay DECLARED so an older settings document still parses; the
 * deprecated ones are read by nothing and their secrets are cleared by the
 * migration in `apply`.
 */
export interface Config {
  /** Master switch for the plugin (routes, prompt section). */
  enabled?: boolean
  /** Announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Allow Agents to submit and retrieve image-generation tasks. */
  allowAgentImageGeneration?: boolean
  /**
   * @deprecated Channels come from the host gateway catalog. Kept so an older
   * settings document still parses; the value is never read.
   */
  channels?: ChannelConfig[]
  /**
   * @deprecated The gateway credential lives in the host credential service.
   * Kept so an older settings document still parses; the migration empties it.
   */
  channelSecrets?: Record<string, string>
  /**
   * @deprecated The single gateway channel is the only channel. Kept so an
   * older settings document still parses; the value is never read.
   */
  defaultChannelId?: string
  /** Model alias selected by default for GUI, canvas and Agent generation. Empty uses the gateway's default. */
  defaultModel?: string
  /**
   * @deprecated Prompt editing runs on the host conversation model. Kept so an
   * older settings document still parses; the value is never read.
   */
  promptApiUrl?: string
  /**
   * @deprecated Prompt editing runs on the host conversation model. Kept so an
   * older settings document still parses; the migration empties it.
   */
  promptApiKey?: string
  /**
   * @deprecated Prompt editing runs on the host conversation model. Kept so an
   * older settings document still parses; the value is never read.
   */
  promptModel?: string
  /** Model alias selected by default for video generation. Empty uses the gateway's default. */
  defaultVideoModel?: string
  /** Allow Agents to submit and retrieve video-generation tasks. */
  allowAgentVideoGeneration?: boolean
  /** Local root for generated/history/gallery/canvas images. Empty keeps the default under DSH_HOME. */
  localStoragePath?: string
  /** @deprecated Object-storage sync was removed. Kept so an older settings document still parses. */
  storageEnabled?: boolean
  /** @deprecated Object-storage sync was removed. Kept so an older settings document still parses. */
  storageEndpoint?: string
  /** @deprecated Object-storage sync was removed. Kept so an older settings document still parses. */
  storageRegion?: string
  /** @deprecated Object-storage sync was removed. Kept so an older settings document still parses. */
  storagePrefix?: string
  /** @deprecated Object-storage sync was removed. Kept so an older settings document still parses. */
  storageAccessKey?: string
  /** @deprecated Object-storage sync was removed; the migration empties this secret. */
  storageSecretKey?: string
  /** @deprecated Object-storage sync was removed. Kept so an older settings document still parses. */
  storageSyncGallery?: boolean
  /** @deprecated Object-storage sync was removed. Kept so an older settings document still parses. */
  storageSyncHistory?: boolean
  /* ------------------------- infinite-canvas skills ------------------------- */
  /** Master switch for canvas skills (menu, runs, produced nodes). */
  skillsEnabled?: boolean
  /** Allow heavy skills, which run a headless DSH agent (slow, token-hungry). */
  allowHeavySkills?: boolean
  /** External-skill allowlist (comma/newline separated; empty = all installed). */
  skillAllowlist?: string
  /** Working directory for heavy skill runs; empty uses `<data>/canvas/runs`. */
  skillOutputDir?: string
  /** Heavy-skill timeout in minutes (0 disables the timeout). */
  skillHeavyTimeoutMinutes?: number
  /** Headless-agent preset used for heavy runs; empty uses the host default. */
  skillAgentPreset?: string
  /* --------------------------- skill configuration -------------------------- */
  /**
   * Per-skill configuration values declared by `skill.config.json`, keyed
   * `<skill>/<field>` (see `docs/skill-config.md`). Non-secret values only; the
   * secret half lives in `skillConfigSecrets`.
   */
  skillConfig?: Record<string, string>
  /** Secret half of the skill configuration, stored redacted. */
  skillConfigSecrets?: Record<string, string>
  /* ----- deprecated legacy single-endpoint fields (no longer read) ----- */
  /** @deprecated The gateway endpoint comes from the host catalog. */
  apiUrl?: string
  /** @deprecated The gateway credential lives in the host credential service; the migration empties this secret. */
  apiKey?: string
  /** @deprecated Model catalogs come from the host catalog. Kept so an older settings document still parses. */
  imageModels?: string[]
}

const configSchema = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
  allowAgentImageGeneration: z.boolean().default(true).volatile(),
  channels: z.array(z.object({
    id: z.string(),
    preset: z.string().default(''),
    name: z.string().default(''),
    apiUrl: z.string().default(''),
    apiUrlFull: z.boolean().default(false),
    /** @deprecated 该协议族已移除。保留声明只为旧文档照旧解析。 */
    watermark: z.boolean().default(true),
    /** @deprecated 适配器参考图上限：族已移除。保留声明只为旧文档照旧解析。 */
    autoReferenceLimit: z.boolean().default(true),
    /**
     * 传输协议。旧的 `google-native` / `qwen-draw` 也留在联合里：它们解析得出，
     * 但归一化时会被丢掉，退回 `auto`（OpenAI 兼容 images）。
     */
    protocol: z.union([z.const('auto'), z.const('images'), z.const('chat-completions'), z.const('google-native'), z.const('qwen-draw')]).default('auto'),
    /** @deprecated 订阅账号已移除。保留声明只为旧文档照旧解析。 */
    auth: z.union([z.const('api-key'), z.const('subscription')]).default('api-key'),
    /** @deprecated 订阅账号已移除。保留声明只为旧文档照旧解析。 */
    subscription: z.string().default(''),
    models: z.array(z.object({
      alias: z.string(),
      id: z.string(),
    })).default([]),
    /** Video model catalog (alias → upstream id). Appended after `models` so
     *  existing channels keep parsing unchanged: an absent list is empty. */
    videoModels: z.array(z.object({
      alias: z.string(),
      id: z.string(),
    })).default([]),
  })).default([]).volatile(),
  /** @deprecated 旧版按渠道存的密钥；迁移会把它清空。保留声明只为旧文档照旧解析。 */
  channelSecrets: z.dict(z.string().role('secret')).default({}).volatile(),
  /** @deprecated 渠道只来自宿主目录。保留声明只为旧文档照旧解析。 */
  defaultChannelId: z.string().default('').volatile(),
  defaultModel: z.string().default('').volatile(),
  defaultVideoModel: z.string().default('').volatile(),
  allowAgentVideoGeneration: z.boolean().default(true).volatile(),
  /** @deprecated 提示词增强走宿主对话模型。保留声明只为旧文档照旧解析。 */
  promptApiUrl: z.string().default('').volatile(),
  /** @deprecated 提示词增强走宿主对话模型；迁移会把它清空。 */
  promptApiKey: z.string().role('secret').default('').volatile(),
  /** @deprecated 提示词增强走宿主对话模型。保留声明只为旧文档照旧解析。 */
  promptModel: z.string().default('').volatile(),
  localStoragePath: z.string().default('').volatile(),
  /** @deprecated 对象存储同步已移除。保留声明只为旧文档照旧解析。 */
  storageEnabled: z.boolean().default(false).volatile(),
  storageEndpoint: z.string().default('').volatile(),
  storageRegion: z.string().default('').volatile(),
  storagePrefix: z.string().default('dsh-imagegen').volatile(),
  storageAccessKey: z.string().default('').volatile(),
  /** @deprecated 对象存储同步已移除；迁移会把它清空。 */
  storageSecretKey: z.string().role('secret').default('').volatile(),
  storageSyncGallery: z.boolean().default(true).volatile(),
  storageSyncHistory: z.boolean().default(false).volatile(),
  skillsEnabled: z.boolean().default(true).volatile(),
  allowHeavySkills: z.boolean().default(false).volatile(),
  skillAllowlist: z.string().default('').volatile(),
  skillOutputDir: z.string().default('').volatile(),
  skillHeavyTimeoutMinutes: z.number().default(20).volatile(),
  skillAgentPreset: z.string().default('').volatile(),
  skillConfig: z.dict(z.string()).default({}).volatile(),
  skillConfigSecrets: z.dict(z.string().role('secret')).default({}).volatile(),
  /** @deprecated 端点来自宿主目录。保留声明只为旧文档照旧解析。 */
  apiUrl: z.string().default('').volatile(),
  /** @deprecated 密钥由宿主凭据服务持有；迁移会把它清空。 */
  apiKey: z.string().role('secret').default('').volatile(),
  /** @deprecated 模型目录来自宿主目录。保留声明只为旧文档照旧解析。 */
  imageModels: z.array(z.string()).default([]).volatile(),
})

// The public schema type stays the plain Config shape for plugin consumers;
// the loader resolves these top-level fields to Volatile references.
export const Config: z<Config> = configSchema as unknown as z<Config>

/** One live config field exposed by schemastery's volatile resolver. */
interface VolatileValue<T> {
  get: () => T
}

/** Read a value that may be a volatile config reference. */
function unwrapVolatileValue<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileValue<T>).get()
  }
  return value as T
}

/** Detach the plain Config view from the loader's top-level volatile fields. */
function unwrapConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out as Config
}

/** Schema defaults, re-read for hand-built contexts (the loader applies them normally). */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true
const DEFAULT_ALLOW_AGENT_IMAGE_GENERATION = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, and limits. */
/**
 * 给 Agent 的静态说明。
 *
 * 这段文字**不随目录变化**：每个账号、每次目录刷新都重写一次系统提示会打掉提供方的提示
 * 缓存，也让同一份产品在不同账号下长得不一样。模型清单、玩法与参数因此在
 * `list_media_models` 里，按需读取。
 */
export const IMAGEGEN_GUIDANCE = '本机有「创作」工作台（侧栏「创作」，可看历史与无限画布）。用户要用模板、批量出图或在画布上编排时，引导用户到「创作」里操作。生视频用 generate_video，不传 model 用默认模型；可用模型、玩法与参数见 list_media_models。视频渲染需要数分钟，提交后不要反复轮询。失败原因以工具结果为准，不要编造模型名。'


/** Normalize raw channel entries into the wire shape (schema-adjacent guard). */
function normalizeChannels(value: unknown): ChannelConfig[] {
  if (!Array.isArray(value)) return []
  const out: ChannelConfig[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') continue
    const models: ModelMapping[] = []
    if (Array.isArray(raw.models)) {
      for (const entry of raw.models) {
        if (entry === null || typeof entry !== 'object') continue
        const record = entry as Record<string, unknown>
        const alias = typeof record.alias === 'string' ? record.alias.trim() : ''
        const upstream = typeof record.id === 'string' ? record.id.trim() : ''
        if (alias === '') continue
        models.push({ alias, id: upstream === '' ? alias : upstream })
      }
    }
    const videoModels: ModelMapping[] = []
    if (Array.isArray(raw.videoModels)) {
      for (const entry of raw.videoModels) {
        if (entry === null || typeof entry !== 'object') continue
        const record = entry as Record<string, unknown>
        const alias = typeof record.alias === 'string' ? record.alias.trim() : ''
        const upstream = typeof record.id === 'string' ? record.id.trim() : ''
        if (alias === '') continue
        videoModels.push({ alias, id: upstream === '' ? alias : upstream })
      }
    }
    out.push({
      id,
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl.trim() : '',
      apiUrlFull: raw.apiUrlFull === true,
      ...isChannelProtocolPreference(raw.protocol) ? { protocol: raw.protocol } : {},
      models,
      videoModels,
    })
  }
  return out
}

/** Effective config (schema defaults applied). */
export interface EffectiveConfig {
  enabled: boolean
  announceToAgent: boolean
  allowAgentImageGeneration: boolean
  channels: RuntimeChannel[]
  defaultChannelId: string
  defaultModel: string
  /** Model alias used when a video request does not name one. */
  defaultVideoModel: string
  /** Allow Agents to submit and retrieve video-generation tasks. */
  allowAgentVideoGeneration: boolean
  /** Infinite-canvas skill settings. */
  skills: {
    enabled: boolean
    allowHeavy: boolean
    allowlist: string[]
    outputDir: string
    heavyTimeoutMs: number
    agentPreset: string
  }
  /** Per-skill configuration values, secrets included (host side only). */
  skillConfig: SkillConfigStore
}

/** 旧版本按渠道存的明文密钥字典。 */
const LEGACY_SECRET_DICTS = ['channelSecrets'] as const

/** 旧版本按单值存的明文密钥。 */
const LEGACY_SECRET_TEXTS = ['apiKey', 'promptApiKey', 'storageSecretKey'] as const

/**
 * Clear the plaintext secrets an older release wrote into this plugin's
 * settings document.
 *
 * 第三方渠道、订阅账号、插件自有提示词端点和对象存储在合并进部署时全部移除，
 * 旧文档里那些密钥不该继续以明文留在磁盘上。迁移只做减法：字典置空、字符串置空，
 * 其余字段一律不碰，所以老文档照旧解析。
 *
 * Idempotency is part of the contract, not a nicety: a pass over an already
 * clean document issues no write at all, so the host importing a settings file
 * twice costs nothing and never loops through its own update event.
 * @param seam - the settings read/write seam.
 * @param namespace - this plugin's settings namespace.
 * @returns whether the document changed (false = nothing to clear).
 */
export async function clearLegacySecrets(seam: SettingsSeam, namespace: string): Promise<boolean> {
  const descriptor = seam.describe({ redactSecrets: false })
    .find(candidate => String(candidate.ns) === namespace)
  const value = descriptor?.value
  if (descriptor === undefined || value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const ops: Array<Record<string, unknown>> = []
  for (const field of LEGACY_SECRET_DICTS) {
    const dict = record[field]
    if (dict !== null && typeof dict === 'object' && Object.keys(dict).length > 0) {
      ops.push({ op: 'set', path: [field], value: {} })
    }
  }
  for (const field of LEGACY_SECRET_TEXTS) {
    const text = record[field]
    if (typeof text === 'string' && text.trim() !== '') {
      ops.push({ op: 'set', path: [field], value: '' })
    }
  }
  if (ops.length === 0) return false
  await seam.mutate(namespace, ops)
  return true
}

/**
 * Mount the settings section, routes, and announcement.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): (() => void) | void {
  const mounts = new Map<Feature, (ctx: Context) => void>()
  // The live source the surfaces read: the settings section once the settings
  // service is attached, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  /**
   * 网关凭据：账号凭据随登录变化，缓存只服务于同步读取（resolve() 是同步的），
   * 每次提交由 `resolveApiKey` 重新解析——凭据服务的约定是不跨操作缓存。
   */
  let gatewayKey = ''
  const gatewayHost = (): GatewayCatalogHost | undefined => ctx.get('suanliModels') as GatewayCatalogHost | undefined
  const gatewayEndpoint = (): GatewayEndpoint | undefined => {
    const endpoint = gatewayHost()?.endpoint()
    return endpoint !== undefined && isCredentialRefName(endpoint.credential) ? endpoint : undefined
  }
  /** 供 Agent 工具读取的目录快照（插件视角，含 not-configured）。 */
  const gatewaySnapshotValue = (): PluginSnapshot => pluginSnapshotOf(gatewayHost())

  const reloadGatewayKey = async (): Promise<string> => {
    const endpoint = gatewayEndpoint()
    if (endpoint === undefined) {
      gatewayKey = ''
      return ''
    }
    const credentials = ctx.get('credentials') as GatewayCredentialsHost | undefined
    gatewayKey = (await credentials?.resolve(endpoint.credential))?.value ?? ''
    return gatewayKey
  }
  void reloadGatewayKey().catch(() => { gatewayKey = '' })
  ctx.effect(() => ctx.on('credentials/reference-updated', (ref: string) => {
    if (ref !== gatewayEndpoint()?.credential) return
    void reloadGatewayKey().catch(() => undefined)
  }), 'dsh-imagegen: gateway credential')

  const resolve = (): EffectiveConfig => {
    const value = unwrapConfig(current())
    setImageDataRoot(value.localStoragePath)
    // 渠道只有一个来源：宿主的网关能力清单。地址按宿主的 origin 拼，模型与玩法由
    // 目录决定，密钥在提交时按凭据名现取——插件不再有自己的渠道、预设或密钥配置。
    const snapshot = pluginSnapshotOf(gatewayHost())
    const endpoint = gatewayEndpoint()
    const gateway = endpoint === undefined ? undefined : gatewayChannel({ entries: snapshot.entries, baseURL: endpoint.baseURL })
    const channels = gateway === undefined ? [] : [{ ...gateway, apiKey: gatewayKey, resolveApiKey: () => reloadGatewayKey() }]
    const defaultChannelId = gateway?.id ?? ''
    const imageEntries = entriesOfKind(snapshot.entries, 'images')
    const videoEntries = entriesOfKind(snapshot.entries, 'videos_task')
    const defaultModel = selectDefaultAlias(imageEntries, typeof value.defaultModel === 'string' ? value.defaultModel.trim() : '')
    // 视频默认模型与图像分开比较：一个过期的 defaultVideoModel 不能漏到图像路径上。
    const defaultVideoModel = selectDefaultAlias(videoEntries, typeof value.defaultVideoModel === 'string' ? value.defaultVideoModel.trim() : '')
    return {
      enabled: value.enabled ?? DEFAULT_ENABLED,
      announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
      allowAgentImageGeneration: value.allowAgentImageGeneration ?? DEFAULT_ALLOW_AGENT_IMAGE_GENERATION,
      allowAgentVideoGeneration: value.allowAgentVideoGeneration ?? true,
      channels,
      defaultChannelId,
      defaultModel,
      defaultVideoModel,
      skills: {
        enabled: value.skillsEnabled ?? true,
        allowHeavy: value.allowHeavySkills ?? false,
        allowlist: (value.skillAllowlist ?? '')
          .split(/[\n,]/)
          .map(item => item.trim())
          .filter(item => item !== ''),
        outputDir: typeof value.skillOutputDir === 'string' ? value.skillOutputDir.trim() : '',
        heavyTimeoutMs: Math.max(0, Math.round((value.skillHeavyTimeoutMinutes ?? 20) * 60_000)),
        agentPreset: typeof value.skillAgentPreset === 'string' ? value.skillAgentPreset.trim() : '',
      },
      skillConfig: {
        values: asConfigDict(value.skillConfig),
        secrets: asConfigDict(value.skillConfigSecrets),
      },
    }
  }

  // Transient helper used by several mount points below: resolve the shared
  // channel view once per access; the runtime then picks per-request creds.
  const channelsView = (): ChannelsView => {
    const value = resolve()
    return { channels: value.channels, defaultChannelId: value.defaultChannelId }
  }

  // Browser endpoints and Agent tools share the exact same serial queue. This
  // keeps image persistence, cancellation, and retries coherent across both
  // entry points; Agent tools wait for their task result by default and render
  // images in the tool result instead of injecting a synthetic user message.
  // The video director plans with the deployment's own conversation model, the
  // same one the code path and the canvas light skills use — there is no second
  // credential to configure, and no plugin-owned chat endpoint at all.
  //
  // The host conversation model is reached through its `agents` service, which
  // this plugin only sees inside the injection block below; the runtime is
  // built before that. A holder keeps the wiring order honest: the seam the
  // runtime holds asks this holder per call instead of capturing a snapshot.
  let hostServices: { agents?: HostAgentsService; presets?: HostAgentPresets; defaultModel?: HostDefaultModel } | undefined
  let saveImageService: ((input: SaveImageAttachment) => Promise<ImageAttachmentRef>) | undefined
  const hostChatService = (): HostChatSeam => createHostChatSeam({
    ...hostServices === undefined ? {} : hostServices,
    ...saveImageService === undefined ? {} : { saveImage: async input => await saveImageService!(input) },
    cwd: () => process.cwd(),
    preset: () => resolveSkills().agentPreset,
  })

  const runtime = new ImageGenerationRuntime(channelsView, undefined, {
    resolveConfig: (): ChatTarget => ({ model: hostChatService().label() }),
    complete: async (options: ChatOptions) => await hostChatService().complete(options),
  } satisfies VideoDirectorSeam, {
    // The host's own conversation model, resolved lazily: `agents` mounts in
    // the injection block below, AFTER this runtime is built, and the selected
    // model can change at any time.
    available: () => hostChatService().available(),
    label: () => hostChatService().label(),
    complete: async options => await hostChatService().complete(options),
  })
  const pendingConversationImages = new Map<string, ImageAttachmentRef>()

  // Host-rendered copy (skill catalog labels, run errors, produced node titles)
  // resolves through the same dictionaries the browser bundle ships, so a run
  // started in Chinese never answers in English.
  setSkillTranslate((key, params, language) => interpolate(key, params, imageGenLanguageOf(language)))

  // The canvas skill runner is assembled lazily: its chat tier needs only the
  // prompt-enhancement endpoint (always available), while the heavy tier needs
  // the host agent runtime. `setSkillRuntime` is called from the soft injection
  // below, and routes read it per request — so a deployment without the agent
  // runtime still gets the built-in light actions.
  let skillRunner: SkillRunner | undefined
  // The isolated editppt environment lives under the data root, so a reinstall
  // or a data-folder move is picked up without restarting the host.
  const pptRuntime = new PptRuntime(
    () => imageDataRoot(),
    async () => {
      const definition = await skillRunner?.skillDefinition(EDITABLE_PPT_SKILL)
      return definition?.path
    },
  )
  const resolveSkills = (): EffectiveConfig['skills'] => resolve().skills
  skillRunner = new SkillRunner({
    backend: {
      canvas: canvasStore as unknown as SkillCanvasBackend,
      // The light tier asks the deployment's own conversation model. Image
      // parts ride the same turn as attachment-backed content blocks.
      chat: {
        complete: async options => await hostChatService().complete(options),
      },
    },
    enabled: () => resolve().enabled && resolveSkills().enabled,
    heavyEnabled: () => resolveSkills().allowHeavy,
    allowlist: () => resolveSkills().allowlist,
    runRoot: () => resolveSkills().outputDir,
    heavyTimeoutMs: () => resolveSkills().heavyTimeoutMs,
    dataRoot: () => imageDataRoot(),
    pptInstallUrl: knownSkillUrl(EDITABLE_PPT_SKILL),
    // The deck pipeline runs an installed CLI, so the runner has to know which
    // executable this host prepared rather than assuming one on PATH.
    pptCommand: () => pptRuntime.command(),
    // The local (ffmpeg) tier: stitching clips happens entirely on this machine,
    // so the runner gets a seam instead of importing the video store itself.
    // `createClipComposer()` only resolves/memoizes the tool paths on first use,
    // so a host without ffmpeg still runs everything else.
    composer: createClipComposer(),
  })

  // ---------------------------------------------------------- skill config
  //
  // A skill may declare the settings it needs in `skill.config.json` beside its
  // `SKILL.md` (see docs/skill-config.md). The plugin renders that declaration,
  // stores the values in its own settings namespace, and runs the declared
  // `apply` steps on request. Known skills that ship no declaration are covered
  // by a built-in recipe; everything else keeps its own conventions.

  /** Settings write path, installed by the settings injection further down. */
  let mutateSettings: ((ops: Array<Record<string, unknown>>) => Promise<void>) | undefined
  /** Settings read/write seam, installed by the same injection. */
  let settingsSeam: SettingsSeam | undefined
  let settingsNamespace = IMAGEGEN_SETTINGS_NAMESPACE

  /**
   * Run the legacy-secret migration once.
   *
   * Called when the plugin applies and again after the host imports a settings
   * document (the import replaces the whole section, so a document written by an
   * older release re-introduces secrets that the first pass already cleared).
   * Only a pass that actually wrote something records a diagnostics line, so a
   * clean document leaves no trace and no noise.
   */
  const migrateLegacySecrets = async (): Promise<void> => {
    const seam = settingsSeam
    if (seam === undefined) return
    const changed = await clearLegacySecrets(seam, String(settingsNamespace))
    if (!changed) return
    recordDiagnostic({
      phase: 'config',
      channel: '',
      model: '',
      mode: '',
      url: '',
      method: '',
      failureCode: 'legacy-secrets-cleared',
      message: '已移除旧版第三方渠道配置',
      durationMs: 0,
      hadAuth: false,
    })
  }

  /** Entry paths the last library listing resolved, so lookups agree with it. */
  const entryPathByName = new Map<string, string>()

  /** Localize one ignored-declaration reason for the panel. */
  const configIssueText = (language?: string) => (issue: SkillConfigIssue): string => {
    const t = canvasSkillCopy(language)
    switch (issue) {
      case 'unsupported-version': return t('canvas.skills.configIssueVersion')
      case 'empty': return t('canvas.skills.configIssueEmpty')
      default: return t('canvas.skills.configIssueUnreadable')
    }
  }

  /** Resolve one skill's values from the live settings dictionaries. */
  const skillValues = (name: string, declaration: SkillConfigDeclaration): Map<string, string> =>
    valuesFor(declaration, resolve().skillConfig, name)

  /**
   * The library entry path for one skill: the last listing's answer when it has
   * one, else a direct disk read — so a config lookup and the panel agree.
   */
  const entryPathFor = async (name: string): Promise<string | undefined> => {
    const known = entryPathByName.get(name)
    if (known !== undefined) return known
    return (await readLocalSkill(skillsRoot(), name).catch(() => undefined))?.path
  }

  /** Look up a declaration by skill name, reading its path from disk. */
  const declarationByName = async (name: string): Promise<{ declaration?: SkillConfigDeclaration; issue?: SkillConfigIssue }> => {
    const entryPath = await entryPathFor(name)
    return await readCanvasSkillConfig({
      name,
      ...entryPath === undefined ? {} : { entryPath },
      root: skillsRoot(),
      store: resolve().skillConfig,
    })
  }

  /** The directory a `command` step runs in by default (created on demand). */
  const configRunRoot = (name: string): string => {
    const configured = resolveSkills().outputDir.trim()
    const root = configured === '' ? path.join(imageDataRoot(), 'canvas', 'runs') : configured
    return path.join(root, 'skill-config', name)
  }

  // Local skill library (`~/.dsh/skills`): the canvas installs skills the same
  // way a user would by hand, and both the filesystem skill provider (through
  // its watcher) and the canvas catalog below read the same directory — so an
  // install needs no host restart and never stays invisible to node skills.
  let skillRegistryNames: ReadonlyArray<{ name: string; path?: string }> | undefined
  /** One entry's "why the node menu cannot offer this" line, in caller copy. */
  const issueText = (language?: string) => (issue: LocalSkillIssue, name: string): string => {
    const t = canvasSkillCopy(language)
    switch (issue) {
      case 'no-frontmatter': return t('canvas.skills.libraryIssueFrontmatter')
      case 'bad-name': return t('canvas.skills.libraryIssueName', { name })
      case 'no-description': return t('canvas.skills.libraryIssueDescription')
      case 'bad-invocation': return t('canvas.skills.libraryIssueInvocation')
      default: return t('canvas.skills.libraryIssueUserOnly')
    }
  }
  const snapshotLibrary = async (language?: string): Promise<CanvasSkillLibrary> => {
    const library = await listLibrary({
      root: skillsRoot(),
      ...skillRegistryNames === undefined ? {} : { known: skillRegistryNames },
      networkAvailable: true,
      issueText: issueText(language),
    })
    const store = resolve().skillConfig
    const entries = await Promise.all(library.entries.map(async entry => {
      if (entry.path !== undefined) entryPathByName.set(entry.name, entry.path)
      const found = await readCanvasSkillConfig({
        name: entry.name,
        ...entry.path === undefined ? {} : { entryPath: entry.path },
        root: skillsRoot(),
        store,
        issueText: configIssueText(language),
      })
      return found.view === undefined ? entry : { ...entry, config: found.view }
    }))
    return { ...library, entries }
  }
  /** Merge one save request into both dictionaries and write them back. */
  const saveSkillValues = async (
    name: string,
    declaration: SkillConfigDeclaration,
    edits: ReadonlyArray<{ id: string; value: string }>,
  ): Promise<void> => {
    if (mutateSettings === undefined) throw new SkillStoreError(canvasSkillCopy()('canvas.skills.configUnwritable'))
    const store = resolve().skillConfig
    const next: SkillConfigStore = { values: { ...store.values }, secrets: { ...store.secrets } }
    const byId = new Map(declaration.manifest.fields.map(field => [field.id, field]))
    for (const edit of edits) {
      const field = byId.get(edit.id)
      if (field === undefined) continue
      const key = skillConfigKey(name, field.id)
      const dict = field.type === 'secret' ? next.secrets : next.values
      if (edit.value.trim() === '') delete dict[key]
      else dict[key] = edit.value
    }
    await mutateSettings([
      { op: 'set', path: ['skillConfig'], value: next.values },
      { op: 'set', path: ['skillConfigSecrets'], value: next.secrets },
    ])
  }
  const skillLibrary = {
    list: async (options?: { language?: string }): Promise<CanvasSkillLibrary> => await snapshotLibrary(options?.language),
    install: async (request: CanvasSkillInstallRequest): Promise<CanvasSkillInstallResult> => {
      const root = skillsRoot()
      const installed: string[] = []
      const failed: Array<{ source: string; message: string }> = []
      let message: string | undefined
      if (request.asset !== undefined) {
        try {
          const found = await canvasStore.readAssets([request.asset])
          const blob = found.get(request.asset.assetId)
          if (blob === undefined) throw new SkillStoreError('上传的压缩包已失效，请重新上传')
          installed.push(await installFromArchive(blob.data, root, request.name ?? 'skill', request.force === true))
        } catch (error) { message = messageOf(error) }
      }
      for (const source of request.sources ?? []) {
        try {
          installed.push(await installFromUrl(source, root, { force: request.force === true, fallbackName: request.name }))
        } catch (error) {
          failed.push({ source, message: messageOf(error) })
        }
      }
      return {
        ok: installed.length > 0,
        installed,
        failed,
        library: await snapshotLibrary(request.language),
        ...message === undefined ? {} : { message },
      }
    },
    remove: async (name: string, options?: { language?: string }): Promise<CanvasSkillRemoveResult> => {
      try {
        const removed = await removeSkill(name, skillsRoot())
        return { ok: true, library: await snapshotLibrary(options?.language), message: removed }
      } catch (error) {
        return { ok: false, library: await snapshotLibrary(options?.language), message: messageOf(error) }
      }
    },
    configSave: async (request: CanvasSkillConfigSaveRequest): Promise<CanvasSkillConfigSaveResult> => {
      try {
        const found = await declarationByName(request.name)
        if (found.declaration === undefined) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? 'empty'))
        await saveSkillValues(request.name, found.declaration, request.values ?? [])
        return { ok: true, library: await snapshotLibrary(request.language) }
      } catch (error) {
        return { ok: false, library: await snapshotLibrary(request.language), message: messageOf(error) }
      }
    },
    configApply: async (request: CanvasSkillConfigApplyRequest): Promise<CanvasSkillConfigApplyResult> => {
      const library = async (): Promise<CanvasSkillLibrary> => await snapshotLibrary(request.language)
      try {
        const found = await declarationByName(request.name)
        if (found.declaration === undefined) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? 'empty'))
        const values = skillValues(request.name, found.declaration)
        const runRoot = configRunRoot(request.name)
        await mkdir(runRoot, { recursive: true })
        const skillDir = bundleDirOf((await readLocalSkill(skillsRoot(), request.name).catch(() => undefined))?.path)
        const results = await applySkillConfigSteps(found.declaration, values, {
          runRoot,
          ...skillDir === undefined ? {} : { skillDir },
        })
        return {
          ok: results.every(result => result.ok),
          library: await library(),
          steps: results.map(result => ({
            kind: result.step.kind,
            detail: result.detail,
            ok: result.ok,
            ...result.output === undefined ? {} : { output: result.output },
          })),
        }
      } catch (error) {
        return { ok: false, library: await library(), steps: [], message: messageOf(error) }
      }
    },
  }

  // Attach the host skill registry and agent runtime when this deployment has
  // them. Both are optional seams: the plugin must keep working (light tier
  // included) on a host that never mounted them.
  mounts.set('skills', componentCtx => {
  componentCtx.inject(['skills', 'agents'], sctx => {
    const services = sctx as unknown as CanvasSkillServices
    // Hand the host conversation model to the code-render path. Set inside the
    // effect and cleared on unload, so a host that drops the services makes the
    // code path fall back to the prompt-enhancement endpoint rather than using
    // a stale handle.
    hostServices = {
      agents: services.agents as unknown as HostAgentsService,
      presets: sctx.get('agentPresets') as unknown as HostAgentPresets | undefined,
      defaultModel: sctx.get('agentDefaultModel') as unknown as HostDefaultModel | undefined,
    }
    const unregister = sctx.effect(() => {
      // The canvas catalog unions the host registry with the local library: on
      // the Web surface the registry alone is scope-blind here (see the adapter).
      const registry = createSkillRegistryBackend(services.skills, { root: skillsRoot })
      // The library panel prefers these paths over its own disk guess.
      void registry.list().then(
        listed => { skillRegistryNames = listed.map(item => ({ name: item.name, ...item.path === undefined ? {} : { path: item.path } })) },
        () => { skillRegistryNames = [] },
      )
      // A heavy run needs the preset roster and a model route. Both are optional
      // host services (a minimal host may mount neither), so they are read once
      // here and handed to the composition, which reports a missing model rather
      // than starting a tool-less agent that dies on its first step.
      const presets = sctx.get('agentPresets') as unknown as CanvasAgentPresets | undefined
      const defaultModel = sctx.get('agentDefaultModel') as unknown as CanvasDefaultModel | undefined
      const agents: SkillAgentBackend = {
        available: () => services.agents !== undefined,
        create: async options => await createCanvasSkillAgent({
          agents: services.agents,
          ...presets === undefined ? {} : { presets },
          ...defaultModel === undefined ? {} : { defaultModel },
          agentPreset: resolveSkills().agentPreset,
          sessionId: options.sessionId,
          cwd: options.cwd,
          systemPrompt: options.systemPrompt,
          ...options.signal === undefined ? {} : { signal: options.signal },
          fail: options.fail,
        }),
      }
      skillRunner?.attach({
        registry,
        agents,
        // Skill configuration: the catalog shows which required fields still
        // have no value, and a run carries the exposable values it declared.
        skillConfig: {
          missing: async names => {
            const out = new Map<string, string[]>()
            for (const name of names) {
              const found = await declarationByName(name)
              if (found.declaration === undefined) continue
              const missing = missingFields(found.declaration, skillValues(name, found.declaration))
              if (missing.length > 0) out.set(name, missing)
            }
            return out
          },
          note: async name => {
            const found = await declarationByName(name)
            if (found.declaration === undefined) return undefined
            return configNote(found.declaration, skillValues(name, found.declaration))
          },
        },
      })
      return () => { skillRunner?.attach({}); hostServices = undefined }
    }, 'dsh-imagegen: canvas skills')
    void unregister
  })

  })

  // The route family mounts once, gated on the settings seam (the bridge
  // serves it; without the seam there is nothing to expose). Route handlers
  // read resolve() per request, so config edits apply live. The settings
  // bridge deliberately keeps serving while the plugin is disabled — it is
  // how the user re-enables the plugin from the settings card.
  ctx.inject(['settings', 'attachments'], (sctx) => {
    const seam = sctx.get('settings') as unknown as SettingsSeam
    settingsNamespace = resolveSettingsNamespaceCompat(ctx, seam, ImageGenSettingsNamespace)
    // Skill configuration values are written through the same namespace the
    // settings card edits; the panel never crafts settings ops itself.
    mutateSettings = async ops => { await seam.mutate(settingsNamespace, ops) }
    settingsSeam = seam
    // Image parts of a host-model turn become durable attachments, so the image
    // describe / layer-split actions can hand the model a picture.
    saveImageService = sctx.attachments.saveImage === undefined
      ? undefined
      : async input => await sctx.attachments.saveImage!(input)
    // Once on apply, then once per document import: the import replaces the
    // section wholesale, so a legacy `settings.yaml` re-introduces the secrets.
    void migrateLegacySecrets().catch(() => { /* a refused write is not fatal: the next pass retries */ })
    sctx.effect(() => sctx.on('settings/document-updated', (ns) => {
      if (String(ns) !== String(settingsNamespace)) return
      void migrateLegacySecrets().catch(() => { /* see above */ })
    }), 'dsh-imagegen: legacy settings migration')
    sctx.effect(() => () => {
      settingsSeam = undefined
      saveImageService = undefined
    }, 'dsh-imagegen: settings seam')
    sctx.effect(
      () => {
        // The guard needs the address this host listens on: with a LAN bind
        // (a concrete NIC address), a browser on that address is not a loopback
        // client, and only the bind address itself can authorise its Host
        // header. The published type advertises just the two literals, so read
        // the runtime value as a plain string rather than narrowing it away.
        const bindHost = (sctx.webServer as { host?: unknown } | undefined)?.host
        // 网关目录：宿主读取、缓存并持久化能力清单，这里只把它翻成工作台要的快照。
        // 宿主没挂目录服务（Web / headless）时快照为 not-configured，两条路由照样应答。
        const gatewaySnapshot = (): GatewayCatalogSnapshot => {
          const host = sctx.get('suanliModels') as GatewayCatalogHost | undefined
          const snapshot = pluginSnapshotOf(host)
          return {
            status: snapshot.status,
            version: snapshot.version,
            fetchedAt: snapshot.fetchedAt,
            image: modelOptionsOf(entriesOfKind(snapshot.entries, 'images')),
            video: modelOptionsOf(entriesOfKind(snapshot.entries, 'videos_task')),
          }
        }
        const routes = makeRoutes({
          settings: seam,
          settingsNamespace,
          bindHost: typeof bindHost === 'string' && bindHost !== '' ? bindHost : undefined,
          resolveChannels: channelsView,
          // 按调用现取：`agents` 可能晚于这些路由挂载，用户也会随时切换对话模型。
          chat: {
            available: () => hostChatService().available(),
            label: () => hostChatService().label(),
            complete: async options => await hostChatService().complete(options),
          },
          attachments: sctx.attachments,
          pendingConversationImages,
          runtime,
          skills: skillRunner,
          pptRuntime,
          skillLibrary,
          gateway: {
            snapshot: gatewaySnapshot,
            refresh: async () => {
              const host = sctx.get('suanliModels') as GatewayCatalogHost | undefined
              // 刷新的失败不抛给浏览器：宿主保留上一份目录并把原因写进 status。
              if (host !== undefined) await host.refresh().catch(() => undefined)
              return gatewaySnapshot()
            },
          },
        })
        const disposeRoutes = sctx.provide(ROUTE_SERVICE, { routes })
        const disposers = routes.filter(route => routeComponent(route.path) === 'core').map(route => sctx.webServer.register(route))
        return () => { disposeRoutes(); for (const dispose of disposers) dispose() }
      }, 'dsh-imagegen: core routes',
    )
  })

  mounts.set('templates', componentCtx => {
    componentCtx.effect(() => {
        // Background template sync: the upstream sources update on their own
        // schedule, so pull every one of them shortly after start and then
        // twice a day while the plugin stays enabled. Best-effort: failures
        // keep the last good snapshot (bundled or previously refreshed).
        const TEMPLATE_SYNC_INITIAL_DELAY_MS = 30_000
        const TEMPLATE_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000
        let syncTimer: NodeJS.Timeout | undefined
        const runSync = (): void => {
          if (!resolve().enabled) return
          void syncAllTemplates().catch(() => { /* keep the last good snapshot */ })
        }
        const startTimer = setTimeout(runSync, TEMPLATE_SYNC_INITIAL_DELAY_MS)
        syncTimer = setInterval(runSync, TEMPLATE_SYNC_INTERVAL_MS)
        syncTimer.unref?.()
        return () => {
          clearTimeout(startTimer)
          clearInterval(syncTimer)
        }
      },
      'dsh-imagegen: template sync',
    )
  })

  for (const feature of ['image', 'video', 'canvas'] as const) {
  mounts.set(feature, componentCtx => {
  componentCtx.inject(['tools', 'attachments', 'commands'], (tctx) => {
    tctx.effect(() => {
      const resolveAgentConfig = () => {
        const value = resolve()
        return {
          enabled: value.enabled,
          allowAgentImageGeneration: value.allowAgentImageGeneration,
          channels: value.channels,
          defaultChannelId: value.defaultChannelId,
          defaultModel: value.defaultModel,
        }
      }
      const resolveVideoToolConfig = () => {
        const value = resolve()
        return {
          enabled: value.enabled,
          allowAgentVideoGeneration: value.allowAgentVideoGeneration,
          channels: value.channels,
          defaultChannelId: value.defaultChannelId,
          defaultVideoModel: value.defaultVideoModel,
        }
      }
      if (feature === 'video') return registerAgentVideoTools(tctx, runtime, resolveVideoToolConfig)
      if (feature === 'canvas') return registerAgentCanvasTools(tctx, resolveVideoToolConfig)
      // Chat image generation belongs to the host's generate_image; the plugin keeps the /edit_image command.
      // 只读的模型清单：系统提示不拼目录，模型名与玩法由它按需回答。
      const disposeModelsTool = registerMediaModelsTool(tctx, () => {
        const value = resolve()
        return { enabled: value.enabled, announceToAgent: value.announceToAgent, snapshot: gatewaySnapshotValue }
      })
      const disposeCommand = registerEditImageCommand(tctx, runtime, resolveAgentConfig, {
        get: sessionId => pendingConversationImages.get(sessionId),
        consume: (sessionId, ref) => {
          if (pendingConversationImages.get(sessionId)?.attachmentId === ref.attachmentId) pendingConversationImages.delete(sessionId)
        },
      })
      return () => {
        disposeCommand()
        disposeModelsTool()
      }
    }, 'dsh-imagegen: ' + feature + ' agent tools')
  })

  })
  }
  const components: ComponentRuntime = { mount: (feature, componentCtx) => { mounts.get(feature)?.(componentCtx) } }
  ctx.provide(COMPONENT_SERVICE, components)

  // System-prompt announcement (toggled by settings changes).
  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const value = resolve()
    if (!value.enabled || !value.announceToAgent) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-imagegen',
      order: SECTION_ORDER,
      text: IMAGEGEN_GUIDANCE,
    })
  }

  installSettingsSectionCompat(ctx, ImageGenSettingsNamespace, Config, unwrapConfig(config), {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()

  return () => { disposeSection?.() }
}
