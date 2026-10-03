/**
 * P07-T01 — Regression 语料 schema 校验 + 语料级 cross-strategy invariant 前置检查。
 *
 * 定位(PLAN-v1 §11.2；PLAN-v1.1 R-2):
 *  - 本文件只做**可离线判定的语料契约检查**:fixtures JSON 形状是否合法、覆盖是否齐全、
 *    每条 `invariant_checks` 是否声明了运行期检查所需的参数,并验证该声明在语料层
 *    自洽(如 partial-quote 的 quote 确实只是 raw 的片段);
 *  - 真正的「编译输出 → invariant」运行期强制由 P07-T02 的 `test/regression/run.mjs`
 *    实现,详见 docs/regression.md §3/§4;
 *  - **阈值纪律(R-2)**:effect 不得携带任何数值通过阈值(未校准前不作为发布标准)。
 *
 * 运行:先 `npm run build`,再 `node test/regression/schema.test.mjs`。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStrategyRegistry } from '../../lib/core/registry.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, 'fixtures')

const PROMPT_TYPES = [
  'research',
  'planning',
  'execution',
  'diagnostic',
  'review',
  'creative',
  'general',
]
const GOLDEN_TYPES = PROMPT_TYPES.filter((type) => type !== 'general')
const PRIMARY_TAGS = ['golden', 'g4-regression', 'coverage']
const EVALUATOR_PROMPT_ID = 'intent-fidelity-v1'
const FOUR_PART_PROTOCOL = 'four-part'
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `invariant_checks` 的 canonical id → 必需参数(运行期由 P07-T02 runner 执行)。 */
const CANONICAL_CHECKS = new Map([
  ['unknown-not-blocking', []],
  ['suggested-not-upgraded', []],
  ['unknown-semantic-dedup', ['topic', 'aliases']],
  ['partial-quote-not-user-explicit', ['quote', 'claimed_requirement']],
  ['conflicting-evidence-weighted', ['conflict_a', 'conflict_b']],
  ['planning-override-contract', ['protocol', 'expect_provenance_ok', 'sections']],
  ['explicit-priority-current-over-historical', ['historical_fact', 'current_override']],
])

/** G-4 真人验收暴露、必须由语料覆盖的 5 项检查。 */
const REQUIRED_G4_CHECKS = [
  'partial-quote-not-user-explicit',
  'unknown-semantic-dedup',
  'unknown-not-blocking',
  'conflicting-evidence-weighted',
  'planning-override-contract',
]

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function assertStringArray(value, label, { allowEmpty = true } = {}) {
  assert.ok(Array.isArray(value), `${label} 必须是数组`)
  if (!allowEmpty) assert.ok(value.length > 0, `${label} 不得为空数组`)
  for (const [index, item] of value.entries()) {
    assert.ok(isNonEmptyString(item), `${label}[${index}] 必须是非空字符串`)
  }
}

/** 将 context 归一化为 ConversationTurn[]:字符串按 user 消息处理。 */
function normalizeContext(fixture, label) {
  const context = fixture.context ?? []
  assert.ok(Array.isArray(context), `${label}.context 必须是数组`)
  return context.map((entry, index) => {
    if (typeof entry === 'string') {
      assert.ok(isNonEmptyString(entry), `${label}.context[${index}] 不得为空字符串`)
      return { role: 'user', text: entry }
    }
    assert.ok(isPlainObject(entry), `${label}.context[${index}] 必须是字符串或 {role,text}`)
    assert.ok(
      entry.role === 'user' || entry.role === 'assistant',
      `${label}.context[${index}].role 必须是 user|assistant`,
    )
    assert.ok(isNonEmptyString(entry.text), `${label}.context[${index}].text 必须是非空字符串`)
    return { role: entry.role, text: entry.text }
  })
}

function assertInvariants(fixture, label) {
  assert.ok(Array.isArray(fixture.invariants) && fixture.invariants.length > 0, `${label}.invariants 必须是非空数组`)
  for (const [index, invariant] of fixture.invariants.entries()) {
    const where = `${label}.invariants[${index}]`
    assert.ok(isPlainObject(invariant), `${where} 必须是对象`)
    assert.ok(isNonEmptyString(invariant.desc), `${where}.desc 必须是非空字符串`)
    const hasRequire = Object.prototype.hasOwnProperty.call(invariant, 'require')
    const hasProhibit = Object.prototype.hasOwnProperty.call(invariant, 'prohibit')
    assert.ok(
      hasRequire !== hasProhibit,
      `${where} 必须且只能包含 require / prohibit 之一`,
    )
    const key = hasRequire ? 'require' : 'prohibit'
    assert.ok(isNonEmptyString(invariant[key]), `${where}.${key} 必须是非空字符串`)
    assert.doesNotThrow(
      () => new RegExp(invariant[key]),
      `${where}.${key} 必须是合法正则`,
    )
  }
}

function assertEffect(fixture, label) {
  if (fixture.effect === undefined) return
  const effect = fixture.effect
  assert.ok(isPlainObject(effect), `${label}.effect 必须是对象`)
  assert.equal(
    effect.evaluator_prompt_id,
    EVALUATOR_PROMPT_ID,
    `${label}.effect.evaluator_prompt_id 必须是 ${EVALUATOR_PROMPT_ID}`,
  )
  assertStringArray(effect.questions, `${label}.effect.questions`, { allowEmpty: false })
  for (const forbidden of ['threshold', 'thresholds', 'pass_threshold', 'min_score', 'score', 'cutoff']) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(effect, forbidden),
      `${label}.effect 不得携带数值阈值字段 ${forbidden}（R-2: 阈值 DEFERRED_TO_P07_CALIBRATION）`,
    )
  }
}

function assertInvariantChecks(fixture, label) {
  if (fixture.invariant_checks === undefined) return
  assert.ok(
    Array.isArray(fixture.invariant_checks) && fixture.invariant_checks.length > 0,
    `${label}.invariant_checks 若存在必须是非空数组`,
  )
  for (const [index, check] of fixture.invariant_checks.entries()) {
    const where = `${label}.invariant_checks[${index}]`
    assert.ok(isPlainObject(check), `${where} 必须是对象`)
    assert.ok(isNonEmptyString(check.id), `${where}.id 必须是非空字符串`)
    assert.ok(CANONICAL_CHECKS.has(check.id), `${where}.id=${check.id} 不在 canonical 检查表内`)
    assert.ok(isNonEmptyString(check.desc), `${where}.desc 必须是非空字符串`)
    if (check.params !== undefined) {
      assert.ok(isPlainObject(check.params), `${where}.params 必须是对象`)
    }
    const params = check.params ?? {}
    for (const required of CANONICAL_CHECKS.get(check.id)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(params, required),
        `${where}(id=${check.id}) 缺少必需参数 ${required}`,
      )
    }
  }
}

const combinedGuardText = (fixture) =>
  JSON.stringify({
    invariants: fixture.invariants,
    prohibited_drift: fixture.prohibited_drift,
    invariant_checks: fixture.invariant_checks ?? [],
  })

const hasBlockingGuard = (fixture) =>
  /请先回答|必须先确认|必须先补充|否则无法继续|回答后才能继续|确认后才能继续|等你确认|待你确认|阻塞|non-blocking/i.test(
    combinedGuardText(fixture),
  )

const hasSuggestionGuard = (fixture) => {
  const text = combinedGuardText(fixture)
  return /建议/.test(text) && /(升级|必须|务必|强约束|硬约束|要求|explicit)/.test(text)
}

/** 语料层语义自洽检查:确认该 fixture 真的构成了它声明的那个问题场景。 */
function assertCheckSemantics(fixture, check, context, label) {
  const params = check.params ?? {}
  const where = `${label}#${check.id}`
  switch (check.id) {
    case 'unknown-not-blocking':
      assert.ok(
        hasBlockingGuard(fixture),
        `${where} 必须携带阻止「阻塞式未知项」的 invariant/prohibited_drift`,
      )
      break
    case 'suggested-not-upgraded':
      assert.ok(
        hasSuggestionGuard(fixture),
        `${where} 必须携带阻止建议升级的 invariant/prohibited_drift`,
      )
      break
    case 'unknown-semantic-dedup': {
      assert.ok(isNonEmptyString(params.topic), `${where}.params.topic 必须是非空字符串`)
      assertStringArray(params.aliases, `${where}.params.aliases`, { allowEmpty: false })
      assert.ok(
        params.aliases.length >= 2 && new Set(params.aliases).size === params.aliases.length,
        `${where}.params.aliases 必须至少 2 个互不相同的语义重复表述`,
      )
      for (const alias of params.aliases) {
        assert.ok(
          fixture.raw_input.includes(alias),
          `${where}.params.aliases 中的「${alias}」必须逐字出现在 raw_input 中`,
        )
      }
      break
    }
    case 'partial-quote-not-user-explicit': {
      assert.ok(isNonEmptyString(params.quote), `${where}.params.quote 必须是非空字符串`)
      assert.ok(
        isNonEmptyString(params.claimed_requirement),
        `${where}.params.claimed_requirement 必须是非空字符串`,
      )
      assert.ok(
        fixture.raw_input.includes(params.quote),
        `${where}: quote「${params.quote}」必须逐字存在于 raw_input（部分匹配前提）`,
      )
      assert.ok(
        !fixture.raw_input.includes(params.claimed_requirement),
        `${where}: claimed_requirement 不得逐字存在于 raw_input，否则不构成过度归因`,
      )
      assert.ok(
        params.claimed_requirement.includes(params.quote),
        `${where}: claimed_requirement 必须包含 quote 片段`,
      )
      break
    }
    case 'conflicting-evidence-weighted': {
      for (const key of ['conflict_a', 'conflict_b']) {
        assert.ok(isNonEmptyString(params[key]), `${where}.params.${key} 必须是非空字符串`)
      }
      assert.notEqual(params.conflict_a, params.conflict_b, `${where}: 冲突双方不得相同`)
      assert.ok(
        fixture.raw_input.includes(params.conflict_a) || fixture.raw_input.includes(params.conflict_b),
        `${where}: 至少一方冲突说法必须逐字出现在 raw_input`,
      )
      assert.match(
        combinedGuardText(fixture),
        /冲突|并列|加权|证据强度/,
        `${where}: 必须携带要求并列呈现 / 强度提示的 invariant 或 prohibited_drift`,
      )
      break
    }
    case 'planning-override-contract': {
      assert.equal(
        fixture.manual_override,
        'planning',
        `${where}: 必须声明 manual_override=planning`,
      )
      assert.equal(fixture.expected_type, 'planning', `${where}: expected_type 必须是 planning`)
      assert.equal(params.protocol, FOUR_PART_PROTOCOL, `${where}.params.protocol 必须是 ${FOUR_PART_PROTOCOL}`)
      assert.equal(params.expect_provenance_ok, true, `${where}.params.expect_provenance_ok 必须为 true`)
      assert.deepEqual(
        params.sections,
        defaultStrategyRegistry.getSections('planning'),
        `${where}.params.sections 必须与 planning 策略 required_sections 完全一致`,
      )
      break
    }
    case 'explicit-priority-current-over-historical': {
      assert.ok(
        isNonEmptyString(params.current_override),
        `${where}.params.current_override 必须是非空字符串`,
      )
      assert.ok(
        isNonEmptyString(params.historical_fact),
        `${where}.params.historical_fact 必须是非空字符串`,
      )
      assert.ok(
        fixture.raw_input.includes(params.current_override),
        `${where}: current_override 必须逐字出现在 raw_input`,
      )
      const userTurns = context.filter((turn) => turn.role === 'user')
      assert.ok(
        userTurns.some((turn) => turn.text.includes(params.historical_fact)),
        `${where}: historical_fact 必须存在于历史 user 消息中`,
      )
      assert.ok(
        !fixture.raw_input.includes(params.historical_fact),
        `${where}: historical_fact 不得出现在当前 raw_input，否则不构成「当前覆盖历史」`,
      )
      assert.match(
        combinedGuardText(fixture),
        /沿用|保留/,
        `${where}: 必须携带禁止沿用旧设定的 invariant 或 prohibited_drift`,
      )
      break
    }
    default:
      assert.fail(`${where}: 未实现的 canonical 检查`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 加载 + 逐例 schema 校验
// ─────────────────────────────────────────────────────────────────────────────

const files = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
assert.ok(files.length > 0, 'test/regression/fixtures 下必须存在 JSON 语料')

const fixtures = []
for (const file of files) {
  const label = `fixtures/${file}`
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'))
  assert.ok(isPlainObject(fixture), `${label} 必须是 JSON 对象`)

  assert.ok(isNonEmptyString(fixture.id), `${label}.id 必须是非空字符串`)
  assert.match(fixture.id, ID_RE, `${label}.id 必须匹配 ${ID_RE}`)
  assert.equal(file, `${fixture.id}.json`, `${label} 文件名必须等于 <id>.json`)

  assertStringArray(fixture.tags, `${label}.tags`, { allowEmpty: false })
  assert.equal(new Set(fixture.tags).size, fixture.tags.length, `${label}.tags 不得重复`)
  assert.ok(
    fixture.tags.some((tag) => PRIMARY_TAGS.includes(tag)),
    `${label}.tags 必须至少含一个主标签 ${PRIMARY_TAGS.join('|')}`,
  )

  assert.ok(isNonEmptyString(fixture.raw_input), `${label}.raw_input 必须是非空字符串`)
  assert.ok(
    PROMPT_TYPES.includes(fixture.expected_type),
    `${label}.expected_type=${fixture.expected_type} 不在 PromptType 枚举内`,
  )

  const context = normalizeContext(fixture, label)

  if (fixture.type_alternatives !== undefined) {
    assertStringArray(fixture.type_alternatives, `${label}.type_alternatives`)
    for (const alternative of fixture.type_alternatives) {
      assert.ok(PROMPT_TYPES.includes(alternative), `${label}.type_alternatives 含非法类型 ${alternative}`)
      assert.notEqual(alternative, fixture.expected_type, `${label}.type_alternatives 不得与 expected_type 相同`)
    }
    assert.equal(
      new Set(fixture.type_alternatives).size,
      fixture.type_alternatives.length,
      `${label}.type_alternatives 不得重复`,
    )
  }

  if (fixture.manual_override !== undefined) {
    assert.ok(
      PROMPT_TYPES.includes(fixture.manual_override),
      `${label}.manual_override 不在 PromptType 枚举内`,
    )
  }

  assertInvariants(fixture, label)
  assertStringArray(fixture.prohibited_drift, `${label}.prohibited_drift`, { allowEmpty: false })
  assertInvariantChecks(fixture, label)
  assertEffect(fixture, label)

  for (const check of fixture.invariant_checks ?? []) {
    assertCheckSemantics(fixture, check, context, `${label}`)
  }

  fixtures.push({ ...fixture, context })
}
console.log(`✓ rgs1 schema: ${fixtures.length} 条语料全部合法（id/文件名/正则/context/effect/checks）`)

// ─────────────────────────────────────────────────────────────────────────────
// 2. 语料级覆盖:七类型 + 六 golden + 真实历史 + G-4/G-2 必收 case
// ─────────────────────────────────────────────────────────────────────────────

{
  const ids = fixtures.map((fixture) => fixture.id)
  assert.equal(new Set(ids).size, ids.length, `语料 id 必须唯一:${ids.join(', ')}`)

  const coveredTypes = new Set(fixtures.map((fixture) => fixture.expected_type))
  assert.deepEqual(
    PROMPT_TYPES.filter((type) => !coveredTypes.has(type)),
    [],
    '语料必须覆盖全部七类型（含 general 兜底）',
  )

  const goldenTypes = new Set(
    fixtures
      .filter((fixture) => fixture.tags.includes('golden'))
      .map((fixture) => fixture.expected_type),
  )
  assert.deepEqual(
    GOLDEN_TYPES.filter((type) => !goldenTypes.has(type)),
    [],
    '六 golden examples 必须逐一覆盖 research/planning/execution/diagnostic/review/creative',
  )

  assert.ok(
    fixtures.some((fixture) => fixture.tags.includes('user-history')),
    '语料必须包含用户真实历史需求（tags 含 user-history）',
  )
  console.log('✓ rgs2 覆盖:七类型 + 六 golden + 真实历史需求')
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. cross-strategy invariant 检查表完整挂载
// ─────────────────────────────────────────────────────────────────────────────

{
  const declared = new Set(
    fixtures.flatMap((fixture) => (fixture.invariant_checks ?? []).map((check) => check.id)),
  )
  for (const required of REQUIRED_G4_CHECKS) {
    assert.ok(declared.has(required), `G-4 必收检查缺失:${required}`)
  }
  assert.ok(
    fixtures.some((fixture) => fixture.id === 'planning-historical-fact-true-negative'),
    'G-2 case B(planning-historical-fact-false-positive) 必须入库',
  )
  assert.ok(
    fixtures.some((fixture) => fixture.id === 'creative-storyboard-explicit-override'),
    'G-2 case C(creative-explicit-override-priority) 必须入库',
  )
  console.log('✓ rgs3 invariant_checks:G-4 五项 + G-2 case B/C 全部入库且语义自洽')
}

console.log('\ntest/regression/schema.test.mjs: all regression corpus schema tests passed')
