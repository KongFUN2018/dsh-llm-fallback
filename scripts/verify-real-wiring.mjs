/**
 * Real-wiring verification for @kongfun2018/dsh-llm-fallback.
 *
 * Runs the plugin's shipped build (lib/index.js) inside the ACTUAL production
 * runtime tree (the globally installed dsh — cordis, dsh-llm, dsh-agent-loop,
 * dsh-llm-pi-ai, dsh-llm-retry), with a local HTTP mock standing in for the
 * vendor gateways:
 *
 *   - iwhalecloud  → fails the way production does (429 + Chinese
 *                    budget_exceeded body, or 402 Insufficient Balance)
 *   - zai-coding-cn → answers a well-formed OpenAI SSE stream
 *
 * This exercises the seams tests/fallback.spec.ts cannot: real HTTP error →
 * OpenAI SDK error → pi-ai classification → agent/request-error waterfall with
 * llm-retry registered FIRST (production composition: retry outermost).
 *
 * Usage:  node scripts/verify-real-wiring.mjs
 * Requires the global dsh install (C:\\Users\\KongFUN\\AppData\\Local\\nvm\\...).
 * Not part of `npm test` — it verifies the local production environment.
 */
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const DSH = 'file:///C:/Users/KongFUN/AppData/Local/nvm/v24.9.0/node_modules/@deepseek-ai/dsh/node_modules'

const { Context } = await import(`${DSH}/@deepseek-ai/cordis/lib/index.js`)
const { default: LlmRuntime, createUserMessage } = await import(`${DSH}/@deepseek-ai/dsh-llm/lib/index.js`)
const { default: SessionStore, SessionId } = await import(`${DSH}/@deepseek-ai/dsh-session/lib/index.js`)
const { default: SystemPrompt } = await import(`${DSH}/@deepseek-ai/dsh-system-prompt/lib/index.js`)
const { default: ToolRuntime } = await import(`${DSH}/@deepseek-ai/dsh-tools/lib/index.js`)
const { default: CommandRuntime } = await import(`${DSH}/@deepseek-ai/dsh-commands/lib/index.js`)
const { default: AgentRegistry } = await import(`${DSH}/@deepseek-ai/dsh-agent/lib/index.js`)
const { default: AgentLoop } = await import(`${DSH}/@deepseek-ai/dsh-agent-loop/lib/index.js`)
const llmRetry = await import(`${DSH}/@deepseek-ai/dsh-llm-retry/lib/index.js`)
const piAi = await import(`${DSH}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`)

// The plugin under test: the repo's shipped artifact, not src.
const fallback = await import('../lib/index.js')

process.env.IW_TEST_KEY ??= 'test-iw-key'
process.env.ZAI_TEST_KEY ??= 'test-zai-key'

/** The exact payloads production returned (OpenAI `error`-wrapped), per the
 * session record: iwhalecloud exhaustion is 429 budget_exceeded (Chinese
 * message → pi-ai classifies RATE_LIMIT); a zeroed balance is 402 with
 * English wording (→ QUOTA). */
const IW_429_BODY = JSON.stringify({
  error: {
    message: '今日额度已耗尽（信控累计: 104.56元，限额: 101.00元；额外池余额: 0.00元），请明天再试',
    type: 'budget_exceeded',
    param: 'cost_quota',
    code: '429',
  },
})
const IW_402_BODY = JSON.stringify({
  error: { message: 'Insufficient Balance', type: 'billing_error', code: '402' },
})

function sseSuccess(model, text) {
  const chunk = (delta, finishReason, usage) => `data: ${JSON.stringify({
    id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...usage === undefined ? {} : { usage },
  })}\n\n`
  return chunk({ role: 'assistant', content: '' }, null)
    + chunk({ content: text }, null)
    + chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
    + 'data: [DONE]\n\n'
}

/** Mock vendor gateway. iwMode: '429' | '402'. Records every request. */
function startMock(iwMode) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let model = ''
      try { model = JSON.parse(body).model ?? '' } catch { /* not JSON */ }
      requests.push({ url: req.url, model })
      if (req.url?.endsWith('/user/balance')) {
        // Production iwhalecloud has no balance endpoint: 404, like the real thing.
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"detail":"Not Found"}')
        return
      }
      if (req.url?.startsWith('/iw/')) {
        const status = iwMode === '429' ? 429 : 402
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(iwMode === '429' ? IW_429_BODY : IW_402_BODY)
        return
      }
      if (req.url?.startsWith('/zai/')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(sseSuccess(model, 'fallback ok'))
        return
      }
      res.writeHead(404).end('{}')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }))
  })
}

/** The plugin config, mirroring cordis.patch.yml's production shape. */
function pluginConfig(port) {
  return {
    fallbacks: [{ provider: 'zai-coding-cn', model: 'glm-5.2' }],
    strategy: { mode: 'cost' },
    allowUnknownCapacity: true,
    cooldownMs: 60_000,
    quota: {
      deepseek: { provider: 'iwhalecloud', apiKeyEnv: 'IW_TEST_KEY', baseURL: `http://127.0.0.1:${port}/iw/v1` },
      thresholdAbsolute: 10,
      prices: {
        iwhalecloud: { input: 1, output: 1.5 },
        'zai-coding-cn': { input: 3, output: 3 },
      },
    },
  }
}

async function runScenario(name, iwMode, expectation) {
  const mock = await startMock(iwMode)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(piAi, {
      providers: {
        iwhalecloud: {
          apiKeyEnv: 'IW_TEST_KEY',
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${mock.port}/iw/v1`,
          // No contextWindow on purpose: production's iwhalecloud catalog declares none.
          models: [{ id: 'g-deepseek-v4-flash' }],
          retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 10, maxDelayMs: 20 } },
        },
        'zai-coding-cn': {
          apiKeyEnv: 'ZAI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${mock.port}/zai/v1`,
          models: [{ id: 'glm-5.2', contextWindow: 1_000_000, maxTokens: 131072 }],
        },
      },
    })
    // Production composition: llm-retry loads from the core bundle BEFORE the
    // patch-inserted fallback plugin, so retry sits outermost in the waterfall.
    await ctx.plugin(llmRetry, {})
    let innerCtx
    await ctx.plugin(Object.assign((inner, config) => {
      innerCtx = inner
      return fallback.apply(inner, config)
    }, { inject: fallback.inject, Config: fallback.Config }), pluginConfig(mock.port))
    await ctx.plugin(AgentLoop, { agents: [] })
    // Innermost probe: only runs when every outer listener delegates.
    ctx.on('agent/request-error', (payload, next) => {
      console.log(`  [probe] request-error delegated to innermost: code=${payload.failure.code} message=${String(payload.failure.message).slice(0, 80)}`)
      return next()
    })
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      console.log(`  [probe] request resolved: ${resolved.provider}/${resolved.model}`)
      return resolved
    })

    const agent = ctx.agentLoop.create(SessionId(`repro-${name}`), { provider: 'iwhalecloud', model: 'g-deepseek-v4-flash' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const routeLog = mock.requests.filter(r => r.url?.endsWith('/chat/completions')).map(r => `${r.url.split('/')[1]}:${r.model}`)
    const events = agent.session.events
    const fallbackEvents = events.filter(e => e.type === 'llm/fallback').map(e => e.data)
    const retryEvents = events.filter(e => e.type === 'llm/retry')
    const exhausted = events.filter(e => e.type === 'llm/fallback-exhausted')
    const lastMessage = agent.session.deriveMessages().at(-1)
    const turnEnd = events.at(-1)
    // Diagnostics: how far did the plugin's recovery listener get?
    console.log(`  [diag] stats=${JSON.stringify(fallback.getFallbackStats(innerCtx))} retryEvents=${retryEvents.length} routeLog=${JSON.stringify(routeLog)}`)

    const problems = []
    if (expectation.iwCalls !== routeLog.filter(r => r.startsWith('iw:')).length) {
      problems.push(`expected ${expectation.iwCalls} iwhalecloud call(s), got ${JSON.stringify(routeLog)}`)
    }
    if (!routeLog.some(r => r.startsWith('zai:'))) problems.push(`no zai request went out; route log: ${JSON.stringify(routeLog)}`)
    if (fallbackEvents.length !== 1) problems.push(`expected exactly 1 llm/fallback event, got ${fallbackEvents.length}`)
    else {
      const data = fallbackEvents[0]
      if (data.fromProvider !== 'iwhalecloud' || data.toProvider !== 'zai-coding-cn' || data.toModel !== 'glm-5.2') {
        problems.push(`llm/fallback carries wrong routes: ${JSON.stringify(data)}`)
      }
      if (data.code !== expectation.code) problems.push(`llm/fallback code ${data.code}, expected ${expectation.code}`)
    }
    if (expectation.noRetryEvents && retryEvents.length !== 0) problems.push(`expected no llm/retry events, got ${retryEvents.length}`)
    if (exhausted.length !== 0) problems.push(`unexpected llm/fallback-exhausted: ${JSON.stringify(exhausted.map(e => e.data))}`)
    if (lastMessage?.source?.provider !== 'zai-coding-cn' || lastMessage?.source?.model !== 'glm-5.2') {
      problems.push(`final assistant message did not come from the fallback route: ${JSON.stringify(lastMessage?.source)}`)
    }
    if (turnEnd?.type !== 'turn/end' || turnEnd?.data?.reason?.kind !== 'completed') {
      problems.push(`turn did not complete: ${JSON.stringify(turnEnd?.data?.reason)}`)
    }

    if (problems.length === 0) {
      console.log(`PASS ${name}  routes=${JSON.stringify(routeLog)} fallback=${JSON.stringify(fallbackEvents[0])}`)
      return true
    }
    console.log(`FAIL ${name}`)
    for (const p of problems) console.log(`  - ${p}`)
    return false
  } catch (error) {
    console.log(`FAIL ${name} threw:`, error)
    return false
  } finally {
    await ctx.fiber.dispose()
    mock.server.close()
  }
}

// AC-4: the production cordis.patch.yml plugin config must pass the shipped
// Config schema (this is the same `~standard` validation the loader runs).
const prodConfig = pluginConfig(1)
delete prodConfig.quota.deepseek.baseURL // production sets the real URL; schema check does not need it
prodConfig.quota.deepseek.baseURL = 'https://lab.iwhalecloud.com/gpt-proxy/v1'
const validation = fallback.Config['~standard'].validate(prodConfig)
const validated = validation instanceof Promise ? await validation : validation
const schemaOk = validated.issues === undefined || validated.issues.length === 0
console.log(schemaOk ? 'PASS schema: production config validates against shipped Config'
  : `FAIL schema: ${JSON.stringify(validated.issues)}`)

const ok429 = await runScenario('rate-limit-429', '429', { code: 'RATE_LIMIT', iwCalls: 2, noRetryEvents: false })
const ok402 = await runScenario('quota-402', '402', { code: 'QUOTA', iwCalls: 1, noRetryEvents: true })

const allOk = schemaOk && ok429 && ok402
console.log(allOk ? 'ALL PASS' : 'SOME FAILED')
process.exit(allOk ? 0 : 1)
