/**
 * 宿主媒体目录在本插件里的适配层：把宿主 `suanliModels` 的目录快照转成工作台要用的渠道、
 * 默认模型与网关地址，并把「为什么现在不能用」翻译成一个状态。
 *
 * 这一层只做纯逻辑，不碰网络、不碰设置：目录由宿主读取、缓存与持久化（见宿主的
 * `@deepseek-ai/dsh-suanli-model-catalog`），插件只消费 `media()` / `endpoint()` 的结果。
 * 宿主的类型在本文件里按最小结构重新声明，不依赖宿主包：插件是独立发布、随宿主 rc 版本
 * 一起安装的，依赖宿主内部包会让两者的版本互相绑架。
 */

/** 网关地址与凭据名，来自宿主 `suanliModels.endpoint()`。 */
export interface GatewayEndpoint {
  /** 带 API 前缀的网关根，例如 `https://maas.example.com/v1`。 */
  readonly baseURL: string
  /** 凭据名（`AURORA_API_KEY` 这样的环境变量式名字），不是密钥本身。 */
  readonly credential: string
}

/** 宿主目录里一条能力的本地化文案。 */
export interface GatewayLabel {
  readonly zh: string
  readonly en: string
}

/** 宿主目录里一条能力的硬上限。 */
export interface GatewayLimits {
  readonly maxReferenceImages: number
  readonly maxDurationSeconds: number
  readonly maxInputBytes: number
}

/** 宿主目录里一条能力的玩法。 */
export interface GatewayMode {
  /** 提交时 `metadata.image_mode` 的取值。 */
  readonly id: string
  /** 玩法名称。 */
  readonly label: GatewayLabel
  /** 与 `id` 等价的 `metadata.task_type`。 */
  readonly taskType: string
  /** 单张图时实际走的任务类型（首尾帧用）。 */
  readonly taskTypeIfSingleImage?: string
  /** 三类参考素材的数量区间。 */
  readonly references: {
    readonly image: { readonly min: number; readonly max: number }
    readonly video: { readonly min: number; readonly max: number }
    readonly audio: { readonly min: number; readonly max: number }
  }
  /** 是否必须给源视频（续写用）。 */
  readonly requiresSourceVideo?: boolean
  /** 玩法说明。 */
  readonly note?: GatewayLabel
}

/** 宿主目录里的一条能力，只列本插件读到的字段。 */
export interface GatewayEntry {
  /** `<operation>:<model>`。 */
  readonly id: string
  /** 操作类别，例如 `generate_image`。 */
  readonly operation: string
  /** 提交时 `model` 的取值。 */
  readonly model: string
  /** 展示名。 */
  readonly displayName: GatewayLabel
  /** 一句话说明。 */
  readonly description: GatewayLabel
  /** 传输方式；`kind` 决定端点。 */
  readonly transport: { readonly kind: string }
  /** 该模型支持的任务类型。 */
  readonly taskTypes?: readonly string[]
  /** 参数表。 */
  readonly paramSchema?: {
    readonly type: string
    readonly properties: Readonly<Record<string, {
      readonly type: string
      readonly title?: string
      readonly enum?: readonly string[]
      readonly minimum?: number
      readonly maximum?: number
      readonly default?: string
    }>>
  }
  /** 硬上限。 */
  readonly limits: GatewayLimits
  /** 每个请求时长对应的实际交付秒数。 */
  readonly deliveryDurations?: readonly number[]
  /** 玩法列表；缺省表示单一玩法。 */
  readonly modes?: readonly GatewayMode[]
  /** 是否为该操作的默认模型。 */
  readonly default: boolean
}

/** 宿主目录快照的状态；`not-configured` 只有插件侧会出现（宿主没有网关配置时）。 */
export type GatewayStatus =
  | 'not-configured'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'signed-out'
  | 'unauthorized'
  | 'kyc-required'
  | 'rate-limited'
  | 'unreachable'

/** 宿主目录快照，字段与宿主 `MediaCatalogSnapshot` 一致。 */
export interface GatewaySnapshot {
  /** 最近一次读取的结果。 */
  readonly status: Exclude<GatewayStatus, 'not-configured'>
  /** 最近一份成功目录的版本。 */
  readonly version: string | null
  /** 最近一份成功目录的读取时间。 */
  readonly fetchedAt: number | null
  /** 最近一份成功目录的全部条目。 */
  readonly entries: readonly GatewayEntry[]
}

/** 宿主 `suanliModels` 命名空间里本插件用到的方法。 */
export interface GatewayCatalogHost {
  /** 读取最近一份目录快照。 */
  media(): GatewaySnapshot
  /** 触发一次刷新并返回刷新后的快照。 */
  refresh(): Promise<unknown>
  /** 读取网关地址与凭据名。 */
  endpoint(): GatewayEndpoint
}

/** 宿主凭据服务里本插件用到的方法。 */
export interface GatewayCredentialsHost {
  /**
   * 解析一个凭据名。
   * @param ref - 凭据名。
   * @returns 值，或未配置时的 `undefined`。
   */
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
}

/** 网关渠道的固定 id：历史、画廊与设置都按它归属，不随目录变化。 */
export const GATEWAY_CHANNEL_ID = 'suanli-gateway'

/** 网关渠道的显示名。 */
export const GATEWAY_CHANNEL_NAME = '蒜狸网关'

/**
 * 凭据名的合法形状。
 *
 * 与宿主 `packages/credentials/credentials/src/index.ts` 的 `REF_PATTERN` 一致：插件不
 * 依赖宿主包，所以这条正则在本地有一份副本，改动那一边时要同步这里。
 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 网关 origin。
 * @param baseURL - 网关根，带不带 `/v1` 都可以。
 * @returns 协议 + 主机（+ 非默认端口）。
 */
export function gatewayOrigin(baseURL: string): string {
  return new URL(baseURL).origin
}

/**
 * 拼接网关上的一个完整地址。
 *
 * 目录、上传、图像与视频请求都走这里：`baseURL` 末尾多一个 `/v1` 或少一个 `/v1` 都不该
 * 改变结果，所以统一从 origin 起拼，不再把 `baseURL` 当前缀。
 * @param baseURL - 网关根。
 * @param path - 以 `/` 开头的路径，例如 `/v1/ov/capabilities`。
 * @returns 完整地址。
 */
export function gatewayUrl(baseURL: string, path: `/${string}`): string {
  return `${gatewayOrigin(baseURL)}${path}`
}

/**
 * 网关渠道对象（供引擎与 Agent 工具沿用）。
 * @param inputs.entries - 目录里的全部条目。
 * @param inputs.baseURL - 网关根。
 * @returns 只读渠道；密钥不在其中，提交时按凭据名现取。
 */
export function gatewayChannel(inputs: {
  readonly entries: readonly GatewayEntry[]
  readonly baseURL: string
}): {
  id: string
  preset: string
  name: string
  apiUrl: string
  apiUrlFull: boolean
  watermark: boolean
  autoReferenceLimit: boolean
  protocol: 'auto'
  auth: 'api-key'
  subscription: string
  models: { alias: string; id: string }[]
  videoModels: { alias: string; id: string }[]
} {
  // 传输方式不足以选出可提交的条目：`upscale` 与 `edit_media` 也走 images 传输，但工作台
  // 不渲染它们（见目录契约）。所以按「传输 + 操作」成对过滤，渠道里只留真正能提交的。
  const modelsOf = (kind: string, operation: string): { alias: string; id: string }[] => inputs.entries
    .filter(entry => entry.transport.kind === kind && entry.operation === operation)
    .map(entry => ({ alias: displayNameOf(entry), id: entry.model }))
  return {
    id: GATEWAY_CHANNEL_ID,
    preset: '',
    name: GATEWAY_CHANNEL_NAME,
    // 引擎按 `apiUrl + '/路径'` 拼接，因此这里固定带 `/v1` 且不带结尾斜杠。
    apiUrl: `${gatewayOrigin(inputs.baseURL)}/v1`,
    apiUrlFull: false,
    watermark: true,
    autoReferenceLimit: true,
    protocol: 'auto',
    auth: 'api-key',
    subscription: '',
    models: modelsOf('images', 'generate_image'),
    videoModels: modelsOf('videos_task', 'generate_video'),
  }
}

/**
 * 条目的展示名：中文名优先，缺省回落到模型名。
 * @param entry - 目录条目。
 * @returns 展示名。
 */
export function displayNameOf(entry: GatewayEntry): string {
  return entry.displayName.zh !== '' ? entry.displayName.zh : entry.model
}

/**
 * 在一组候选里选默认模型。
 *
 * 顺序是「用户上次的选择 → 目录标记的默认项 → 第一条」，用户的选择只在它仍存在于目录里时
 * 才算数：网关撤掉一个模型后，界面不能还选着它。
 * @param candidates - 同一操作类别的条目。
 * @param previous - 用户上次选择的模型名。
 * @returns 选中的模型名，候选为空时为空串。
 */
export function selectDefaultModel(candidates: readonly GatewayEntry[], previous: string): string {
  if (candidates.length === 0) return ''
  if (previous !== '' && candidates.some(entry => entry.model === previous)) return previous
  return (candidates.find(entry => entry.default) ?? candidates[0]!).model
}

/**
 * 某个操作类别下可选的模型条目。
 * @param entries - 目录里的全部条目。
 * @param kind - 传输方式（`images` / `videos_task`）。
 * @returns 该传输方式下的条目，保持目录顺序。
 */
export function entriesOfKind(entries: readonly GatewayEntry[], kind: string): readonly GatewayEntry[] {
  return entries.filter(entry => entry.transport.kind === kind)
}

/**
 * 把条目转成状态条与模型选择器要的选项。
 * @param entries - 同一传输方式下的条目。
 * @returns 选项列表，保持目录顺序。
 */
export function modelOptionsOf(entries: readonly GatewayEntry[]): { model: string; label: string; isDefault: boolean }[] {
  return entries.map(entry => ({ model: entry.model, label: displayNameOf(entry), isDefault: entry.default }))
}

/**
 * 目录里的条目能否被工作台渲染。
 * @param entries - 目录里的全部条目。
 * @returns 至少有图像或视频条目时为 true。
 */
export function hasRenderableEntries(entries: readonly GatewayEntry[]): boolean {
  return entriesOfKind(entries, 'images').length > 0 || entriesOfKind(entries, 'videos_task').length > 0
}

/**
 * 凭据名是否合法。
 * @param credential - 凭据名。
 * @returns 合法时为 true。
 */
export function isCredentialRefName(credential: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(credential)
}

/**
 * 把宿主快照收敛成工作台要渲染的快照。
 *
 * 宿主没有挂载目录服务（Web / headless 构建）时为 `not-configured`；宿主报告 `ready`
 * 但一条图像 / 视频条目都没有时，就本插件而言等同于 `empty`。
 * @param host - 宿主的目录服务，未挂载时为 `undefined`。
 * @returns 插件视角的快照。
 */
export function pluginSnapshotOf(host: GatewayCatalogHost | undefined): {
  status: GatewayStatus
  version: string | null
  fetchedAt: number | null
  entries: readonly GatewayEntry[]
} {
  if (host === undefined) return { status: 'not-configured', version: null, fetchedAt: null, entries: [] }
  const snapshot = host.media()
  const status = snapshot.status === 'ready' && !hasRenderableEntries(snapshot.entries) ? 'empty' : snapshot.status
  return { status, version: snapshot.version, fetchedAt: snapshot.fetchedAt, entries: snapshot.entries }
}
