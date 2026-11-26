/**
 * 创作工作台的对外挂载面：侧栏入口 + 主面板。
 *
 * 插件只通过外壳自己的两个座位出现，中心列归外壳所有：
 *
 *  - `sidebar.panellist` —— 侧栏的全局面板入口行，`order: 20` 排在外壳自己的
 *    任务（10）之后，选中它就是切到本面板；
 *  - `main`（key `imagegen`）—— 中心列的键控座位，按侧栏入口 id 分发。
 *
 * 这样「创作」和「任务」「频道」是同级的并列视图，切换交给外壳，插件不碰别人
 * 的 DOM。曾经的 DOM 接管（中心列里插容器、侧栏上方插两栏切换器、拿侧栏区域
 * 当历史宿主）已经随 WP4 删除，不再是一条可选路径。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { ImageGenPanel } from './ImageGenPanel.tsx'
import type { ImageGenApi } from './api.ts'
import type { ConversationService } from './conversation-sync.ts'
import { tt } from './helpers.ts'
import type { ImageGenScope } from './settings-scope.ts'

/** 侧栏入口 id，同时是 `main` 的键：外壳按入口 id 分发中心列座位。 */
export const IMAGE_GEN_PANEL_ID = 'imagegen'
const PANEL_ID = IMAGE_GEN_PANEL_ID

/** 一次挂载需要的全部依赖；与 `mountPanel` 的入参一致，只是改由槽位渲染。 */
export interface ImageGenSurfaceInputs {
  readonly api: ImageGenApi
  readonly scope: ImageGenScope
  readonly sessions?: ISessions
  readonly conversation?: ConversationService
  /** 宿主目录选择器；精简外壳没有时铺板卡退回手输路径。 */
  readonly pickDirectory?: () => Promise<string | null>
}

/**
 * 侧栏行里的图标：与外壳其它面板行一样，直接返回 SVG，不套额外包装元素。
 *
 * 与包图标（`icon.png`）同一字形：圆角画框 + 右上角四角星，星芒压在画框的
 * 右上角上。单色，只用 `currentColor`，颜色随外壳行自己的墨色走。
 */
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
      <rect x="2.1" y="5.2" width="9.9" height="8" rx="1.8" />
      <path
        d="M12.1 1.2Q12.35 3.25 14.4 3.6Q12.35 3.95 12.1 6Q11.85 3.95 9.8 3.6Q11.85 3.25 12.1 1.2Z"
        fill="currentColor"
        stroke="none"
      />
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
    slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, label: () => tt('entry.creative') }, Panel)),
    slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => tt('entry.creative'),
    }, ImageGenPanelIcon)),
  ]
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
