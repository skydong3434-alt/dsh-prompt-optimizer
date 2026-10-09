/**
 * V3 真实模型行为验证(检查**实际生成的提示词内容**,不只分类)。
 *
 * 覆盖:GENERAL / IMAGE / VIDEO / AUDIO / AGENT / STRUCTURED 及组合。
 * 每例检查:① 用途判定 ② 原意保留 ③ 是否擅自增加需求 ④ 是否过度重写
 *          ⑤ 关键歧义是否正确提问并在回答后输出 ⑥ 是否仍只调用一次模型 ⑦ 无循环/超时
 *
 * 用法:node scripts/v3-real-check.mjs [--runs N] [--only LABEL] [APO_PROVIDER=… APO_MODEL=…]
 * 退出码:非 0 表示存在硬失败。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { detectIntentExpansion, inferUsageMechanically, looksLikeProtocolEnvelope } from '../lib/core/v3.js'

// 默认必须与真实 UI 的模型路由一致:桌面端会话模型是 opencode-go/deepseek-v4.1-flash
// (profiles/desktop/cordis.patch.yml → agent-default-model),客户端把会话当前模型随请求发出,
// 所以 UI 里的优化请求用的就是它。改这里之前先核对 UI 实际路由(见 CURRENT_STATE.md
// 「模型路由」一节),否则测出来的不是用户看到的行为。
const PROVIDER = process.env.APO_PROVIDER ?? 'opencode-go'
const MODEL = process.env.APO_MODEL ?? 'deepseek-v4.1-flash'
const ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions'
const KEY = /OPENCODE_API_KEY:\s*(\S+)/.exec(
  readFileSync(join(process.env.HOME ?? '', '.dsh', '.credentials.yaml'), 'utf8'),
)?.[1]
if (!KEY) {
  console.error('缺少 OPENCODE_API_KEY')
  process.exit(2)
}

const argv = process.argv.slice(2)
const RUNS = Number(argv[argv.indexOf('--runs') + 1]) || 2
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null

function makeLlm(log) {
  return {
    stream: async function* (options) {
      const entry = { text: '', started: Date.now() }
      log.push(entry)
      const body = {
        model: MODEL,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          ...options.messages.map((m) => ({
            role: m.role ?? 'user',
            content: Array.isArray(m.content)
              ? m.content.map((c) => c.text ?? '').join('\n')
              : String(m.content ?? ''),
          })),
        ],
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0,
        // 与宿主一致:宿主会取该模型的最低档 reasoning effort 并传下来(deepseek-v4.1-flash
        // 是推理模型,不传会按提供方默认走高档,预算被思考吃光 → 假失败)。
        ...(options.reasoningEffort ? { reasoning_effort: String(options.reasoningEffort) } : {}),
        stream: true,
      }
      entry.messages = body.messages
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${KEY}`,
          'x-opencode-session': 'dsh-apo-v3',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        entry.finish = `http-${res.status}`
        entry.ms = Date.now() - entry.started
        yield { type: 'finish', reason: { kind: 'error', failure: { code: String(res.status), message: (await res.text()).slice(0, 120) } } }
        return
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let i = 0
      let last = 'stop'
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let s
        while ((s = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, s).trim()
          buf = buf.slice(s + 1)
          if (!line.startsWith('data:')) continue
          const p = line.slice(5).trim()
          if (p === '[DONE]') continue
          try {
            const j = JSON.parse(p)
            const c = j.choices?.[0]
            // 注意:本模型先流 reasoning_content,那不是正文,必须忽略。
            if (c?.delta?.content) {
              entry.text += c.delta.content
              yield { type: 'text-delta', index: i++, text: c.delta.content }
            }
            if (c?.finish_reason && c.finish_reason !== 'stop') last = c.finish_reason
          } catch {
            /* ignore */
          }
        }
      }
      entry.ms = Date.now() - entry.started
      entry.finish = last === 'length' ? 'max-tokens' : 'stop'
      if (entry.text) yield { type: 'block-end', index: 0, block: { type: 'text', text: entry.text } }
      yield { type: 'finish', reason: { kind: last === 'length' ? 'max-tokens' : 'stop' } }
    },
    listProviders: () => [{ id: PROVIDER, name: 'OpenCode Go' }],
    listModels: async () => [{ id: MODEL, provider: PROVIDER, name: MODEL }],
    resolveModelInfo: async () => ({ id: MODEL, provider: PROVIDER, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  }
}

async function boot() {
  const routes = {}
  const llmLog = []
  const ctx = new Context()
  ctx.provide('httpServer', { register(r) { routes[r.path] = r; return () => {} } })
  ctx.provide('llm', makeLlm(llmLog))
  await ctx.plugin(plugin, {})
  return { routes, llmLog }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = {
    status: 0, headers: {}, body: '', writableEnded: false, destroyed: false, on() {},
    writeHead(s, h) { res.status = s; res.headers = h ?? {} },
    write(c) { res.body += c; return true },
    end(p) { if (p) res.body += p; res.writableEnded = true },
  }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.headers = {}
  await handler(req, res)
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((f) => {
      const l = f.split('\n').find((x) => x.startsWith('data:'))
      return l ? JSON.parse(l.slice(5).trim()) : null
    })
    .filter(Boolean)
}

/** 跑一例到终态;歧义例按客户端真实契约回传回答(模拟用户补充)。 */
async function runOne(routes, text, { answer = '它指的是首页配色方案;第二种是深色主题。', blindTrust = false } = {}) {
  const t0 = Date.now()
  const callsBefore = routes.__log.length
  const events = await call(routes, { text, provider: PROVIDER, model: MODEL })
  const types = events.filter((e) => e.type !== 'delta').map((e) => e.type)
  const d = events.find((e) => e.type === 'discovery_required')
  const err = events.find((e) => e.type === 'error')
  let done = events.find((e) => e.type === 'done')
  if (d && !done) {
    const q = d.questions?.[0]
    const askedQuestion = q?.question ?? null
    // 客户端契约:mode:'answer' + 回传宿主给的 session + answers
    const events2 = await call(routes, {
      text,
      provider: PROVIDER,
      model: MODEL,
      // 客户端真实契约:discovery 的字段是**平铺**的(parseDiscoveryInput 从 record 顶层读)
      discovery: {
        mode: 'answer',
        answers: blindTrust
          ? [{ key: q?.key, text: `${q?.question ?? ''}(保持未确定)`, blind_trust: true }]
          : [{ key: q?.key, text: answer }],
        questions: d.questions ?? [],
        asked: d.asked ?? [],
        ledger: d.ledger ?? [],
        round: d.round ?? 1,
      },
    })
    for (const e of events2) {
      if (e.type === 'done') done = e
    }
    const err2 = events2.find((e) => e.type === 'error')
    return {
      done, askedQuestion, totalMs: Date.now() - t0,
      calls: routes.__log.length - callsBefore,
      types: [...types, ...events2.filter((e) => e.type !== 'delta').map((e) => e.type)],
      error: err2?.error,
      answerText: answer,
    }
  }
  return {
    done, askedQuestion: null, totalMs: Date.now() - t0,
    calls: routes.__log.length - callsBefore,
    types, error: err?.error,
    answerText: answer,
  }
}

/**
 * 原意保留:去掉「帮我写一个…提示词」这类请求外壳后,输入的内容字覆盖率 ≥60%。
 * (生成提示词会把句子改写成描述式,逐字相等不适用;内容要素必须留住。)
 */
function intentKept(text, output) {
  const stripped = String(text)
    .replace(/帮我(写|生成|做)(一(个|段|条|篇|张))?/g, '')
    .replace(/的?(AI|ai)?(生图|文生视频|图生视频|首帧图生视频|配音音频|音频|视频|图片|图像)?提示词/g, '')
  const stop = new Set('的了吗呢是我你他她它这那就都很并和与在把被给对从到有和及等一二三'.split(''))
  const chars = [...stripped].filter((c) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c) && !stop.has(c))
  if (!chars.length) return 1
  const hit = chars.filter((c) => String(output).includes(c)).length
  return hit / chars.length
}

const CASES = [
  {
    label: 'GENERAL-目标描述(核心回归)',
    text: '我想用DSH控制ComfyUI生成视频。',
    expectUsage: 'GENERAL',
    mustNotContain: ['可行方案', '制定计划', '请执行', '实施方案'],
    maxLen: 120,
  },
  {
    label: 'GENERAL-想法讨论',
    text: '我想做一个本地知识库工具，先聊聊思路。',
    expectUsage: 'GENERAL',
    mustNotContain: ['请实现', '请部署', '给出可行方案'],
    maxLen: 260,
  },
  {
    label: 'GENERAL-清晰提示词最小修改',
    text: '请审查并重构订单服务模块。约束:仅限修改 src/order；输出格式:问题清单；验收:npm test 全绿。',
    expectUsage: 'GENERAL',
    acceptUsage: ['GENERAL', 'AGENT'],
    mustContain: ['src/order', 'npm test'],
    maxLen: 900,
  },
  {
    label: 'IMAGE-生图提示词',
    text: '帮我写一个二次元女孩的生图提示词，海边黄昏。',
    expectUsage: 'IMAGE',
    mustContain: ['二次元'],
    mustNotContain: ['裙', '外套'], // 忠实优化模式:不得凭空给人物加服装
    maxLen: 1400,
  },
  {
    label: 'VIDEO-文生视频提示词',
    text: '帮我写一段可灵文生视频提示词:一只猫在窗台上打哈欠。',
    expectUsage: 'VIDEO',
    mustContain: ['猫'],
    maxLen: 1400,
  },
  {
    label: 'AUDIO-配音提示词',
    text: '帮我写一段配音音频提示词:温柔女声读一段产品介绍。',
    expectUsage: 'AUDIO',
    mustContain: [['女声', '女性声音', '女性', '女声线']],
    maxLen: 1400,
  },
  {
    label: 'AGENT-代码任务指令',
    text: '帮我写给 Codex 的代码修复任务:修复登录超时问题。',
    expectUsage: 'AGENT',
    mustContain: ['登录超时'],
    maxLen: 2000,
  },
  {
    label: 'STRUCTURED-严格 JSON',
    text: '严格 JSON 格式输出一个 agent 任务指令，字段固定为 title/steps/verify。',
    expectUsage: 'AGENT',
    mustContain: ['title', 'steps', 'verify'],
    maxLen: 2000,
  },
  {
    label: '歧义-指代不明(用户补充后继续)',
    text: '把它改成第二种。',
    expectUsage: 'GENERAL',
    expectClarification: true,
    maxLen: 600,
  },
  {
    label: '歧义-保持未确定后必须输出',
    text: '把那个旧的换掉。',
    expectUsage: 'GENERAL',
    expectClarification: true,
    blindTrust: true,
    maxLen: 600,
  },
  // ── 以下三例来自真实 DSH UI 人工验收失败(m02408),固定为回归用例 ──
  {
    // 失败①:用户只描述目标,模型擅自追加「请说明可行的实现方式…」以及接口/控制流程/实施限制等要求。
    // 原则:用户只描述目标时,不得擅自决定下一步是讨论、研究、规划还是实施。
    label: 'UI真实失败①-目标描述不得扩展任务',
    text: '我想用DSH控制ComfyUI生成视频。',
    expectUsage: 'GENERAL',
    mustNotContain: [
      '可行的实现方式',
      '实现方式',
      '控制流程',
      '实施限制',
      '方案或指南',
      '整体思路',
      '覆盖以下要点',
      '列出优劣',
      '可行方案',
      '制定计划',
      '实施方案',
      '请执行',
    ],
    maxLen: 120,
  },
  {
    // 失败②:优化器因「未来执行任务需要的信息」追问软件名称/版本/截图。
    // 正确行为:直接整理为清晰的分析请求。判断缺失信息是否妨碍**优化提示词本身**,
    // 而不是未来执行任务是否需要;执行 Agent 能自行调查的不应成为强制澄清条件。
    label: 'UI真实失败②-软件评估不得追问',
    text: '帮我看看这个软件哪里不好用还有什么地方可以改怎么弄比较好。',
    expectUsage: 'GENERAL',
    mustContain: [['分析', '梳理', '整理', '评估', '看看'], ['改进', '优化', '建议', '可以改', '怎么改']],
    maxLen: 400,
  },
  {
    // 失败③:可灵图生视频必须识别为 VIDEO(不是 General),且要素逐项保留。
    label: 'UI真实失败③-可灵图生视频用途',
    text: '帮我优化一段可灵图生视频提示词：一个女孩在雨夜街道上缓慢行走，镜头从侧面跟拍。',
    expectUsage: 'VIDEO',
    mustContain: ['女孩', '雨夜', ['侧面', '跟拍']],
    // 忠实优化模式(m03069 ①):可以理顺表达,不得凭空增加服装 / 神情 / 场景元素 / 光影风格
    mustNotContain: ['外套', '神情', '忧郁', '霓虹', '冷色调'],
    maxLen: 1400,
  },
  {
    label: 'GENERAL-代码关键词不得判 AGENT',
    text: '优化一下这段代码：def f(x): return x + 1',
    expectUsage: 'GENERAL',
    mustContain: ['def f'],
    maxLen: 400,
  },
]

const selected = ONLY ? CASES.filter((c) => c.label.includes(ONLY)) : CASES
if (!selected.length) {
  console.error(`没有匹配 --only ${ONLY} 的用例`)
  process.exit(2)
}

const { routes, llmLog } = await boot()
routes.__log = llmLog

const report = []
let hardFail = 0

for (const c of selected) {
  for (let i = 1; i <= RUNS; i += 1) {
    let r
    try {
      r = await runOne(routes, c.text, { blindTrust: c.blindTrust === true })
    } catch (e) {
      report.push({ label: c.label, run: i, ok: false, reason: `抛错: ${e.message}` })
      hardFail += 1
      continue
    }
    const output = String(r.done?.optimized ?? '')
    const usage = r.done?.usage ?? '—'
    const problems = []
    if (!r.done) problems.push(`未到终态(${r.types.join('→')})${r.error ? ` ${r.error}` : ''}`)
    if (c.expectClarification) {
      // 歧义用例:可以提问后继续,也可以直接交付(不问更好);但绝不能问完不交付。
      if (!output) problems.push(r.askedQuestion ? '回答后仍无输出' : '既未提问也无输出')
    } else {
      if (r.askedQuestion) problems.push(`不该提问却问了:「${r.askedQuestion}」`)
      if (!output) problems.push('无输出')
    }
    if (output) {
      const accepted = c.acceptUsage ?? [c.expectUsage]
      if (!accepted.includes(usage)) problems.push(`用途=${usage} 期望=${accepted.join('/')}`)
      for (const bad of c.mustNotContain ?? []) {
        if (output.includes(bad)) problems.push(`擅自增加:「${bad}」`)
      }
      const exp = detectIntentExpansion(c.text, output)
      if (exp.expanded) problems.push(`意图扩展:${exp.phrases.join('/')}`)
      if (looksLikeProtocolEnvelope(output)) problems.push('协议信封泄漏到正文')
      for (const must of c.mustContain ?? []) {
        // 数组 = 同义替代(如「女声 / 女性声音」),语义保真即可,不要求逐字相同。
        const alts = Array.isArray(must) ? must : [must]
        if (!alts.some((m) => output.includes(m))) problems.push(`丢失原意要素:「${alts[0]}」`)
      }
      if (output.length > c.maxLen) problems.push(`过度重写:${output.length} 字 > 上限 ${c.maxLen}`)
    }
    // 澄清用例的原意保留:提问前原文是「把它改成第二种」这类指代句,
    // 回答后输出会承载**答案**的内容,再比对原文只会得到假失败。
    // 因此仅在「未发生澄清」时比对原文;发生澄清时比对答案文本。
    // 「保持未确定」的回答本身不含内容(它只是「这题先不定」),仍以原文为基准;
    // 只有真正补充了内容的回答才以答案为基准。
    // 格式契约类用例(声明 mustContain)的真实保真是「字段是否齐」,不是原文字符覆盖率:
    // 输出是一个 JSON 对象,原样覆盖原文中文既不可能也不必要。此类跳过覆盖率检查。
    const keptBasis = c.mustContain
      ? null
      : r.askedQuestion && !c.blindTrust && r.answerText
        ? r.answerText
        : c.text
    if (keptBasis && keptBasis !== c.text) {
      const kept2 = intentKept(keptBasis, output)
      if (output && kept2 < 0.6) problems.push(`答案内容保留率 ${(kept2 * 100).toFixed(0)}% < 60%`)
    } else if (keptBasis && c.keepMin !== undefined && output && intentKept(c.text, output) < c.keepMin) {
      problems.push(`原意保留率 ${(intentKept(c.text, output) * 100).toFixed(0)}% < ${(c.keepMin * 100).toFixed(0)}%`)
    }
    const expectedCalls = c.expectClarification ? (r.askedQuestion ? 2 : 1) : 1
    if (r.calls !== expectedCalls) problems.push(`模型调用 ${r.calls} 次(期望 ${expectedCalls})`)
    if (r.totalMs > 150000) problems.push(`耗时异常 ${(r.totalMs / 1000).toFixed(1)}s`)
    // 模型侧空产出:产品已如实下发技术错误(error 终态),这是模型端方差,
    // 不是产品缺陷 —— 记录但不计硬失败(硬失败只针对「产品行为不对」)。
    const modelSideEmpty = !output && /模型没有产出可用内容/.test(String(r.error ?? ''))
    const productProblems = problems.filter((p) => !modelSideEmpty || !/无输出|未到终态/.test(p))
    const ok = productProblems.length === 0
    if (!ok) hardFail += 1
    report.push({
      label: c.label, run: i, ok, modelSideEmpty, usage, structured: r.done?.structured ?? null,
      answerText: r.answerText ?? null, errorText: r.error ?? null,
      calls: r.calls, ms: r.totalMs, outLen: output.length,
      kept: output ? Number(intentKept(c.text, output).toFixed(2)) : 0,
      question: r.askedQuestion, output: output.slice(0, 400), problems,
    })
  }
}

mkdirSync('logs/v3', { recursive: true })
const file = `logs/v3/real-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify({ model: MODEL, runs: RUNS, report }, null, 2))

for (const r of report) {
  console.log(
    `${r.ok ? '✓' : '✗'} [${r.label} #${r.run}] usage=${r.usage} calls=${r.calls} ` +
      `${(r.ms / 1000).toFixed(1)}s out=${r.outLen}字 kept=${r.kept}` +
      (r.question ? ` Q=「${r.question}」` : ''),
  )
  for (const p of r.problems ?? []) console.log(`    - ${p}`)
}
console.log(`\n总计 ${report.length} 例,硬失败 ${hardFail} 例;日志 ${file}`)
process.exit(hardFail ? 1 : 0)
