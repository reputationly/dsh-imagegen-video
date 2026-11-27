/**
 * 生成输入条的目标解析。
 *
 * 配置节点仍是普通生成目标；标注提示词卡不是图里的输入节点，它选中时要把
 * 输入条挂回被标注的图片。这样「在图上标注」不用额外手工连线，也能直接生成。
 */

import type { CanvasNode } from '../../protocol.ts'
import { isAnnotationCard, liveAnnotations, nodeMetadata } from './node-model.ts'

/** Resolve the node the generation composer should submit against. */
export function generationComposerTarget(nodes: CanvasNode[], selectedIds: ReadonlySet<string>): CanvasNode | null {
  const selected = nodes.filter(node => selectedIds.has(node.id))
  const configs = selected.filter(node => node.type === 'config')
  if (configs.length === 1) return configs[0]!
  const candidates = new Set<string>()
  for (const node of selected) {
    if (node.type === 'image' && liveAnnotations(node, nodes).length > 0) candidates.add(node.id)
    if (!isAnnotationCard(node)) continue
    const sourceId = nodeMetadata(node).annotation?.sourceNodeId
    const source = nodes.find(item => item.id === sourceId)
    if (source?.type === 'image') candidates.add(source.id)
  }
  if (candidates.size !== 1) return null
  const id = [...candidates][0]!
  return nodes.find(node => node.id === id) ?? null
}

/** Inputs of one composer submission: an image target is itself the first reference. */
export function generationComposerInputs(target: CanvasNode, upstream: CanvasNode[]): CanvasNode[] {
  return target.type === 'image' ? [target, ...upstream] : upstream
}
