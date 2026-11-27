/**
 * 生成输入条的目标解析。
 *
 * 配置节点仍是普通生成目标；标注提示词卡不是图里的输入节点，它选中时要把
 * 输入条挂回被标注的图片。这样「在图上标注」不用额外手工连线，也能直接生成。
 */

import type { CanvasNode, CanvasRect } from '../../protocol.ts'
import { attachedCards, isAnnotationCard, liveAnnotations, nodeMetadata } from './node-model.ts'


export interface AnnotationEntry {
  readonly rect: CanvasRect
  readonly text: string
}

/** Live boxes and their prompt-card text on one image. */
export function annotationEntries(image: CanvasNode, nodes: CanvasNode[]): AnnotationEntry[] {
  return liveAnnotations(image, nodes).map(annotation => {
    const card = annotation.nodeId === undefined ? undefined : nodes.find(node => node.id === annotation.nodeId)
    return {
      rect: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height },
      text: (card === undefined ? '' : nodeMetadata(card).text ?? '').trim(),
    }
  })
}

/** Boxes sent to the edit model: written boxes win; otherwise blank boxes still constrain a composer prompt. */
export function constrainedAnnotationBoxes(entries: readonly AnnotationEntry[]): { rect: CanvasRect; text: string }[] {
  const instructed = entries.some(entry => entry.text !== '')
  return (instructed ? entries.filter(entry => entry.text !== '') : entries)
    .map(entry => ({ rect: entry.rect, text: entry.text === '' ? '按生成描述修改这个区域' : entry.text }))
}

/** Prefer images with written instructions; use blank boxes only when no input has written instructions. */
export function preferredAnnotationInputs(inputs: CanvasNode[], nodes: CanvasNode[]): CanvasNode[] {
  const annotated = inputs.filter(node => node.type === 'image' && liveAnnotations(node, nodes).length > 0)
  const hasInstructions = annotated.some(node => annotationEntries(node, nodes).some(entry => entry.text !== ''))
  return hasInstructions
    ? annotated.filter(node => annotationEntries(node, nodes).some(entry => entry.text !== ''))
    : annotated
}

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

/** X position for a generated child: annotation cards occupy the first column right of their source. */
export function generationOutputX(anchor: CanvasNode, nodes: CanvasNode[], gap = 80): number {
  const base = anchor.x + anchor.width + gap
  if (anchor.type !== 'image') return Math.round(base)
  const right = attachedCards(anchor, nodes).reduce((edge, card) => Math.max(edge, card.x + card.width), 0)
  return Math.round(Math.max(base, right + gap))
}
