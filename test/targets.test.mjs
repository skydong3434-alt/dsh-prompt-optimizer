/**
 * v2 Phase 1 —— Prompt Target / Target Engine 目录单测。
 *
 * 验证:表驱动完整性(无 if/else 链)、目标↔模态一致、引擎别名最长优先、
 * 确定性目标解析的优先级(引擎 > 目标线索 > general)。
 *
 * 运行:先 `npm run build`,再 `node test/targets.test.mjs`。
 */
import assert from 'node:assert/strict'
import {
  TARGET_CATALOG,
  ENGINE_CATALOG,
  getTargetSpec,
  getEngine,
  enginesForTarget,
  findEngine,
  resolveEngine,
  modalityOf,
  targetForModality,
  isVisualTarget,
  resolveTargetDeterministic,
  targetCueScore,
} from '../lib/core/targets.js'
import { PROMPT_TARGETS, PROMPT_MODALITIES } from '../lib/core/types.js'

// 1. 目标目录:覆盖全部枚举、无重复、模态合法
{
  const ids = TARGET_CATALOG.map((t) => t.id)
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort(), '目标 id 不得重复')
  assert.deepEqual([...ids].sort(), [...PROMPT_TARGETS].sort(), '目标目录必须覆盖全部 PromptTarget')
  for (const spec of TARGET_CATALOG) {
    assert.ok(PROMPT_MODALITIES.includes(spec.modality), `${spec.id} 模态必须合法`)
    assert.ok(spec.nameZh && spec.nameEn, `${spec.id} 必须有中英名`)
    assert.ok(spec.responsibilities.length >= 3, `${spec.id} 至少 3 条信息责任`)
  }
  // 未知目标回落 general(不抛错)
  assert.equal(getTargetSpec('nope').id, 'general')
  console.log('✓ tg1 目标目录完整 / 无重复 / 未知回落 general')
}

// 2. 图像 / 视频:模态为 image|video,且信息责任里不得出现 Goal/Phase/Task/Tests 式模板标题
{
  assert.equal(modalityOf('image_generation'), 'image')
  assert.equal(modalityOf('video_generation'), 'video')
  assert.equal(isVisualTarget('image_generation'), true)
  assert.equal(isVisualTarget('video_generation'), true)
  assert.equal(isVisualTarget('coding'), false)
  const forbidden = /^(goal|phase|task|tasks|test|tests|目标|阶段|任务|测试|验收)$/i
  for (const spec of TARGET_CATALOG.filter((t) => t.modality === 'image' || t.modality === 'video')) {
    for (const responsibility of spec.responsibilities) {
      assert.ok(!forbidden.test(responsibility.trim()), `${spec.id} 责任项不得是模板标题:${responsibility}`)
    }
  }
  console.log('✓ tg2 图像/视频模态 + 责任项不含模板标题(Goal/Phase/Task/Tests)')
}

// 3. 引擎目录:唯一 id、目标与模态合法、归属目标存在
{
  const ids = ENGINE_CATALOG.map((e) => e.id)
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort(), '引擎 id 不得重复')
  for (const engine of ENGINE_CATALOG) {
    assert.ok(PROMPT_TARGETS.includes(engine.target), `${engine.id} 目标必须合法`)
    assert.ok(PROMPT_MODALITIES.includes(engine.modality), `${engine.id} 模态必须合法`)
    assert.equal(
      engine.modality,
      getTargetSpec(engine.target).modality,
      `${engine.id} 模态必须与目标目录一致(单一真源)`,
    )
    assert.ok(engine.aliases.length > 0, `${engine.id} 至少 1 个别名`)
  }
  assert.equal(getEngine('nope'), undefined)
  assert.ok(enginesForTarget('video_generation').length >= 5, '视频目标至少覆盖 5 个引擎')
  console.log('✓ tg3 引擎目录不变量 + 按目标过滤')
}

// 4. 引擎识别:最长别名优先 + 大小写不敏感
{
  assert.equal(findEngine('用 DSH 跑一下')?.id, 'dsh')
  assert.equal(findEngine('用 dsh 跑一下')?.id, 'dsh')
  assert.equal(findEngine('可灵 2.0 出个片子')?.id, 'kling')
  assert.equal(findEngine('Midjourney 出图')?.id, 'midjourney')
  assert.equal(findEngine('用 SDXL 出图')?.id, 'stable-diffusion', 'sdxl 应命中 stable-diffusion 而非被 "sd" 抢先')
  assert.equal(findEngine('用 stable diffusion 出图')?.id, 'stable-diffusion')
  assert.equal(findEngine('用 SDK 做个集成')?.id, undefined, 'sd 是短别名,必须要求词边界(不能命中 SDK)')
  assert.equal(findEngine('用 SD 出图')?.id, 'stable-diffusion', '独立出现的 SD 应命中')
  assert.equal(findEngine('完全没有引擎词的一句话'), undefined)
  assert.equal(resolveEngine('DSH')?.id, 'dsh')
  assert.equal(resolveEngine('某个不认识的模型')?.id, null)
  assert.equal(resolveEngine(null), null)
  assert.equal(resolveEngine('  '), null)
  console.log('✓ tg4 引擎识别:最长别名优先 / 未知引擎保留原话')
}

// 5. 确定性目标解析:引擎线索 > 目标线索 > general
{
  const image = resolveTargetDeterministic({ raw_input: '帮我画一张赛博朋克风格的海报' })
  assert.equal(image.target, 'image_generation')
  assert.equal(image.modality, 'image')

  const video = resolveTargetDeterministic({ raw_input: '生成一段 10 秒的运镜视频' })
  assert.equal(video.target, 'video_generation')

  // 引擎线索压过目标线索:用户说「写」但点名了可灵 → 视频
  const engineWins = resolveTargetDeterministic({ raw_input: '帮我写一段可灵能用的提示词' })
  assert.equal(engineWins.target, 'video_generation')
  assert.equal(engineWins.engine?.id, 'kling')
  assert.equal(engineWins.confidence, 'high')
  assert.ok(engineWins.evidence.length > 0, '引擎命中必须给出逐字证据')

  const vague = resolveTargetDeterministic({ raw_input: '嗯' })
  assert.equal(vague.target, 'general')
  assert.equal(vague.confidence, 'low')

  // 上下文里的引擎线索也认(仅 user 文本)
  const fromContext = resolveTargetDeterministic({
    raw_input: '按上面的来',
    context_texts: ['用 Flux 出一张图'],
  })
  assert.equal(fromContext.target, 'image_generation')
  console.log('✓ tg5 目标解析优先级(引擎 > 线索 > general)')
}

// 6. 辅助函数:模态 → 目标、线索打分
{
  assert.equal(targetForModality('image'), 'image_generation')
  assert.equal(targetForModality('video'), 'video_generation')
  assert.equal(targetForModality('code'), 'coding')
  assert.equal(targetForModality('structured_data'), 'data_analysis')
  assert.equal(targetForModality('text'), 'general')
  assert.ok(targetCueScore('coding', '帮我修一个 bug') > 0)
  assert.equal(targetCueScore('general', '任意文本'), 0, 'general 无线索词')
  console.log('✓ tg6 模态→目标映射 + 线索打分')
}

console.log('targets.test.mjs: ALL PASS')
