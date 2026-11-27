/**
 * 标注输入条目标的离线验证。
 *
 * 钉住的是「在图上标注」的手顺：框出来的提示词卡不需要连线；选中卡片或
 * 被标注图片时，生成输入条都把那张图片当作编辑目标与第一张参考图。
 *
 * Run: node scripts/smoke-canvas-annotation-composer.mjs   (from the package root)
 */

import assert from 'node:assert/strict'
import { createCheckHarness } from './lib/check-harness.mjs'
import { annotationEntries, constrainedAnnotationBoxes, generationComposerInputs, generationComposerTarget, generationOutputX, preferredAnnotationInputs } from '../src/client/canvas/annotation-composer.ts'

const results = []
const check = createCheckHarness({ results })

const image = (id, annotations = []) => ({
  id, type: 'image', title: id, x: 0, y: 0, width: 240, height: 240,
  metadata: { status: 'success', annotations },
})
const card = (id, sourceNodeId, text = '把这里换成一只橘猫') => ({
  id, type: 'text', title: id, x: 300, y: 0, width: 180, height: 100,
  metadata: { text, annotation: { sourceNodeId, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } },
})
const config = id => ({ id, type: 'config', title: id, x: 0, y: 0, width: 240, height: 160, metadata: {} })

await check('选中标注提示词卡时目标是被标注图片', () => {
  const source = image('img', [{ id: 'ann', x: 0.1, y: 0.1, width: 0.2, height: 0.2, nodeId: 'card' }])
  const nodes = [source, card('card', 'img')]
  assert.equal(generationComposerTarget(nodes, new Set(['card']))?.id, 'img')
})

await check('选中带标注的图片本身也能打开输入条', () => {
  const source = image('img', [{ id: 'ann', x: 0.1, y: 0.1, width: 0.2, height: 0.2, nodeId: 'card' }])
  const nodes = [source, card('card', 'img')]
  assert.equal(generationComposerTarget(nodes, new Set(['img']))?.id, 'img')
})

await check('普通图片不会突然变成生成目标', () => {
  const nodes = [image('plain')]
  assert.equal(generationComposerTarget(nodes, new Set(['plain'])), null)
})

await check('配置节点仍然优先', () => {
  const source = image('img', [{ id: 'ann', x: 0.1, y: 0.1, width: 0.2, height: 0.2, nodeId: 'card' }])
  const nodes = [source, card('card', 'img'), config('cfg')]
  assert.equal(generationComposerTarget(nodes, new Set(['card', 'cfg']))?.id, 'cfg')
})

await check('两个不同标注来源同时选中时不猜测', () => {
  const first = image('a', [{ id: 'anna', x: 0, y: 0, width: 0.1, height: 0.1, nodeId: 'card-a' }])
  const second = image('b', [{ id: 'annb', x: 0, y: 0, width: 0.1, height: 0.1, nodeId: 'card-b' }])
  const nodes = [first, second, card('card-a', 'a'), card('card-b', 'b')]
  assert.equal(generationComposerTarget(nodes, new Set(['card-a', 'card-b'])), null)
})

await check('图片目标是第一张参考输入，配置目标只读上游', () => {
  const target = image('target')
  const upstream = [image('upstream')]
  assert.deepEqual(generationComposerInputs(target, upstream).map(node => node.id), ['target', 'upstream'])
  assert.deepEqual(generationComposerInputs(config('cfg'), upstream).map(node => node.id), ['upstream'])
})


await check('生成结果让开标注提示词卡所在列', () => {
  const source = image('img', [{ id: 'ann', x: 0.1, y: 0.1, width: 0.2, height: 0.2, nodeId: 'card' }])
  const promptCard = card('card', 'img')
  const nodes = [source, promptCard]
  assert.equal(generationOutputX(source, nodes), promptCard.x + promptCard.width + 80)
  assert.equal(generationOutputX(config('cfg'), nodes), config('cfg').x + config('cfg').width + 80)
})


await check('有写明要求的标注图优先于空白标注图', () => {
  const blankSource = image('blank', [{ id: 'annb', x: 0, y: 0, width: 0.1, height: 0.1, nodeId: 'blank-card' }])
  const writtenSource = image('written', [{ id: 'annw', x: 0, y: 0, width: 0.1, height: 0.1, nodeId: 'written-card' }])
  const nodes = [blankSource, writtenSource, card('blank-card', 'blank', ''), card('written-card', 'written')]
  assert.deepEqual(preferredAnnotationInputs([blankSource, writtenSource], nodes).map(node => node.id), ['written'])
})

await check('全部标注卡为空时空白框仍作为生成约束', () => {
  const source = image('blank', [{ id: 'annb', x: 0, y: 0, width: 0.1, height: 0.1, nodeId: 'blank-card' }])
  const nodes = [source, card('blank-card', 'blank', '')]
  const entries = annotationEntries(source, nodes)
  assert.equal(constrainedAnnotationBoxes(entries)[0]?.text, '按生成描述修改这个区域')
})

process.stdout.write(`${results.join('\n')}\n`)
const failed = results.filter(line => line.startsWith('FAIL')).length
if (failed > 0) {
  process.stderr.write(`\ncanvas annotation composer: ${failed} failed, ${results.length - failed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\ncanvas annotation composer: ${results.length} passed\n`)
}
