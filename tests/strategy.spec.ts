/**
 * Strategy-mode tests (docs/strategy-design.md P1): pure decision-layer unit
 * tests plus integration scenarios over the fail-and-switch harness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as fallback from '../src/index.ts'
import type { StrategyCandidate, StrategySettings } from '../src/strategy.ts'
import {
  buildFloor, comparePerformance, costScore, passesFloor, priceOf, selectByStrategy,
} from '../src/strategy.ts'

/* ----------------------------- pure layer ----------------------------- */

const COST_SETTINGS: StrategySettings = {
  mode: 'cost',
  marginTokens: 8192,
  estimatedOutputTokens: 1024,
  futureSteps: 1,
  sessionFailurePenalty: 2,
  cliffPenalty: 1.5,
  axes: ['reasoning', 'context', 'output'],
  significantRatio: 1.5,
}

const PERF_SETTINGS: StrategySettings = { ...COST_SETTINGS, mode: 'performance' }

function candidate(overrides: Partial<StrategyCandidate> & Pick<StrategyCandidate, 'model'>): StrategyCandidate {
  return {
    provider: 'a',
    chainIndex: 0,
    contextWindow: 65_536,
    ...overrides,
  }
}

describe('strategy pure layer', () => {
  it('priceOf falls back from provider/model to provider keys', () => {
    const prices = {
      a: { input: 10, output: 20 },
      'a/vip': { input: 0.1 },
      b: { output: 5 },
    }
    expect(priceOf(prices, 'a', 'vip')).toEqual({ input: 0.1 })
    expect(priceOf(prices, 'a', 'std')).toEqual({ input: 10, output: 20 })
    expect(priceOf(prices, 'b', 'any')).toEqual({ output: 5 })
    expect(priceOf(prices, 'c', 'any')).toBeUndefined()
    expect(priceOf(undefined, 'a', 'vip')).toBeUndefined()
  })

  it('buildFloor adds margin above current usage', () => {
    expect(buildFloor(1000, 8192)).toBe(9192)
    expect(buildFloor(0, 100)).toBe(101)
  })

  it('passesFloor enforces modality coverage and the dynamic window', () => {
    const required: ModelModality[] = ['text' as ModelModality]
    const seeing = { modalities: required as readonly ModelModality[] }
    expect(passesFloor(candidate({ model: 'ok', contextWindow: 9192, ...seeing }), 9192, required, false)).toBe(true)
    expect(passesFloor(candidate({ model: 'small', contextWindow: 9191, ...seeing }), 9192, required, false)).toBe(false)
    // Unknown windows fail unless explicitly allowed.
    expect(passesFloor(candidate({ model: 'mystery', contextWindow: undefined, ...seeing }), 9192, required, false)).toBe(false)
    expect(passesFloor(candidate({ model: 'mystery', contextWindow: undefined, ...seeing }), 9192, required, true)).toBe(true)
    // A missing required modality rejects regardless of window.
    expect(passesFloor(candidate({ model: 'blind', modalities: [] }), 9192, required, false)).toBe(false)
  })

  it('costScore returns undefined unpriced and applies risk multipliers', () => {
    const floor = buildFloor(1000, 8192)
    // Base: (1000×0.1 + 1024×0.4) / 1e6 = 0.0005096.
    const cheap = candidate({ model: 'cheap', inputPrice: 0.1, outputPrice: 0.4 })
    expect(costScore(cheap, 1000, floor, COST_SETTINGS)).toBeCloseTo(0.0005096, 10)
    // Session failure doubles the risk.
    const failed = candidate({ model: 'cheap', inputPrice: 0.1, outputPrice: 0.4, sessionFailed: true })
    expect(costScore(failed, 1000, floor, COST_SETTINGS)).toBeCloseTo(0.0010192, 10)
    // Cliff: window 9600 < floor 9192 + 8192/2 = 13288 → ×1.5.
    const cliffy = candidate({ model: 'cliff', contextWindow: 9600, inputPrice: 0.1, outputPrice: 0.4 })
    expect(costScore(cliffy, 1000, floor, COST_SETTINGS)).toBeCloseTo(0.0007644, 10)
    // Unpriced candidates are uncomparable.
    expect(costScore(candidate({ model: 'free?' }), 1000, floor, COST_SETTINGS)).toBeUndefined()
  })

  it('comparePerformance ranks reasoning strictly and windows by significance', () => {
    const thinker = candidate({ model: 'thinker', hasReasoning: true, contextWindow: 32_768 })
    const broad = candidate({ model: 'broad', hasReasoning: false, contextWindow: 131_072 })
    // reasoning axis decides before context.
    expect(comparePerformance(thinker, broad, PERF_SETTINGS)).toBeLessThan(0)
    // Same reasoning tier: 131072 >= 32768×1.5 → broad significantly larger.
    const broad2 = candidate({ model: 'broad2', hasReasoning: true, contextWindow: 131_072 })
    expect(comparePerformance(broad2, thinker, PERF_SETTINGS)).toBeLessThan(0)
    // 40960 < 32768×1.5 = 49152 → not significant; falls to chain order.
    const near = candidate({ model: 'near', hasReasoning: true, contextWindow: 40_960, chainIndex: 1 })
    const base = candidate({ model: 'base', hasReasoning: true, contextWindow: 32_768, chainIndex: 0 })
    expect(comparePerformance(near, base, PERF_SETTINGS)).toBeGreaterThan(0)
  })

  it('selectByStrategy picks the global cost minimum and ranks unpriced last', () => {
    const pool = [
      candidate({ model: 'mid', inputPrice: 0.3, outputPrice: 1 }),
      candidate({ model: 'unpriced' }),
      candidate({ model: 'cheap', inputPrice: 0.1, outputPrice: 0.4 }),
    ]
    const pick = selectByStrategy(pool, COST_SETTINGS, 1000, undefined, false)
    expect(pick?.candidate.model).toBe('cheap')
    expect(pick?.score).toBeCloseTo(0.0005096, 10)
    // Without prices anywhere, tie-break is chain order — never a crash.
    const bare = selectByStrategy(
      [candidate({ model: 'z', chainIndex: 1 }), candidate({ model: 'a', chainIndex: 0 })],
      COST_SETTINGS, 1000, undefined, false,
    )
    expect(bare?.candidate.model).toBe('a')
    expect(bare?.score).toBeUndefined()
  })

  it('selectByStrategy performance mode prefers the strongest by axes', () => {
    const pool = [
      candidate({ model: 'weak', contextWindow: 32_768 }),
      candidate({ model: 'strong', hasReasoning: true, contextWindow: 131_072, maxTokens: 16_384 }),
    ]
    expect(selectByStrategy(pool, PERF_SETTINGS, 1000, undefined, false)?.candidate.model).toBe('strong')
  })

  it('selectByStrategy returns undefined when the floor clears nobody', () => {
    const pool = [candidate({ model: 'small', contextWindow: 4096 })]
    expect(selectByStrategy(pool, COST_SETTINGS, 1000, undefined, false)).toBeUndefined()
  })

  it('selectByStrategy ranks an allowed unknown-window candidate strictly last', () => {
    const pools = [
      // Even a costlier known-window candidate outranks a cheaper unknown one.
      candidate({ model: 'known-big', contextWindow: 65_536, inputPrice: 5, outputPrice: 10, chainIndex: 1 }),
      candidate({ model: 'unknown-cheap', contextWindow: undefined, inputPrice: 0.01, outputPrice: 0.01, chainIndex: 0 }),
    ]
    // cost mode: the unknown tier is never scored, so the known winner wins
    // despite its higher price.
    const costPick = selectByStrategy(pools, COST_SETTINGS, 1000, undefined, true)
    expect(costPick?.candidate.model).toBe('known-big')
    expect(costPick?.score).toBeTruthy()
    // performance mode: same tiering — a known window outranks an unknown one.
    // (no unknown at all → settled by chain position then id)
    const perfPick = selectByStrategy(pools, PERF_SETTINGS, 1000, undefined, true)
    expect(perfPick?.candidate.model).toBe('known-big')
  })

  it('selectByStrategy falls back to the unknown tier in chain order when nothing is known', () => {
    const pool = [
      candidate({ model: 'z', contextWindow: undefined, chainIndex: 1 }),
      candidate({ model: 'a', contextWindow: undefined, chainIndex: 0 }),
    ]
    for (const settings of [COST_SETTINGS, PERF_SETTINGS]) {
      const pick = selectByStrategy(pool, settings, 1000, undefined, true)
      expect(pick?.candidate.model).toBe('a')
      expect(pick?.score).toBeUndefined()
    }
  })
})

/* --------------------------- integration ----------------------------- */

type ScriptEntry = Error | Iterable<StreamChunk>

interface ModelSpec {
  id: string
  contextWindow?: number
  maxTokens?: number
  modalities?: ModelModality[]
  reasoning?: boolean
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly scripts: Record<string, ScriptEntry[]>,
    private readonly catalog: Record<string, ModelSpec[]> = {},
  ) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.scripts[options.provider]?.shift()
    if (entry === undefined) throw new Error(`script exhausted for provider "${options.provider}"`)
    if (entry instanceof Error) throw entry
    yield* entry
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve((this.catalog[provider] ?? []).map(model => ({
      provider, id: model.id, name: model.id,
      ...model.modalities === undefined ? {} : { inputModalities: model.modalities },
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = this.catalog[provider]?.find(entry => entry.id === model)
    if (spec === undefined) return Promise.resolve({ provider, id: model, name: model })
    return Promise.resolve({
      provider, id: model, name: model,
      ...spec.modalities === undefined ? {} : { inputModalities: spec.modalities },
      ...spec.contextWindow === undefined ? {} : { context: { contextWindow: spec.contextWindow } },
      ...spec.maxTokens === undefined ? {} : { defaultMaxTokens: spec.maxTokens },
      ...spec.reasoning === true ? { reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'high' }] } } : {},
    })
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(
  scripts: Record<string, ScriptEntry[]>,
  config: fallback.Config,
  catalog: Record<string, ModelSpec[]> = {},
): Promise<{ ctx: Context; adapter: ScriptedAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(scripts, catalog)
  ctx.llm.registerAdapter(Object.keys(scripts), adapter)
  return { ctx, adapter }
}

describe('llm-fallback strategy integration', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    vi.unstubAllGlobals()
  })

  it('S1 cost mode selects the globally cheapest route across the chain', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [textResponse('mid-ok')],
      b: [textResponse('cheap-ok')],
    }, {
      fallbacks: [{ provider: 'a' }, { provider: 'b' }],
      strategy: { mode: 'cost' },
      quota: {
        prices: {
          a: { input: 0.25, output: 1 },
          b: { input: 0.05, output: 0.2 },
        },
      },
    }, {
      a: [{ id: 'mid', contextWindow: 65_536 }],
      b: [{ id: 'cheap', contextWindow: 65_536 }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s1-cost-global'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // b/cheap is cheaper than anything in a — the chain order loses to the price.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'b/cheap'])
    const events = agent.session.events.filter(event => event.type === 'llm/fallback')
    expect(events).toHaveLength(1)
    expect(events[0]!.data.mode).toBe('cost')
    expect(events[0]!.data.score).toBeGreaterThan(0)
  })

  it('S2 the dynamic floor excludes cheap models whose window cannot carry the task', async () => {
    // ~100k chars ≈ 25k tokens of context → floor ≈ 33k > tiny's 32k window.
    const bigMessage = 'x'.repeat(100_000)
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [textResponse('big-ok')],
    }, {
      fallbacks: [{ provider: 'a' }],
      strategy: { mode: 'cost' },
      quota: {
        prices: { 'a/tiny': { input: 0.01, output: 0.01 }, 'a/big': { input: 0.5, output: 1 } },
      },
    }, {
      a: [
        { id: 'tiny', contextWindow: 32_768 },
        { id: 'big', contextWindow: 65_536 },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s2-floor'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: bigMessage }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // tiny is 50× cheaper but cannot carry the context — the floor excludes it.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'a/big'])
  })

  it('S3 per-model prices take precedence over provider-level prices', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [textResponse('vip-ok')],
    }, {
      fallbacks: [{ provider: 'a' }],
      strategy: { mode: 'cost' },
      quota: {
        prices: {
          a: { input: 10, output: 10 },
          'a/vip': { input: 0.1, output: 0.1 },
        },
      },
    }, {
      // Tie under provider-level pricing would fall to id order ('std' < 'vip').
      a: [
        { id: 'std', contextWindow: 65_536 },
        { id: 'vip', contextWindow: 65_536 },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s3-per-model-price'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'a/vip'])
  })

  it('S4 the escalation ladder promotes performance mode after cost-mode failures', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [
        new LlmError('down1', 'SERVER', { status: 500 }),
        new LlmError('down2', 'SERVER', { status: 500 }),
        textResponse('strong-ok'),
      ],
    }, {
      fallbacks: [{ provider: 'a' }],
      strategy: {
        mode: 'cost',
        escalation: { afterFailures: 2 },
      },
      quota: {
        prices: {
          'a/cheap1': { input: 0.1, output: 0.2 },
          'a/cheap2': { input: 0.2, output: 0.3 },
          'a/strong': { input: 5, output: 10 },
        },
      },
    }, {
      a: [
        { id: 'cheap1', contextWindow: 65_536 },
        { id: 'cheap2', contextWindow: 65_536 },
        { id: 'strong', contextWindow: 131_072, reasoning: true },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s4-escalation'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // cost → cheap1 fails → cost → cheap2 fails → escalated performance → strong.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'a/cheap1', 'a/cheap2', 'a/strong',
    ])
    const modes = agent.session.events
      .filter(event => event.type === 'llm/fallback')
      .map(event => event.data.mode)
    expect(modes).toEqual(['cost', 'cost', 'performance'])
  })

  it('S5 a disclosed allowance below the projected cost excludes the route (floor F4)', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [textResponse('broke?')],
      b: [textResponse('alt-ok')],
    }, {
      fallbacks: [{ provider: 'a' }, { provider: 'b' }],
      strategy: { mode: 'cost' },
      quota: {
        static: { a: { kind: 'balance', remaining: 0 } },
        prices: {
          'a/cheap': { input: 0.01, output: 0.01 },
          b: { input: 0.25, output: 0.5 },
        },
      },
    }, {
      a: [{ id: 'cheap', contextWindow: 65_536 }],
      b: [{ id: 'alt', contextWindow: 65_536 }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s5-quota-floor'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // a/cheap is cheapest but broke — the allowance floor skips it entirely.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'b/alt'])
  })

  it('S6 performance mode selects the strongest capability through the whole chain', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [textResponse('weak-ok')],
      b: [textResponse('strong-ok')],
    }, {
      fallbacks: [{ provider: 'a' }, { provider: 'b' }],
      strategy: { mode: 'performance' },
    }, {
      a: [{ id: 'plain', contextWindow: 32_768 }],
      b: [{ id: 'thinker', contextWindow: 131_072, reasoning: true, maxTokens: 16_384 }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s6-performance'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'b/thinker'])
    const events = agent.session.events.filter(event => event.type === 'llm/fallback')
    expect(events[0]!.data.mode).toBe('performance')
    expect(events[0]!.data.score).toBeUndefined()
  })

  it('S7 quota-warning switches carry the strategy mode too', async () => {
    const h = await harness({
      ds: [],
      b: [textResponse('warned-ok')],
    }, {
      fallbacks: [{ provider: 'b' }],
      strategy: { mode: 'cost' },
      quota: {
        static: { ds: { kind: 'balance', remaining: 0, total: 10 } },
        thresholdAbsolute: 5,
        prices: { b: { input: 0.1, output: 0.2 } },
      },
    }, {
      b: [{ id: 'alt', contextWindow: 65_536 }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s7-warning-mode'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const warnings = agent.session.events.filter(event => event.type === 'llm/quota-warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.data.mode).toBe('cost')
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['b/alt'])
  })

  it('S8 closest mode (no strategy) never emits mode fields on events', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s8-legacy'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events.filter(event => event.type === 'llm/fallback')
    expect(events).toHaveLength(1)
    expect('mode' in events[0]!.data).toBe(false)
    expect('score' in events[0]!.data).toBe(false)
  })

  it('S9 an allowed unknown-window model is a last resort even when cheaper', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [textResponse('known-ok')],
    }, {
      fallbacks: [{ provider: 'a' }],
      strategy: { mode: 'cost' },
      allowUnknownCapacity: true,
      quota: {
        prices: {
          'a/known': { input: 5, output: 10 },
          'a/mystery': { input: 0.01, output: 0.01 },
        },
      },
    }, {
      a: [
        { id: 'mystery' }, // no contextWindow in the catalog → unknown capacity
        { id: 'known', contextWindow: 65_536 },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('s9-unknown-last'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // 'mystery' is ~500× cheaper but its window is unverifiable — the known
    // candidate clears the floor and outranks it.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'a/known'])
  })
})
