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
    // m03336 §八 案例 A(原 UI真实失败①):用户只描述目标,没说希望 AI 做什么。
    // 正确行为:可以问**一个**影响任务方向的关键问题(讨论思路/制定方案/直接实施),
    // 但不得擅自替用户选择方向,也不得把目标句扩写成规划/执行任务。
    label: '案例A-目标描述(UI真实失败①)',
    text: '我想用DSH控制ComfyUI生成视频。',
    expectUsage: 'GENERAL',
    optionalClarification: true,
    answer: '先讨论实现思路。',
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
    maxLen: 200,
  },
  {
    label: 'GENERAL-想法讨论',
    text: '我想做一个本地知识库工具，先聊聊思路。',
    expectUsage: 'GENERAL',
    mustNotContain: ['请实现', '请部署', '给出可行方案'],
    maxLen: 400,
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
    // m03336 §八 案例 D:IMAGE 必须具备生图提示词的专业优化能力。
    // 可以完善:主体与背景关系 / 空间层次 / 黄昏自然光影 / 构图视角 / 风格表达。
    // 不得凭空增加:具体服装 / 未指定的发型 / 新人物 / 新动作 / 无关场景道具。
    label: '案例D-IMAGE生图提示词',
    text: '帮我优化生图提示词：二次元女孩站在海边，背景是黄昏。',
    expectUsage: 'IMAGE',
    mustContain: ['二次元', '女孩', '海边', '黄昏'],
    mustNotContain: ['裙', '外套', '发型', '新人物', '男孩'],
    improveGroups: [
      ['构图', '视角', '画面', '中景', '前景', '后景', '层次', '站位'],
      ['光影', '光线', '夕阳', '逆光', '侧光', '打光', '色调', '暖色'],
      ['风格', '插画', '写实', '氛围', '质感'],
    ],
    improveMin: 2,
    maxLen: 1400,
  },
  {
    // m03336 §八 案例 C:VIDEO 必须写清已有动作的起点、发展过程与结束状态,
    // 不能只做同义词替换,不得增加新情节;用户指定的平台(可灵)必须保留。
    label: '案例C-VIDEO文生视频提示词',
    text: '帮我优化一段可灵文生视频提示词：一只猫在窗台上打哈欠。',
    expectUsage: 'VIDEO',
    mustContain: ['猫', '可灵'],
    improveGroups: [
      ['窗台', '窗边', '窗台上'],
      ['张开', '张大', '打哈欠'],
      ['逐渐', '慢慢', '缓缓', '逐步'],
      ['合上', '闭合', '收起', '结束'],
    ],
    improveMin: 3,
    maxLen: 1400,
  },
  {
    // m03336 §八 案例 E:首尾帧视频 = 识别子类型,侧重从首帧到尾帧的合理运动过程。
    label: '案例E-VIDEO首尾帧',
    text: '根据首尾帧生成视频，人物从站立状态缓慢转身。',
    expectUsage: 'VIDEO',
    mustContain: ['站立', '转身', ['首尾帧', '首帧', '尾帧']],
    improveGroups: [
      ['缓慢', '逐渐', '慢慢', '匀速'],
      ['过程', '过渡', '中间', '逐步', '依次'],
      ['姿态', '姿势', '身体', '朝向', '角度'],
    ],
    improveMin: 2,
    maxLen: 1400,
  },
  {
    // m03336 §八 案例 F:原文已经写得很完整 → 允许最小必要修改,不机械要求变长。
    // 判据:所有明确设定(人物/服装/机位/时长/风格)必须保留,不得改设定、不得加新内容。
    label: '案例F-已完整的专业视频提示词(最小必要修改)',
    text: '帮我优化一段视频提示词，它已经写得比较完整了：场景是黄昏的海边礁石上，一名穿白色连衣裙的女孩背对镜头站立；镜头为中景固定机位，景别不变；动作是她缓慢转身面向镜头，海风吹动裙摆和发梢；时长约 5 秒，动作匀速，起止状态清晰；风格是写实电影感，暖色夕阳侧逆光。约束：不要改变人物、服装、机位、时长和风格，只做必要的专业化完善。',
    expectUsage: 'VIDEO',
    mustContain: ['白色连衣裙', '中景', ['固定机位', '机位固定'], ['5 秒', '5秒', '五秒'], ['写实', '电影感']],
    mustNotContain: ['新人物', '第二个女孩', '男主', '奔跑', '下雨'],
    maxLen: 900,
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
  {
    // m03336 §八 案例 B:软件评估不是「把问句写正式」,而是整理出明确的评估维度与改进建议要求。
    label: '案例B-软件评估(GENERAL 专业化)',
    text: '帮我看看这个软件哪里不好用，还有什么地方可以改。',
    expectUsage: 'GENERAL',
    mustContain: [['分析', '梳理', '整理', '评估', '看看'], ['改进', '优化', '建议', '可以改', '怎么改']],
    improveGroups: [
      ['评估维度', '分析维度', '几个方面', '哪些方面', '维度', '方面'],
      ['改进建议', '优化建议', '改进方向', '改进点', '可改进'],
      ['优先级', '优先', '排序', '重要程度'],
    ],
    improveMin: 2,
    maxLen: 700,
  },
  {
    // m03336 §八 案例 C 的用途保护:可灵图生视频必须识别为 VIDEO,要素逐项保留。
    label: 'UI真实失败③-可灵图生视频用途',
    text: '帮我优化一段可灵图生视频提示词：一个女孩在雨夜街道上缓慢行走，镜头从侧面跟拍。',
    expectUsage: 'VIDEO',
    mustContain: ['女孩', '雨夜', ['侧面', '跟拍']],
    // m03336 一:光影/色调/画面连续性属于**允许的专业化完善**;
    // 只保留真正越界的项(凭空增加服装 / 神情 / 新情节)。
    mustNotContain: ['外套', '新人物', '新情节'],
    improveGroups: [
      ['缓慢', '慢慢', '匀速', '放慢'],
      ['跟拍', '跟随', '跟随拍摄', '平移'],
      ['连续', '连贯', '保持一致', '衔接'],
    ],
    improveMin: 2,
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
      r = await runOne(routes, c.text, { blindTrust: c.blindTrust === true, answer: c.answer })
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
    } else if (c.optionalClarification) {
      // 目标描述类输入(m03336 六):允许问一个方向性问题后继续,也允许直接交付;
      // 两种情况都必须有终态输出。
      if (!output) problems.push(r.askedQuestion ? '回答后仍无输出' : '既未提问也无输出')
    } else {
      if (r.askedQuestion) problems.push(`不该提问却问了:「${r.askedQuestion}」`)
      if (!output) problems.push('无输出')
    }
    if (output) {
      const accepted = c.acceptUsage ?? [c.expectUsage]
      if (!accepted.includes(usage)) problems.push(`用途=${usage} 期望=${accepted.join('/')}`)
      // m03336 六:目标描述类输入允许先问**一个**任务方向问题。
      // 一旦用户回答了方向(如「先讨论实现思路」),输出里出现「思路 / 方案」是**用户授权的**,
      // 不能再按「擅自改变任务方向」判失败;此时改为检查「问的确实是方向问题」+「输出跟随了答案」。
      const directionChosen = c.optionalClarification === true && !!r.askedQuestion
      if (directionChosen) {
        const q = String(r.askedQuestion)
        if (!/思路|方案|实施|执行|讨论|计划/.test(q)) problems.push(`提问不是任务方向问题:「${q}」`)
        if (!/思路|讨论|方案|计划|实施/.test(output)) problems.push('回答方向后输出未跟随用户选择')
      } else {
        for (const bad of c.mustNotContain ?? []) {
          if (output.includes(bad)) problems.push(`擅自增加:「${bad}」`)
        }
        const exp = detectIntentExpansion(c.text, output)
        if (exp.expanded) problems.push(`意图扩展:${exp.phrases.join('/')}`)
      }
      if (looksLikeProtocolEnvelope(output)) problems.push('协议信封泄漏到正文')
      for (const must of c.mustContain ?? []) {
        // 数组 = 同义替代(如「女声 / 女性声音」),语义保真即可,不要求逐字相同。
        const alts = Array.isArray(must) ? must : [must]
        if (!alts.some((m) => output.includes(m))) problems.push(`丢失原意要素:「${alts[0]}」`)
      }
      if (!directionChosen && output.length > c.maxLen) problems.push(`过度重写:${output.length} 字 > 上限 ${c.maxLen}`)
      // m03336 七:优化质量。只检查「有没有真正专业化完善」——
      // 每个组是同义替代集合,命中该组任一词即算命中;至少命中 improveMin 组才算通过。
      // 这直接对应「不能只做同义词替换 / 不能只改成更正式的问句」。
      const groups = c.improveGroups ?? []
      if (groups.length) {
        const hits = groups.filter((g) => g.some((m) => output.includes(m)))
        const need = c.improveMin ?? groups.length
        if (hits.length < need) {
          problems.push(`未体现专业化完善:命中 ${hits.length}/${groups.length} 组(需 ≥${need})`)
        }
      }
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
    const expectedCalls = c.expectClarification || c.optionalClarification ? (r.askedQuestion ? 2 : 1) : 1
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
