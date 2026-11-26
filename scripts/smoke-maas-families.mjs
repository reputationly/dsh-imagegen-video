// 自家 MaaS 的族判定：图片走 h3-image（只认 size 的 2K 档），视频走 h3-v2
// （网关统一任务接口 + metadata.image_mode）。纯函数，不需要网络、密钥或构建产物。
import assert from 'node:assert/strict'
import { describeModel, promptCharLimit } from '../src/model-catalog.ts'
import { describeVideoModel } from '../src/video-model-catalog.ts'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}

// ------------------------------------------------------------------ 图片族
check('minimax-h3-image 归到 h3-image，而不是 MiniMax 官方族', () => {
  assert.equal(describeModel('minimax-h3-image').family, 'h3-image')
})

check('聚合模型 minimax-h3-image-enhanced 也在 h3-image 族内', () => {
  assert.equal(describeModel('minimax-h3-image-enhanced').family, 'h3-image')
})

check('带厂商前缀的 id 同样归到 h3-image', () => {
  assert.equal(describeModel('suanli/minimax-h3-image').family, 'h3-image')
})

check('h3-image 的提示词上限是 7000（按族给出，不套用通用值）', () => {
  assert.equal(promptCharLimit('minimax-h3-image'), 7000)
  assert.equal(promptCharLimit('minimax-h3-image-enhanced'), 7000)
})

check('h3-image 不声明 aspect_ratio 语义（尺寸只走 size）', () => {
  assert.equal(describeModel('minimax-h3-image').supportsAspectRatio, false)
})

// ------------------------------------------------------------------ 视频族
check('minimax-h3-2k 归到 h3-v2（网关聚合模型）', () => {
  assert.equal(describeVideoModel('minimax-h3-2k').family, 'h3-v2')
})

check('minimax-h3-ref-2k 归到 h3-v2', () => {
  assert.equal(describeVideoModel('minimax-h3-ref-2k').family, 'h3-v2')
})

check('minimax-h3-fl2va / minimax-h3-ref2va 归到 h3-v2', () => {
  assert.equal(describeVideoModel('minimax-h3-fl2va').family, 'h3-v2')
  assert.equal(describeVideoModel('minimax-h3-ref2va').family, 'h3-v2')
})

check('h3-v2 提供首尾帧与参考族两种玩法', () => {
  const entry = describeVideoModel('minimax-h3-2k')
  for (const mode of ['text', 'image', 'keyframe', 'reference']) {
    assert.ok(entry.modes.includes(mode), `缺少玩法 ${mode}`)
  }
})

check('h3-v2 只提供 768P（2K 由网关侧超分完成）', () => {
  assert.deepEqual(describeVideoModel('minimax-h3-2k').resolutions, ['768P'])
})

check('h3-v2 的时长档位是 5/10/15', () => {
  assert.deepEqual(describeVideoModel('minimax-h3-2k').durations, [5, 10, 15])
})

check('裸名 minimax-h3 与大小写变体同样归到 h3-v2，不会掉到 unknown', () => {
  assert.equal(describeVideoModel('MiniMax-H3').family, 'h3-v2')
  assert.equal(describeVideoModel('minimax-h3').family, 'h3-v2')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
