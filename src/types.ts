/**
 * Browser-safe types for the llm-fallback plugin: the durable fallback event
 * vocabulary plus the ordered fallback route description.
 *
 * @module @deepseek-ai/dsh-llm-fallback/types
 */

/** Rule-based tie-break preference among capability-matched candidates. */
export type SelectionPreference = 'closest' | 'price' | 'speed' | 'reasoning'

/** One ordered fallback route. */
export interface LlmFallbackRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id; when omitted, one is chosen by capability match. */
  model?: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Durable payload recorded immediately before switching to a fallback route. */
export interface LlmFallbackEventData {
  /** Turn containing the failed request. */
  turn: number
  /** Step containing the failed request. */
  step: number
  /** Provider route that failed. */
  fromProvider: string
  /** Model that failed. */
  fromModel: string
  /** Provider route switched to. */
  toProvider: string
  /** Model switched to. */
  toModel: string
  /** Stable provider-neutral failure code that triggered the switch. */
  code: string
  /** Fallback candidates remaining after this switch. */
  remaining: number
}

/** How one provider route exposes its remaining allowance. */
export type QuotaKind = 'balance' | 'quota' | 'unobservable'

/** Result of one quota interrogation. */
export interface QuotaCheck {
  /** Whether allowance is recharge balance, a resetting quota, or unknown. */
  kind: QuotaKind
  /** Remaining allowance in the provider's unit (currency or request count). */
  remaining?: number
  /** Total allowance when disclosed. */
  total?: number
  /** Epoch-ms reset time for a quota-kind allowance. */
  resetAt?: number
}

/** Statically configured allowance for one provider route. */
export interface QuotaStaticEntry {
  kind: 'balance' | 'quota'
  remaining: number
  total?: number
  resetAt?: number
}

/**
 * Pluggable quota source. A provider returns `undefined` when it does not own
 * the route (unobservable); a thrown error means the interrogation itself
 * failed and must not be treated as an exhausted allowance.
 */
export interface QuotaProvider {
  /** Stable identity for diagnostics. */
  readonly name: string
  /** Interrogate one provider route; `undefined` means the route is unobservable. */
  check(provider: string, model: string, signal: AbortSignal): Promise<QuotaCheck | undefined>
}

/** Durable payload recorded when a pre-request quota check triggers a switch. */
export interface LlmQuotaWarningEventData {
  /** Turn containing the pre-request check. */
  turn: number
  /** Step containing the pre-request check. */
  step: number
  /** Provider route that tripped the warning. */
  provider: string
  /** Model that tripped the warning. */
  model: string
  /** Remaining allowance at warning time, when disclosed. */
  remaining?: number
  /** Total allowance, when disclosed. */
  total?: number
  /** Threshold that was crossed. */
  threshold?: number
  /** Estimated cost of this request in the provider's unit, when priced. */
  estimatedCost?: number
  /** Input unit price (per million tokens) used in the estimate. */
  inputPrice?: number
  /** Output unit price (per million tokens) used in the estimate. */
  outputPrice?: number
  /** Warning reason. */
  reason: 'below-threshold' | 'insufficient-cost'
}

/** One candidate route surfaced to a pluggable decision provider. */
export interface DecisionCandidateInfo {
  provider: string
  model: string
  contextWindow?: number
  modalities?: string[]
}

/** Input handed to a pluggable decision provider. */
export interface DecisionInput {
  /** Primary route capability signals. */
  primary: {
    contextWindow?: number
    modalities?: string[]
  }
  /** All eligible candidate routes, with resolved capability signals. */
  candidates: readonly DecisionCandidateInfo[]
}

/**
 * Pluggable model-selection decision provider. When configured, its result is
 * adopted after validation; any throw, timeout, or invalid route falls back to
 * rule-based matching.
 */
export interface DecisionProvider {
  decide(input: DecisionInput): Promise<{ provider: string; model: string } | undefined>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one automatic model fallback switch. */
    'llm/fallback': LlmFallbackEventData
    /** Durable, non-surface record of one preemptive quota warning switch. */
    'llm/quota-warning': LlmQuotaWarningEventData
  }
}
