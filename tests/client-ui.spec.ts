/**
 * Browser-half unit tests: the two Conversation Definitions narrow, reject,
 * and project their events correctly, and the locale dictionaries stay in
 * key parity. Pure-logic tests only — the React rows are presentation.
 */
import { describe, expect, it } from 'vitest'
import type {
  ConversationMatch, ConversationNodeContext,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { en, zh } from '../src/client/locales.ts'
import {
  fallbackNodeDefinition, quotaWarningNodeDefinition, strategyDetailParts,
} from '../src/client/nodes.ts'
import { bindFallbackTranslate, fbT } from '../src/client/translate.ts'

const FALLBACK_DATA = {
  turn: 1,
  step: 2,
  fromProvider: 'ds',
  fromModel: 'chat',
  toProvider: 'gl',
  toModel: 'haiku',
  code: 'QUOTA',
  remaining: 2,
  mode: 'cost',
  score: 0.0005096,
}

const FALLBACK_DATA_NO_STRATEGY = {
  ...FALLBACK_DATA,
  mode: undefined,
  score: undefined,
}

const WARNING_DATA = {
  turn: 1,
  step: 3,
  provider: 'ds',
  model: 'chat',
  remaining: 10,
  total: 60,
  threshold: 20,
  reason: 'below-threshold',
  mode: 'cost',
}

function eventOf(type: string, seq: number, data: unknown): SessionEvent {
  return { seq, time: 1000 + seq, type, data } as SessionEvent
}

/** The engine-shaped match: definition.match's {id, role} plus the event. */
function matchOf(event: SessionEvent): ConversationMatch {
  return {
    event,
    view: undefined,
    role: 'start',
    location: { kind: 'session' },
  } as ConversationMatch
}

function contextOf<State>(state: State | undefined, match: ConversationMatch): ConversationNodeContext<State> {
  return {
    key: `ctx:${match.event.seq}`,
    kind: 'llm-fallback',
    id: `id:${match.event.seq}`,
    matches: [match],
    start: match,
    state,
    current: new Map(),
  }
}

const reader = { previous: () => undefined }

describe('fallbackNodeDefinition', () => {
  it('matches its own event with a per-event identity and ignores others', () => {
    expect(fallbackNodeDefinition.match?.(eventOf('llm/fallback', 7, FALLBACK_DATA)))
      .toEqual({ id: 'llm-fallback:7', role: 'start' })
    expect(fallbackNodeDefinition.match?.(eventOf('llm/fallback', 7, { junk: true }))).toBeNull()
    expect(fallbackNodeDefinition.match?.(eventOf('llm/quota-warning', 7, WARNING_DATA))).toBeNull()
    expect(fallbackNodeDefinition.match?.(eventOf('turn/start', 7, {}))).toBeNull()
  })

  it('start projects one switch row with routes, mode, and cost score', () => {
    const event = eventOf('llm/fallback', 7, FALLBACK_DATA)
    const match = matchOf(event)
    const state = fallbackNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(state.switches).toEqual([{
      seq: 7,
      time: 1007,
      from: 'ds/chat',
      to: 'gl/haiku',
      code: 'QUOTA',
      remaining: 2,
      mode: 'cost',
      score: 0.0005096,
    }])
  })

  it('start omits mode and score for a rule-based (no-strategy) switch', () => {
    const match = matchOf(eventOf('llm/fallback', 8, FALLBACK_DATA_NO_STRATEGY))
    const state = fallbackNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(state.switches[0]).toMatchObject({
      from: 'ds/chat', to: 'gl/haiku', code: 'QUOTA', remaining: 2,
    })
    expect('mode' in state.switches[0]!).toBe(false)
    expect('score' in state.switches[0]!).toBe(false)
  })

  it('start throws on a structurally invalid payload', () => {
    const match = matchOf(eventOf('llm/fallback', 8, { ...FALLBACK_DATA, toModel: '' }))
    expect(() => fallbackNodeDefinition.start(contextOf(undefined, match), match, reader))
      .toThrow(/requires a valid/)
  })

  it('buildViewNode anchors a visible chat node at the event seq', () => {
    const match = matchOf(eventOf('llm/fallback', 9, FALLBACK_DATA))
    const state = fallbackNodeDefinition.start(contextOf(undefined, match), match, reader)
    const node = fallbackNodeDefinition.buildViewNode!(contextOf(state, match))
    expect(node).toMatchObject({
      kind: 'llm-fallback',
      target: 'chat',
      anchorSeq: 9,
      visibility: 'visible',
    })
    expect(fallbackNodeDefinition.buildViewNode!(contextOf(undefined, match))).toBeNull()
  })
})

describe('quotaWarningNodeDefinition', () => {
  it('matches its own event and keeps optional fields when present', () => {
    const event = eventOf('llm/quota-warning', 11, WARNING_DATA)
    expect(quotaWarningNodeDefinition.match?.(event))
      .toEqual({ id: 'llm-quota-warning:11', role: 'start' })
    const match = matchOf(event)
    const state = quotaWarningNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(state).toMatchObject({
      seq: 11,
      route: 'ds/chat',
      remaining: 10,
      threshold: 20,
      reason: 'below-threshold',
      mode: 'cost',
    })
  })

  it('rejects an unknown reason', () => {
    expect(quotaWarningNodeDefinition.match?.(
      eventOf('llm/quota-warning', 12, { ...WARNING_DATA, reason: 'mystery' }),
    )).toBeNull()
  })

  it('accepts the unobservable-probe reason and projects the route', () => {
    const event = eventOf('llm/quota-warning', 15, {
      turn: 2, step: 1, provider: 'gl', model: 'haiku', reason: 'unobservable',
    })
    const match = matchOf(event)
    expect(quotaWarningNodeDefinition.match?.(event))
      .toEqual({ id: 'llm-quota-warning:15', role: 'start' })
    const state = quotaWarningNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(state).toMatchObject({ route: 'gl/haiku', reason: 'unobservable' })
    expect(state.remaining).toBeUndefined()
  })

  it('accepts a minimal payload without optional fields', () => {
    const event = eventOf('llm/quota-warning', 13, {
      turn: 2, step: 1, provider: 'az', model: 'gpt', reason: 'insufficient-cost',
    })
    const match = matchOf(event)
    expect(quotaWarningNodeDefinition.match?.(event))
      .toEqual({ id: 'llm-quota-warning:13', role: 'start' })
    const state = quotaWarningNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(state.remaining).toBeUndefined()
    expect(state.estimatedCost).toBeUndefined()
  })

  it('accepts the forecast-low advisory and projects its burn fields', () => {
    const event = eventOf('llm/quota-warning', 16, {
      turn: 3, step: 1, provider: 'ds', model: 'chat', remaining: 0.04, total: 1,
      threshold: 0.05, thresholdKind: 'ratio', estimatedCost: 0.001,
      projectedBurn: 0.01, forecastSteps: 10, reason: 'forecast-low',
    })
    const match = matchOf(event)
    expect(quotaWarningNodeDefinition.match?.(event))
      .toEqual({ id: 'llm-quota-warning:16', role: 'start' })
    const state = quotaWarningNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(state).toMatchObject({
      route: 'ds/chat',
      remaining: 0.04,
      total: 1,
      threshold: 0.05,
      projectedBurn: 0.01,
      forecastSteps: 10,
      reason: 'forecast-low',
    })
  })

  it('accepts forecast-low without burn fields (unpriced route advisory)', () => {
    const event = eventOf('llm/quota-warning', 17, {
      turn: 3, step: 2, provider: 'az', model: 'gpt', remaining: 2, reason: 'forecast-low',
    })
    const match = matchOf(event)
    expect(quotaWarningNodeDefinition.match?.(event))
      .toEqual({ id: 'llm-quota-warning:17', role: 'start' })
    const state = quotaWarningNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(state).toMatchObject({ route: 'az/gpt', remaining: 2, reason: 'forecast-low' })
    expect(state.projectedBurn).toBeUndefined()
    expect(state.forecastSteps).toBeUndefined()
  })

  it('buildViewNode anchors a visible chat node at the event seq', () => {
    const match = matchOf(eventOf('llm/quota-warning', 14, WARNING_DATA))
    const state = quotaWarningNodeDefinition.start(contextOf(undefined, match), match, reader)
    expect(quotaWarningNodeDefinition.buildViewNode!(contextOf(state, match))).toMatchObject({
      kind: 'llm-quota-warning',
      target: 'chat',
      anchorSeq: 14,
      visibility: 'visible',
    })
  })
})

describe('strategyDetailParts', () => {
  it('renders nothing for a rule-based switch', () => {
    expect(strategyDetailParts(undefined, undefined)).toEqual([])
  })

  it('renders a mode tag and the cost score for a cost-mode switch', () => {
    bindFallbackTranslate((key, params) => `${key}-${JSON.stringify(params ?? {})}`)
    const parts = strategyDetailParts('cost', 0.0005096)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe('strategy.mode-{"mode":"cost"}')
    expect(parts[1]).toBe('strategy.score-{"score":"0.0005096"}')
  })

  it('renders only the mode tag for performance mode (no score)', () => {
    bindFallbackTranslate(() => undefined as unknown as string)
    expect(strategyDetailParts('performance', undefined)).toEqual(['strategy.mode'])
  })

  it('renders only the mode tag for a cost switch without a score', () => {
    bindFallbackTranslate(() => undefined as unknown as string)
    expect(strategyDetailParts('cost', undefined)).toEqual(['strategy.mode'])
  })
})

describe('locales', () => {
  it('keeps en and zh in exact key parity', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('carries the reset-button copy in both dictionaries', () => {
    expect(zh['reset.label']).toBeTruthy()
    expect(zh['reset.title']).toBeTruthy()
    expect(en['reset.label']).toBeTruthy()
    expect(en['reset.title']).toBeTruthy()
  })
})

describe('fbT', () => {
  it('reads through the bound thunk and degrades to the bare key when unbound', () => {
    bindFallbackTranslate((key, params) => `${key}:${JSON.stringify(params ?? {})}`)
    expect(fbT('fallback.detail', { code: 'QUOTA', count: 2 })).toBe(
      'fallback.detail:{"code":"QUOTA","count":2}',
    )
    bindFallbackTranslate(() => undefined as unknown as string)
    expect(fbT('fallback.prefix')).toBe('fallback.prefix')
  })
})
