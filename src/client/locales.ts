/**
 * `llmFallback` namespace dictionaries: the copy of the two chat notice rows.
 *
 * @module @kongfun2018/dsh-llm-fallback/client/locales
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'fallback.prefix': '已自动切换模型：',
  'fallback.detail': '原因 {code} · 还可回退 {count} 个路由',
  'fallback.detailLast': '原因 {code} · 已是最后一个回退路由',
  'strategy.mode': '策略模式 {mode}',
  'strategy.score': '预估成本 {score}',
  'warning.belowThreshold': '额度预警：{route} 剩余 {remaining}（阈值 {threshold}），已提前切换',
  'warning.insufficientCost': '额度预警：{route} 剩余 {remaining}，低于本次请求估算成本，已提前切换',
  'warning.belowThresholdUnknown': '额度预警：{route} 低于阈值，已提前切换',
  'warning.unobservableProbe': '额度预警：{route} 额度不可观测，将用本次请求探测其可用性',
  'reset.label': '恢复所有模型',
  'reset.title': '一键恢复所有已配置模型的可用性（清除回退禁选/健康路由等全部决策）',
} satisfies Record<string, string>

/** The llmFallback namespace key union. */
export type FallbackKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'fallback.prefix': 'Switched model automatically: ',
  'fallback.detail': 'reason {code} · {count} fallback route(s) left',
  'fallback.detailLast': 'reason {code} · last fallback route',
  'strategy.mode': 'mode {mode}',
  'strategy.score': 'est. cost {score}',
  'warning.belowThreshold': 'Quota warning: {route} has {remaining} left (threshold {threshold}) — switched preemptively',
  'warning.insufficientCost': 'Quota warning: {route} has {remaining} left, below the estimated request cost — switched preemptively',
  'warning.belowThresholdUnknown': 'Quota warning: {route} fell below its threshold — switched preemptively',
  'warning.unobservableProbe': 'Quota warning: {route} has no disclosed allowance — probing usability with this request',
  'reset.label': 'Restore models',
  'reset.title': 'Restore every configured model\'s usability (clear all fallback bans / healthy-route / decisions)',
} satisfies Record<FallbackKey, string>
