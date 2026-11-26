/**
 * 工作台顶部的网关状态条。
 *
 * 目录由宿主读取并缓存，插件只是消费方，所以这里回答的是两件事：现在是什么状态，
 * 以及用户能对它做什么。文案全部来自 locale 字典（宿主只给状态码），登录与实名入口
 * 目前没有可调用的宿主接口，因此给出去处的文字指引而不是一个假按钮。
 */

import type { ReactElement } from 'react'
import type { GatewayCatalogSnapshot } from '../protocol.ts'
import { tt } from './helpers.ts'
import type { ImageGenKey } from './locales.ts'
import css from './gateway-status.module.css'

/** 状态条需要的输入。 */
export interface GatewayStatusProps {
  /** 宿主目录快照（插件视角）。 */
  readonly snapshot: GatewayCatalogSnapshot
  /** 是否正在刷新；刷新期间按钮禁用。 */
  readonly refreshing: boolean
  /** 重试 / 刷新。 */
  readonly onRefresh: () => void
}

/**
 * 哪些状态值得给一个「重试 / 刷新」按钮。
 *
 * 未实名与未授权也算：用户在网关完成实名或换了账号权限之后，密钥本身不变，宿主收不到凭据
 * 事件，只有手动刷新才会重读目录。
 */
const RETRYABLE: ReadonlySet<GatewayCatalogSnapshot['status']> = new Set(['rate-limited', 'unreachable', 'empty', 'kyc-required', 'unauthorized'])

/** 哪些状态需要告诉用户去哪里处理（宿主没有可调用的登录 / 实名入口）。 */
const HINTED: ReadonlySet<GatewayCatalogSnapshot['status']> = new Set(['signed-out', 'unauthorized', 'kyc-required'])

/**
 * 渲染状态条。
 * @param props - 快照、刷新状态与重试回调。
 * @returns 状态条；目录正常（或已有缓存并在后台刷新）时渲染 `null`。
 */
export function GatewayStatus({ snapshot, refreshing, onRefresh }: GatewayStatusProps): ReactElement | null {
  const hasModels = snapshot.image.length > 0 || snapshot.video.length > 0
  // 有缓存的加载中不打扰用户：上一份模型列表还在用。
  if (snapshot.status === 'ready') return null
  if (snapshot.status === 'loading' && hasModels) return null
  const text = tt(gatewayCopyKey(snapshot))
  return (
    <div className={css.bar} data-gateway-status={snapshot.status} role="status">
      <span className={css.dot} aria-hidden="true" />
      <span className={css.text} title={text}>{text}</span>
      {HINTED.has(snapshot.status) ? <span className={css.hint}>{tt('gateway.loginHint')}</span> : null}
      {RETRYABLE.has(snapshot.status)
        ? (
          <button type="button" className={css.action} disabled={refreshing} onClick={onRefresh}>
            {tt(snapshot.status === 'rate-limited' ? 'gateway.retry' : 'gateway.refresh')}
          </button>
        )
        : null}
    </div>
  )
}

/**
 * 状态对应的文案键。
 *
 * 导出给工作台用：生成按钮禁用时要说的那句话，必须和状态条说的是同一句。
 * @param snapshot - 目录快照。
 * @returns locale 字典里的键。
 */
export function gatewayCopyKey(snapshot: Pick<GatewayCatalogSnapshot, 'status' | 'image' | 'video'>): ImageGenKey {
  const hasModels = snapshot.image.length > 0 || snapshot.video.length > 0
  switch (snapshot.status) {
    case 'not-configured': return 'gateway.notConfigured'
    case 'loading': return 'gateway.loading'
    case 'empty': return 'gateway.empty'
    case 'signed-out': return 'gateway.signedOut'
    case 'kyc-required': return 'gateway.kycRequired'
    case 'unauthorized': return 'gateway.unauthorized'
    case 'rate-limited': return 'gateway.rateLimited'
    case 'unreachable': return hasModels ? 'gateway.unreachableCached' : 'gateway.unreachable'
    case 'ready': return 'gateway.loading'
  }
}
