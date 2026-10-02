/**
 * Strategy Registry 单元测试(P02-T08)。
 *
 * 运行:先 `npm run build`,再 `node test/registry.test.mjs`。
 * 覆盖:七类型全注册 / 规范顺序 / get() 未知类型 → general / has() /
 * list()/types() / getVersion() 独立版本审计 / getSections() / 自定义注册表
 * (裁掉 general 自动补回、重复类型覆盖)/ legacy general 标记 / 源码纯度。
 *
 * 注意:registry.js 与 strategies/*.js 是各自独立的 bundle,策略对象副本之间
 * 不保证同一性,因此一律比对契约字段(version/type/sections),不比对对象身份。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_STRATEGIES,
  createStrategyRegistry,
  defaultStrategyRegistry,
  generalFallbackStrategy,
  generalStrategy,
  isLegacyGeneral,
} from '../lib/core/registry.js'
import research, { RESEARCH_STRATEGY_VERSION } from '../lib/core/strategies/research.js'
import planning, { PLANNING_STRATEGY_VERSION } from '../lib/core/strategies/planning.js'
import execution, { EXECUTION_STRATEGY_VERSION } from '../lib/core/strategies/execution.js'
import diagnostic, { DIAGNOSTIC_STRATEGY_VERSION } from '../lib/core/strategies/diagnostic.js'
import review, { REVIEW_STRATEGY_VERSION } from '../lib/core/strategies/review.js'
import creative, { CREATIVE_STRATEGY_VERSION } from '../lib/core/strategies/creative.js'
import general, { GENERAL_STRATEGY_VERSION } from '../lib/core/strategies/general.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel) => readFileSync(join(here, rel), 'utf8')

/** 规范注册顺序 = PromptType 的七个取值。 */
const EXPECTED_TYPES = [
  'research',
  'planning',
  'execution',
  'diagnostic',
  'review',
  'creative',
  'general',
]

/** 版本审计锚点:策略独立升级只改这里与对应策略文件。 */
const EXPECTED_VERSIONS = {
  research: '0.2.0',
  planning: '0.1.0',
  execution: '0.1.0',
  diagnostic: '0.1.0',
  review: '0.1.0',
  creative: '0.1.0',
  general: '0.1.0',
}

const VERSION_RE = /^\d+\.\d+\.\d+$/

// rg1. 七类型全注册:list()/types()/has() 与规范顺序一致
{
  const types = defaultStrategyRegistry.types()
  assert.deepEqual(types, EXPECTED_TYPES, '七类型必须按规范顺序全注册')
  assert.deepEqual(
    defaultStrategyRegistry.list().map((s) => s.type),
    EXPECTED_TYPES,
    'list() 顺序必须与 types() 一致',
  )
  assert.equal(defaultStrategyRegistry.list().length, 7, 'list() 必须恰好七条')
  for (const type of EXPECTED_TYPES) {
    assert.equal(defaultStrategyRegistry.has(type), true, `has(${type}) 应为 true`)
    assert.equal(defaultStrategyRegistry.get(type).type, type, `get(${type}) 类型必须匹配`)
  }
  assert.equal(defaultStrategyRegistry.has('bogus'), false)
  assert.equal(defaultStrategyRegistry.has('General'), false, '类型匹配区分大小写')
  assert.equal(DEFAULT_STRATEGIES.length, 7, 'DEFAULT_STRATEGIES 必须七条')
  console.log('✓ rg1 七类型全注册 / 规范顺序 / has()')
}

// rg2. getVersion():七条独立版本,可审计;与策略对象、版本常量三方一致
{
  const versions = defaultStrategyRegistry.getVersion()
  assert.deepEqual(Object.keys(versions).sort(), [...EXPECTED_TYPES].sort())
  for (const type of EXPECTED_TYPES) {
    assert.equal(versions[type], EXPECTED_VERSIONS[type], `getVersion().${type} 必须可审计`)
    assert.equal(defaultStrategyRegistry.get(type).version, EXPECTED_VERSIONS[type])
    assert.match(versions[type], VERSION_RE, `${type} 版本必须是 x.y.z`)
  }
  // 与各策略文件导出的版本常量交叉核对(防止注册了错误副本)。
  assert.equal(versions.research, RESEARCH_STRATEGY_VERSION)
  assert.equal(versions.planning, PLANNING_STRATEGY_VERSION)
  assert.equal(versions.execution, EXECUTION_STRATEGY_VERSION)
  assert.equal(versions.diagnostic, DIAGNOSTIC_STRATEGY_VERSION)
  assert.equal(versions.review, REVIEW_STRATEGY_VERSION)
  assert.equal(versions.creative, CREATIVE_STRATEGY_VERSION)
  assert.equal(versions.general, GENERAL_STRATEGY_VERSION)
  console.log('✓ rg2 getVersion 七策略版本独立可审计')
}

// rg3. get() 未知类型 → general 兜底;已注册类型直达,不误兜底
{
  assert.equal(defaultStrategyRegistry.get('planning').type, 'planning', '已注册类型不得兜底')
  assert.equal(defaultStrategyRegistry.get('creative').type, 'creative')
  for (const bogus of ['bogus', '', 'Research', 'unknown-type']) {
    const strategy = defaultStrategyRegistry.get(bogus)
    assert.equal(strategy.type, 'general', `未知类型 ${JSON.stringify(bogus)} 必须回退 general`)
  }
  assert.equal(defaultStrategyRegistry.get('bogus'), defaultStrategyRegistry.get('general'))
  console.log('✓ rg3 未知类型 → general fallback')
}

// rg4. 七策略契约完整(required_sections 非空 + rules/guards 齐 + getSections 快照)
{
  for (const type of EXPECTED_TYPES) {
    const strategy = defaultStrategyRegistry.get(type)
    assert.ok(strategy.name.length > 0, `${type}.name 不得为空`)
    assert.ok(strategy.purpose.length > 0, `${type}.purpose 不得为空`)
    assert.ok(strategy.required_sections.length > 0, `${type}.required_sections 不得为空`)
    assert.deepEqual(
      strategy.outputContract.sections,
      strategy.required_sections,
      `${type}.outputContract.sections 必须与 required_sections 对齐`,
    )
    assert.ok(Array.isArray(strategy.suggestionRules), `${type}.suggestionRules 必须存在`)
    assert.ok(Array.isArray(strategy.guards), `${type}.guards 必须存在`)
    assert.ok(strategy.provenanceRules.length > 0, `${type}.provenanceRules 不得为空`)
    assert.equal(typeof strategy.buildSystem, 'function')
    assert.equal(typeof strategy.buildUser, 'function')
    // getSections 快照必须与 strategy.required_sections 一致(且是副本,不可被外部改写)。
    const sections = defaultStrategyRegistry.getSections(type)
    assert.deepEqual(sections, strategy.required_sections)
    sections.push('__mutated__')
    assert.deepEqual(
      defaultStrategyRegistry.get(type).required_sections,
      strategy.required_sections,
      'getSections 必须返回副本',
    )
  }
  assert.deepEqual(defaultStrategyRegistry.getSections('bogus'), general.required_sections)
  console.log('✓ rg4 七策略契约完整 / getSections 快照')
}

// rg5. 自定义注册表:裁掉 general 自动补回;重复类型覆盖;显式顺序保留
{
  const custom = createStrategyRegistry([research])
  assert.equal(custom.has('research'), true)
  assert.equal(custom.has('general'), true, '裁掉 general 时必须自动补回')
  assert.equal(custom.list().length, 2)
  assert.equal(custom.get('planning').type, 'general', '未注册类型仍必须兜底')
  assert.equal(custom.get('bogus').type, 'general')
  assert.equal(custom.get('general').type, 'general', '自动补回的应是 general 策略')
  assert.equal(custom.get('general').version, GENERAL_STRATEGY_VERSION)
  assert.equal(custom.get('general').required_sections.length, 8)

  const ordered = createStrategyRegistry([general, research])
  assert.deepEqual(ordered.types(), ['general', 'research'], '显式顺序必须保留')
  assert.equal(ordered.get('planning').type, 'general')
  assert.equal(ordered.get('general').type, 'general')
  assert.equal(ordered.get('general').version, GENERAL_STRATEGY_VERSION)
  assert.equal(ordered.get('research').type, 'research')

  const duplicates = createStrategyRegistry([research, research])
  assert.equal(
    duplicates.list().filter((s) => s.type === 'research').length,
    1,
    '重复类型只保留一条',
  )
  assert.equal(duplicates.has('general'), true, '重复裁剪后仍需补回 general')
  assert.equal(duplicates.get('research').type, 'research')

  const full = createStrategyRegistry(DEFAULT_STRATEGIES)
  assert.equal(full.list().length, 7)
}

// rg6. legacy general 标记:仅 general 走 prompt.ts 老路径,其余策略不误判
{
  assert.equal(isLegacyGeneral(generalFallbackStrategy), true, 'general 兜底应标记 legacy')
  assert.equal(isLegacyGeneral(generalStrategy), true)
  assert.equal(generalFallbackStrategy, generalStrategy, '兼容别名必须指向同一 general 对象')
  for (const type of EXPECTED_TYPES.filter((t) => t !== 'general')) {
    assert.equal(isLegacyGeneral(defaultStrategyRegistry.get(type)), false, `${type} 不得标记 legacy`)
  }
  console.log('✓ rg6 legacy general 标记 / 其余策略零误判')
}

// rg7. 源码纯度:零 ctx / UI / Host / compiler / classify 依赖
{
  const source = readSource('../src/core/registry.ts')
  assert.doesNotMatch(source, /ctx\./, '策略注册表不得持有 ctx 句柄')
  assert.doesNotMatch(source, /from ['"]@deepseek-ai/, '不得依赖 Harness 包')
  assert.doesNotMatch(source, /from ['"][^'"]*(?:\/index|client|ui|ctx)[^'"]*['"]/, '不得依赖 Host/UI')
  assert.doesNotMatch(source, /from ['"]\.\/(?:compiler|classify)/, 'registry 不得依赖 compiler/classify')
  for (const type of EXPECTED_TYPES) {
    assert.match(source, new RegExp(`strategies/${type}\\.js`), `必须注册 ${type} 策略`)
  }
  console.log('✓ rg7 registry 源码纯度 / 七策略导入')
}

console.log('\nregistry: all passed')
