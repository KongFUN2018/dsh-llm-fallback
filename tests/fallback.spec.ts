import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, RetryPolicyConfig, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as fallback from '../src/index.ts'
import type { DecisionInput, DecisionProvider, LlmFallbackEventData, LlmQuotaWarningEventData, QuotaProvider } from '../src/types.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

interface ModelSpec {
  id: string
  contextWindow?: number
  maxTokens?: number
  modalities?: ModelModality[]
  reasoning?: boolean
}

/** One adapter serving several providers, each with its own scripted responses. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Record<string, ResolvedRetryPolicy | undefined> = {}

  constructor(
    private readonly scripts: Record<string, ScriptEntry[]>,
    private readonly catalog: Record<string, ModelSpec[]> = {},
  ) {
    super()
  }

  configureRetryPolicies(policies: Record<string, RetryPolicyConfig | undefined>): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined ? undefined : resolveRetryPolicy(policy, `fallback test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const list = this.scripts[options.provider]
    const entry = list?.shift()
    if (entry === undefined) throw new Error(`script exhausted for provider "${options.provider}"`)
    if (entry instanceof Error) throw entry
    yield* entry
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = this.catalog[provider] ?? []
    return Promise.resolve(models.map(model => ({
      provider,
      id: model.id,
      name: model.id,
      ...model.modalities === undefined ? {} : { inputModalities: model.modalities },
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = this.catalog[provider]?.find(entry => entry.id === model)
    if (spec === undefined) return Promise.resolve({ provider, id: model, name: model })
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...spec.modalities === undefined ? {} : { inputModalities: spec.modalities },
      ...spec.contextWindow === undefined ? {} : { context: { contextWindow: spec.contextWindow } },
      ...spec.maxTokens === undefined ? {} : { defaultMaxTokens: spec.maxTokens },
      ...spec.reasoning === true ? { reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'high' }] } } : {},
    })
  }
}

async function* partialTextFailure(text: string, error: Error): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  throw error
}

function toolCallResponse(id: string, name: string, arguments_: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: arguments_ } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
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
  config: fallback.Config = { fallbacks: [] },
  catalog: Record<string, ModelSpec[]> = {},
  retryOptions: { policies?: Record<string, RetryPolicyConfig | undefined>; internals?: retry.RetryInternals } = {},
  beforeFallback?: (ctx: Context) => void,
): Promise<{ ctx: Context; adapter: ScriptedAdapter; fallbackFiber: ReturnType<Context['plugin']>; stats: () => { agents: number; steps: number } | undefined; reset: () => fallback.ResetSummary | undefined }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  beforeFallback?.(ctx)
  let innerCtx: Context | undefined
  const fallbackFiber = ctx.plugin(Object.assign((inner: Context) => {
    innerCtx = inner
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  await fallbackFiber
  if (retryOptions.policies !== undefined) {
    await ctx.plugin(Object.assign((inner: Context) => {
      retry.apply(inner, {}, retryOptions.internals ?? {})
    }, { inject: retry.inject }))
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(scripts, catalog)
  if (retryOptions.policies !== undefined) adapter.configureRetryPolicies(retryOptions.policies)
  ctx.llm.registerAdapter(Object.keys(scripts), adapter)
  const stats = (): { agents: number; steps: number } | undefined =>
    innerCtx === undefined ? undefined : fallback.getFallbackStats(innerCtx)
  const reset = (): fallback.ResetSummary | undefined =>
    innerCtx === undefined ? undefined : fallback.resetFallback(innerCtx)
  return { ctx, adapter, fallbackFiber, stats, reset }
}

describe('llm-fallback (slice 1: fail-and-switch)', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    vi.unstubAllGlobals()
    delete process.env.DEEPSEEK_API_KEY
  })

  it('T1.1 switches to the first fallback route after a QUOTA failure and completes the turn', async () => {
    const h = await harness({
      ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-quota'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/opus'])

    const events = agent.session.events
    const fallbacks = events.filter(event => event.type === 'llm/fallback')
    expect(fallbacks.map(event => event.data)).toEqual([{
      turn: 1,
      step: 1,
      fromProvider: 'ds',
      fromModel: 'chat',
      toProvider: 'gl',
      toModel: 'opus',
      code: 'QUOTA',
      remaining: 0,
    }])

    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'gl', model: 'opus' },
    })

    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('T1.2 advances through the chain until one candidate succeeds', async () => {
    const h = await harness({
      ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 })],
      a: [new LlmError('rate limited', 'RATE_LIMIT', { status: 429 })],
      b: [textResponse('recovered')],
    }, {
      fallbacks: [
        { provider: 'a', model: 'm1' },
        { provider: 'b', model: 'm2' },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-chain'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'a/m1', 'b/m2',
    ])
    const fallbacks = agent.session.events.filter(event => event.type === 'llm/fallback')
    expect(fallbacks.map(event => event.data)).toEqual([
      { turn: 1, step: 1, fromProvider: 'ds', fromModel: 'chat', toProvider: 'a', toModel: 'm1', code: 'QUOTA', remaining: 1 },
      { turn: 1, step: 1, fromProvider: 'a', fromModel: 'm1', toProvider: 'b', toModel: 'm2', code: 'RATE_LIMIT', remaining: 0 },
    ])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
      source: { kind: 'model', provider: 'b', model: 'm2' },
    })
  })

  it('T1.2b exhausts the chain and delegates the final failure to the loop', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      a: [new LlmError('rate', 'RATE_LIMIT', { status: 429 })],
      b: [new LlmError('down', 'SERVER', { status: 500 })],
    }, {
      fallbacks: [
        { provider: 'a', model: 'm1' },
        { provider: 'b', model: 'm2' },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-exhausted'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'a/m1', 'b/m2',
    ])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(2)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  it('T1.3 does not switch on a non-eligible failure code', async () => {
    const h = await harness({
      ds: [new LlmError('bad request', 'INVALID_REQUEST', { status: 400 })],
      gl: [textResponse('should not run')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-ineligible'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(0)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST' } } },
    })
  })

  it('T1.5 does not switch when cancellation wins the recovery race', async () => {
    const h = await harness(
      { ds: [new LlmError('quota', 'QUOTA', { status: 402 })], gl: [textResponse('unused')] },
      { fallbacks: [{ provider: 'gl', model: 'opus' }] },
      {},
      {},
      (inner) => {
        inner.on('agent/request-error', async ({ agent }, next) => {
          agent.cancel({ kind: 'user' })
          return next()
        })
      },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('abort'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(0)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('T4.1b re-sends identical history after a mid-stream failure', async () => {
    const h = await harness({
      ds: [partialTextFailure('discarded partial', new LlmError('quota', 'QUOTA', { status: 402 }))],
      gl: [textResponse('done')],
    }, { fallbacks: [{ provider: 'gl', model: 'opus' }] })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('partial'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/opus'])
    expect(h.adapter.requests[1]?.messages).toEqual(h.adapter.requests[0]?.messages)
    expect(JSON.stringify(h.adapter.requests[1]?.messages)).not.toContain('discarded partial')
    expect(agent.session.deriveMessages().filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('T4.2 keeps completed tool results when switching mid-tool-loop', async () => {
    const h = await harness({
      ds: [toolCallResponse('c1', 'calc', '{}'), new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, { fallbacks: [{ provider: 'gl', model: 'opus' }] })
    ctx = h.ctx
    ctx.tools.register(defineContentToolFixture({
      name: 'calc',
      description: '',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'tool done' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('tool-continue'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'ds/chat', 'gl/opus'])
    expect(JSON.stringify(h.adapter.requests[2]?.messages)).toContain('tool done')
    expect(agent.session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
  })

  it('T4.1 continues subsequent turns normally after a switch', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('turn1 done'), textResponse('turn2 done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-continue'), { provider: 'ds', model: 'chat' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // The switch persists the request header, so the next turn keeps the
    // fallback route without re-hitting the exhausted primary.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'gl/opus', 'gl/opus',
    ])
    const messages = agent.session.deriveMessages()
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'turn1 done' }],
      source: { kind: 'model', provider: 'gl', model: 'opus' },
    })
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'turn2 done' }],
      source: { kind: 'model', provider: 'gl', model: 'opus' },
    })
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('T2.1 selects the capability-matched model from the target provider catalog', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }],
    }, {
      ds: [{ id: 'chat', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] }],
      gl: [
        { id: 'opus', contextWindow: 200000, maxTokens: 32000, modalities: ['text'] },
        { id: 'sonnet', contextWindow: 200000, maxTokens: 16000, modalities: ['text'] },
        { id: 'haiku', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-match'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/haiku'])
    const fallbacks = agent.session.events.filter(event => event.type === 'llm/fallback')
    expect(fallbacks.map(event => event.data)).toEqual([{
      turn: 1, step: 1, fromProvider: 'ds', fromModel: 'chat', toProvider: 'gl', toModel: 'haiku', code: 'QUOTA', remaining: 0,
    }])
  })

  it('T2.2 chooses the closest non-degrading candidate when no exact match exists', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }],
    }, {
      ds: [{ id: 'chat', contextWindow: 128000 }],
      gl: [
        { id: 'opus', contextWindow: 200000 },
        { id: 'haiku', contextWindow: 32000 },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-nondegrade'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/opus'])
  })

  it('T2.3 skips a provider with no non-degrading candidate and continues the chain', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('should not run')],
      az: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }, { provider: 'az', model: 'gpt' }],
    }, {
      ds: [{ id: 'chat', contextWindow: 128000 }],
      gl: [{ id: 'small', contextWindow: 32000 }],
      az: [{ id: 'gpt', contextWindow: 200000 }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-skip'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'az/gpt'])
    const fallbacks = agent.session.events.filter(event => event.type === 'llm/fallback')
    expect(fallbacks.map(event => event.data)).toEqual([{
      turn: 1, step: 1, fromProvider: 'ds', fromModel: 'chat', toProvider: 'az', toModel: 'gpt', code: 'QUOTA', remaining: 0,
    }])
  })

  it('T2.4 skips candidates with unknown capacity by default', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('should not run')],
      az: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }, { provider: 'az', model: 'gpt' }],
    }, {
      ds: [{ id: 'chat', contextWindow: 128000 }],
      gl: [{ id: 'mystery' }],
      az: [{ id: 'gpt', contextWindow: 200000 }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-unknown'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'az/gpt'])
  })

  it('T2.4b accepts unknown capacity when allowUnknownCapacity is set', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }],
      allowUnknownCapacity: true,
    }, {
      ds: [{ id: 'chat', contextWindow: 128000 }],
      gl: [{ id: 'mystery' }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('fallback-unknown-accept'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/mystery'])
  })

  it('T8.6 warns an observable primary before ever probing an unobservable fallback', async () => {
    const h = await harness({
      ds: [textResponse('unused')],
      fb1: [textResponse('done')],
      fb2: [textResponse('unused')],
    }, {
      fallbacks: [{ provider: 'fb1', model: 'm1' }, { provider: 'fb2', model: 'm2' }],
      quota: {
        thresholdAbsolute: 20,
        static: { ds: { kind: 'balance', remaining: 10 }, fb1: { kind: 'balance', remaining: 100 } },
      },
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('warn-then-probe'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // The observable primary is warned out and the observable fb1 serves it;
    // the unobservable fb2 is never attempted and no failure ever happens.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['fb1/m1'])
    expect(agent.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(0)
  })

  it('T8.4 caches the probed route as healthy for the session under a re-applied selection', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('turn1 done'), textResponse('turn2 done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    // Simulate installModelSelection re-applying the user's primary selection every request.
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('healthy-cache'), { provider: 'ds', model: 'chat' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'gl/opus', 'gl/opus',
    ])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('T9.1 advances past a structurally unusable candidate (NO_ADAPTER) without terminating', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [
        { provider: 'missing', model: 'x' },
        { provider: 'gl', model: 'opus' },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('unusable-skip'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/opus'])
    const fallbacks = agent.session.events.filter(event => event.type === 'llm/fallback')
    expect(fallbacks.map(event => event.data)).toEqual([
      { turn: 1, step: 1, fromProvider: 'ds', fromModel: 'chat', toProvider: 'missing', toModel: 'x', code: 'QUOTA', remaining: 1 },
      { turn: 1, step: 1, fromProvider: 'missing', fromModel: 'x', toProvider: 'gl', toModel: 'opus', code: 'NO_ADAPTER', remaining: 0 },
    ])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'gl', model: 'opus' },
    })
    expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('T9.2 skips cooled-down chain candidates on a later turn', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 }), new LlmError('quota again', 'QUOTA', { status: 402 })],
      fb1: [new LlmError('rate', 'RATE_LIMIT', { status: 429 })],
      fb2: [new LlmError('down', 'SERVER', { status: 500 })],
    }, {
      fallbacks: [
        { provider: 'fb1', model: 'm1' },
        { provider: 'fb2', model: 'm2' },
      ],
      cooldownMs: 60_000,
    })
    ctx = h.ctx
    // Simulate installModelSelection re-applying the user's primary selection.
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('cooldown-skip'), { provider: 'ds', model: 'chat' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'fb1/m1', 'fb2/m2', 'ds/chat',
    ])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(2)
  })

  it('T8.2 probes availability first, then capability-matches inside the surviving provider', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      fb1: [new LlmError('quota', 'QUOTA', { status: 402 })],
      fb2: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'fb1' }, { provider: 'fb2' }],
    }, {
      ds: [{ id: 'chat', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] }],
      fb1: [{ id: 'm', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] }],
      fb2: [
        { id: 'opus', contextWindow: 200000, maxTokens: 32000, modalities: ['text'] },
        { id: 'sonnet', contextWindow: 200000, maxTokens: 16000, modalities: ['text'] },
        { id: 'haiku', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('two-stage-probe'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'fb1/m', 'fb2/haiku'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(2)
  })

  it('T5.1 preemptively switches when balance is below threshold without a failure', async () => {
    const h = await harness({
      ds: [textResponse('should not run')],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
      quota: {
        thresholdAbsolute: 200,
        static: { ds: { kind: 'balance', remaining: 100 } },
      },
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('warn-switch'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus'])
    const warnings = agent.session.events.filter(event => event.type === 'llm/quota-warning')
    expect(warnings.map(event => event.data)).toEqual([{
      turn: 1, step: 1, provider: 'ds', model: 'chat', remaining: 100, threshold: 200, reason: 'below-threshold',
    }])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'gl', model: 'opus' },
    })
  })

  it('T5.2a does not trip exactly at the absolute threshold', async () => {
    const h = await harness({
      ds: [textResponse('ok')],
      gl: [textResponse('unused')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
      quota: { thresholdAbsolute: 200, static: { ds: { kind: 'balance', remaining: 200 } } },
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('boundary-eq'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat'])
    expect(agent.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(0)
  })

  it('T5.2b trips on an absolute shortfall and on a ratio shortfall', async () => {
    const h = await harness({
      ds: [textResponse('should not run')],
      gl: [textResponse('done')],
      az: [textResponse('done too')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
      quota: {
        thresholdAbsolute: 200,
        static: { ds: { kind: 'balance', remaining: 199 } },
      },
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('below-abs'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus'])
    expect(agent.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(1)

    const h2 = await harness({
      ds: [textResponse('should not run')],
      az: [textResponse('ratio done')],
    }, {
      fallbacks: [{ provider: 'az', model: 'gpt' }],
      quota: {
        thresholdRatio: 0.5,
        static: { ds: { kind: 'quota', remaining: 300, total: 1000 } },
      },
    })
    ctx = h2.ctx
    const agent2 = ctx.agentLoop.create(SessionId('below-ratio'), { provider: 'ds', model: 'chat' })
    agent2.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent2.whenIdle()
    expect(h2.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['az/gpt'])
    expect(agent2.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(1)
  })

  it('T6.2a keeps a quota route banned until resetAt', async () => {
    const resetAt = Date.now() + 3_600_000
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 }), new LlmError('quota', 'QUOTA', { status: 402 })],
      fb1: [new LlmError('down', 'SERVER', { status: 500 })],
    }, {
      fallbacks: [{ provider: 'fb1', model: 'm1' }],
      quota: { static: { fb1: { kind: 'quota', remaining: 0, resetAt } } },
    })
    ctx = h.ctx
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('quota-reset-future'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'fb1/m1', 'ds/chat',
    ])
  })

  it('T6.2b recovers a quota route whose resetAt has passed', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 }), new LlmError('quota', 'QUOTA', { status: 402 })],
      fb1: [new LlmError('down', 'SERVER', { status: 500 }), textResponse('recovered')],
    }, {
      fallbacks: [{ provider: 'fb1', model: 'm1' }],
      quota: { static: { fb1: { kind: 'quota', remaining: 0, resetAt: Date.now() - 1000 } } },
    })
    ctx = h.ctx
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('quota-reset-past'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'fb1/m1', 'ds/chat', 'fb1/m1',
    ])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      content: [{ type: 'text', text: 'recovered' }],
      source: { kind: 'model', provider: 'fb1', model: 'm1' },
    })
  })

  it('T5.4 an unobservable route never warns and only degrades via trial-and-error', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('unobservable'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/opus'])
    expect(agent.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('T6.1 balance exhaustion bans permanently regardless of a short cooldown', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 }), new LlmError('quota', 'QUOTA', { status: 402 })],
      fb1: [new LlmError('down', 'SERVER', { status: 500 })],
    }, {
      fallbacks: [{ provider: 'fb1', model: 'm1' }],
      cooldownMs: 1,
      quota: { static: { fb1: { kind: 'balance', remaining: 0 } } },
    })
    ctx = h.ctx
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('balance-permanent'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 20))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'fb1/m1', 'ds/chat',
    ])
  })

  it('T6.4 treats balance, quota, and unobservable kinds independently in one chain', async () => {
    const h = await harness({
      ds: [textResponse('unused')],
      gl: [textResponse('turn1 done'), textResponse('turn2 done')],
      az: [textResponse('unused')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }, { provider: 'az', model: 'gpt' }],
      quota: {
        thresholdAbsolute: 20,
        static: {
          ds: { kind: 'balance', remaining: 10 },
          gl: { kind: 'quota', remaining: 30, total: 100, resetAt: Date.now() + 7_200_000 },
        },
      },
    })
    ctx = h.ctx
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('mixed-kinds'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // ds (balance) is warned out, gl (quota) stays healthy, az (unobservable) is never reached.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus', 'gl/opus'])
    expect(agent.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(0)
  })

  it('T3.1 breaks same-provider ties by the speed preference', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, { fallbacks: [{ provider: 'gl' }], preference: 'speed' }, {
      ds: [{ id: 'chat', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] }],
      gl: [
        { id: 'aa-slow', contextWindow: 128000, maxTokens: 32000, modalities: ['text'] },
        { id: 'zz-fast', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('pref-speed'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/zz-fast'])
  })

  it('T3.1b breaks same-provider ties by the reasoning preference', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, { fallbacks: [{ provider: 'gl' }], preference: 'reasoning' }, {
      ds: [{ id: 'chat', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] }],
      gl: [
        { id: 'plain', contextWindow: 128000, maxTokens: 8000, modalities: ['text'] },
        { id: 'thinker', contextWindow: 128000, maxTokens: 8000, modalities: ['text'], reasoning: true },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('pref-reasoning'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/thinker'])
  })

  it('T3.2 adopts a decision provider result over rule matching', async () => {
    const decisions: DecisionInput[] = []
    const decisionProvider: DecisionProvider = {
      async decide(input) {
        decisions.push(input)
        return { provider: 'gl', model: 'opus' }
      },
    }
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }],
      decisionProvider,
    }, {
      gl: [
        { id: 'haiku', contextWindow: 128000, maxTokens: 8000 },
        { id: 'opus', contextWindow: 200000, maxTokens: 8000 },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('decision-adopt'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/opus'])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.candidates.map(candidate => candidate.model)).toEqual(['haiku', 'opus'])
  })

  it('T3.3 falls back to rule matching when the decision provider throws', async () => {
    const decisionProvider: DecisionProvider = {
      async decide() { throw new Error('boom') },
    }
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }],
      decisionProvider,
    }, {
      gl: [
        { id: 'haiku', contextWindow: 128000, maxTokens: 8000 },
        { id: 'opus', contextWindow: 200000, maxTokens: 8000 },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('decision-throws'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/haiku'])
  })

  it('T3.4 rejects an invalid decision route and falls back to rules', async () => {
    const decisionProvider: DecisionProvider = {
      async decide() { return { provider: 'unknown', model: 'x' } },
    }
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl' }],
      decisionProvider,
    }, {
      gl: [
        { id: 'haiku', contextWindow: 128000, maxTokens: 8000 },
        { id: 'opus', contextWindow: 200000, maxTokens: 8000 },
      ],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('decision-invalid'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/haiku'])
  })

  it('T7.1 rejects duplicate routes and empty identifiers at load', () => {
    expect(() => fallback.apply(new Context(), {
      fallbacks: [{ provider: 'gl', model: 'opus' }, { provider: 'gl', model: 'opus' }],
    })).toThrow(/duplicate/)
    expect(() => fallback.apply(new Context(), {
      fallbacks: [{ provider: '', model: 'x' }],
    })).toThrow(/empty/)
    expect(() => fallback.apply(new Context(), {
      fallbacks: [{ provider: 'gl', model: '' }],
    })).toThrow(/empty/)
  })

  it('T7.2 keeps the fallback event payloads identical to the session event map', () => {
    expectTypeOf<LlmFallbackEventData>().toEqualTypeOf<SessionEventMap['llm/fallback']>()
    expectTypeOf<LlmQuotaWarningEventData>().toEqualTypeOf<SessionEventMap['llm/quota-warning']>()
  })

  it('T7.4 isolates switching state across agents', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 }), new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('a1'), textResponse('a2')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    const agent1 = ctx.agentLoop.create(SessionId('iso-1'), { provider: 'ds', model: 'chat' })
    const agent2 = ctx.agentLoop.create(SessionId('iso-2'), { provider: 'ds', model: 'chat' })
    agent1.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent1.whenIdle()
    agent2.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent2.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'ds/chat', 'gl/opus', 'ds/chat', 'gl/opus',
    ])
    expect(agent1.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(agent2.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('T-C4 caches a successful quota interrogation within TTL across agents', async () => {
    let calls = 0
    const provider: QuotaProvider = {
      name: 'fake-quota',
      async check() {
        calls += 1
        return { kind: 'balance', remaining: 500 }
      },
    }
    const h = await harness({
      ds: [textResponse('one'), textResponse('two')],
    }, {
      fallbacks: [],
      quota: { thresholdAbsolute: 200, providers: [provider] },
    })
    ctx = h.ctx
    const agent1 = ctx.agentLoop.create(SessionId('quota-cache-1'), { provider: 'ds', model: 'chat' })
    const agent2 = ctx.agentLoop.create(SessionId('quota-cache-2'), { provider: 'ds', model: 'chat' })
    agent1.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent1.whenIdle()
    agent2.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent2.whenIdle()

    expect(calls).toBe(1)
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'ds/chat'])
    expect(agent1.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(0)
  })

  it('T-D1 built-in DeepSeek balance source warns below threshold without a failure', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key'
    let fetchedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetchedUrl = url
      return {
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '100' }],
        }),
      }
    }))
    const h = await harness({
      ds: [textResponse('should not run')],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
      quota: {
        thresholdAbsolute: 200,
        deepseek: { provider: 'ds', baseURL: 'https://test.local' },
      },
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('deepseek-balance'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(fetchedUrl).toBe('https://test.local/user/balance')
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus'])
    const warnings = agent.session.events.filter(event => event.type === 'llm/quota-warning')
    expect(warnings.map(event => event.data)).toEqual([{
      turn: 1, step: 1, provider: 'ds', model: 'chat', remaining: 100, threshold: 200, reason: 'below-threshold',
    }])
  })

  it('T7.6 does not intercept after disposal', async () => {
    const h = await harness({
      ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
      gl: [textResponse('done')],
    }, {
      fallbacks: [{ provider: 'gl', model: 'opus' }],
    })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('disposed'), { provider: 'ds', model: 'chat' })
    await h.fallbackFiber.dispose()

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(0)
    expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  })

  it('T7.5 retires finished-turn step state instead of growing unbounded', async () => {
    const h = await harness({
      ds: [textResponse('t1'), textResponse('t2'), textResponse('t3')],
    }, { fallbacks: [{ provider: 'gl', model: 'opus' }] })
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('retire'), { provider: 'ds', model: 'chat' })
    const stats = (): { agents: number; steps: number } =>
      h.stats() ?? { agents: 0, steps: 0 }

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'three' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(stats().agents).toBe(1)
    expect(stats().steps).toBeLessThanOrEqual(1)
  })

  it('T7.3 registered before llm-retry switches first instead of retrying the primary', async () => {
    const h = await harness(
      {
        ds: [new LlmError('quota', 'QUOTA', { status: 402 })],
        gl: [textResponse('done')],
      },
      { fallbacks: [{ provider: 'gl', model: 'opus' }] },
      {},
      {
        policies: {
          ds: {
            mode: 'normal',
            maxRetries: 3,
            retryableCodes: ['QUOTA'],
            backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        },
      },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('coexist'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // The fallback handler short-circuits retry: ds runs once, then gl serves the turn.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['ds/chat', 'gl/opus'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
  })

  it('T5.6 polling clears a stale fallback once the primary allowance recovers', async () => {
    let remaining = 100
    const provider: QuotaProvider = {
      name: 'fake-quota',
      async check() {
        return { kind: 'balance', remaining }
      },
    }
    const h = await harness(
      { ds: [textResponse('recovered')], gl: [textResponse('done')] },
      {
        fallbacks: [{ provider: 'gl', model: 'opus' }],
        pollIntervalMs: 10,
        quota: { thresholdAbsolute: 200, providers: [provider], cacheMs: 0 },
      },
    )
    ctx = h.ctx
    // Simulate installModelSelection re-applying the user's primary selection every request.
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('poll'), { provider: 'ds', model: 'chat' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus'])

    remaining = 500
    await new Promise(resolve => setTimeout(resolve, 50))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus', 'ds/chat'])
  })

  it('T5.7 a preemptive switch sends exactly one request and never retries', async () => {
    const h = await harness(
      { ds: [textResponse('should not run')], gl: [textResponse('done')] },
      {
        fallbacks: [{ provider: 'gl', model: 'opus' }],
        quota: { thresholdAbsolute: 200, static: { ds: { kind: 'balance', remaining: 100 } } },
      },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('idempotent'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'llm/quota-warning')).toHaveLength(1)
  })

  it('T5.3 switches when remaining cannot cover the projected request cost', async () => {
    const h = await harness(
      { ds: [textResponse('should not run')], gl: [textResponse('done')] },
      {
        fallbacks: [{ provider: 'gl', model: 'opus' }],
        quota: {
          static: { ds: { kind: 'balance', remaining: 50 } },
          prices: { ds: { output: 100 } },
          estimatedOutputTokens: 1_000_000,
        },
      },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('cost-trip'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual(['gl/opus'])
    const warnings = agent.session.events.filter(event => event.type === 'llm/quota-warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.data).toMatchObject({
      reason: 'insufficient-cost',
      provider: 'ds',
      model: 'chat',
      remaining: 50,
      inputPrice: 0,
      outputPrice: 100,
    })
    expect(warnings[0]!.data.estimatedCost).toBeCloseTo(100, 5)
  })

  it('T5.8 a user model switch is re-checked with a fresh allowance and redirects when under-funded', async () => {
    const h = await harness(
      {
        ds: [textResponse('first-ok')],
        az: [textResponse('fallback-ok')],
      },
      {
        fallbacks: [{ provider: 'az', model: 'model-az' }],
        quota: {
          static: {
            ds: { kind: 'balance', remaining: 100 },
            gl: { kind: 'balance', remaining: 5 },
          },
          thresholdAbsolute: 10,
          cacheMs: 30_000,
        },
      },
    )
    ctx = h.ctx
    // The user switches the session model selection on the second turn.
    let selected = { provider: 'ds', model: 'chat' }
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      return payload.turn >= 2
        ? { ...resolved, provider: selected.provider, model: selected.model }
        : resolved
    })
    const agent = ctx.agentLoop.create(SessionId('user-switch-quota'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    selected = { provider: 'gl', model: 'new-model' }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // Turn 1 runs ds/chat. Turn 2 the user picked gl/new-model — an under-funded fresh
    // primary (5 < threshold 10) — so the plugin forces a fresh check and redirects
    // to the fallback instead of trusting the stale cache or admitting the user model.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'az/model-az'])
    const warnings = agent.session.events.filter(event => event.type === 'llm/quota-warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.data).toMatchObject({
      provider: 'gl',
      model: 'new-model',
      remaining: 5,
      threshold: 10,
      reason: 'below-threshold',
    })
  })

  it('T5.9 a user model switch respects the user over the session healthy fallback', async () => {
    const h = await harness(
      {
        ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 })],
        gl: [textResponse('healthy-ok')],
        az: [textResponse('user-pick-ok')],
      },
      { fallbacks: [{ provider: 'gl', model: 'opus' }] },
    )
    ctx = h.ctx
    let selected = { provider: 'gl', model: 'opus' }
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      return payload.turn >= 2
        ? { ...resolved, provider: selected.provider, model: selected.model }
        : resolved
    })
    const agent = ctx.agentLoop.create(SessionId('user-switch-respect'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    selected = { provider: 'az', model: 'pick' }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // Turn 1: ds fails, the plugin falls back to gl/opus which becomes the session
    // healthy route. Turn 2: the user picks az/pick — a user switch, so the plugin
    // must NOT force the request back to gl/opus and instead honor az/pick.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'gl/opus', 'az/pick'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('T5.10 a user switch to an unobservable model probes with the request and warns', async () => {
    const h = await harness(
      {
        ds: [textResponse('first-ok')],
        gl: [textResponse('probe-ok')],
      },
      { fallbacks: [{ provider: 'az', model: 'never' }] },
    )
    ctx = h.ctx
    let selected = { provider: 'ds', model: 'chat' }
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      return payload.turn >= 2
        ? { ...resolved, provider: selected.provider, model: selected.model }
        : resolved
    })
    const agent = ctx.agentLoop.create(SessionId('user-switch-unobservable'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    selected = { provider: 'gl', model: 'haiku' }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // gl/haiku has no disclosed quota (unobservable), so the plugin honors the
    // selection and sends this very request as the probe.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'gl/haiku'])
    const warnings = agent.session.events.filter(event => event.type === 'llm/quota-warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.data).toMatchObject({
      provider: 'gl',
      model: 'haiku',
      reason: 'unobservable',
    })
  })

  it('T6.5 resetFallback restores every model to usability by clearing bans/healthy/failures', async () => {
    const h = await harness(
      {
        ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 }), textResponse('ds-recovered')],
        gl: [textResponse('gl-opus-ok')],
      },
      { fallbacks: [{ provider: 'gl', model: 'opus' }] },
    )
    ctx = h.ctx
    // Simulate installModelSelection re-applying the user's primary every request,
    // so a per-request switch does not persist the fallback route as the header.
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'ds', model: 'chat' }
    })
    const agent = ctx.agentLoop.create(SessionId('reset'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // ds failed (now banned) and gl/opus became the session-healthy route.
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'gl/opus'])

    const summary = h.reset()!
    expect(summary.resetAgents).toBe(1)
    expect(summary.clearedBans).toBeGreaterThanOrEqual(1)
    expect(summary.clearedFailures).toBeGreaterThanOrEqual(1)

    // After the reset, a fresh turn with the same primary re-tries ds/chat
    // instead of being redirected to the (cleared) healthy gl/opus or skipping
    // the (cleared) banned ds.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(h.adapter.requests.map(request => `${request.provider}/${request.model}`))
      .toEqual(['ds/chat', 'gl/opus', 'ds/chat'])
  })
})
