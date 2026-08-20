/**
 * Conversation Definitions for the two durable llm-fallback events.
 *
 * Each event opens its own one-row Context (the events carry no producer
 * correlation id, so the event seq is the identity): an `llm/fallback`
 * switch renders one "switched from → to" row and an `llm/quota-warning`
 * renders one preemptive-switch row, anchored at the event's own seq so the
 * notice sits exactly where the switch happened inside the turn.
 *
 * @module @deepseek-ai/dsh-llm-fallback/client/nodes
 */
import type {
  ChatConversationViewNode, ConversationLocation, ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ChatNodeDataMap merge target (erased before bundling).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { LlmFallbackEventData, LlmQuotaWarningEventData } from '../types.ts'
import { fbT } from './translate.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One automatic model fallback switch notice row. */
    'llm-fallback': FallbackChatData
    /** One preemptive quota-warning switch notice row. */
    'llm-quota-warning': QuotaWarningChatData
  }
}

/** One fallback switch as the chat row renders it. */
export interface FallbackSwitchRow {
  readonly seq: number
  readonly time: number
  /** Failed route, as "provider/model". */
  readonly from: string
  /** Route switched to, as "provider/model". */
  readonly to: string
  /** Provider-neutral failure code that triggered the switch. */
  readonly code: string
  /** Chain positions remaining after this switch (see LlmFallbackEventData). */
  readonly remaining: number
  /** Strategy mode that selected the target, when a strategy was active. */
  readonly mode?: 'cost' | 'performance' | 'closest'
  /** The mode's score for the selected route (cost mode: projected cost), when defined. */
  readonly score?: number
}

/** Chat payload of one llm/fallback event. */
export interface FallbackChatData {
  readonly switches: readonly FallbackSwitchRow[]
}

/** Chat payload of one llm/quota-warning event. */
export interface QuotaWarningChatData {
  readonly seq: number
  readonly time: number
  /** Route that tripped the warning, as "provider/model". */
  readonly route: string
  readonly remaining?: number
  readonly total?: number
  readonly threshold?: number
  readonly estimatedCost?: number
  readonly reason: 'below-threshold' | 'insufficient-cost' | 'unobservable'
  /** Strategy mode that selected the target, when a strategy was active. */
  readonly mode?: 'cost' | 'performance' | 'closest'
}

/** A finite non-negative integer read from an untrusted payload field. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** A non-empty string read from an untrusted payload field. */
function label(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A strategy-mode enum read from an untrusted payload field, or undefined. */
function strategyMode(value: unknown): 'cost' | 'performance' | 'closest' | undefined {
  return value === 'cost' || value === 'performance' || value === 'closest' ? value : undefined
}

/** A finite non-negative score read from an untrusted payload field. */
function scoreOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Structurally narrow one llm/fallback event payload. */
function fallbackOf(event: SessionEvent): LlmFallbackEventData | undefined {
  if (event.type !== 'llm/fallback') return undefined
  const data = event.data as Partial<LlmFallbackEventData> | undefined
  if (data === undefined) return undefined
  const turn = count(data.turn)
  const step = count(data.step)
  const fromProvider = label(data.fromProvider)
  const fromModel = label(data.fromModel)
  const toProvider = label(data.toProvider)
  const toModel = label(data.toModel)
  const code = label(data.code)
  const remaining = count(data.remaining)
  if (turn === undefined || step === undefined || fromProvider === undefined
    || fromModel === undefined || toProvider === undefined || toModel === undefined
    || code === undefined || remaining === undefined) return undefined
  const mode = strategyMode(data.mode)
  const score = scoreOf(data.score)
  return {
    turn, step, fromProvider, fromModel, toProvider, toModel, code, remaining,
    ...(mode !== undefined ? { mode } : {}),
    ...(score !== undefined ? { score } : {}),
  }
}

/** Structurally narrow one llm/quota-warning event payload. */
function warningOf(event: SessionEvent): LlmQuotaWarningEventData | undefined {
  if (event.type !== 'llm/quota-warning') return undefined
  const data = event.data as Partial<LlmQuotaWarningEventData> | undefined
  if (data === undefined) return undefined
  const turn = count(data.turn)
  const step = count(data.step)
  const provider = label(data.provider)
  const model = label(data.model)
  if (turn === undefined || step === undefined || provider === undefined || model === undefined) {
    return undefined
  }
  if (data.reason !== 'below-threshold' && data.reason !== 'insufficient-cost' && data.reason !== 'unobservable') return undefined
  const remaining = count(data.remaining)
  const total = count(data.total)
  const threshold = count(data.threshold)
  const estimatedCost = count(data.estimatedCost)
  const inputPrice = count(data.inputPrice)
  const outputPrice = count(data.outputPrice)
  const mode = strategyMode(data.mode)
  return {
    turn, step, provider, model, reason: data.reason,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(estimatedCost !== undefined ? { estimatedCost } : {}),
    ...(inputPrice !== undefined ? { inputPrice } : {}),
    ...(outputPrice !== undefined ? { outputPrice } : {}),
    ...(mode !== undefined ? { mode } : {}),
  }
}

/** Best currently loaded event Location of one Context. */
function contextLocation(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/** One mode for strategy-detail rendering. */
export type StrategyModeDisplay = 'cost' | 'performance' | 'closest'

/**
 * Translated strategy-detail segments for one switch notice: a mode tag, plus
 * the projected cost when a cost-mode score is present. Empty for a rule-based
 * (no-strategy) switch, so the view renders no trailing detail.
 */
export function strategyDetailParts(
  mode: StrategyModeDisplay | undefined,
  score: number | undefined,
): string[] {
  if (mode === undefined) return []
  const parts = [fbT('strategy.mode', { mode })]
  if (mode === 'cost' && score !== undefined) {
    parts.push(fbT('strategy.score', { score: score.toPrecision(4) }))
  }
  return parts
}

/** Definition for the durable llm/fallback switch notice. */
export const fallbackNodeDefinition: ConversationNodeDefinition<FallbackChatData> = {
  kind: 'llm-fallback',
  target: 'chat',
  match: (event) => {
    const payload = fallbackOf(event)
    return payload === undefined ? null : { id: `llm-fallback:${event.seq}`, role: 'start' }
  },
  start: (_context, match) => {
    const payload = fallbackOf(match.event)
    if (payload === undefined) throw new Error('llm-fallback start requires a valid llm/fallback event')
    return {
      switches: [{
        seq: match.event.seq,
        time: match.event.time,
        from: `${payload.fromProvider}/${payload.fromModel}`,
        to: `${payload.toProvider}/${payload.toModel}`,
        code: payload.code,
        remaining: payload.remaining,
        ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
        ...(payload.score !== undefined ? { score: payload.score } : {}),
      }],
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined || context.state.switches.length === 0) return null
    return {
      key: context.key,
      kind: 'llm-fallback',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.switches[0]!.seq,
      location: contextLocation(context),
      visibility: 'visible',
      data: context.state,
    } satisfies ChatConversationViewNode
  },
}

/** Definition for the durable llm/quota-warning preemptive-switch notice. */
export const quotaWarningNodeDefinition: ConversationNodeDefinition<QuotaWarningChatData> = {
  kind: 'llm-quota-warning',
  target: 'chat',
  match: (event) => {
    const payload = warningOf(event)
    return payload === undefined ? null : { id: `llm-quota-warning:${event.seq}`, role: 'start' }
  },
  start: (_context, match) => {
    const payload = warningOf(match.event)
    if (payload === undefined) {
      throw new Error('llm-quota-warning start requires a valid llm/quota-warning event')
    }
    return {
      seq: match.event.seq,
      time: match.event.time,
      route: `${payload.provider}/${payload.model}`,
      reason: payload.reason,
      ...(payload.remaining !== undefined ? { remaining: payload.remaining } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      ...(payload.threshold !== undefined ? { threshold: payload.threshold } : {}),
      ...(payload.estimatedCost !== undefined ? { estimatedCost: payload.estimatedCost } : {}),
      ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'llm-quota-warning',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: contextLocation(context),
      visibility: 'visible',
      data: context.state,
    } satisfies ChatConversationViewNode
  },
}
