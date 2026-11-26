/**
 * 工作室的对外挂载面：右侧栏入口 + 主面板。
 *
 * 上游用 DOM 接管中心列（`mount.tsx`），理由写在那个文件的 NATIVE-GAP 注释里：
 * 它当时无法声明槽位。接管会让外壳自己的中心列视图（会话 / 任务 / 频道）被整块
 * 盖住，外壳一改版还会直接白屏。这里改用外壳自己的两个座位：
 *
 *  - `sidebar.panellist` —— 侧栏的全局面板入口行，选中它就是切到本面板；
 *  - `main`（key `imagegen`）—— 中心列的键控座位，按侧栏入口 id 分发。
 *
 * 这样「生图」和「任务」「频道」是同级的并列视图，切换交给外壳，插件不碰别人
 * 的 DOM。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { ImageGenPanel } from './ImageGenPanel.tsx'
import type { ImageGenApi } from './api.ts'
import type { ImageGenController } from './controller.ts'
import type { ConversationService } from './conversation-sync.ts'
import { tt } from './helpers.ts'
import type { ImageGenScope } from './settings-scope.ts'

/** 侧栏入口 id，同时是 `main` 的键：外壳按入口 id 分发中心列座位。 */
const PANEL_ID = 'imagegen'

/** 一次挂载需要的全部依赖；与 `mountPanel` 的入参一致，只是改由槽位渲染。 */
export interface ImageGenSurfaceInputs {
  readonly api: ImageGenApi
  readonly scope: ImageGenScope
  readonly sessions?: ISessions
  readonly conversation?: ConversationService
  /** 宿主目录选择器；精简外壳没有时铺板卡退回手输路径。 */
  readonly pickDirectory?: () => Promise<string | null>
}

/** 侧栏行里的图标：与外壳其它面板行一样，直接返回 SVG，不套额外包装元素。 */
function ImageGenPanelIcon({ size }: { readonly size?: number }) {
  const edge = size ?? 16
  return (
    <svg
      width={edge}
      height={edge}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <circle cx="5.75" cy="6.5" r="1" />
      <path d="M3.5 12.5 6.75 9l2 2.25L11 8.75l2 3.75" />
    </svg>
  )
}

/** 槽位注册面：只声明这里用到的两种方法，避免依赖尚未声明的座位类型。 */
interface SlotSurfaceRegistry {
  inject: (key: string, callback: () => () => void) => () => void
  register: (options: Readonly<Record<string, unknown>>, component: (props: never) => React.ReactElement) => () => void
}

/**
 * 把工作室注册成侧栏入口与主面板。
 * @param ctx - 客户端插件上下文，提供槽位服务与生命周期。
 * @param inputs - 面板依赖，闭包在渲染函数里。
 * @returns 释放两个槽位注册的 disposer。
 */
export function registerImageGenSlotSurface(
  ctx: ClientContext,
  inputs: ImageGenSurfaceInputs,
): () => void {
  const Panel = (): React.ReactElement => (
    <ImageGenPanel
      api={inputs.api}
      scope={inputs.scope}
      active
      {...inputs.sessions === undefined ? {} : { sessions: inputs.sessions }}
      {...inputs.conversation === undefined ? {} : { conversation: inputs.conversation }}
      {...inputs.pickDirectory === undefined ? {} : { pickDirectory: inputs.pickDirectory }}
    />
  )
  // 这两处座位在插件锁定的客户端类型版本里还没有声明，因此按名字注册；
  // 结构与该版本 register/inject 的实际签名一致。
  const slots = ctx.slots as unknown as SlotSurfaceRegistry
  const disposers = [
    slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, label: () => tt('entry.image') }, Panel)),
    slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => tt('entry.image'),
    }, ImageGenPanelIcon)),
  ]
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
