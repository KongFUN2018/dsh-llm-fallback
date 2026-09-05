# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@kongfun2018/dsh-llm-fallback` — a DeepSeek Harness (DSH) plugin that does automatic cross-provider model fallback with quota awareness. This is a **standalone repo** (not part of the DSH monorepo); it builds and tests against the published `@deepseek-ai/*@0.1.0-rc.6` runtime packages, which are `peerDependencies`.

Node ≥ 24. ESM (`"type": "module"`).

## Commands

```bash
npm install
npm run build   # tsc -p tsconfig.json && tsdown
npm test        # vitest run
```

Run a single test by name or file:

```bash
npx vitest run tests/fallback.spec.ts
npx vitest run -t "T1.1 switches to the first fallback route"
```

There is no lint script. Type errors surface only through `tsc` in the build — run `npx tsc -p tsconfig.json --noEmit` to check types without emitting.

## The two-phase build (read this before touching build config)

`tsc` and `tsdown` do **different jobs** and neither is optional:

1. **`tsc -p tsconfig.json`** emits `lib/types/*.js` + `*.d.ts` + sourcemaps from `src/`. `rootDir` is `src`, `outDir` is `lib/types`. This is what produces the shipped `.d.ts` type declarations. Source imports use `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`) — write imports as `'./types.ts'`, not `'./types'`.
2. **`tsdown`** then bundles `lib/types/index.js`, `lib/types/invariant.js`, `lib/types/types.js` (node ESM, `clean: false` so it does not wipe tsc's output) **and** `src/client/index.ts` directly into `lib/` as four outputs. The browser client is a **CJS** bundle wrapped in a `window.__ModuleLoader__.load({ id, factory })` banner/footer (see `tsdown.config.ts`) — this is the handoff shape the DSH web shell's module loader expects.

`tsconfig` is strict in load-bearing ways: `noUncheckedIndexedAccess` (index access returns `T | undefined`), `exactOptionalPropertyTypes` (you cannot assign `undefined` to an optional field — use conditional spread `...x === undefined ? {} : { x }`), `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`. Code in this repo uses the conditional-spread idiom pervasively to satisfy `exactOptionalPropertyTypes`; match it.

`tsdown.config.ts` defines `CLIENT_EXTERNALS` — the module specifiers the browser shell shares into its frozen module table. Browser-half **value** imports must stay inside that list; everything else is type-only (`import type {}`) and erased before bundling. Do not add a value import from a package not in `CLIENT_EXTERNALS` to the client half.

## Package shape (exports)

`package.json` `exports` maps four consumed entry points, all backed by files in `lib/`:

| Subpath | Source | Runtime |
|---|---|---|
| `.` | `src/index.ts` → `lib/index.js` | node — the plugin |
| `./invariant` | `src/invariant.ts` → `lib/invariant.js` | node — event-validation companion |
| `./types` | `src/types.ts` → `lib/types/types.js` + `.d.ts` | browser-safe types only |
| `./client` | `src/client/index.ts` → `lib/client.js` | browser companion |

`./types` is deliberately browser-safe (no node imports) so remote renderers can read the durable event vocabulary without loading the runtime. Keep it that way — do not add `@deepseek-ai/dsh-*` runtime imports to `src/types.ts`.

The `dsh.client` field in `package.json` declares the browser half to the DSH web shell: `platform: web` + an `inject` list. The shell loads `lib/client.js` at `/plugins/@kongfun2018/dsh-llm-fallback/client.js` automatically whenever the node half is loaded — no manual wiring.

## Architecture

### The plugin never wraps `ctx.llm.stream()`

This is the central design constraint. The plugin installs two Cordis listeners on the agent loop:

- **`agent/request`** (outermost, registered before per-agent model selection) — snapshots the primary route, records the issued route, and rewrites it when a recovery has resolved a fallback route (via `withRoute`, which rebuilds the `LlmCallConfig` with a new `provider`/`model`/optional `reasoningEffort`). It also runs the **preemptive** quota check: before a request goes out, if the resolved route's allowance trips a threshold or cannot cover the projected cost, it switches without ever sending the failing request and records `llm/quota-warning`.
- **`agent/request-error`** — on an eligible failure code, bans the failed route, resolves the next fallback route, stages it in `state.pendingRoute` for the next `agent/request` to apply, and returns `{ kind: 'retry' }` so the loop **re-derives the request against the same turn/step** (preserving the conversation built so far).

Each adapter call is exactly one provider attempt. Each switch is a fresh model selection. Do not introduce a wrapper around `ctx.llm.stream()` — that would break the "one call = one attempt" invariant.

### Two selection paths, one dispatcher

`selectNext()` in `src/index.ts` dispatches to one of two resolvers in priority order:

1. **`strategy`** — `selectNextByStrategy`: the `cost` / `performance` modes from `src/strategy.ts`. Expands the whole chain, applies the **task-completion floor**, then scores globally.
2. **rules** (default / `closest`) — `selectNextByRules`: lazy chain walk, capability-matched per provider.

Selection outcomes carry a `CursorDirective`: rule/decision-free paths return `{ advanceTo }` (the next chain index to try), while the strategy path returns `{ reselectFrom }` (stay at the winning index — the ban table, not the cursor, prevents revisits). `cursorIndexOf()` extracts the numeric index both consumers need.

`src/strategy.ts` is **pure and synchronous** — it owns only the decision layer (floor + score + tie-breaks). The host half (`src/index.ts`) owns candidate expansion, quota interrogation, and session-memory side effects. Keep strategy pure; do not move I/O into it.

The floor invariant: **the floor guarantees the switch can finish the task; the score only chooses among candidates that already can.** A cheap model whose window cannot carry the context is never selected. When cost-mode candidates keep failing, the **escalation ladder** re-selects that step under `performance` after `afterFailures` (default 2) losses.

### Per-agent, per-step state

`AgentState` (keyed by `Agent`, held in a `WeakMap`) holds session-wide routing state: `bannedUntil` map, `failedRoutes` set (cost-risk multiplier), `healthyRoute` (the last fallback that completed successfully — a session-wide preferred cache), `switchedKeys`. `StepState` (keyed by `turn/step`) holds the chain cursor, attempt count, pending route, and strategy-mode failure counter. Step state for a finished turn is retired on the next turn's first request.

The plugin promotes a switched route to `healthyRoute` only after it completes a model message successfully — observed via an `internal/dispatch` listener for `session/event` of type `assistant/message`. The same listener folds provider-reported `usage.outputTokens` into a rolling per-provider average (last 8 samples, on `AgentState.outputSamples`) that refines the output side of the cost projection (`estimateCost`, the strategy projection, the forecast advisory, and the `costCap` accumulator); the input side keeps tracking the live transcript (chars/4). Once healthy, subsequent requests are redirected to the healthy route **unless** the user switches models (detected as a fresh primary that differs from the previous step's primary — the plugin never rewrites `primaryRoute` to a fallback, so a change there is the user's own selection).

`pollIntervalMs` re-checks the primary route's allowance on an interval to clear a stale `healthyRoute` in time for the next request. It never interrupts an in-flight turn.

### Quota interrogation

`checkQuota()` resolves in precedence order: `static` (config, highest) → `providers` (code-level `QuotaProvider[]`) → `queryers` (declarative HTTP endpoints, DeepSeek `/user/balance` response shape `{ is_available, balance_infos: [{ total_balance }] }`) → built-in `deepseek` source. Results cached for `cacheMs` (default 30s) with single-flight de-duplication. **Any interrogation failure resolves to `unobservable` and never blocks a request.** API keys resolve through `ctx.credentials` first, then the launching environment.

Ban duration is quota-kind-aware: a recharge `balance` at zero bans permanently; a resetting `quota` bans until `resetAt`; transient failures cool down for `cooldownMs` (`0` = session ban). Structural `unusableCodes` (`NO_ADAPTER`, `UNSUPPORTED_REASONING_EFFORT`, …) advance the chain **without** banning.

### Three durable events

All are appended to the session event stream and typed via `declare module '@deepseek-ai/dsh-session/types'` augmentation in `src/types.ts`:

- `llm/fallback` — recorded immediately before switching: from/to route, code, remaining chain positions.
- `llm/quota-warning` — recorded on a preemptive switch, stop-loss, unobservable probe note, or the advisory forecast: route, remaining/threshold/estimated cost, and a `reason` of `below-threshold` | `insufficient-cost` | `cost-cap-reached` | `unobservable` | `forecast-low`. `forecast-low` is the one reason that does NOT accompany a switch: the advisory (`quota.warnAbsolute`/`warnRatio`, horizon `forecastSteps`) fires level-latched per route when the projected remaining after N steps falls below the floor.
- `llm/fallback-exhausted` — recorded when an eligible failure finds no fallback candidate (the chain is out): the last failed route, its code, and the step's `attempts` count.

The browser half (`src/client/`) only **renders** what the node half recorded — it does no routing. It registers three Conversation Definitions + three keyed chat renderers (`FallbackNodeView`, `QuotaWarningNodeView`, `FallbackExhaustedNodeView`) so each event shows as a muted notice row exactly where it happened in the conversation. The composer's model seat deliberately keeps showing the user's own selection (selection is intent; routing is the plugin's job).

### Diagnostics: `getFallbackStats`

`getFallbackStats(ctx)` returns `{ agents, steps, switches, switchSuccess, exhaustions }` — the instance's routing health: how many switches went out, how many completed successfully, and how many steps exhausted the chain. It is the product-level reliability seam (the "is fallback actually working" answer); read it through the same `WeakMap` registry as reset.

### Cost-cap stop-loss

`Config.quota.costCap` sets an instance-wide cumulative projected-cost budget. `apply()` holds a `cumulativeCost` accumulator charged on every request that actually goes out (`agent/request`'s three return paths). In `agent/request-error`, once `cumulativeCost >= costCap`, the plugin stops switching (`return next()`) and records a `cost-cap-reached` `llm/quota-warning`. `resetFallback` zeroes the accumulator via the tracker's `onReset` callback.

### Reset escape hatch

`resetFallback(ctx)` clears every routing decision the plugin made — bans, healthy route, switched set, failure-risk scores, step state, and the quota cache. It is exposed three ways: the exported function (for tests/diagnostics), an agent-callable `llm-fallback-reset` tool (requires `confirm: true`), and a `/llm-fallback-reset` command (invoked by the composer reset button). `getFallbackStats(ctx)` is the parallel diagnostics seam. Both are keyed by plugin context through `WeakMap` registries because a plugin's `apply` context is test-internal.

### The invariant companion

`src/invariant.ts` is a **separate Cordis plugin** (`name: 'llm-fallback-invariant'`, `inject: ['invariants']`) published as `./invariant`. It validates that every `llm/fallback`, `llm/quota-warning`, and `llm/fallback-exhausted` record names the currently open turn/step, carries non-empty identifiers and non-negative numeric fields, switches to a different route, and uses a known reason. It runs on loaded sessions, on session creation, and on every appended event. Keep it as a companion — the node plugin and the invariant are independently registered.

## Testing conventions

Tests live in `tests/` (4 files, 97 tests) and use a real Cordis context, not mocks. `tests/fallback.spec.ts` exports a `harness()` helper that wires `LlmRuntime`, `SessionStore`, `SystemPrompt`, `ToolRuntime`, `CommandRuntime`, `AgentRegistry`, `AgentLoop`, then the fallback plugin, against a `ScriptedAdapter` that serves scripted `StreamChunk` sequences (or `LlmError`s) per provider and records every `GenerateOptions` call. Tests typically assert on two things:

- `h.adapter.requests.map(r => `${r.provider}/${r.model}`)` — the exact sequence of provider/model calls the loop actually issued.
- `agent.session.events.filter(e => e.type === 'llm/fallback' | 'llm/quota-warning' | 'llm/fallback-exhausted')` — the durable records the plugin appended.

`tests/strategy.spec.ts` splits between a `strategy pure layer` describe (calls `selectByStrategy` etc. directly) and an `llm-fallback strategy integration` describe (goes through `harness`). When adding strategy logic, add a pure-layer test first — it is far cheaper than an integration one.

Each `describe` owns its own `ctx` and disposes it in `afterEach` (`ctx?.fiber.dispose()`), plus `vi.unstubAllGlobals()` and `delete process.env.DEEPSEEK_API_KEY`. Follow that cleanup pattern in new test groups.

## Configuration reference

See `README.md` §Configuration for the full YAML shape and `docs/strategy-design.md` for the strategy design (floor F1–F4, cost/performance scoring, escalation ladder, the §十三 chat-notice rendering). When changing config schema, update both `Config` (the `z.object` in `src/index.ts`) and the `Config` interface above it — they must stay in sync.

**Schemastery fills absent arrays/dicts/objects with `[]`/`{}`/default-filled objects** when the loader validates config (`Config['~standard'].validate`). An absent `codes` arrives in `apply()` as `[]`, which is not nullish, so `config.codes ?? DEFAULT_*` does NOT fall back — the field must carry its real default in the schema (`.default([...])`). This once disabled all reactive switching in production while direct-`apply()` tests stayed green (see the `config schema` describe in tests/fallback.spec.ts). Any new optional array/dict config field needs its intended default in the schema, and a schema-validated test if apply() branches on it.

`scripts/verify-real-wiring.mjs` (not in `npm test`) runs the shipped `lib/` build inside the locally installed production dsh runtime tree with a mock gateway, covering the seams the vitest harness cannot (real HTTP → pi-ai classification → retry/fallback waterfall order). Requires the global `dsh` install; run it before deploying to the profile.
