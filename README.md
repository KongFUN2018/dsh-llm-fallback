# `@deepseek-ai/dsh-llm-fallback`

English | [中文](README.zh.md)

Automatic cross-provider model fallback with quota awareness for the DeepSeek Harness. It installs an outer listener on the agent loop's `agent/request` waterfall and a recovery listener on `agent/request-error`, so every switch re-derives the request against the same turn/step and preserves the conversation built so far. It never wraps `ctx.llm.stream()`: each adapter call is one provider attempt, and each switch is a fresh model selection.

## Setup

This is a standalone repository (not part of the DeepSeek Harness monorepo). It builds and tests on its own against the published `@deepseek-ai/*` runtime packages.

```bash
npm install
npm run build   # tsc emits lib/types/*.js + .d.ts, then tsdown bundles lib/
npm test        # 42 vitest tests
```

Requirements: Node ≥ 24, npm (or pnpm). Runtime peer dependencies are the DeepSeek Harness packages at `0.1.0-rc.6` (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-invariants`).

To use the plugin as a dependency: `npm install @deepseek-ai/dsh-llm-fallback`, then register it in your DSH config (see [Configuration](#configuration)).

## What it does

- **Fail-and-switch** — on an eligible failure code (`QUOTA`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`) it walks the configured `fallbacks` chain, skips providers with no usable model, and returns `{ kind: 'retry' }` so the loop re-derives the request with the same turn/step.
- **Capability-matched selection** — when a fallback route omits `model`, it picks one from that provider's real `listModels` catalog by modality coverage, then capacity non-degradation, then closeness, then cost. Structural codes (`NO_ADAPTER`, …) advance the chain without cooling the failed route.
- **Task continuation** — a switch mid-tool-loop keeps completed tool results; later steps and turns continue on the switched route.
- **Probing for unobservable providers** — providers without a quota source degrade to trial-and-error: candidates are attempted in order, and the first success is remembered as session-healthy.
- **Preemptive quota warnings** — before each request the resolved route's allowance is checked; below a configured threshold it switches without ever sending the failing request, recording `llm/quota-warning`.
- **Quota-kind-aware bans** — a recharge `balance` at zero bans permanently, a resetting `quota` bans until `resetAt`, transient failures cool down for `cooldownMs`, and unobservable routes only trial-and-error.
- **Optional LLM decision** — a pluggable `decisionProvider` receives the primary capability plus the expanded candidate list and may pick any route; a throw, timeout, or invalid route falls back to rule matching.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'

- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    fallbacks:
      - provider: gl
      - provider: az
        model: gpt-4o
        reasoningEffort: high
    codes: [QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE]
    unusableCodes: [NO_ADAPTER, UNSUPPORTED_REASONING_EFFORT]
    cooldownMs: 60000
    pollIntervalMs: 30000
    allowDegrade: false
    allowUnknownCapacity: false
    preference: closest
    quota:
      thresholdAbsolute: 200
      thresholdRatio: 0.2
      cacheMs: 30000
      static:
        ds: { kind: balance, remaining: 150 }
        gl: { kind: quota, remaining: 30, total: 100, resetAt: 1735689600000 }
      queryers:
        az: { endpoint: 'https://gateway.example/credits', apiKeyEnv: AZ_API_KEY }
      deepseek:
        provider: deepseek-official
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
      prices:
        ds: { input: 0.27, output: 1.10 }
      estimatedOutputTokens: 1024
```

`fallbacks` is the ordered recovery chain. A route with `model` uses that exact model; one without it is resolved by capability match inside its provider. `codes` are eligible failure codes, `unusableCodes` advance the chain without banning, and `cooldownMs: 0` bans transient failures for the session. `pollIntervalMs` re-checks the primary route's allowance on an interval so a recovered allowance clears the session-healthy cache in time for the next request. `preference` breaks ties among capability-matched candidates within one provider: `closest` (default, nearest context window), `price` (smallest non-degrading window), `speed` (smallest output cap), or `reasoning` (prefers models that expose a reasoning effort).

Quota interrogation resolves in precedence order: `static` (highest), then `providers` (code-level pluggable sources), then `queryers` (declarative HTTP endpoints whose response uses the DeepSeek `/user/balance` shape `{ is_available, balance_infos: [{ total_balance }] }`), then the built-in `deepseek` source (the DeepSeek `/user/balance` endpoint, with the API key resolved through `ctx.credentials` or the launching environment). Results are cached for `cacheMs` with single-flight de-duplication; any interrogation failure resolves to *unobservable* and never blocks a request.

`thresholdAbsolute` and `thresholdRatio` (remaining/total) trigger preemptive switching. When `prices` maps a route to per-million-token unit prices, a per-request cost projection (`estimatedInputTokens` from the serialized transcript plus `estimatedOutputTokens`) also triggers a switch when the disclosed `remaining` cannot cover it; the `llm/quota-warning` event then records `estimatedCost`, `inputPrice`, and `outputPrice`.

## Events

Both events are non-surface and typed by the browser-safe `@deepseek-ai/dsh-llm-fallback/types` subpath, so remote renderers can read durable status without loading the runtime.

- `llm/fallback` — recorded immediately before switching: `{ turn, step, fromProvider, fromModel, toProvider, toModel, code, remaining }`.
- `llm/quota-warning` — recorded when a pre-request check trips a threshold or cost projection: `{ turn, step, provider, model, remaining?, total?, threshold?, estimatedCost?, inputPrice?, outputPrice?, reason }` with `reason` of `below-threshold` or `insufficient-cost`.

The separately published `./invariant` companion checks that every record names the current open turn/step, carries non-empty identifiers, non-negative numeric fields, a different from/to route for `llm/fallback`, and a known reason for `llm/quota-warning`.

## Known Limitations and Deferred Work

- **Input-token projection is a rough estimate** — the cost check serializes the derived transcript and divides by four characters-per-token; exact token accounting needs a provider metering source.
- **Polling is best-effort** — `pollIntervalMs` re-checks the primary route's allowance to clear a stale fallback; it never interrupts an in-flight turn, and quota kinds that disclose no reset time stay unobservable between requests.
- **Health cache lives in-session** — a successful probed route stays preferred until the next failure or a negating quota check; it is not persisted across sessions.
- **`llm/fallback` records switching, not completion** — later step and turn events establish success or exhaustion.
