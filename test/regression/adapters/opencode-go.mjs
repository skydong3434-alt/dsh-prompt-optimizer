/**
 * opencode-go external adapter —— P07 Effect Regression 用 OpenCode Go 套餐的真实模型调用。
 *
 * 用途：替代 run.mjs 默认 live adapter（DeepSeek API），满足用户 E3 裁决：
 *   P07-T03 起使用 OpenCode Go（OPENCODE_API_KEY），不再依赖 api.deepseek.com / DEEPSEEK_API_KEY。
 *
 * 真实端点取证（2026-10-04 只读探测，非推测）：
 *   GET  https://opencode.ai/zen/go/v1/models        → 200，OpenAI-compatible 模型列表
 *   POST https://opencode.ai/zen/go/v1/chat/completions → 200，chat.completion（model=deepseek-v4-flash）
 *   x-opencode-session 头**必填**（缺失 → 400 MissingSessionID；desktop 配置同样如此）
 *
 * 架构边界：复用 run.mjs 既有 `--adapter external` 机制（createAdapter → {call(ctx)}）；
 *   不改 run.mjs、不新增 Provider 实现、不改 DSH/APO 产品逻辑。
 * 凭据：只从 env / 显式路径读 OPENCODE_API_KEY，绝不打印。
 */
import { readFileSync } from 'node:fs'

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const SESSION = 'dsh-apo-regression'

function apiKeyFrom(options) {
  // 本 adapter 固定走 OpenCode Go 凭据（OPENCODE_API_KEY），
  // 忽略 run.mjs 透传的默认 apiKeyEnv='DEEPSEEK_API_KEY'（避免误取 DeepSeek key 发给 opencode）。
  const envName = 'OPENCODE_API_KEY'
  if (options.credentials) {
    const t = readFileSync(options.credentials, 'utf8')
    // 只精确匹配 OPENCODE_API_KEY 行（两空格缩进；不匹配 DEEPSEEK_API_KEY）
    const m = t.match(/^\s{2}OPENCODE_API_KEY:\s*(\S+)/m)
    if (m) return m[1].replace(/['"]/g, '')
    throw new Error('credentials 中未找到 OPENCODE_API_KEY')
  }
  const key = process.env[envName] ?? process.env.DSH_REGRESSION_API_KEY
  if (key) return String(key).trim()
  throw new Error(`opencode-go adapter 缺少凭据：设置 env ${envName} 或 --credentials <yaml>`)
}

export function createAdapter(options = {}) {
  const apiKey = apiKeyFrom(options)
  const baseUrl = options.baseUrl ?? process.env.DSH_REGRESSION_BASE_URL ?? DEFAULT_BASE_URL
  // run.mjs 会把 options.model 默认值（deepseek-chat）透传进来；对 opencode-go 我们只认
  // 明确指定或默认的 opencode-go 模型（deepseek-v4-flash），忽略 runner 的 deepseek 默认值。
  const requested = options.opencodeModel ?? options.model
  const model =
    requested && requested !== 'deepseek-chat' ? requested : 'deepseek-v4-flash'
  const timeoutMs = options.timeoutMs ?? 60000
  return {
    name: `opencode-go:${model}`,
    async call(ctx) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            // opencode-go 强制要求（缺失 → 400 MissingSessionID）
            'x-opencode-session': SESSION,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: ctx?.maxTokens ?? 2048,
            messages: [
              { role: 'system', content: String(ctx?.system ?? '') },
              { role: 'user', content: String(ctx?.user ?? '') },
            ],
          }),
          signal: controller.signal,
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(`opencode-go HTTP ${res.status}: ${text.slice(0, 200)}`)
        }
        const data = await res.json()
        const text = (data?.choices?.[0]?.message?.content) ?? ''
        return { text, model: data?.model ?? model, usage: data?.usage ?? null }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export default createAdapter