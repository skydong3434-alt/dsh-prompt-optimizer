import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 类型级引入,激活 'conversation.input.dock' 的 SlotMap 合并声明。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SparkleIcon } from './SparkleIcon.js'
import {
  shouldAutoClose,
  type MissingConstraintView,
  type OptimizerController,
  type ProvenanceView,
  type ResolutionView,
} from './controller.js'
import { useT, type MessageKey } from './i18n.js'

export type ResultDockProps = PropsRuntime<'conversation.input.dock'>

/** 任务类型 → i18n key(未登记类型回落 general)。 */
const TYPE_LABEL_KEY: Record<string, MessageKey> = {
  research: 'panel.type.research',
  planning: 'panel.type.planning',
  execution: 'panel.type.execution',
  diagnostic: 'panel.type.diagnostic',
  review: 'panel.type.review',
  creative: 'panel.type.creative',
  general: 'panel.type.general',
}

/** 置信度档位 → i18n key(内部数值一律不展示)。 */
const CONFIDENCE_KEY: Record<'High' | 'Medium' | 'Low', MessageKey> = {
  High: 'panel.confidence.high',
  Medium: 'panel.confidence.medium',
  Low: 'panel.confidence.low',
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 非安全上下文(局域网 http)没有 clipboard API,走 textarea 兜底。
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** 全部走 Harness 设计令牌(--dsw-alias-*),明暗主题自动跟随;变量缺失时用括号内兜底值。 */
const styles = {
  panel: {
    marginBottom: 6,
    borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3))',
    background: 'var(--dsw-alias-bg-layer-2, #fff)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    // 阴影从 0.12 降到与官方输入卡同档的极淡弥散(0.03~0.05):
    // 之前的重投影在白底上晕出一圈灰,是面板「显灰显大」的另一来源。
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03), 0 4px 14px rgba(0, 0, 0, 0.05)',
    padding: '8px 10px',
    fontSize: 12.5,
    lineHeight: 1.5,
    fontFamily: 'var(--dsw-font-family, inherit)',
  } as const,
  header: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 } as const,
  title: { fontWeight: 600, flex: 1 } as const,
  modelBadge: {
    fontSize: 11,
    color: 'var(--dsw-alias-label-primary-dimmed, rgba(128,128,128,0.9))',
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
    borderRadius: 999,
    padding: '0 8px',
  } as const,
  close: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary-dimmed, inherit)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
  } as const,
  // U5:分析与优化各自独立滚动区(原先单容器 maxHeight 嵌套出现双滚动条),
  // 长内容不再互相挤压;外层 body 不限高,滚动归属到各段内部。
  body: { paddingRight: 4 } as const,
  analysisBody: { maxHeight: '14vh', overflowY: 'auto', marginTop: 2 } as const,
  optimizedBox: {
    // 层面令牌在浅色主题下是纯白,填充不可见,用细描边给出容器感(不引入灰底)。
    background: 'var(--dsw-alias-bg-layer-3, transparent)',
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.2))',
    borderRadius: 8,
    padding: '5px 8px',
    maxHeight: '22vh',
    overflowY: 'auto',
    marginTop: 2,
  } as const,
  sectionTitle: {
    // U5:段落标题可点击折叠;去掉默认按钮外观。
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary-dimmed, rgba(128,128,128,0.9))',
    margin: '5px 0 2px',
    padding: 0,
    border: 'none',
    background: 'none',
    font: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  } as const,
  chevron: { fontSize: 9, transition: 'transform 0.15s ease' } as const,
  pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' } as const,
  actions: { display: 'flex', gap: 8, marginTop: 6 } as const,
  actionBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '3px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
    // 幽灵按钮:button-tool-bar-fill 在当前主题是 50% 灰(#54555780),整排灰块
    // 是面板显灰的主因,改为透明底 + 细描边,与输入卡的工具按钮同语言。
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary, inherit)',
    cursor: 'pointer',
  } as const,
  primaryBtn: {
    background: 'var(--dsw-alias-button-primary-fill, #3b6ef6)',
    borderColor: 'transparent',
    color: 'var(--dsw-alias-label-primary-inverted, #fff)',
  } as const,
  errorText: { color: 'var(--dsw-alias-state-error-primary, #e5534b)', whiteSpace: 'pre-wrap' } as const,
  // U7/O6:头部状态条(绿色描边小徽章)。
  statusChip: {
    fontSize: 11,
    color: 'var(--dsw-alias-state-success-primary, #2da44e)',
    border: '1px solid currentColor',
    borderRadius: 999,
    padding: '0 8px',
    whiteSpace: 'nowrap',
  } as const,
  // 类型徽章 + 置信度档位(内部数值一律不展示)。
  typeBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary, inherit)',
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
    borderRadius: 999,
    padding: '0 8px',
    whiteSpace: 'nowrap',
  } as const,
  confidenceBadge: {
    fontSize: 11,
    color: 'var(--dsw-alias-label-primary-dimmed, rgba(128,128,128,0.9))',
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
    borderRadius: 999,
    padding: '0 8px',
    whiteSpace: 'nowrap',
  } as const,
  // 四组 provenance 各自独立底色/边框:explicit 实线、suggested 虚线、unknown 警示色。
  groupBox: {
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.2))',
    borderRadius: 8,
    padding: '4px 8px',
    maxHeight: '12vh',
    overflowY: 'auto',
  } as const,
  suggestBox: {
    border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
    borderRadius: 8,
    padding: '4px 8px',
    maxHeight: '12vh',
    overflowY: 'auto',
    color: 'var(--dsw-alias-label-primary-dimmed, rgba(128,128,128,0.9))',
  } as const,
  unknownBox: {
    border: '1px solid var(--dsw-alias-state-warn-primary, #d4a72c)',
    borderRadius: 8,
    padding: '4px 8px',
    maxHeight: '12vh',
    overflowY: 'auto',
  } as const,
  groupItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 4,
    padding: '1px 0',
  } as const,
  // P06-T02:来源身份小标(WORKSPACE_FACT 等确定性事实)与逐条「缺证据」降级标记。
  sourceChip: {
    fontSize: 10,
    color: 'var(--dsw-alias-label-primary-dimmed, rgba(128,128,128,0.9))',
    border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
    borderRadius: 999,
    padding: '0 6px',
    whiteSpace: 'nowrap',
  } as const,
  evidenceWarn: {
    fontSize: 10,
    color: 'var(--dsw-alias-state-warn-primary, #d4a72c)',
    whiteSpace: 'nowrap',
  } as const,
  // U10/R5:质量警示(truncated / notWellFormed)从灰色小字升级为描边警示框,
  // 让「替换前请检查」被真正看到;notWellFormed 横幅置于内容区顶部(R5)。
  warnBanner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 8,
    padding: '6px 8px',
    fontSize: 12,
    lineHeight: 1.5,
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-state-warn-primary, #d4a72c)',
    background: 'var(--dsw-alias-state-warn-bg, rgba(212, 167, 44, 0.12))',
    color: 'var(--dsw-alias-state-warn-primary, #d4a72c)',
  } as const,
  cancelledHint: {
    fontSize: 12,
    color: 'var(--dsw-alias-state-warn-primary, #d4a72c)',
    padding: '4px 0 2px',
  } as const,
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--dsw-alias-label-primary-dimmed, inherit)',
    padding: '8px 0',
  } as const,
}

/** 输入卡上方整行的结果面板:注册进 'conversation.input.dock',不遮挡输入框。 */
export function createResultDock(controller: OptimizerController) {
  return function OptimizerResultDock(props: ResultDockProps) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const t = useT()
    const [copied, setCopied] = useState(false)
    // U5:分析诊断段折叠态(默认展开)——长分析可收起,聚焦优化稿本身。
    const [analysisOpen, setAnalysisOpen] = useState(true)
    // O6:撤回后的正向反馈——头部短暂显示「已撤回 ✓」,避免用户以为没生效。
    const [undoneFlash, setUndoneFlash] = useState(false)
    // 宿主双形态:0.1.2 起渲染器提供 useInput/useSession standard hooks;
    // 旧版(0.1.0-rc.x/0.1.1-rc.x)渲染器直传 input/session 快照对象。
    const p = props as ResultDockProps & {
      useInput?: (selector: (s: unknown) => unknown) => unknown
      useSession?: (selector: (s: unknown) => unknown) => unknown
      input?: { draft?: string }
      session?: { running?: boolean; queue?: unknown[] }
      sessionId?: string
      inputActions?: { setDraft(text: string): void }
    }
    const input = (p.useInput ? (p.useInput((s: unknown) => s) as { draft?: string }) : p.input) ?? {}
    const session = (p.useSession ? (p.useSession((s: unknown) => s) as { running?: boolean; queue?: unknown[] }) : p.session) ?? {}
    const inputActions = p.inputActions
    // controller 是会话间共享的单例:面板只对发起优化的那个会话渲染,
    // 避免切会话后旧结果跟着飘过来、甚至误替换别的会话的输入框。
    const owns = state.open && state.last?.sessionId === p.sessionId

    useEffect(() => {
      if (!owns) return
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return
        // O2:优化中 Esc = 取消(保留已生成部分并定格展示);其余状态 Esc = 直接关闭。
        if (controller.getSnapshot().status === 'loading') controller.cancel()
        else controller.close()
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [owns])

    // 发送即关闭:判定逻辑在 controller.shouldAutoClose(纯函数,有单测)。
    // 顺带限定 owns:其他会话的 dock 实例不得因自身状态变化影响本会话的撤回依据。
    const applied = state.applied
    const draft = input.draft ?? ''
    const running = Boolean(session.running)
    const queued = session.queue?.length ?? 0
    const prevRef = useRef({ running, queued })
    useEffect(() => {
      const prev = prevRef.current
      prevRef.current = { running, queued }
      if (!owns) return
      if (shouldAutoClose({ open: true, status: state.status, draft, prevRunning: prev.running, running, prevQueued: prev.queued, queued })) {
        controller.close()
        return
      }
      // 撤回自动失效:替换后用户手动改过草稿(内容不再等于替换文本),
      // 撤回会覆盖用户编辑,此时撤掉撤回入口。
      if (applied && draft !== applied.text) controller.clearApplied()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft, applied, owns, state.status, running, queued])

    // loading 期间的耗时读数:进入 loading 起每秒刷新,离开即停。
    const [elapsed, setElapsed] = useState(0)
    useEffect(() => {
      if (state.status !== 'loading') return
      const started = Date.now()
      setElapsed(0)
      const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
      return () => clearInterval(timer)
    }, [state.status])

    // O6:「已撤回 ✓」短暂展示后自动消退。
    useEffect(() => {
      if (!undoneFlash) return
      const timer = setTimeout(() => setUndoneFlash(false), 2500)
      return () => clearTimeout(timer)
    }, [undoneFlash])

    // 流式实况的 stick-to-bottom(自动跟随滚动):内容增长时贴住底部,
    // 用户向上滚动即暂停跟随,滚回底部附近(±28px)自动恢复。
    const liveBoxRef = useRef<HTMLDivElement | null>(null)
    const stickRef = useRef(true)
    useEffect(() => {
      if (state.status === 'loading') stickRef.current = true
    }, [state.status])
    useEffect(() => {
      const el = liveBoxRef.current
      if (!el || state.status !== 'loading') return
      if (stickRef.current) el.scrollTop = el.scrollHeight
    }, [state.live, state.status])
    const onLiveScroll = () => {
      const el = liveBoxRef.current
      if (!el) return
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28
    }

    if (!owns) return null
    const { result } = state
    // v2 分析结论:loading 用 meta,完成后用 result;旧版 Host 无该字段 → null。
    const v2 = result?.analysisView ?? state.meta?.analysisView ?? null
    const triageLabel = (value: string): string => {
      const key = `panel.triage.${value}`
      const label = t(key as never)
      // 缺译回退:未知分诊值显示原始值,绝不显示空白。
      return label === key ? value : label
    }
    // 阶段提示:meta 未到 = 正在识别任务类型(AUTO 两阶段的第一阶段);meta 到达后
    // 按流式段落推进:等待响应 → 分析诊断 → 输出优化稿。
    const stage = !state.meta
      ? t('panel.stage.classifying')
      : state.live?.optimized
        ? t('panel.stage.writing')
        : state.live?.analysis
          ? t('panel.stage.analyzing')
          : t('panel.stage.waiting')

    // 流式实况段(loading 与 cancelled 共用;U5 限高滚动 + 自动跟随,不遮挡阶段行)。
    const liveBody =
      state.live && (state.live.analysis || state.live.optimized) ? (
        <div ref={liveBoxRef} onScroll={onLiveScroll} style={{ ...styles.body, maxHeight: '34vh', overflowY: 'auto', marginTop: 2 }}>
          {state.live.analysis && (
            <>
              <div style={styles.sectionTitle}>{t('panel.analysis')}</div>
              <pre style={styles.pre}>{state.live.analysis}</pre>
            </>
          )}
          {state.live.optimized && (
            <>
              <div style={styles.sectionTitle}>{t('panel.optimized')}</div>
              <div style={styles.optimizedBox}>
                <pre style={styles.pre}>{state.live.optimized}</pre>
              </div>
            </>
          )}
        </div>
      ) : null

    const onCopy = async () => {
      if (!result) return
      setCopied(await copyText(result.optimized))
      setTimeout(() => setCopied(false), 1500)
    }
    const onReplace = () => {
      if (!result) return
      // 面板保持打开进入「已替换」态,撤回依据 = 替换前的原文。
      // 斜杠命令前缀拼回:优化只针对正文,命令词原样保留;
      // applied.text 必须是替换后的完整草稿(含前缀),否则撤回失效检测会误判为用户编辑。
      const nextDraft = state.last?.prefix ? `${state.last.prefix} ${result.optimized}` : result.optimized
      controller.markApplied({ backup: input.draft ?? '', text: nextDraft })
      inputActions?.setDraft(nextDraft)
    }
    const onUndo = () => {
      if (!applied) return
      inputActions?.setDraft(applied.backup)
      controller.clearApplied()
      setUndoneFlash(true)
    }

    // 四组 provenance 渲染:每组独立样式;逐字 quote 证据走 item 级 title tooltip。
    // - suggested 组条目带「建议(可忽略)」前缀(与组标题分离,避免重复);
    // - context 组默认标出 WORKSPACE_FACT 等确定性来源;
    // - explicit/context 条目无逐字证据时做「缺证据」降级展示(对应 provenance_ok=false)。
    const renderGroup = (
      title: string,
      records: ProvenanceView[],
      tone: 'explicit' | 'context' | 'suggested' | 'unknown',
      opts?: { showSource?: boolean },
    ) => {
      if (!records.length) return null
      const box = tone === 'suggested' ? styles.suggestBox : tone === 'unknown' ? styles.unknownBox : styles.groupBox
      return (
        <div>
          <div style={{ ...styles.sectionTitle, cursor: 'default' }}>{title}</div>
          <div style={box}>
            {records.map((record) => {
              const lacksEvidence =
                (tone === 'explicit' || tone === 'context') && record.source !== 'WORKSPACE_FACT' && record.evidence.length === 0
              return (
                <div
                  key={record.id || `${tone}-${record.text}`}
                  style={styles.groupItem}
                  title={record.evidence.length ? `${t('panel.group.evidence')}: ${record.evidence.join(' | ')}` : record.note}
                >
                  <span aria-hidden>{tone === 'suggested' ? '✎' : tone === 'unknown' ? '?' : '✓'}</span>
                  <span>
                    {tone === 'suggested' ? `${t('panel.suggestedPrefix')}: ` : ''}
                    {record.text}
                  </span>
                  {opts?.showSource && record.source === 'WORKSPACE_FACT' && (
                    <span style={styles.sourceChip}>{t('panel.source.workspace')}</span>
                  )}
                  {lacksEvidence && <span style={styles.evidenceWarn}>⚠ {t('panel.group.noEvidence')}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    // 缺口清单:missing_constraints 独立成段(不再被非空 unknowns 遮蔽);
    // 已被 unknowns 覆盖的条目不再重复列出。unknowns 的 text 形如 `[待补充: …]`。
    const missingOnly = result
      ? result.missingConstraints.filter((item) => !result.unknowns.some((u) => u.text.includes(item.label)))
      : []
    const renderMissing = (title: string, items: MissingConstraintView[]) => {
      if (!items.length) return null
      return (
        <div>
          <div style={{ ...styles.sectionTitle, cursor: 'default' }}>{title}</div>
          <div style={styles.unknownBox}>
            {items.map((item) => (
              <div key={item.id || item.label} style={styles.groupItem} title={item.reason}>
                <span aria-hidden>?</span>
                <span>{`[待补充: ${item.label}]`}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }

    /**
     * v2 需求确认分组渲染:每条未决项给出分类依据与建议问法,让用户一眼看懂
     * 「为什么停下」以及「回答什么就能继续」。空组不渲染。
     */
    const renderResolutionGroup = (title: string, items: ResolutionView[], blocking: boolean) => {
      if (items.length === 0) return null
      return (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...styles.sectionTitle, cursor: 'default', ...(blocking ? { color: '#b45309' } : {}) }}>
            {title}({items.length})
          </div>
          <div style={styles.unknownBox}>
            {items.map((item) => (
              <div key={item.id || item.text} style={styles.groupItem} title={item.rationale}>
                <div>• {item.text}</div>
                {item.question ? (
                  <div style={{ opacity: 0.75, marginLeft: 12 }}>
                    {t('panel.discovery.question')}:{item.question}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )
    }

    return (
      <div style={styles.panel} role="dialog" aria-label={t('panel.aria')}>
        <div style={styles.header}>
          <SparkleIcon size={15} />
          <span style={styles.title}>{t('panel.title')}</span>
          {/* 任务类型徽章 + 把握度(高/中/低):loading 时用 meta,完成后用 result。 */}
          {(result || state.meta) && (
            <span style={styles.typeBadge}>
              {t('panel.type')}: {t(TYPE_LABEL_KEY[(result?.promptType ?? state.meta?.promptType) ?? 'general'] ?? 'panel.type.general')}
            </span>
          )}
          {(result || state.meta) && (
            <span style={styles.confidenceBadge}>
              {t(CONFIDENCE_KEY[(result?.confidenceLevel ?? state.meta?.confidenceLevel) ?? 'Low'])}
            </span>
          )}
          {(() => {
            const contract = result?.contract ?? state.meta?.contract
            return contract ? (
              <span style={styles.modelBadge}>
                {t('panel.contract')}: {t(`panel.contract.${contract}` as never)}
              </span>
            ) : null
          })()}
          {v2 && (
            <span style={styles.modelBadge} title={v2.target.rationale}>
              {t('panel.target')}: {v2.target.target}
              {v2.target.engine ? ` · ${v2.target.engine}` : ''}
            </span>
          )}
          {v2 && (
            <span style={styles.modelBadge} title={v2.triage.reasons.join(';')}>
              {t('panel.triage')}: {triageLabel(v2.triage.triage)}
            </span>
          )}
          {result && (
            <span
              style={styles.modelBadge}
              title={result.fallbackUsed && result.fallbackReason ? `${t('panel.fallback')}: ${result.fallbackReason}` : undefined}
            >
              {result.provider} / {result.model}
              {result.fallbackUsed ? ` · ${t('panel.fallback')}` : ''}
              {typeof result.durationMs === 'number' ? ` · ${t('panel.duration')} ${(result.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
          )}
          {/* U7/O6:头部状态条——已替换常驻;撤回动作短暂反馈。 */}
          {applied && <span style={styles.statusChip}>{t('panel.appliedShort')}</span>}
          {!applied && undoneFlash && <span style={styles.statusChip}>{t('panel.undoneShort')}</span>}
          <button className="dsh-po-btn" type="button" style={styles.close} title={t('panel.closeTitle')} onClick={() => controller.close()}>
            ✕
          </button>
        </div>

        {state.status === 'loading' && (
          <>
            <div style={styles.loading}>
              <SparkleIcon spinning />
              {stage}…({elapsed}s,{t('panel.escCancel')})
            </div>
            {liveBody}
          </>
        )}

        {state.status === 'cancelled' && (
          <>
            <div style={styles.cancelledHint}>{t('panel.cancelled')}</div>
            {liveBody}
            <div style={styles.actions}>
              <button className="dsh-po-btn" type="button" style={{ ...styles.actionBtn, ...styles.primaryBtn }} title={t('panel.reoptimizeTitle')} onClick={() => controller.retry()}>
                {t('panel.reoptimize')}
              </button>
              <button className="dsh-po-btn" type="button" style={styles.actionBtn} onClick={() => controller.close()}>
                {t('panel.close')}
              </button>
            </div>
          </>
        )}

        {state.status === 'error' && (
          <>
            <div style={styles.sectionTitle}>{t('panel.error')}</div>
            <div style={styles.errorText}>{state.error}</div>
            <div style={styles.actions}>
              <button className="dsh-po-btn" type="button" style={styles.actionBtn} title={t('panel.reoptimizeTitle')} onClick={() => controller.retry()}>
                {t('panel.retry')}
              </button>
              <button className="dsh-po-btn" type="button" style={styles.actionBtn} onClick={() => controller.close()}>
                {t('panel.close')}
              </button>
            </div>
          </>
        )}

        {state.status === 'discovery' && (
          <div style={styles.body}>
            <div style={{ ...styles.sectionTitle, cursor: 'default' }}>{t('panel.discovery.title')}</div>
            <div style={styles.optimizedBox}>{t('panel.discovery.hint')}</div>
            {state.discovery?.rationale ? (
              <div style={styles.groupItem}>
                <strong>{t('panel.discovery.gateReason')}:</strong> {state.discovery.rationale}
              </div>
            ) : null}
            {state.discovery ? renderResolutionGroup(t('panel.discovery.blocking'), state.discovery.analysis.gate.blockingItems, true) : null}
            {state.discovery ? renderResolutionGroup(t('panel.discovery.discoverable'), state.discovery.analysis.gate.discoverableItems, false) : null}
            {state.discovery ? renderResolutionGroup(t('panel.discovery.optional'), state.discovery.analysis.gate.optionalItems, false) : null}
          </div>
        )}
        {state.status === 'discovery' && (
          <div style={styles.actions}>
            <button className="dsh-po-btn" type="button" style={{ ...styles.actionBtn, ...styles.primaryBtn }} onClick={() => controller.close()}>
              {t('panel.discovery.revise')}
            </button>
            <button className="dsh-po-btn" type="button" style={styles.actionBtn} title={t('panel.reoptimizeTitle')} onClick={() => controller.retry()}>
              {t('panel.discovery.retry')}
            </button>
          </div>
        )}

        {state.status === 'done' && result && (
          <>
            {/* v2 KEEP:输入被原样保留(未做任何改写),这是最需要先说清的事。 */}
            {result.keep && (
              <div style={{ ...styles.warnBanner, marginTop: 0, marginBottom: 8 }}>
                <span aria-hidden>✓</span>
                <span>{t('panel.keepNotice')}</span>
              </div>
            )}
            {/* provenance 校验失败与低置信提示置于最顶部:替换前必须先被看到。 */}
            {!result.provenanceOk && (
              <div style={{ ...styles.warnBanner, marginTop: 0, marginBottom: 8 }}>
                <span aria-hidden>⚠</span>
                <span>{t('panel.provenanceFail')}</span>
              </div>
            )}
            {result.confidenceLevel === 'Low' && (
              <div style={{ ...styles.warnBanner, marginTop: 0, marginBottom: 8 }}>
                <span aria-hidden>⚠</span>
                <span>
                  {t('panel.lowConfidence', {
                    type: t(TYPE_LABEL_KEY[result.promptType] ?? 'panel.type.general'),
                  })}
                </span>
              </div>
            )}
            {/* R5:格式退化(结果可能混入多余文字)是最需要被看到的质量警示,置于顶部。 */}
            {!result.wellFormed && (
              <div style={{ ...styles.warnBanner, marginTop: 0, marginBottom: 8 }}>
                <span aria-hidden>⚠</span>
                <span>{t('panel.notWellFormed')}</span>
              </div>
            )}
            <div style={styles.body}>
              {result.analysis && (
                <>
                  <button className="dsh-po-btn" type="button" style={styles.sectionTitle} onClick={() => setAnalysisOpen((v) => !v)} aria-expanded={analysisOpen}>
                    <span style={{ ...styles.chevron, transform: analysisOpen ? 'rotate(90deg)' : 'none' }}>▸</span>
                    {t('panel.analysis')}
                  </button>
                  {analysisOpen && (
                    <div style={styles.analysisBody}>
                      <pre style={styles.pre}>{result.analysis}</pre>
                    </div>
                  )}
                </>
              )}
              {/* 四组 provenance 分开展示:明确要求 / 上下文确认 / 优化器建议 / 待补充。 */}
              {renderGroup(t('panel.group.explicit'), result.explicitRequirements, 'explicit')}
              {renderGroup(t('panel.group.context'), result.contextRequirements, 'context', { showSource: true })}
              {renderGroup(t('panel.group.suggested'), result.suggestedRequirements, 'suggested')}
              {renderGroup(t('panel.group.unknown'), result.unknowns, 'unknown')}
              {/* 缺口清单独立成段:unknowns 非空时 missing_constraints 仍需可见。 */}
              {renderMissing(t('panel.missing'), missingOnly)}
              <div style={{ ...styles.sectionTitle, cursor: 'default' }}>{t('panel.optimized')}</div>
              <div style={styles.optimizedBox}>
                <pre style={styles.pre}>{result.optimized}</pre>
              </div>
              {result.truncated && (
                <div style={styles.warnBanner}>
                  <span aria-hidden>⚠</span>
                  <span>{t('panel.truncated')}</span>
                </div>
              )}
            </div>
            <div style={styles.actions}>
              {applied ? (
                <>
                  <button className="dsh-po-btn" type="button" style={{ ...styles.actionBtn, ...styles.primaryBtn }} onClick={onUndo}>
                    {t('panel.undo')}
                  </button>
                  <button className="dsh-po-btn" type="button" style={styles.actionBtn} title={t('panel.reoptimizeTitle')} onClick={() => controller.retry()}>
                    {t('panel.reoptimize')}
                  </button>
                  <button className="dsh-po-btn" type="button" style={styles.actionBtn} onClick={() => controller.close()}>
                    {t('panel.close')}
                  </button>
                </>
              ) : (
                <>
                  <button className="dsh-po-btn" type="button" style={{ ...styles.actionBtn, ...styles.primaryBtn }} onClick={onReplace}>
                    {t('panel.replace')}
                  </button>
                  <button className="dsh-po-btn" type="button" style={styles.actionBtn} onClick={onCopy}>
                    {copied ? t('panel.copied') : t('panel.copy')}
                  </button>
                  {/* O3:提示重试语义——改稿续接(带 previous),同文则是全新生成。 */}
                  <button className="dsh-po-btn" type="button" style={styles.actionBtn} title={t('panel.reoptimizeTitle')} onClick={() => controller.retry()}>
                    {t('panel.reoptimize')}
                  </button>
                  {/* U9:未替换态补明确的关闭出口,「先看看再说」的用户不必找 ✕ 或按 Esc。 */}
                  <button className="dsh-po-btn" type="button" style={styles.actionBtn} onClick={() => controller.close()}>
                    {t('panel.close')}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    )
  }
}
