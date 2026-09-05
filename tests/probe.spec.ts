import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import * as fallback from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

interface ModelSpec { id: string; contextWindow?: number; maxTokens?: number; modalities?: ModelModality[]; reasoning?: boolean }

/** probe 感知适配器：按 maxTokens===1 区分 probe 请求，单独从 probeScripts 消费，与真实请求的 scripts 隔离。 */
class ProbeAwareAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly probeScripts: Record<string, ScriptEntry[]>
  constructor(
    private readonly scripts: Record<string, ScriptEntry[]>,
    probe: Record<string, ScriptEntry[]> = {},
    private readonly catalog: Record<string, ModelSpec[]> = {},
  ) {
    super()
    this.probeScripts = probe
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const isProbe = options.maxTokens === 1
    const list = isProbe ? (this.probeScripts[options.provider] ?? []) : this.scripts[options.provider]
    const entry = list?.shift()
    if (entry === undefined) throw new Error(`script exhausted for provider "${options.provider}"${isProbe ? ' (probe)' : ''}`)
    if (entry instanceof Error) throw entry
    yield* entry
  }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = this.catalog[provider] ?? []
    return Promise.resolve(models.map(model => ({ provider, id: model.id, name: model.id })))
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = this.catalog[provider]?.find(entry => entry.id === model)
    if (spec === undefined) return Promise.resolve({ provider, id: model, name: model })
    return Promise.resolve({
      provider, id: model, name: model,
      ...spec.contextWindow === undefined ? {} : { context: { contextWindow: spec.contextWindow } },
      ...spec.modalities === undefined ? {} : { inputModalities: spec.modalities },
      ...spec.maxTokens === undefined ? {} : { defaultMaxTokens: spec.maxTokens },
    })
  }
}

function textResponse(text = 'ok'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
function errorResponse(code: string, message: string): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }]
}

async function harness(
  scripts: Record<string, ScriptEntry[]>,
  probe: Record<string, ScriptEntry[]>,
  config: fallback.Config,
  catalog: Record<string, ModelSpec[]> = {},
): Promise<{ ctx: Context; adapter: ProbeAwareAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const installFallback = (inner: Context): void => { fallback.apply(inner, config) }
  const installRetry = (inner: Context): void => { retry.apply(inner, {}) }
  Object.assign(installFallback, { inject: fallback.inject })
  Object.assign(installRetry, { inject: retry.inject })
  const adapter = new ProbeAwareAdapter(scripts, probe, catalog)
  await ctx.plugin(installFallback)
  await ctx.plugin(installRetry)
  ctx.llm.registerAdapter(Object.keys(scripts), adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, adapter }
}

describe('llm-fallback probe (post-selection availability check)', () => {
  let ctx: Context | undefined
  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    vi.unstubAllGlobals()
  })

  it('P1: probe failure on a candidate bans it and advances to the next candidate', async () => {
    const h = await harness(
      {
        ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 })],
        gl: [textResponse('done')],           // 真实请求（切到 gl 后）
      },
      {
        gl: [errorResponse('UNKNOWN_MODEL', 'no configured model')],   // probe gl 失败
      },
      {
        fallbacks: [{ provider: 'gl', model: 'opus' }],
        probe: { enabled: true },
      },
      { gl: [{ id: 'opus', contextWindow: 200000, maxTokens: 32000, modalities: ['text'] }] },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('probe-advance'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // ds 失败后，先 probe gl（失败），链耗尽 → 无候选。
    // 断言：probe 失败被记录为 llm/fallback 且 reason=probe-failed，turn 以 error 结束
    const fallbacks = agent.session.events.filter(e => e.type === 'llm/fallback')
    console.log('P1 fallback events:', JSON.stringify(fallbacks.map(e => e.data)))
    console.log('P1 requests:', h.adapter.requests.map(r => `${r.provider}/${r.model}`))
    // ds 的 QUOTA 失败先切换；probe gl 失败；链已无候选 → 最终 turn 报错
    expect(fallbacks.length).toBeGreaterThanOrEqual(1)
    const last = fallbacks.at(-1)?.data as { reason?: string; toProvider?: string }
    expect(last.reason).toBe('probe-failed')
    expect(last.toProvider).toBe('gl')
  })

  it('P2: probe success lets the switch go through and the turn completes', async () => {
    const h = await harness(
      {
        ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 })],
        gl: [textResponse('done')],
      },
      {
        gl: [textResponse('probe-ok')],       // probe gl 成功
      },
      {
        fallbacks: [{ provider: 'gl', model: 'opus' }],
        probe: { enabled: true },
      },
      { gl: [{ id: 'opus', contextWindow: 200000, maxTokens: 32000, modalities: ['text'] }] },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('probe-ok'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const requests = h.adapter.requests.map(r => `${r.provider}/${r.model}`)
    console.log('P2 requests:', requests)
    // probe(gl,1token) 成功 + 真实(gl) 成功
    expect(requests.at(-1)).toBe('gl/opus')
    // 没有 probe-failed 标记
    const fallbacks = agent.session.events.filter(e => e.type === 'llm/fallback')
    const probeFailed = fallbacks.filter(e => (e.data as { reason?: string }).reason === 'probe-failed')
    expect(probeFailed.length).toBe(0)
    // 最终消息来自 gl
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'gl', model: 'opus' },
    })
  })

  it('P4: first candidate probe-failed → advances to a healthy second candidate', async () => {
    const h = await harness(
      {
        ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 })],
        gl: [textResponse('gl-heavy')],
        gb: [textResponse('done')],
      },
      {
        gl: [errorResponse('UNKNOWN_MODEL', 'no configured model')],  // gl probe 失败
        gb: [textResponse('probe-ok')],                              // gb probe 成功
      },
      {
        fallbacks: [
          { provider: 'gl', model: 'opus' },
          { provider: 'gb', model: 'sonnet' },
        ],
        probe: { enabled: true },
      },
      {
        gl: [{ id: 'opus', contextWindow: 200000, maxTokens: 32000, modalities: ['text'] }],
        gb: [{ id: 'sonnet', contextWindow: 200000, maxTokens: 16000, modalities: ['text'] }],
      },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('probe-advance-to-second'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const requests = h.adapter.requests.map(r => `${r.provider}/${r.model}`)
    console.log('P4 requests:', requests)
    console.log('P4 final:', JSON.stringify(agent.session.deriveMessages().at(-1)))
    // ds 失败 → 切 gl（probe 失败被跳过）→ 切 gb（probe 成功，真实请求成功）
    expect(requests[0]).toBe('ds/chat')
    expect(requests).toContain('gl/opus')     // probe 请求
    expect(requests.at(-1)).toBe('gb/sonnet') // 真实请求落到 gb
    const fallbacks = agent.session.events.filter(e => e.type === 'llm/fallback')
    const probeFailed = fallbacks.filter(e => (e.data as { reason?: string }).reason === 'probe-failed')
    // 一条 probe-failed（gl），一条成功切换（gb）
    expect(probeFailed.length).toBe(1)
    expect(probeFailed[0]?.data).toMatchObject({ toProvider: 'gl', toModel: 'opus', reason: 'probe-failed' })
    // 最终消息来自 gb（成功的第二候选）
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'gb', model: 'sonnet' },
    })
  })

  it('P3: probe disabled (default) — switch goes through with no probe request at all', async () => {    const h = await harness(
      {
        ds: [new LlmError('quota exhausted', 'QUOTA', { status: 402 })],
        gl: [textResponse('done')],
      },
      {},
      {
        fallbacks: [{ provider: 'gl', model: 'opus' }],
        // probe 默认关闭
      },
      { gl: [{ id: 'opus', contextWindow: 200000, maxTokens: 32000, modalities: ['text'] }] },
    )
    ctx = h.ctx
    const agent = ctx.agentLoop.create(SessionId('probe-off'), { provider: 'ds', model: 'chat' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const requests = h.adapter.requests.map(r => `${r.provider}/${r.model}`)
    console.log('P3 requests:', requests)
    // 应只有 ds(失败) + gl(成功)，无 probe（maxTokens=1 无）
    expect(requests).toEqual(['ds/chat', 'gl/opus'])
  })
})
