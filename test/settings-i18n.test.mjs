/**
 * P06-T03 settings 扩展 + i18n 测试(s1..s3)。
 *
 * 覆盖:
 *   s1 Host Config schema 新字段的默认值语义 + volatile 标记 + 宽松接收;
 *   s2 settings-face 统一读写面(0.2.0 configForms / 0.1.x settingsScope)
 *      对新字段 promptType / classifierModel 的读写、快照缓存与优先级回归;
 *   s3 i18n zh/en 键齐套(每键双语齐全,缺译结构上回退中文)+ 新增文案键存在。
 *
 * 运行:先 `npm run build`,再 `node test/settings-i18n.test.mjs`。
 * 本文件场景全部为本项目独立撰写,未复制任何 AGPL 项目(linshenkx / zhangjiazhi)的
 * 源码 / 模板 / 测试。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../lib/index.js'
import { createSettingsFace } from '../lib/client/settings-face.js'

/** volatile 引用 cell(0.2.0)按结构解包;普通值原样返回。 */
const plain = (value) => (value && typeof value.get === 'function' ? value.get() : value)

// ─────────────────────────────────────────────────────────────────────────────
// s1. Config schema:新字段默认值 / volatile / 宽松接收;既有默认值零回归
// ─────────────────────────────────────────────────────────────────────────────
{
  const defaults = plugin.Config({})
  assert.equal(plain(defaults.promptType), 'auto', '默认任务类型必须是 auto')
  assert.equal(plain(defaults.classifierModel), undefined, '分类模型默认未设置(跟随主路由)')
  assert.equal(
    typeof defaults.promptType?.get,
    'function',
    'promptType 必须 .volatile() 声明(0.2.0 宿主据此投影设置表单并原位更新)',
  )
  assert.equal(
    typeof plugin.Config({ classifierModel: 'p/fast' }).classifierModel?.get,
    'function',
    'classifierModel 必须 .volatile() 声明',
  )

  // 既有字段默认值零回归(设置语义不变)。
  assert.equal(plain(defaults.language), 'zh')
  assert.equal(plain(defaults.model), undefined)
  assert.equal(plain(defaults.fallbackModel), undefined)
  assert.equal(plain(defaults.maxTokens), 8192)
  assert.equal(plain(defaults.timeoutSeconds), 120)
  assert.equal(plain(defaults.mode), 'full')
  assert.equal(plain(defaults.reasoningEffort), 'lowest')
  assert.equal(plain(defaults.temperature), 0.2)
  assert.equal(plain(defaults.autoMaxTokens), true)
  assert.equal(plain(defaults.includeContext), true)

  const custom = plugin.Config({ promptType: 'planning', classifierModel: 'p/fast-m' })
  assert.equal(plain(custom.promptType), 'planning')
  assert.equal(plain(custom.classifierModel), 'p/fast-m')

  // 宽松 string schema:旧版/手填的未知默认类型不得让校验抛错(使用处归一化)。
  const loose = plugin.Config({ promptType: 'bogus' })
  assert.equal(plain(loose.promptType), 'bogus', 'schema 应宽松接收未知默认类型,使用处再归一化')
  console.log('✓ s1 Config 新字段默认值 / volatile / 宽松接收 + 既有默认零回归')
}

// ─────────────────────────────────────────────────────────────────────────────
// s2. settings-face:新字段双后端读写回归
// ─────────────────────────────────────────────────────────────────────────────
/** 最小后端 mock(subscribe/getSnapshot/set 三件套)。 */
function makeBackend(initial = {}) {
  const listeners = new Set()
  const writes = []
  const state = { status: 'ready', value: { ...initial }, writable: true }
  return {
    writes,
    state,
    api: {
      subscribe(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      getSnapshot() {
        return state
      },
      async set(key, value) {
        writes.push([key, value])
        state.value = { ...state.value, [key]: value }
        for (const fn of listeners) fn()
      },
    },
  }
}

{
  // 后端未就绪:固定 loading 快照,写入明确拒绝(不静默丢失)。
  const pending = createSettingsFace()
  assert.equal(pending.face.getSnapshot().status, 'loading')
  await assert.rejects(pending.face.set('promptType', 'auto'), /设置服务尚未就绪/)

  // 0.2.0 configForms:读新字段 + 写入转发到 form.set + 快照随之重建。
  const forms = makeBackend({ promptType: 'research', classifierModel: 'fast-p/fast-m' })
  const viaForms = createSettingsFace()
  viaForms.attachForms({ get: () => forms.api }, 'prompt-optimizer')
  const first = viaForms.face.getSnapshot()
  assert.equal(first.status, 'ready')
  assert.equal(first.value.promptType, 'research', 'configForms 快照应带上 promptType')
  assert.equal(first.value.classifierModel, 'fast-p/fast-m', 'configForms 快照应带上 classifierModel')
  assert.equal(viaForms.face.getSnapshot(), first, '状态未变时快照引用必须稳定(React #185 防护)')

  await viaForms.face.set('promptType', 'creative')
  assert.deepEqual(forms.writes.at(-1), ['promptType', 'creative'], '写入应按字段名转发到 form.set')
  const second = viaForms.face.getSnapshot()
  assert.notEqual(second, first, '后端通知后应重建快照引用')
  assert.equal(second.value.promptType, 'creative')

  await viaForms.face.set('classifierModel', 'small-p/small-m')
  assert.deepEqual(forms.writes.at(-1), ['classifierModel', 'small-p/small-m'])
  assert.equal(viaForms.face.getSnapshot().value.classifierModel, 'small-p/small-m')

  // 0.1.x settingsScope:同一面读写新字段。
  const legacy = makeBackend({ promptType: 'planning' })
  const viaLegacy = createSettingsFace()
  viaLegacy.attachLegacy(legacy.api)
  assert.equal(viaLegacy.face.getSnapshot().value.promptType, 'planning')
  await viaLegacy.face.set('classifierModel', 'l-p/l-m')
  assert.deepEqual(legacy.writes.at(-1), ['classifierModel', 'l-p/l-m'])

  // configForms 优先:legacy 后到达不得顶掉 0.2.0 后端。
  const formsPriority = makeBackend({ promptType: 'research' })
  const legacyLate = makeBackend({ promptType: 'general' })
  const mixed = createSettingsFace()
  mixed.attachForms({ get: () => formsPriority.api }, 'prompt-optimizer')
  mixed.attachLegacy(legacyLate.api)
  assert.equal(mixed.face.getSnapshot().value.promptType, 'research', 'configForms 应保持优先')
  await mixed.face.set('promptType', 'execution')
  assert.deepEqual(formsPriority.writes.at(-1), ['promptType', 'execution'], '写入应走优先后端')
  assert.equal(legacyLate.writes.length, 0, 'legacy 后端不得收到写入')
  console.log('✓ s2 settings-face 新字段双后端读写 / 快照缓存 / configForms 优先')
}

// ─────────────────────────────────────────────────────────────────────────────
// s3. i18n:zh/en 键齐套 + 缺译回退结构 + 新增文案键
// ─────────────────────────────────────────────────────────────────────────────
{
  const source = readFileSync(new URL('../src/client/i18n.ts', import.meta.url), 'utf8')
  const enStart = source.indexOf('\n  en: {')
  assert.ok(enStart > 0, 'i18n 字典应含 zh/en 两段')
  const zhPart = source.slice(0, enStart)
  const enPart = source.slice(enStart)
  const collect = (text) => new Set([...text.matchAll(/^\s{4}'([^']+)':/gm)].map((match) => match[1]))
  const zhKeys = collect(zhPart)
  const enKeys = collect(enPart)
  assert.ok(zhKeys.size > 100, 'zh 字典应已收录全部文案')
  assert.ok(enKeys.size > 100, 'en 字典应已收录全部文案')

  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key)).sort()
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key)).sort()
  assert.deepEqual(missingInEn, [], `en 缺译:${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `zh 缺少 en 侧键:${missingInZh.join(', ')}`)

  // P06-T03 新增文案键必须双语齐全。
  const addedKeys = [
    'settings.group.classify',
    'settings.promptType',
    'settings.promptType.desc',
    'settings.classifierModel',
    'settings.classifierModel.desc',
    'settings.classifierModel.follow',
  ]
  for (const key of addedKeys) {
    assert.ok(zhKeys.has(key), `zh 缺少新增文案键:${key}`)
    assert.ok(enKeys.has(key), `en 缺少新增文案键:${key}`)
  }

  // 缺译回退:translate/useT 取值一律 `dict[active][key] ?? dict.zh[key]`,
  // 结构上保证新增文案即使漏译也回退中文(不会显示 undefined)。
  assert.match(
    source,
    /dict\[active\]\[key\] \?\? dict\.zh\[key\]/,
    '取值必须保留「缺译回退中文」结构',
  )
  console.log('✓ s3 i18n zh/en 键齐套 + 新增文案键 + 缺译回退结构')
}

console.log('\nsettings-i18n: all passed')
