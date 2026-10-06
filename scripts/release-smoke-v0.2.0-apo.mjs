/**
 * v0.2.0-apo Release Smoke —— 用**准备发布的构建**驱动真实宿主处理器(与 Desktop UI 调用的
 * 同一条路由 `/dsh-prompt-optimizer/optimize`),覆盖 8 条用户路径 A–H。
 *
 * 说明:本脚本验证的是**产品代码 + 真实模型**的端到端行为(宿主 handler / 路由 / 分析 /
 * 编译 / 校验 / SSE 事件序)。真实 **GUI 点击**路径需由用户在 DSH Desktop 里确认
 * (浏览器信任围栏禁止外部注入),对应步骤写在 docs/release-smoke-v0.2.0-apo.md。
 *
 * 用法:node scripts/release-smoke-v0.2.0-apo.mjs
 * 凭据:只从 ~/.dsh/.credentials.yaml 读,绝不打印。
 */
import { Readable } from 'node:stream'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const MODEL = 'deepseek-v4-flash'
const KEY = /OPENCODE_API_KEY:\s*(\S+)/.exec(readFileSync(join(process.env.HOME ?? '', '.dsh', '.credentials.yaml'), 'utf8'))?.[1]

function makeLlm() {
  return {
    async *stream(options) {
      const body = {
        model: MODEL,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          ...options.messages.map((m) => ({
            role: 'user',
            content: Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join('\n') : String(m.content ?? ''),
          })),
        ],
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0,
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        stream: true,
      }
      const resp = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-opencode-session': 'dsh-apo-release-smoke' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: String(resp.status), message: (await resp.text()).slice(0, 160) } } }
        return
      }
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let index = 0
      let last = 'stop'
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let sep
        while ((sep = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, sep).trim()
          buf = buf.slice(sep + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload)
            const choice = json.choices?.[0]
            if (choice?.delta?.content) yield { type: 'text-delta', index: index++, text: choice.delta.content }
            if (choice?.finish_reason && choice.finish_reason !== 'stop') last = choice.finish_reason
          } catch {
            /* ignore */
          }
        }
      }
      yield { type: 'finish', reason: { kind: last === 'length' ? 'max-tokens' : 'stop' } }
    },
    listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
    listModels: async () => [{ id: MODEL, provider: 'opencode-go', name: MODEL }],
    resolveModelInfo: async () => ({ id: MODEL, provider: 'opencode-go', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  }
}

async function boot() {
  const routes = {}
  const calls = []
  const llmLog = []
  const ctx = new Context()
  ctx.provide('httpServer', {
    register(r) {
      routes[r.path] = r
      return () => {}
    },
  })
  ctx.provide('llm', {
    async *stream(options) {
      calls.push(options)
      const kind = isMeta(options.system) ? 'analysis' : 'compile'
      const entry = { kind, finish: 'stop', textLen: 0 }
      llmLog.push(entry)
      for await (const chunk of makeLlm().stream(options)) {
        if (chunk.type === 'text-delta') entry.textLen += chunk.text.length
        if (chunk.type === 'finish') entry.finish = chunk.reason?.kind ?? 'stop'
        yield chunk
      }
    },
    listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
    listModels: async () => [{ id: MODEL, provider: 'opencode-go', name: MODEL }],
    resolveModelInfo: async () => ({ id: MODEL, provider: 'opencode-go', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  })
  await ctx.plugin(plugin, {})
  return { routes, calls, llmLog }
}

async function call(routes, body) {
  const handler = routes['/dsh-prompt-optimizer/optimize'].handler
  const res = {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    on() {},
    writeHead(s, h) {
      res.status = s
      res.headers = h ?? {}
    },
    write(c) {
      res.body += c
      return true
    },
    end(p) {
      if (p) res.body += p
      res.writableEnded = true
    },
  }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.headers = {}
  await handler(req, res)
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      return line ? JSON.parse(line.slice(5).trim()) : null
    })
    .filter(Boolean)
}

/**
 * 走完整真实闭环(与 UI 一致):optimize → 最多 3 轮 Discovery 问答 → confirm → done。
 * 每一轮都把「新提出的问题」按推荐项回答(无选项的机械决策项用「按你的判断继续」)。
 */
async function runFullFlow(routes, text, { maxRounds = 3 } = {}) {
  const stages = []
  const calls = []
  let events = await call(routes, { text, provider: 'opencode-go', model: MODEL })
  calls.push(events)
  let discovery = events.find((e) => e.type === 'discovery_required')
  let confirmation = events.find((e) => e.type === 'requirement_confirmation')
  let done = events.find((e) => e.type === 'done')
  stages.push(discovery ? 'analyzing→discovery_required' : confirmation ? 'requirement_confirmation' : done ? 'compiling→validating→complete' : '(none)')
  let round = 0
  let ledger = discovery?.ledger ?? confirmation?.ledger ?? []
  let analysis = discovery?.analysis ?? confirmation?.analysis ?? null
  let asked = discovery?.asked ?? confirmation?.asked ?? []
  let questions = discovery?.questions ?? []
  let triage = discovery?.triage?.triage ?? confirmation?.triage?.triage ?? 'REBUILD'
  // +1:轮次上限用尽后仍需再走一次 confirm(否则停在确认页,无法进入编译)
  // 步数预算 = 轮次上限 + 2(轮次用尽后仍需:一次 confirm + 一次可能的回流终态)
  while (!done && (discovery || confirmation) && round < maxRounds + 2) {
    round += 1
    if (discovery) {
      const answers = (discovery.questions ?? []).map((q) => {
        const pick = q.options.find((o) => o.id === q.recommended_option_id) ?? q.options[0]
        return pick
          ? { key: q.key, option_id: pick.id, text: pick.label }
          : { key: q.key, text: '按你的判断继续', blind_trust: true }
      })
      events = await call(routes, {
        text,
        provider: 'opencode-go',
        model: MODEL,
        discovery: { mode: 'answer', round, triage, ledger, asked, questions, answers, analysis },
      })
    } else {
      events = await call(routes, {
        text,
        provider: 'opencode-go',
        model: MODEL,
        discovery: { mode: 'confirm', round, triage, ledger, asked, answers: [], questions: [], analysis },
      })
    }
    calls.push(events)
    done = events.find((e) => e.type === 'done')
    discovery = events.find((e) => e.type === 'discovery_required')
    confirmation = events.find((e) => e.type === 'requirement_confirmation')
    stages.push(done ? 'compiling→validating→complete' : discovery ? `discovery_required(round ${round + 1})` : confirmation ? 'requirement_confirmation' : '(none)')
    ledger = discovery?.ledger ?? confirmation?.ledger ?? ledger
    analysis = discovery?.analysis ?? confirmation?.analysis ?? analysis
    asked = discovery?.asked ?? confirmation?.asked ?? asked
    questions = discovery?.questions ?? []
  }
  return { calls, events, done, discovery, confirmation, stages, ledger, analysis, rounds: round }
}

const ONLY = null
const results = []

/** 终态取证:最后一次事件类型 + 错误/回流原因码 + LLM 调用画像。 */
function terminalOf(events, llmLog) {
  const nonDelta = events.filter((e) => e.type !== 'delta')
  const last = nonDelta[nonDelta.length - 1]
  const err = nonDelta.find((e) => e.type === 'error')
  const ret = nonDelta.find((e) => e.type === 'returned')
  return {
    lastEvent: last?.type ?? '(none)',
    sequence: nonDelta.map((e) => e.type).join(','),
    errorCode: err?.reason_code ?? err?.error ?? null,
    returnedCode: ret ? `${ret.action}/${ret.reason_code}` : null,
    llm: (llmLog ?? []).map((l) => `${l.kind}:${l.finish}:${l.textLen}`).join(' | '),
  }
}

/**
 * 定性:PROVIDER_TRANSIENT(外部瞬时)还是 PRODUCT_DEFECT(内部缺陷)。
 * 判据:LLM 调用出现 max-tokens/error 或空产出 → 外部;否则若终态不是明确终态 → 产品。
 */
function classify(events, llmLog) {
  const t = terminalOf(events, llmLog)
  const providerIssue = (llmLog ?? []).some((l) => l.finish !== 'stop' || l.textLen === 0)
  const hasTerminal = ['done', 'discovery_required', 'requirement_confirmation', 'error', 'returned', 'cancelled'].includes(t.lastEvent)
  if (providerIssue && (t.lastEvent === 'error' || t.lastEvent === 'done' || !hasTerminal)) return 'PROVIDER_TRANSIENT'
  if (!hasTerminal) return 'PRODUCT_DEFECT'
  return 'OK'
}
function record(path, name, pass, evidence) {
  results.push({ path, name, pass, evidence })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${path}  ${name}\n      ${evidence.replace(/\n/g, ' ').slice(0, 220)}`)
}

const isMeta = (system) => /意图编译器分析器|intent compiler analyzer/.test(String(system ?? ''))

// ── A. KEEP:完整 Prompt → 逐字保持 ─────────────────────────────────────────
const KEEP_INPUT = [
  '你是一名资深后端工程师,请审查并重构订单服务模块。',
  '',
  '要求:',
  '1. 保持对外 HTTP 接口签名完全不变,不得改动任何路由路径。',
  '2. 数据库迁移必须可回滚,禁止在迁移里删除字段。',
  '3. 所有新增逻辑必须带单元测试,覆盖率不低于 80%。',
  '',
  '约束:',
  '- 仅限修改 src/order 目录下的文件,不要动其他模块。',
  '- 依赖版本不得升级。',
  '',
  '输出格式:先给出问题清单(每条含文件路径与行号),再给出改动后的代码。',
  '',
  '验收标准:',
  '- npm test 全绿;',
  '- 现有 API 契约测试全部通过。',
].join('\n')
{
  const { routes, calls } = await boot()
  const events = await call(routes, { text: KEEP_INPUT, provider: 'opencode-go', model: MODEL })
  const done = events.find((e) => e.type === 'done')
  const compileCalls = calls.filter((o) => !isMeta(o.system)).length
  record(
    'A',
    'KEEP:完整 Prompt → 原文逐字保持',
    done?.optimized === KEEP_INPUT && compileCalls === 0,
    `triage=${done?.triage?.triage} 逐字一致=${done?.optimized === KEEP_INPUT} 编译调用=${compileCalls} 字数=${done?.optimized?.length}`,
  )
}

// ── B. PATCH:已有结构 + 少量缺陷 → 只局部修补 ──────────────────────────────
{
  const PATCH_INPUT = ['1. 先跑一遍测试', '2. 再看失败日志', '3. 输出格式:Markdown 表格'].join('\n')
  const { routes } = await boot()
  const flow = await runFullFlow(routes, PATCH_INPUT)
  const out = String(flow.done?.optimized ?? '')
  const keyTerms = ['先跑一遍测试', '失败日志', 'Markdown']
  const keptItems = keyTerms.filter((k) => out.includes(k)).length >= 2
  record(
    'B',
    'PATCH:只局部修补(保留原有条目与措辞)',
    flow.done?.triage?.triage === 'PATCH' && keptItems,
    `triage=${flow.done?.triage?.triage} 原条目保留=${keptItems} 字数 ${PATCH_INPUT.length}→${out.length} | 闭环 ${flow.stages.join(' → ')}`,
  )
}

// ── C. RESTRUCTURE:信息完整但组织混乱 → 重新整理 ───────────────────────────
{
  const MESSY = [
    '帮我做个小工具,要求是能读 csv 然后汇总,输出格式要 markdown 表格,输出格式要 markdown 表格,',
    '另外要快一点别卡,另外要快一点别卡,字段要能自动识别,字段要能自动识别,不用装数据库,不用装数据库,',
    '最好支持中文列名,最好支持中文列名,跑完给个总数,跑完给个总数,别的先不用管,别的先不用管。',
  ].join(' ')
  const { routes, llmLog } = await boot()
  const flow = await runFullFlow(routes, MESSY)
  const out = String(flow.done?.optimized ?? '')
  const noNewGoals = !/(微服务|数据库集群|权限系统|多用户|部署到云)/.test(out)
  const t = terminalOf(flow.calls[flow.calls.length - 1], flow.llmLog)
  record(
    'C',
    'RESTRUCTURE:重新整理且不新增用户提过的目标',
    flow.done?.triage?.triage === 'RESTRUCTURE' && noNewGoals && out.length > 0,
    `triage=${flow.done?.triage?.triage} 未新增目标=${noNewGoals} 字数 ${MESSY.length}→${out.length} | 闭环 ${flow.stages.join(' → ')} | 终态=${t.lastEvent}(${t.sequence}) err=${t.errorCode ?? '-'} ret=${t.returnedCode ?? '-'} | llm=${t.llm} | 定性=${classify(flow.calls[flow.calls.length - 1], flow.llmLog)}`,
  )
}

// ── D. REBUILD + Discovery:完整六态闭环,Discovery 前编译 0 ────────────────
const COMFY = '我想用 dsh 控制 comfyui 生成视频。'
{
  const { routes, calls } = await boot()
  const first = await call(routes, { text: COMFY, provider: 'opencode-go', model: MODEL })
  const discovery = first.find((e) => e.type === 'discovery_required')
  const compileBeforeDiscovery = calls.filter((o) => !isMeta(o.system)).length
  const flow = await runFullFlow(routes, COMFY)
  const confirmation = flow.calls.flat().find((e) => e.type === 'requirement_confirmation')
  const done = flow.done
  const goal = String(confirmation?.confirmation?.goal ?? '')
  const goalIsUserGoal = /我想用 dsh 控制 comfyui 生成视频/.test(goal)
  const goalHasNoDiagnosis = !/(目标陈述|最小补齐|triage|REBUILD|诊断)/.test(goal)
  const askedTexts = (first.find((e) => e.type === 'discovery_required')?.questions ?? []).map((q) => q.question)
  const agentItemsNotAsked = (confirmation?.confirmation?.agent_researches ?? []).every((item) => !askedTexts.includes(item))
  record(
    'D',
    'REBUILD + Discovery:六态闭环 / Discovery 前编译 0 / 目标与答案正确',
    compileBeforeDiscovery === 0 && Boolean(discovery) && Boolean(confirmation) && Boolean(done) && goalIsUserGoal && goalHasNoDiagnosis && agentItemsNotAsked,
    `状态序 analyzing→discovery_required → ${flow.stages.filter((x) => x !== 'analyzing→discovery_required').join(' → ')} | Discovery 前编译=${compileBeforeDiscovery} | 目标=「${goal.slice(0, 46)}」 | 无诊断=${goalHasNoDiagnosis} | 自查项未被问=${agentItemsNotAsked} | 最终字数=${done?.optimized?.length}`,
  )
}

// ── E. Image Prompt:自动进入 Image contract,无 Agent 任务模板 ──────────────
{
  const IMAGE_INPUT = '二次元女孩坐在未来 AI 工作台前,三栏桌面布局,冷蓝色屏幕光,帮我生成生图提示词。'
  const { routes, llmLog } = await boot()
  const flow = await runFullFlow(routes, IMAGE_INPUT)
  const done = flow.done
  const out = String(done?.optimized ?? '')
  const noTaskTemplate = !/(^|\n)\s*#{0,6}\s*\**\s*(Goal|Phase|Tasks?|Acceptance|Definition of Done)\b/im.test(out)
  const t = terminalOf(flow.calls[flow.calls.length - 1], flow.llmLog)
  record(
    'E',
    'Image:自动 Image contract,不出现 Agent 任务模板',
    done?.contract === 'image' && noTaskTemplate && out.length > 0,
    `contract=${done?.contract} target=${done?.target?.target} 无任务模板=${noTaskTemplate} 字数=${out.length} | 闭环 ${flow.stages.join(' → ')} | 终态=${t.lastEvent}(${t.sequence}) err=${t.errorCode ?? '-'} ret=${t.returnedCode ?? '-'} | llm=${t.llm} | 定性=${classify(flow.calls[flow.calls.length - 1], flow.llmLog)}`,
  )
}

// ── F. Video / Kling:自动识别 Video + Kling,描述式 Prompt ─────────────────
{
  const VIDEO_INPUT = '根据这张首帧写可灵视频提示词,让人物拔刀向前冲,镜头持续后拉。'
  const { routes } = await boot()
  const flow = await runFullFlow(routes, VIDEO_INPUT)
  const done = flow.done
  const out = String(done?.optimized ?? '')
  const noTaskTemplate = !/(^|\n)\s*#{0,6}\s*\**\s*(Goal|Phase|Tasks?|Acceptance|Definition of Done)\b/im.test(out)
  record(
    'F',
    'Video/Kling:自动识别 Video + Kling,描述式 Prompt',
    done?.contract === 'video' && done?.target?.engine?.id === 'kling' && noTaskTemplate && out.length > 0,
    `contract=${done?.contract} engine=${done?.target?.engine?.id} 无任务模板=${noTaskTemplate} 字数=${out.length}`,
  )
}

// ── G. Hard constraint:「只检查,不修改任何文件。」不得被突破 ────────────────
{
  const HARD_INPUT = '帮我看看这段代码有没有并发问题。只检查,不修改任何文件。'
  const { routes } = await boot()
  const flow = await runFullFlow(routes, HARD_INPUT)
  const out = String(flow.done?.optimized ?? '')
  const keepsConstraint = /不(?:要|得|允许)?\s*(?:修改|改动|写入|变更)|只(?:做)?检查|保持现状|不产生(?:任何)?(?:写入|改动)/.test(out)
  // 否定感知:「不得/不要/禁止 直接修改」是在**守住**约束,不是越权
  const noEditInstruction = !/(?<![不没禁勿])(?<!不要)(?<!不得)(?<!禁止)(直接修改|立即修复并提交|提交补丁|自动修复)/.test(out)
  record(
    'G',
    'Hard constraint:不修改文件约束不得被突破',
    Boolean(flow.done) && keepsConstraint && noEditInstruction,
    `含只检查/不改动约束=${keepsConstraint} 无越权改写指令=${noEditInstruction} 字数=${out.length} | 闭环 ${flow.stages.join(' → ')}`,
  )
}

// ── H. Re-optimize:只改无关措辞 → still-valid 保留、不重复问 ────────────────
{
  const { routes } = await boot()
  const base = '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路。'
  const flow = await runFullFlow(routes, base)
  const ledger = flow.ledger
  // 仅改无关措辞(句尾加一句口头语),其余不变
  const reworded = '我想用 dsh 控制 comfyui 生成视频,已经有 workflow,先验证控制链路,谢谢。'
  const re = await call(routes, {
    text: reworded,
    provider: 'opencode-go',
    model: MODEL,
    discovery: { mode: 'reoptimize', round: 2, triage: flow.done?.triage?.triage ?? 'REBUILD', ledger, asked: [], answers: [], questions: [], analysis: null },
  })
  const reDiscovery = re.find((e) => e.type === 'discovery_required')
  const reDone = re.find((e) => e.type === 'done')
  const keptConfirmed = (reDone?.ledger ?? []).filter((e) => e.status === 'CONFIRMED').length
  record(
    'H',
    'Re-optimize:仅改措辞 → 已确认要求保留且不重复询问',
    Boolean(reDone) && !reDiscovery && keptConfirmed >= 1,
    `首次闭环 ${flow.stages.join(' → ')} | 重复询问=${Boolean(reDiscovery)} 保留 CONFIRMED=${keptConfirmed} 台账=${(reDone?.ledger ?? []).length} 字数=${reDone?.optimized?.length}`,
  )
}

const selected = ONLY ? results.filter((r) => ONLY.includes(r.path)) : results
const passCount = selected.filter((r) => r.pass).length
mkdirSync(join(ROOT, 'logs', 'release'), { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = join(ROOT, 'logs', 'release', `smoke-v0.2.0-apo-${stamp}.json`)
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), baseline: '895feeb', model: MODEL, results, passCount, total: results.length }, null, 2))
console.log(`\nrelease smoke: ${passCount}/${selected.length} PASS`)
console.log(`JSON: ${outPath}`)
process.exitCode = passCount === results.length ? 0 : 1
