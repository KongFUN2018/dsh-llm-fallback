/**
 * Automatic cross-provider model fallback on the agent loop's request
 * recovery and request-routing extension points.
 *
 * @module @kongfun2018/dsh-llm-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { LlmFallbackRoute, QuotaCheck, QuotaProvider, QuotaStaticEntry, SelectionPreference, StrategyConfig, StrategyMode } from './types.ts'
import type { PriceTable, StrategyCandidate, StrategySettings } from './strategy.ts'
import { priceOf, selectByStrategy } from './strategy.ts'

export type {
  LlmFallbackEventData,
  LlmFallbackRoute,
  LlmQuotaWarningEventData,
  QuotaCheck,
  QuotaKind,
  QuotaProvider,
  QuotaStaticEntry,
  SelectionPreference,
  StrategyAxis,
  StrategyConfig,
  StrategyMode,
} from './types.ts'
export {
  buildFloor, comparePerformance, costScore, passesFloor, priceOf, selectByStrategy,
} from './strategy.ts'
export type { PriceTable, StrategyCandidate, StrategySelection, StrategySettings } from './strategy.ts'

export const name = 'llm-fallback'

export const inject = ['agents', 'llm']

interface FallbackStats {
  agents: number
  steps: number
  /** Total `llm/fallback` switch events issued (one per switch that went out). */
  switches: number
  /** Switched routes that completed a model message successfully (success count). */
  switchSuccess: number
  /** Eligible failures where no fallback candidate remained (chain exhausted). */
  exhaustions: number
}

/** Per-apply stats handles, keyed by the plugin context (test/diagnostics seam). */
const fallbackStatsRegistry = new WeakMap<Context, () => FallbackStats>()

/** Read a live plugin instance's step-state statistics, if installed. */
export function getFallbackStats(ctx: Context): FallbackStats | undefined {
  return fallbackStatsRegistry.get(ctx)?.()
}

/** What a {@link resetFallback} call cleared, for diagnostics and tool output. */
export interface ResetSummary {
  /** Number of agent states whose runtime routing state was cleared. */
  resetAgents: number
  /** Number of banned-until entries removed. */
  clearedBans: number
  /** Number of session failure-risk routes cleared. */
  clearedFailures: number
  /** Number of step-level states discarded. */
  clearedSteps: number
}

/** Per-apply reset handles, keyed by the plugin context. */
const resetRegistry = new WeakMap<Context, () => ResetSummary>()

/**
 * Clear every model-availability decision the plugin has made in one plugin
 * instance (one `apply` context): banned routes, the session-healthy fallback,
 * the switched-route set, session failure-risk scores, and all step-level
 * selection state, plus the allowance cache so the next request re-queries
 * fresh. This is the escape hatch that restores every configured model to
 * usability regardless of prior plugin decisions.
 * @param ctx - the plugin's own apply context.
 * @returns a summary of what was cleared, or `undefined` when no plugin
 *   instance is installed on that context.
 */
export function resetFallback(ctx: Context): ResetSummary | undefined {
  return resetRegistry.get(ctx)?.()
}

/** Failure codes that trigger a switch; transient + exhausted-account codes. */
export const DEFAULT_FALLBACK_CODES = Object.freeze([
  'QUOTA',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
])

/** Structural "candidate unusable" codes: advance the chain without banning. */
export const DEFAULT_UNUSABLE_CODES = Object.freeze([
  'NO_ADAPTER',
  'UNSUPPORTED_REASONING_EFFORT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
])

/** Plugin configuration. */
export interface Config {
  /** Ordered fallback chain; first entry is tried after the first eligible failure. */
  fallbacks: LlmFallbackRoute[]
  /** Failure codes eligible for switching; defaults to {@link DEFAULT_FALLBACK_CODES}. */
  codes?: string[]
  /** Structural codes that advance the chain without cooling the failed route. */
  unusableCodes?: string[]
  /** How long a failed route stays excluded; 0 excludes it for the session. */
  cooldownMs?: number
  /** Optional interval for re-checking the primary route's allowance to clear stale fallbacks. */
  pollIntervalMs?: number
  /** When no capacity non-degrading candidate exists, allow a degrading one. */
  allowDegrade?: boolean
  /** Accept candidates whose capacity metadata is unknown. */
  allowUnknownCapacity?: boolean
  /** Tie-break preference among capability-matched candidates; defaults to `closest`. */
  preference?: SelectionPreference
  /** Strategy-mode selection (see docs/strategy-design.md); `closest` (or absent) keeps the legacy lazy chain walk. */
  strategy?: StrategyConfig
  /** Post-selection availability probe: before a fallback switch is issued,
   *  send a minimal real request to the chosen candidate to confirm it is
   *  actually usable (directory presence ≠ usable; a route can be listed yet
   *  have no quota or a broken adapter). A candidate that fails the probe is
   *  banned for the session and the chain advances to the next one. Off by
   *  default so existing callers without quota/probe knowledge are unaffected;
   *  enable it in deployments where an unusable candidate must not kill a turn
   *  (real-host UNKNOWN_MODEL is exactly this class of failure). */
  probe?: {
    /** Enable availability probing before issuing a fallback switch. */
    enabled?: boolean
    /** Probe request max output tokens (default 1): the cheapest confirmation. */
    maxTokens?: number
    /** Timeout for one probe (default 6000ms). */
    timeoutMs?: number
    /** Probe prompt; a no-op ping is fine. */
    prompt?: string
  }
  /** Preemptive quota warnings. */
  quota?: {
    /** Switch when remaining allowance falls below this absolute amount. */
    thresholdAbsolute?: number
    /** Switch when remaining/total falls below this ratio (0..1). */
    thresholdRatio?: number
    /** Static allowance table keyed by provider route (highest precedence). */
    static?: Record<string, QuotaStaticEntry>
    /** Pluggable quota sources consulted in order after the static table. */
    providers?: QuotaProvider[]
    /** Cache TTL for successful and unknown interrogations (default 30s). */
    cacheMs?: number
    /** Declarative HTTP balance endpoints keyed by provider (DeepSeek-shaped response). */
    queryers?: Record<string, {
      endpoint: string
      apiKeyEnv?: string
    }>
    /** Built-in DeepSeek `/user/balance` source. */
    deepseek?: {
      /** Provider route the source owns; defaults to `deepseek-official`. */
      provider?: string
      /** Credential reference resolved per check; defaults to `DEEPSEEK_API_KEY`. */
      apiKeyEnv?: string
      /** Endpoint base; defaults to `https://api.deepseek.com`. */
      baseURL?: string
    }
    /** Unit prices (per million tokens) keyed by provider, for cost estimates. */
    prices?: Record<string, { input?: number; output?: number }>
    /** Estimated output tokens per request for cost projection (default 1024). */
    estimatedOutputTokens?: number
    /** Cumulative projected-cost cap (in the provider's unit): once the plugin's
     * accumulated projected cost reaches it, it stops switching and records a
     * `cost-cap-reached` warning, letting the real failure take over. */
    costCap?: number
    /** Advisory floor: warn (WITHOUT switching) when the projected remaining
     * after `forecastSteps` more steps falls below this absolute amount.
     * Set it above `thresholdAbsolute` so the heads-up precedes the switch. */
    warnAbsolute?: number
    /** Advisory floor as a ratio: warn (WITHOUT switching) when the projected
     * remaining/total falls below this value (0..1). */
    warnRatio?: number
    /** Forward horizon in steps for the advisory projection (default 1).
     * The per-step cost reuses this request's estimate, which over-projects a
     * growing conversation — deliberate: warn earlier rather than later. */
    forecastSteps?: number
  }
}

export const Config: z<Config> = z.object({
  fallbacks: z.array(z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
  })).required(),
  // schemastery materializes absent arrays as [] — without .default() that
  // empty array survives `config.codes ?? DEFAULT_*` ([] is not nullish) and
  // silently disables every eligible/unusable code. Defaults must live here.
  codes: z.array(z.string().min(1)).default([...DEFAULT_FALLBACK_CODES]),
  unusableCodes: z.array(z.string().min(1)).default([...DEFAULT_UNUSABLE_CODES]),
  cooldownMs: z.number().min(0).default(60_000),
  pollIntervalMs: z.number().min(1),
  allowDegrade: z.boolean().default(false),
  allowUnknownCapacity: z.boolean().default(false),
  preference: z.union(['closest', 'price', 'speed', 'reasoning']).default('closest'),
  strategy: z.object({
    mode: z.union(['cost', 'performance', 'closest']).default('closest'),
    floor: z.object({
      marginTokens: z.number().min(1).default(8192),
    }),
    cost: z.object({
      futureSteps: z.number().min(1).default(1),
      sessionFailurePenalty: z.number().min(1).default(2),
      cliffPenalty: z.number().min(1).default(1.5),
    }),
    performance: z.object({
      axes: z.array(z.union(['reasoning', 'context', 'output'])).default(['reasoning', 'context', 'output']),
      significantRatio: z.number().min(1).default(1.5),
    }),
    escalation: z.object({
      afterFailures: z.number().min(1).default(2),
    }),
  }),
  probe: z.object({
    enabled: z.boolean().default(false),
    maxTokens: z.number().min(1).default(1),
    timeoutMs: z.number().min(1).default(6000),
    prompt: z.string().min(1),
  }),
  quota: z.object({
    thresholdAbsolute: z.number().min(0),
    thresholdRatio: z.number().min(0).max(1),
    static: z.dict(z.object({
      kind: z.union(['balance', 'quota']).required(),
      remaining: z.number().min(0).required(),
      total: z.number().min(0),
      resetAt: z.number(),
    })),
    providers: z.array(z.any()),
    cacheMs: z.number().min(0),
    queryers: z.dict(z.object({
      endpoint: z.string().min(1).required(),
      apiKeyEnv: z.string().min(1),
    })),
    deepseek: z.object({
      provider: z.string().min(1),
      apiKeyEnv: z.string().min(1),
      baseURL: z.string().min(1),
    }),
    prices: z.dict(z.object({
      input: z.number().min(0),
      output: z.number().min(0),
    })),
    estimatedOutputTokens: z.number().min(1),
    costCap: z.number().min(0),
    warnAbsolute: z.number().min(0),
    warnRatio: z.number().min(0).max(1),
    forecastSteps: z.number().min(1),
  }),
})

/** One provider/model route keyed by the request that actually went out. */
interface Route {
  provider: string
  model: string
}

/** A fallback route whose model has been resolved to a concrete id. */
interface ResolvedRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The capacity signals capability matching compares. */
interface Capability {
  contextWindow?: number
  modalities?: readonly ModelModality[]
}

/** Per-step recovery progress for one agent. */
interface StepState {
  /** Requests already issued in this step, including the one that just failed. */
  attempts: number
  /** Route of the first request in this step; the capability-match baseline. */
  primary: Route | undefined
  /** Route of the most recently issued request in this step. */
  lastRoute: Route
  /** Index of the next fallback-chain entry to try. */
  chainCursor: number
  /** Route selected by the last recovery, awaiting the re-derived request. */
  pendingRoute: ResolvedRoute | undefined
  /** Strategy-mode failures of candidates this step chose (escalation ladder). */
  strategyFailures: number
  /** Mode that selected the route of the most recent request, when strategic. */
  selectedMode: Exclude<StrategyMode, 'closest'> | undefined
}

interface AgentState {
  steps: Map<string, StepState>
  /** Last fallback route that completed successfully (session-wide healthy cache). */
  healthyRoute: Route | undefined
  /** Routes the plugin switched to; a completed match promotes them to healthy. */
  switchedKeys: Set<string>
  /** Failed routes excluded until the given epoch-ms timestamp. */
  bannedUntil: Map<string, number>
  /** Exact routes that failed earlier this session (cost risk multiplier). */
  failedRoutes: Set<string>
  /** Most recent turn number, used to retire finished-turn step state. */
  lastTurn: number | undefined
  /** The agent's primary route, recorded on first request (poll re-check target). */
  primaryRoute: Route | undefined
  /** Total switch events issued for this agent (diagnostics). */
  switches: number
  /** Switched routes that completed a model message successfully (diagnostics). */
  switchSuccess: number
  /** Eligible failures with no fallback candidate remaining (diagnostics). */
  exhaustions: number
  /** Route key whose forecast-low advisory is currently latched (undefined =
   * not latched). Level-latched: the advisory fires on entering the warn zone
   * and re-arms when the projection leaves it or the route changes, so a slow
   * burn inside the zone does not append one event row per request. */
  forecastWarnedRoute: string | undefined
  /** Rolling provider-reported output-token samples (provider → last N
   * `usage.outputTokens` from completed `assistant/message` events), folded to
   * refine the output side of the cost projection with real usage. */
  outputSamples: Map<string, number[]>
}

/** Rolling sample cap for the per-provider output-token average. */
const OUTPUT_SAMPLE_CAP = 8

function stepKey(turn: number, step: number): string {
  return `${turn}/${step}`
}

function routeKey(route: Pick<Route, 'provider' | 'model'>): string {
  return `${route.provider}\u0000${route.model}`
}

/** Rewrite a call config to a resolved fallback route, dropping an inherited effort. */
function withRoute(config: LlmCallConfig, route: ResolvedRoute): LlmCallConfig {
  const { reasoningEffort: _dropped, ...rest } = config
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  }
}

/** Whether candidate modalities cover every required modality. */
function covers(candidate: readonly ModelModality[] | undefined, required: readonly ModelModality[]): boolean {
  if (candidate === undefined) return false
  return required.every(modality => candidate.includes(modality))
}

interface MatchOptions {
  allowDegrade: boolean
  allowUnknownCapacity: boolean
  preference: SelectionPreference
}

/** One catalog candidate with its resolved capability. */
interface Candidate {
  id: string
  capability: Capability
  maxTokens?: number
  hasReasoning?: boolean
}

/**
 * Choose one model id from a provider's resolved candidates by rule:
 * modality coverage, then capacity non-degradation, then closeness, then cost.
 */
function matchModel(
  primary: Capability,
  candidates: readonly Candidate[],
  opts: MatchOptions,
): string | undefined {
  const required = primary.modalities
  let pool = candidates
  if (required !== undefined && required.length > 0) {
    pool = pool.filter(candidate => covers(candidate.capability.modalities, required))
  }
  if (pool.length === 0) return undefined

  const target = primary.contextWindow
  const nonDegrading: Candidate[] = []
  const degrading: Candidate[] = []
  const unknown: Candidate[] = []
  for (const candidate of pool) {
    const window = candidate.capability.contextWindow
    if (window === undefined) unknown.push(candidate)
    else if (target === undefined || window >= target) nonDegrading.push(candidate)
    else degrading.push(candidate)
  }

  let group: Candidate[]
  group = nonDegrading.length > 0 ? nonDegrading
    : opts.allowDegrade ? degrading
    : opts.allowUnknownCapacity ? unknown
    : []
  if (group.length === 0) return undefined

  if (opts.preference !== 'closest' || target !== undefined) {
    group = [...group].sort((a, b) => compareCandidates(a, b, target, opts.preference))
  }
  return group[0]?.id
}

/** Order two capability-matched candidates by the configured tie-break preference. */
function compareCandidates(
  a: Candidate,
  b: Candidate,
  target: number | undefined,
  preference: SelectionPreference,
): number {
  const windowOf = (c: Candidate) => c.capability.contextWindow ?? Number.POSITIVE_INFINITY
  const maxTokensOf = (c: Candidate) => c.maxTokens ?? Number.POSITIVE_INFINITY
  const closenessOf = (c: Candidate) => target === undefined ? 0 : Math.abs(windowOf(c) - target)
  switch (preference) {
    case 'price':
      return windowOf(a) - windowOf(b) || closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id)
    case 'speed':
      return maxTokensOf(a) - maxTokensOf(b) || closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id)
    case 'reasoning':
      return (Number(b.hasReasoning ?? false) - Number(a.hasReasoning ?? false))
        || closenessOf(a) - closenessOf(b)
        || a.id.localeCompare(b.id)
    case 'closest':
    default:
      return closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id)
  }
}

/** How long a provider's catalog (model list + per-model info) stays cached;
 * catalogs change at provider pace, not request pace. */
const CATALOG_CACHE_TTL_MS = 60_000

/** TTL-cached view over `ctx.llm` catalog lookups: `listModels` per provider,
 * `resolveModelInfo` per provider/model. Only successes are cached; failures
 * propagate unchanged, so the never-block philosophy keeps its behavior. */
interface CatalogCache {
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo>
}

function createCatalogCache(ctx: Context): CatalogCache {
  const modelsCache = new Map<string, { at: number; models: readonly LlmModelInfo[] }>()
  const infoCache = new Map<string, { at: number; info: LlmResolvedModelInfo }>()
  const listModels = (provider: string): Promise<readonly LlmModelInfo[]> => {
    const hit = modelsCache.get(provider)
    if (hit !== undefined && Date.now() - hit.at < CATALOG_CACHE_TTL_MS) return Promise.resolve(hit.models)
    return ctx.llm.listModels(provider).then(models => {
      modelsCache.set(provider, { at: Date.now(), models })
      return models
    })
  }
  const resolveModelInfo = (provider: string, model: string): Promise<LlmResolvedModelInfo> => {
    const hit = infoCache.get(routeKey({ provider, model }))
    if (hit !== undefined && Date.now() - hit.at < CATALOG_CACHE_TTL_MS) return Promise.resolve(hit.info)
    return ctx.llm.resolveModelInfo(provider, model).then(info => {
      infoCache.set(routeKey({ provider, model }), { at: Date.now(), info })
      return info
    })
  }
  return { listModels, resolveModelInfo }
}

/** Resolve one exact route's capability signals; a resolve failure degrades to
 * an empty capability (unknown window/modalities) rather than blocking the
 * request — consistent with the plugin's "never block" philosophy. */
async function capabilityOf(catalog: CatalogCache, route: Route): Promise<Capability> {
  const info = await catalog.resolveModelInfo(route.provider, route.model).catch(() => undefined)
  return {
    ...info === undefined || info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
    ...info === undefined || info.inputModalities === undefined ? {} : { modalities: info.inputModalities },
  }
}

/** The resolved quota configuration, derived from the public config so the
 * schema and the engine can never drift apart. */
type QuotaConfig = Config['quota']

/** Rough input-token estimate from the serialized message history (chars / 4).
 * Cached per session: the message list only grows within a turn, so we track
 * the message count and re-serialize only when it changes. */
const tokenEstimateCache = new WeakMap<Session, { count: number; tokens: number }>()

function estimateInputTokens(session: Session): number {
  const messages = session.deriveMessages()
  const cached = tokenEstimateCache.get(session)
  if (cached !== undefined && cached.count === messages.length) return cached.tokens
  const serialized = JSON.stringify(messages)
  const tokens = Math.max(1, Math.ceil(serialized.length / 4))
  tokenEstimateCache.set(session, { count: messages.length, tokens })
  return tokens
}

/** Projected cost in the provider's unit, when a price is configured for the route.
 * `outputTokensOverride` refines the output side with the provider's rolling
 * real-usage average (folded from `assistant/message` events) when available. */
function estimateCost(
  quota: QuotaConfig | undefined,
  provider: string,
  model: string,
  session: Session,
  outputTokensOverride?: number,
): { cost: number; inputPrice: number; outputPrice: number } | undefined {
  const price = priceOf(quota?.prices, provider, model)
  if (price === undefined || (price.input === undefined && price.output === undefined)) return undefined
  const inputPrice = price.input ?? 0
  const outputPrice = price.output ?? 0
  const inputTokens = estimateInputTokens(session)
  const outputTokens = outputTokensOverride ?? quota?.estimatedOutputTokens ?? 1024
  return { cost: (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000, inputPrice, outputPrice }
}

/** Fetch one balance endpoint and parse the DeepSeek `/user/balance` shape.
 * Throws on transport/HTTP/parse failure (probe failure); returns `undefined`
 * only for a well-formed response that discloses no balance (unobservable). */
async function queryBalanceEndpoint(endpoint: string, apiKey: string, signal: AbortSignal): Promise<QuotaCheck | undefined> {
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`balance endpoint ${endpoint} responded ${response.status}`)
  const data = await response.json() as { is_available?: boolean; balance_infos?: Array<{ total_balance?: string }> }
  // `is_available: false` marks the account unusable (frozen or blocked), which
  // the kind vocabulary cannot distinguish from an exhausted balance; mapping
  // it to balance-0 makes the preemptive check treat it as underfunded.
  if (data.is_available === false) return { kind: 'balance', remaining: 0 }
  const total = data.balance_infos?.[0]?.total_balance === undefined
    ? undefined
    : Number.parseFloat(data.balance_infos[0].total_balance)
  if (total === undefined || Number.isNaN(total)) return undefined
  return { kind: 'balance', remaining: total }
}

/** Exclude a failed route until, based on its allowance kind. */
function banUntil(provider: string, cooldownMs: number, quota: QuotaConfig | undefined, now: number): number {
  const entry = quota?.static?.[provider]
  if (entry?.kind === 'balance') return Number.POSITIVE_INFINITY
  if (entry?.kind === 'quota' && entry.resetAt !== undefined) return entry.resetAt
  return cooldownMs === 0 ? Number.POSITIVE_INFINITY : now + cooldownMs
}

/** Whether a disclosed remaining allowance trips a configured threshold. */
function belowThreshold(
  check: QuotaCheck,
  quota: QuotaConfig | undefined,
): { below: boolean; threshold?: number; thresholdKind?: 'absolute' | 'ratio' } {
  if (check.remaining === undefined) return { below: false }
  if (quota?.thresholdAbsolute !== undefined && check.remaining < quota.thresholdAbsolute) {
    return { below: true, threshold: quota.thresholdAbsolute, thresholdKind: 'absolute' }
  }
  if (quota?.thresholdRatio !== undefined && check.total !== undefined && check.total > 0) {
    if (check.remaining / check.total < quota.thresholdRatio) {
      return { below: true, threshold: quota.thresholdRatio, thresholdKind: 'ratio' }
    }
  }
  return { below: false }
}

/** Resolve one provider's candidate catalog with per-candidate capability.
 * Model info lookups are parallelized (no data dependency between models). */
async function selectModel(
  catalog: CatalogCache,
  primary: Capability,
  provider: string,
  opts: MatchOptions,
): Promise<string | undefined> {
  const models = await catalog.listModels(provider)
  const infos = await Promise.all(
    models.map(model => catalog.resolveModelInfo(provider, model.id).catch(() => undefined)),
  )
  const candidates: Candidate[] = []
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const info = infos[i]
    if (model === undefined) continue
    candidates.push({
      id: model.id,
      capability: {
        ...info === undefined || info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
        ...info === undefined || info.inputModalities === undefined ? {} : { modalities: info.inputModalities },
      },
      ...info === undefined || info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens },
      ...info === undefined || info.reasoning === undefined ? {} : { hasReasoning: true },
    })
  }
  return matchModel(primary, candidates, opts)
}

/** One strategy-path selection run: resolved settings plus the host services it needs. */
interface StrategyRun {
  mode: Exclude<StrategyMode, 'closest'>
  settings: StrategySettings
  session: Session
  prices: PriceTable | undefined
  failedRoutes: ReadonlySet<string>
  checkQuota: (provider: string, model: string, signal: AbortSignal) => Promise<QuotaCheck | undefined>
  signal: AbortSignal
  /** Rolling real-usage output estimate per provider (undefined before samples). */
  rollingOutput: (provider: string) => number | undefined
}

/** The chain-cursor directive a selection path returns.
 *  - `advanceTo`: the next chain index to try (rule/decision paths walk forward).
 *  - `reselectFrom`: stay at this index — a global re-selection must still see
 *    this entry's siblings and every later entry, with the ban table (not the
 *    cursor) preventing revisits (strategy path). */
type CursorDirective =
  | { advanceTo: number }
  | { reselectFrom: number }

/** The outcome of any selection path; strategy fields appear only when strategic. */
interface SelectionOutcome {
  route: ResolvedRoute
  cursor: CursorDirective
  mode?: Exclude<StrategyMode, 'closest'>
  score?: number
}

/** The numeric chain index a cursor directive leaves the walk at. */
function cursorIndexOf(directive: CursorDirective): number {
  return 'advanceTo' in directive ? directive.advanceTo : directive.reselectFrom
}

/** Walk the chain from a cursor, resolving each entry to a concrete route. */
async function selectNext(
  catalog: CatalogCache,
  chain: readonly LlmFallbackRoute[],
  cursor: number,
  primary: Capability,
  opts: MatchOptions,
  banned: ReadonlyMap<string, number>,
  now: number,
  strategy?: StrategyRun,
): Promise<SelectionOutcome | undefined> {
  if (strategy !== undefined) {
    const strategic = await selectNextByStrategy(catalog, chain, cursor, primary, opts, strategy, banned, now)
    if (strategic !== undefined) return strategic
  }
  return selectNextByRules(catalog, chain, cursor, primary, opts, banned, now)
}

/** Rule-based lazy walk over the chain. */
async function selectNextByRules(
  catalog: CatalogCache,
  chain: readonly LlmFallbackRoute[],
  cursor: number,
  primary: Capability,
  opts: MatchOptions,
  banned: ReadonlyMap<string, number>,
  now: number,
): Promise<SelectionOutcome | undefined> {
  let index = cursor
  while (index < chain.length) {
    const entry = chain[index]
    if (entry === undefined) return undefined
    if (entry.model !== undefined) {
      const until = banned.get(routeKey({ provider: entry.provider, model: entry.model }))
      if (until !== undefined && until > now) {
        index += 1
        continue
      }
      return {
        route: {
          provider: entry.provider,
          model: entry.model,
          ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
        },
        cursor: { advanceTo: index + 1 },
      }
    }
    const selected = await selectModel(catalog, primary, entry.provider, opts)
    if (selected !== undefined) {
      const until = banned.get(routeKey({ provider: entry.provider, model: selected }))
      if (until !== undefined && until > now) {
        index += 1
        continue
      }
      return {
        route: {
          provider: entry.provider,
          model: selected,
          ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
        },
        cursor: { advanceTo: index + 1 },
      }
    }
    index += 1
  }
  return undefined
}

/** Strategy path (docs/strategy-design.md): expand the whole chain, apply the
 * hard task-completion floor, then score globally under the active mode. */
async function selectNextByStrategy(
  catalog: CatalogCache,
  chain: readonly LlmFallbackRoute[],
  cursor: number,
  primary: Capability,
  opts: MatchOptions,
  run: StrategyRun,
  banned: ReadonlyMap<string, number>,
  now: number,
): Promise<SelectionOutcome | undefined> {
  const inputTokens = estimateInputTokens(run.session)
  const candidates: StrategyCandidate[] = []
  for (let index = cursor; index < chain.length; index++) {
    const entry = chain[index]
    if (entry === undefined) continue
    const ids: string[] = []
    if (entry.model !== undefined) {
      ids.push(entry.model)
    } else {
      const models = await catalog.listModels(entry.provider)
      ids.push(...models.map(model => model.id))
    }
    // Parallelize model-info resolution within this chain entry.
    const infos = await Promise.all(
      ids.map(id => catalog.resolveModelInfo(entry.provider, id).catch(() => undefined)),
    )
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (id === undefined) continue
      const until = banned.get(routeKey({ provider: entry.provider, model: id }))
      if (until !== undefined && until > now) continue
      const info = infos[i]
      const price = priceOf(run.prices, entry.provider, id)
      const outputTokens = run.rollingOutput(entry.provider) ?? run.settings.estimatedOutputTokens
      const projected = price === undefined || (price.input === undefined && price.output === undefined)
        ? undefined
        : (inputTokens * (price.input ?? 0) + outputTokens * (price.output ?? 0)) / 1_000_000
      // Floor F4: a disclosed allowance that cannot cover this very request
      // would switch again immediately — exclude the route up front.
      if (projected !== undefined) {
        const check = await run.checkQuota(entry.provider, id, run.signal)
        if (check?.remaining !== undefined && check.remaining < projected) continue
      }
      candidates.push({
        provider: entry.provider,
        model: id,
        chainIndex: index,
        ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
        ...info === undefined || info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
        ...info === undefined || info.inputModalities === undefined ? {} : { modalities: info.inputModalities },
        ...info === undefined || info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens },
        ...info === undefined || info.reasoning === undefined ? {} : { hasReasoning: true },
        ...price?.input === undefined ? {} : { inputPrice: price.input },
        ...price?.output === undefined ? {} : { outputPrice: price.output },
        ...run.failedRoutes.has(routeKey({ provider: entry.provider, model: id })) ? { sessionFailed: true } : {},
      })
    }
  }
  if (candidates.length === 0) return undefined
  const selection = selectByStrategy(
    candidates, run.settings, inputTokens, primary.modalities, opts.allowUnknownCapacity,
  )
  if (selection === undefined) return undefined
  const candidate = selection.candidate
  return {
    route: {
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort },
    },
    cursor: { reselectFrom: candidate.chainIndex },
    mode: selection.mode,
    ...selection.score === undefined ? {} : { score: selection.score },
  }
}

/** The quota engine: multi-source interrogation with TTL cache, single-flight,
 * probe-failure diagnostics, and a shared clear for resets. */
interface QuotaEngine {
  checkQuota(provider: string, model: string, signal: AbortSignal, force?: boolean): Promise<QuotaCheck | undefined>
  clearAll(): void
}

/** Build the quota engine over the resolved precedence chain: static table,
 * pluggable providers, declarative queryers, then the built-in DeepSeek source.
 * Any interrogation failure resolves to `undefined` (unobservable) and never
 * blocks a request, but is counted and logged as a probe failure. */
function createQuotaEngine(ctx: Context, quota: QuotaConfig | undefined): QuotaEngine {
  const quotaCache = new Map<string, { check: QuotaCheck | undefined; at: number }>()
  const quotaInFlight = new Map<string, Promise<QuotaCheck | undefined>>()
  const quotaCacheMs = quota?.cacheMs ?? 30_000
  const log = ctx.logger('llm-fallback')
  const resolveApiKey = async (ref: string): Promise<string | undefined> => {
    const credentials = ctx.get('credentials') as CredentialProvider | undefined
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit !== undefined) return hit.value
    }
    const ambient = process.env[ref]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }
  const checkQuota = async (provider: string, model: string, signal: AbortSignal, force = false): Promise<QuotaCheck | undefined> => {
    const staticEntry = quota?.static?.[provider]
    if (staticEntry !== undefined) return staticEntry
    // A forced check (e.g. right after the user switches models) bypasses the
    // TTL cache and any in-flight dedup so the new route is interrogated fresh;
    // its result is still written back to the cache for later reads.
    if (!force) {
      const cached = quotaCache.get(provider)
      if (cached !== undefined && Date.now() - cached.at < quotaCacheMs) return cached.check
      const pending = quotaInFlight.get(provider)
      if (pending !== undefined) return pending
    }
    const task = (async (): Promise<QuotaCheck | undefined> => {
      let probeFailures = 0
      const probe = (attempt: Promise<QuotaCheck | undefined>): Promise<QuotaCheck | undefined> =>
        attempt.catch(() => { probeFailures += 1; return undefined })
      for (const source of quota?.providers ?? []) {
        const result = await probe(source.check(provider, model, signal))
        if (result !== undefined) return result
      }
      const queryer = quota?.queryers?.[provider]
      if (queryer !== undefined) {
        const result = await probe((async () => {
          const key = await resolveApiKey(queryer.apiKeyEnv ?? '')
          return queryBalanceEndpoint(queryer.endpoint, key ?? '', signal)
        })())
        if (result !== undefined) return result
      }
      const deepseek = quota?.deepseek
      if (deepseek !== undefined && provider === (deepseek.provider ?? 'deepseek-official')) {
        const result = await probe((async () => {
          const key = await resolveApiKey(deepseek.apiKeyEnv ?? 'DEEPSEEK_API_KEY')
          if (key === undefined) return undefined
          return queryBalanceEndpoint(`${deepseek.baseURL ?? 'https://api.deepseek.com'}/user/balance`, key, signal)
        })())
        if (result !== undefined) return result
      }
      // Distinguish "probe failed" from "genuinely unobservable": a failed
      // interrogation is a transient fault, not an absent source.
      if (probeFailures > 0) {
        log.warn(`quota probe failed for provider "${provider}" (${probeFailures} source(s) threw); treating as unobservable`)
      }
      return undefined
    })()
    quotaInFlight.set(provider, task)
    try {
      const result = await task
      quotaCache.set(provider, { check: result, at: Date.now() })
      return result
    } finally {
      quotaInFlight.delete(provider)
    }
  }
  return {
    checkQuota,
    clearAll: () => {
      quotaCache.clear()
      quotaInFlight.clear()
    },
  }
}

/** Per-agent routing-state tracker: the WeakMap/Set state, the derived stats
 * and reset faces, and the step-state helpers the request handlers drive. */
interface AgentTracker {
  states: WeakMap<Agent, AgentState>
  sessionAgents: WeakMap<Session, Agent>
  knownAgents: Set<Agent>
  stats(): FallbackStats
  reset(): ResetSummary
  stateFor(agent: Agent): AgentState
  stepFor(agent: Agent, turn: number, step: number): StepState
}

/** Build the agent tracker and register its stats/reset faces plus the
 * `agent/disposed` strong-reference cleanup on the given context. */
function createAgentTracker(ctx: Context, clearQuota: () => void, onReset?: () => void): AgentTracker {
  const states = new WeakMap<Agent, AgentState>()
  const sessionAgents = new WeakMap<Session, Agent>()
  const knownAgents = new Set<Agent>()
  const stats = (): { agents: number; steps: number; switches: number; switchSuccess: number; exhaustions: number } => {
    let steps = 0
    let switches = 0
    let switchSuccess = 0
    let exhaustions = 0
    for (const agent of knownAgents) {
      const agentState = states.get(agent)
      if (agentState !== undefined) {
        steps += agentState.steps.size
        switches += agentState.switches
        switchSuccess += agentState.switchSuccess
        exhaustions += agentState.exhaustions
      }
    }
    return { agents: knownAgents.size, steps, switches, switchSuccess, exhaustions }
  }
  fallbackStatsRegistry.set(ctx, stats)
  // Drop a disposed agent's strong reference so the set tracks live agents only
  // (WeakMap already lets `states`/`sessionAgents` GC; `knownAgents` is iterated
  // by reset/poll, so it must be pruned explicitly on registry removal).
  ctx.on('agent/disposed', (payload) => {
    knownAgents.delete(payload.agent)
  }, { global: true })
  const reset = (): ResetSummary => {
    let clearedBans = 0
    let clearedFailures = 0
    let clearedSteps = 0
    for (const agent of [...knownAgents]) {
      const agentState = states.get(agent)
      if (agentState === undefined) continue
      clearedBans += agentState.bannedUntil.size
      clearedFailures += agentState.failedRoutes.size
      clearedSteps += agentState.steps.size
      agentState.bannedUntil.clear()
      agentState.failedRoutes.clear()
      agentState.steps.clear()
      agentState.healthyRoute = undefined
      agentState.switchedKeys.clear()
      agentState.switches = 0
      agentState.switchSuccess = 0
      agentState.exhaustions = 0
      agentState.forecastWarnedRoute = undefined
      agentState.outputSamples.clear()
    }
    // Also drop cached/in-flight allowances so the next request re-interrogates,
    // and reset the instance-wide cost-cap accumulator.
    clearQuota()
    onReset?.()
    return {
      resetAgents: knownAgents.size,
      clearedBans,
      clearedFailures,
      clearedSteps,
    } satisfies ResetSummary
  }
  resetRegistry.set(ctx, reset)
  const stateFor = (agent: Agent): AgentState => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { steps: new Map(), healthyRoute: undefined, switchedKeys: new Set(), bannedUntil: new Map(), failedRoutes: new Set(), lastTurn: undefined, primaryRoute: undefined, switches: 0, switchSuccess: 0, exhaustions: 0, forecastWarnedRoute: undefined, outputSamples: new Map() }
      states.set(agent, state)
    }
    return state
  }
  const stepFor = (agent: Agent, turn: number, step: number): StepState => {
    const state = stateFor(agent)
    const key = stepKey(turn, step)
    let stepState = state.steps.get(key)
    if (stepState === undefined) {
      stepState = {
        attempts: 0,
        primary: undefined,
        lastRoute: { provider: '', model: '' },
        chainCursor: 0,
        pendingRoute: undefined,
        strategyFailures: 0,
        selectedMode: undefined,
      }
      state.steps.set(key, stepState)
    }
    return stepState
  }
  return { states, sessionAgents, knownAgents, stats, reset, stateFor, stepFor }
}

/**
 * Install automatic model fallback.
 * @param ctx - plugin context.
 * @param config - fallback chain and policy.
 */
export function apply(ctx: Context, config: Config = { fallbacks: [] }): void {
  const chain = config.fallbacks ?? []
  const seenRoutes = new Set<string>()
  for (const entry of chain) {
    if (entry.provider === '' || (entry.model !== undefined && entry.model === '')) {
      throw new Error('llm-fallback: fallback route provider/model must not be empty')
    }
    const key = routeKey({ provider: entry.provider, model: entry.model ?? '' })
    if (seenRoutes.has(key)) {
      throw new Error('llm-fallback: duplicate fallback route ' + entry.provider + '/' + (entry.model ?? '*'))
    }
    seenRoutes.add(key)
  }
  const codes = new Set(config.codes ?? DEFAULT_FALLBACK_CODES)
  const unusableCodes = new Set(config.unusableCodes ?? DEFAULT_UNUSABLE_CODES)
  const cooldownMs = config.cooldownMs ?? 60_000
  const quota = config.quota
  // Cumulative projected-cost accumulator for the cost cap (instance-wide budget,
  // not per-agent). The cap is a stop-loss: once reached, the plugin stops
  // switching and lets the real failure take over.
  let cumulativeCost = 0
  const costCap = quota?.costCap

  const engine = createQuotaEngine(ctx, quota)
  const { checkQuota } = engine
  const catalog = createCatalogCache(ctx)
  const opts: MatchOptions = {
    allowDegrade: config.allowDegrade ?? false,
    allowUnknownCapacity: config.allowUnknownCapacity ?? false,
    preference: config.preference ?? 'closest',
  }
  const strategyConfig = config.strategy
  if (strategyConfig !== undefined) {
    for (const axis of strategyConfig.performance?.axes ?? []) {
      if (axis !== 'reasoning' && axis !== 'context' && axis !== 'output') {
        throw new Error(`llm-fallback: unknown strategy axis "${String(axis)}"`)
      }
    }
  }
  const strategySettings: StrategySettings | undefined =
    strategyConfig === undefined || strategyConfig.mode === 'closest' ? undefined : {
      mode: strategyConfig.mode,
      marginTokens: strategyConfig.floor?.marginTokens ?? 8192,
      estimatedOutputTokens: quota?.estimatedOutputTokens ?? 1024,
      futureSteps: strategyConfig.cost?.futureSteps ?? 1,
      sessionFailurePenalty: strategyConfig.cost?.sessionFailurePenalty ?? 2,
      cliffPenalty: strategyConfig.cost?.cliffPenalty ?? 1.5,
      axes: strategyConfig.performance?.axes ?? ['reasoning', 'context', 'output'],
      significantRatio: strategyConfig.performance?.significantRatio ?? 1.5,
    }
  const escalationAfter = strategyConfig?.escalation?.afterFailures ?? 2
  /** The strategy run for one selection: possibly an escalated mode. */
  const strategyRun = (
    mode: Exclude<StrategyMode, 'closest'> | undefined,
    session: Session,
    failedRoutes: ReadonlySet<string>,
    checkQuota: StrategyRun['checkQuota'],
    signal: AbortSignal,
    agentState: AgentState | undefined,
  ): StrategyRun | undefined => mode === undefined || strategySettings === undefined ? undefined : {
    mode,
    settings: { ...strategySettings, mode },
    session,
    prices: quota?.prices,
    failedRoutes,
    checkQuota,
    signal,
    rollingOutput: provider => rollingOutputTokens(agentState, provider),
  }
  const tracker = createAgentTracker(ctx, engine.clearAll, () => { cumulativeCost = 0 })
  const { states, sessionAgents, knownAgents, stateFor, stepFor } = tracker

  /** Probe configuration, resolved from the public config. */
  const probe = config.probe
  const probeTimeoutMs = probe?.timeoutMs ?? 6000
  const probeMaxTokens = probe?.maxTokens ?? 1
  const probePrompt = probe?.prompt ?? 'ok'

  /**
   * Confirm a candidate fallback route is actually usable before issuing the
   * switch. Directory presence is not a guarantee of usability: a route can be
   * listed (pi-ai resolves it via `resolveModelInfo`) yet the host adapter
   * rejects it at call time with `UNKNOWN_MODEL`, or the account has no quota
   * (HTTP 402/429). Sending one minimal real request catches both classes.
   *
   * Uses {@link LlmRuntime.stream} (the public streaming entry point). The
   * probe is NOT an `agent/request` — that event is only emitted by the agent
   * loop's `buildRequest` via the `agent/request` waterfall (dsh-agent-loop),
   * so a probe here never re-triggers this plugin's own `agent/request`
   * recovery listener. It also does not go through `llm-retry` (that plugin
   * only listens on `agent/request-error`). Any failure — throw, transport,
   * timeout, empty output — resolves to "not usable" and never blocks: the
   * plugin's never-block philosophy holds even for probes.
   *
   * @returns `{ok, reason?}` — ok=false with a free-text reason so the caller
   *   can surface it to the session.
   */
  async function probeValidRoute(
    route: ResolvedRoute,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; reason?: string }> {
    if ((ctx as unknown as { llm?: { stream: (o: GenerateOptions) => AsyncIterable<StreamChunk> } }).llm === undefined) {
      // No LLM service mounted (pure test harness): probing is impossible, so
      // never block — treat the route as usable and let the real request judge.
      return { ok: true }
    }
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: probePrompt }], source: { kind: 'user' } }),
    ]
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), probeTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      // Merge the given `signal` and the probe's own timeout: abort on either.
      const linked = signal !== undefined
        ? AbortSignal.any([signal, abort.signal])
        : abort.signal
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens: probeMaxTokens,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
        signal: linked,
      })
      let sawAny = false
      for await (const chunk of stream) {
        if (chunk.type === 'block-start' || chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'block-end') {
          sawAny = true
          // A probe only needs proof the route is reachable and produces output.
          // Stop as soon as we see content so a vision/reasoning-heavy model does
          // not burn tokens exploring the full request.
          if (chunk.type === 'block-start' || chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') break
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'stop') {
            // A successful stop is definitive: the answer completed.
            return { ok: true }
          }
          // finish with error/aborted/max-tokens: not usable OR at least
          // reachable. max-tokens at 1 token is expected to end length, which is
          // still proof the route works. Only an explicit error is not usable.
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            return { ok: false, reason: chunk.reason.kind }
          }
        }
      }
      // Loop ended without any definitive error and without a stop — the route
      // streamed something (sawAny) or completed. Treat "streamed content" as
      // usable; a genuinely dead route throws before yielding anything.
      return { ok: sawAny }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Ban a route for the session (never probe it again until reset). */
  const probeBan = (agentState: AgentState, route: ResolvedRoute): void => {
    agentState.bannedUntil.set(routeKey(route), Number.POSITIVE_INFINITY)
  }

  /** Retire step state for finished turns (turn numbers before `turn`). */
  function retireFinishedTurns(agentState: AgentState, turn: number): void {
    if (agentState.lastTurn !== undefined && agentState.lastTurn !== turn) {
      const retired = `${agentState.lastTurn}/`
      for (const key of [...agentState.steps.keys()]) {
        if (key.startsWith(retired)) agentState.steps.delete(key)
      }
    }
  }

  /** Record the primary route on first request and detect a user model switch.
   * Returns `userSwitched: true` when a fresh primary differs from the previous
   * step's primary (the plugin never rewrites primaryRoute to a fallback, so a
   * change there is the user's own selection). */
  function trackPrimary(
    agentState: AgentState,
    state: StepState,
    resolved: LlmCallConfig,
  ): { userSwitched: boolean } {
    const previousPrimary = agentState.primaryRoute
    const isFreshPrimary = state.primary === undefined
    if (isFreshPrimary) {
      state.primary = { provider: resolved.provider, model: resolved.model }
      agentState.primaryRoute = { provider: resolved.provider, model: resolved.model }
    }
    const userSwitched = isFreshPrimary && previousPrimary !== undefined
      && (previousPrimary.provider !== resolved.provider || previousPrimary.model !== resolved.model)
    return { userSwitched }
  }

  // Escape-hatch tool: an agent can restore every configured model's usability
  // in one call by discarding all of the plugin's routing decisions.
  const tools = ctx.get('tools') as { register(definition: unknown): () => void } | undefined
  if (tools !== undefined) {
    const disposeTool = tools.register({
      name: 'llm-fallback-reset',
      description: 'Restore every configured model\'s usability in one call: clear all fallback bans, the session-healthy route, cost-risk scores, and step-level selection state owned by the llm-fallback plugin, so the next request re-decides from the user\'s model selection and fallback chain. Use this as an escape hatch when the plugin\'s routing decisions need to be discarded entirely.',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'Must be true to confirm the reset; require explicit consent to avoid an accidental wipe of routing state.',
          },
        },
        required: ['confirm'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            resetAgents: { type: 'number', description: 'Number of agent states cleared.' },
            clearedBans: { type: 'number', description: 'Number of banned-until entries removed.' },
            clearedFailures: { type: 'number', description: 'Number of session failure-risk routes cleared.' },
            clearedSteps: { type: 'number', description: 'Number of step-level states discarded.' },
          },
          required: ['resetAgents', 'clearedBans', 'clearedFailures', 'clearedSteps'],
        },
        render: (_args: unknown, value: { resetAgents: number; clearedBans: number; clearedFailures: number; clearedSteps: number }) => [{
          type: 'text' as const,
          text: `Reset ${value.resetAgents} agent(s): removed ${value.clearedBans} ban(s), ${value.clearedFailures} failure-risk route(s), ${value.clearedSteps} step state(s).`,
        }],
      },
      execute: async (args: unknown) => {
        if (args !== null && typeof args === 'object' && (args as { confirm?: unknown }).confirm !== true) {
          throw new Error('llm-fallback-reset requires confirm: true')
        }
        return resetRegistry.get(ctx)?.() ?? { resetAgents: 0, clearedBans: 0, clearedFailures: 0, clearedSteps: 0 }
      },
    })
    ctx.effect(() => disposeTool, 'llm-fallback: reset tool')
  }

  // Mouse-independent escape hatch: a `/llm-fallback:reset` command any
  // surface (the status-bar button) can invoke via `session.command(...)`.
  // The handler clears every route decision for the whole plugin instance and
  // reports a plain summary text; registration is optional so the plugin
  // keeps working even when the commands registry is not mounted.
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    const disposeCommand = commands.register({
      name: 'llm-fallback-reset',
      description: 'Restore every configured model\'s usability \u2014 clear all fallback bans, the session-healthy route, risk scores, and step state.',
      handler: (): CommandResult => {
        const summary = resetRegistry.get(ctx)?.() ?? { resetAgents: 0, clearedBans: 0, clearedFailures: 0, clearedSteps: 0 }
        return { kind: 'success', text: `Restored ${summary.resetAgents} agent(s): cleared ${summary.clearedBans} ban(s), ${summary.clearedFailures} risk route(s), ${summary.clearedSteps} step state(s).` }
      },
    })
    ctx.effect(() => disposeCommand, 'llm-fallback: reset command')
  }

  /** Rolling real-usage output estimate for one provider: the mean of the last
   * folded `usage.outputTokens` samples, or undefined before any sample. */
  const rollingOutputTokens = (agentState: AgentState | undefined, provider: string): number | undefined => {
    const samples = agentState?.outputSamples.get(provider)
    if (samples === undefined || samples.length === 0) return undefined
    let sum = 0
    for (const sample of samples) sum += sample
    return sum / samples.length
  }

  // Outermost listener (registered before per-agent model selection): snapshot
  // the primary route, record the issued route, and rewrite it when a recovery
  // has resolved a fallback route.
  ctx.on('agent/request', async (payload, next) => {
    const { agent, turn, step, signal } = payload
    const agentState = stateFor(agent)
    retireFinishedTurns(agentState, turn)
    agentState.lastTurn = turn
    sessionAgents.set(agent.session, agent)
    const state = stepFor(agent, turn, step)
    state.attempts += 1
    const resolved = await next()
    const { userSwitched } = trackPrimary(agentState, state, resolved)
    knownAgents.add(agent)
    // Charge the projected cost of one request that actually goes out. The cost
    // cap is an instance-wide stop-loss budget, so the accumulator is per-apply.
    const chargeCost = (route: LlmCallConfig): void => {
      const projected = estimateCost(quota, route.provider, route.model, agent.session, rollingOutputTokens(agentState, route.provider))
      if (projected !== undefined) cumulativeCost += projected.cost
    }
    // A pending route from a prior recovery rewrites the resolved config.
    const pending = state.pendingRoute
    state.pendingRoute = undefined
    if (pending !== undefined) {
      const replaced = withRoute(resolved, pending)
      state.lastRoute = { provider: replaced.provider, model: replaced.model }
      chargeCost(replaced)
      return replaced
    }
    // Redirect to the session-healthy fallback unless the user just switched.
    const healthy = agentState.healthyRoute
    if (!userSwitched && healthy !== undefined && (healthy.provider !== resolved.provider || healthy.model !== resolved.model)) {
      const redirected = withRoute(resolved, healthy)
      state.lastRoute = { provider: redirected.provider, model: redirected.model }
      chargeCost(redirected)
      return redirected
    }
    // Preemptive quota check: switch before sending if the allowance is
    // insufficient or unobservable for a user-switched model.
    const preemptive = await preemptiveQuotaCheck(
      resolved, agent, agentState, state, turn, step, signal, userSwitched,
    )
    if (preemptive !== undefined) {
      chargeCost(preemptive)
      return preemptive
    }
    state.lastRoute = { provider: resolved.provider, model: resolved.model }
    chargeCost(resolved)
    return resolved
  })

  /** The preemptive quota gate: checks the resolved route's allowance and
   * switches (or warns + probes) before the request goes out. Returns the
   * rewritten config when a switch occurs, or `undefined` to send as-is. */
  async function preemptiveQuotaCheck(
    resolved: LlmCallConfig,
    agent: Agent,
    agentState: AgentState,
    state: StepState,
    turn: number,
    step: number,
    signal: AbortSignal,
    userSwitched: boolean,
  ): Promise<LlmCallConfig | undefined> {
    const quotaCheck = await checkQuota(resolved.provider, resolved.model, signal, userSwitched)
    const trip = quotaCheck === undefined ? { below: false } : belowThreshold(quotaCheck, quota)
    const projected = estimateCost(quota, resolved.provider, resolved.model, agent.session, rollingOutputTokens(agentState, resolved.provider))
    const costTrip = projected !== undefined
      && quotaCheck?.remaining !== undefined
      && quotaCheck.remaining < projected.cost
    if (trip.below || costTrip) {
      const primaryCapability = await capabilityOf(catalog, resolved)
      // Same probe-selection loop as the failure path: skip an unusable
      // candidate before switching to it (a preemptive switch must not land on
      // a route that is listed but not callable).
      let result: SelectionOutcome | undefined
      while (true) {
        if (signal.aborted) return undefined
        const candidate = await selectNext(
          catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(),
          strategyRun(strategySettings?.mode, agent.session, agentState.failedRoutes, checkQuota, signal, agentState),
        )
        if (candidate === undefined) {
          result = undefined
          break
        }
        if (probe?.enabled !== true) {
          result = candidate
          break
        }
        const check = await probeValidRoute(candidate.route, signal)
        if (check.ok) {
          result = candidate
          break
        }
        probeBan(agentState, candidate.route)
        state.chainCursor = cursorIndexOf(candidate.cursor)
        agent.session.append('llm/quota-warning', {
          turn,
          step,
          provider: candidate.route.provider,
          model: candidate.route.model,
          reason: 'probe-failed',
        })
      }
      if (result !== undefined) {
        agentState.switchedKeys.add(routeKey(result.route))
        agent.session.append('llm/quota-warning', {
          turn,
          step,
          provider: resolved.provider,
          model: resolved.model,
          ...quotaCheck?.remaining === undefined ? {} : { remaining: quotaCheck.remaining },
          ...quotaCheck?.total === undefined ? {} : { total: quotaCheck.total },
          ...trip.threshold === undefined ? {} : { threshold: trip.threshold },
          ...trip.thresholdKind === undefined ? {} : { thresholdKind: trip.thresholdKind },
          ...costTrip && projected !== undefined ? {
            estimatedCost: projected.cost,
            inputPrice: projected.inputPrice,
            outputPrice: projected.outputPrice,
          } : {},
          reason: trip.below ? 'below-threshold' as const : 'insufficient-cost' as const,
          ...result.mode === undefined ? {} : { mode: result.mode },
        })
        state.lastRoute = { provider: result.route.provider, model: result.route.model }
        state.chainCursor = cursorIndexOf(result.cursor)
        return withRoute(resolved, result.route)
      }
      return undefined
    }
    // Advisory forecast: warn (WITHOUT switching) when the projected remaining
    // after `forecastSteps` more steps falls below a configured advisory floor
    // (`warnAbsolute`, or `warnRatio` against the disclosed total). An unpriced
    // route projects zero burn, degrading to a pure balance floor. The advisory
    // is level-latched per route: it fires on entering the warn zone and
    // re-arms when the projection leaves it (e.g. a top-up) or the route
    // changes, so a slow burn inside the zone appends one row, not one per
    // request. The hard switch thresholds above stay the authoritative
    // escalation point; this only gives the user an earlier heads-up.
    if (quota !== undefined && quotaCheck !== undefined && quotaCheck.remaining !== undefined
      && (quota.warnAbsolute !== undefined || quota.warnRatio !== undefined)) {
      const forecastSteps = quota.forecastSteps ?? 1
      const burn = projected !== undefined ? projected.cost * forecastSteps : 0
      const projectedRemaining = quotaCheck.remaining - burn
      const absoluteTrip = quota.warnAbsolute !== undefined && projectedRemaining < quota.warnAbsolute
      const ratioTrip = quota.warnRatio !== undefined
        && quotaCheck.total !== undefined && quotaCheck.total > 0
        && projectedRemaining / quotaCheck.total < quota.warnRatio
      const route = routeKey(resolved)
      if (absoluteTrip || ratioTrip) {
        if (agentState.forecastWarnedRoute !== route) {
          agentState.forecastWarnedRoute = route
          agent.session.append('llm/quota-warning', {
            turn,
            step,
            provider: resolved.provider,
            model: resolved.model,
            remaining: quotaCheck.remaining,
            ...quotaCheck.total === undefined ? {} : { total: quotaCheck.total },
            ...absoluteTrip && quota.warnAbsolute !== undefined
              ? { threshold: quota.warnAbsolute, thresholdKind: 'absolute' as const }
              : quota.warnRatio !== undefined
                ? { threshold: quota.warnRatio, thresholdKind: 'ratio' as const }
                : {},
            ...projected !== undefined ? {
              estimatedCost: projected.cost,
              inputPrice: projected.inputPrice,
              outputPrice: projected.outputPrice,
            } : {},
            projectedBurn: burn,
            forecastSteps,
            reason: 'forecast-low' as const,
          })
        }
      } else {
        agentState.forecastWarnedRoute = undefined
      }
    }
    if (userSwitched && quotaCheck?.remaining === undefined) {
      // The user picked a model whose allowance is unobservable. Honor the
      // selection and let this very request act as the probe.
      agent.session.append('llm/quota-warning', {
        turn,
        step,
        provider: resolved.provider,
        model: resolved.model,
        reason: 'unobservable' as const,
      })
      return resolved
    }
    return undefined
  }

  // On an eligible failure, resolve the next fallback route (skipping providers
  // with no matching model) and ask the loop to re-derive the request with the
  // same turn/step (preserving the conversation so far).
  ctx.on('agent/request-error', async (payload, next) => {
    const { agent, turn, step, failure, signal } = payload
    if (signal.aborted) return next()
    const eligible = codes.has(failure.code)
    const unusable = unusableCodes.has(failure.code)
    if (!eligible && !unusable) return next()
    const state = stepFor(agent, turn, step)
    const primary = state.primary
    if (primary === undefined) return next()
    const agentState = stateFor(agent)
    const from = state.lastRoute
    if (eligible) {
      agentState.bannedUntil.set(routeKey(from), banUntil(from.provider, cooldownMs, quota, Date.now()))
      agentState.failedRoutes.add(routeKey(from))
    }
    // Escalation ladder: cost-mode candidate failures escalate this step to
    // performance mode — task completion outranks the cost preference.
    if (eligible && state.selectedMode === 'cost') state.strategyFailures += 1
    // Cost-cap stop-loss: once the instance's accumulated projected cost reaches
    // the configured cap, the plugin stops switching and lets the real failure
    // take over, recording why it stopped.
    if (costCap !== undefined && cumulativeCost >= costCap) {
      if (eligible) {
        agent.session.append('llm/quota-warning', {
          turn,
          step,
          provider: from.provider,
          model: from.model,
          reason: 'cost-cap-reached',
          costCap,
          cumulativeCost,
        })
      }
      return next()
    }
    const effectiveMode: Exclude<StrategyMode, 'closest'> | undefined = strategySettings === undefined
      ? undefined
      : strategySettings.mode === 'cost' && state.strategyFailures >= escalationAfter
        ? 'performance'
        : strategySettings.mode
    const primaryCapability = await capabilityOf(catalog, primary)
    // Probe-selection loop: selectNext picks one candidate; if the probe is
    // enabled the route is confirmed usable before the switch is issued. A
    // probe failure bans the route for the session and re-selects — the chain
    // advances because selectNext consumed that candidate's cursor. This is the
    // "verify usability before switching" guarantee: a route that is listed in
    // the catalog but is not actually callable (UNKNOWN_MODEL, no quota, broken
    // adapter) never kills the turn, it is skipped for a later candidate.
    let outcome: SelectionOutcome | undefined
    while (true) {
      if (signal.aborted) return next()
      const candidate = await selectNext(
        catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(),
        strategyRun(effectiveMode, agent.session, agentState.failedRoutes, checkQuota, signal, agentState),
      )
      if (candidate === undefined) {
        outcome = undefined
        break
      }
      if (probe?.enabled !== true) {
        outcome = candidate
        break
      }
      const check = await probeValidRoute(candidate.route, signal)
      if (check.ok) {
        outcome = candidate
        break
      }
      // Probe failed: this candidate is unusable this session. Ban it so the
      // next selectNext skips it, log the skip to the session, and re-select.
      probeBan(agentState, candidate.route)
      state.chainCursor = cursorIndexOf(candidate.cursor)
      agentState.switches += 1
      agent.session.append('llm/fallback', {
        turn,
        step,
        fromProvider: from.provider,
        fromModel: from.model,
        toProvider: candidate.route.provider,
        toModel: candidate.route.model,
        code: failure.code,
        remaining: chain.length - cursorIndexOf(candidate.cursor),
        reason: 'probe-failed',
        ...candidate.mode === undefined ? {} : { mode: candidate.mode },
      })
    }
    const result = outcome
    if (result === undefined) {
      // The chain is exhausted for this step: no candidate remains. Count it only
      // for a genuine (eligible) failure — a structural (unusable) code advancing
      // to the end is a config gap, not a reliability event.
      if (eligible) {
        agentState.exhaustions += 1
        // Give the user an explainable terminal notice: every fallback route was
        // tried and failed, so the turn ends in an error with no candidate left.
        agent.session.append('llm/fallback-exhausted', {
          turn,
          step,
          provider: from.provider,
          model: from.model,
          code: failure.code,
          attempts: state.attempts,
        })
      }
      return next()
    }
    agentState.switchedKeys.add(routeKey(result.route))
    state.pendingRoute = result.route
    state.chainCursor = cursorIndexOf(result.cursor)
    state.selectedMode = result.mode
    agentState.switches += 1
    agent.session.append('llm/fallback', {
      turn,
      step,
      fromProvider: from.provider,
      fromModel: from.model,
      toProvider: result.route.provider,
      toModel: result.route.model,
      code: failure.code,
      remaining: chain.length - cursorIndexOf(result.cursor),
      ...result.mode === undefined ? {} : { mode: result.mode },
      ...result.score === undefined ? {} : { score: result.score },
    })
    return { kind: 'retry' as const }
  })

  // Poll the primary route's allowance so a recovered allowance clears the
  // session-wide healthy cache in time for the next request. Uses force=true
  // to bypass the TTL cache — the poll is the sole mechanism that notices a
  // recovered allowance between requests, and a stale cache would defeat it.
  if (config.pollIntervalMs !== undefined && config.pollIntervalMs > 0) {
    const pollAbort = new AbortController()
    const timer = setInterval(async () => {
      for (const agent of knownAgents) {
        const agentState = states.get(agent)
        if (agentState === undefined || agentState.healthyRoute === undefined) continue
        const primary = agentState.primaryRoute
        if (primary === undefined) continue
        const check = await checkQuota(primary.provider, primary.model, pollAbort.signal, true)
        if (check === undefined) continue
        if (!belowThreshold(check, quota).below) agentState.healthyRoute = undefined
      }
    }, config.pollIntervalMs)
    ctx.effect(() => () => {
      clearInterval(timer)
      pollAbort.abort()
    }, 'llm-fallback: stop quota polling')
  }

  // Promote a fallback switch to the session-wide healthy cache once the
  // switched route completes a model message successfully.
  //
  // Assumes Session:Agent is 1:1 (each session is owned by exactly one agent).
  // If multiple agents share a session, the last one to issue a request wins
  // the mapping; the guard below (states.get → undefined) prevents a crash
  // but the healthy promotion may land on the wrong agent.
  let dispatchSeen = false
  ctx.on('internal/dispatch', (_mode: string, eventName: string, args: unknown) => {
    dispatchSeen = true
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'assistant/message') return
    const agent = sessionAgents.get(session)
    if (agent === undefined) return
    const agentState = states.get(agent)
    if (agentState === undefined) return
    const source = event.data.message.source
    if (agentState.switchedKeys.has(routeKey(source))) {
      agentState.healthyRoute = { provider: source.provider, model: source.model }
      agentState.switchSuccess += 1
    }
    // Fold the provider-reported output tokens into the rolling per-provider
    // average that refines the cost projection's output side. The input side
    // keeps tracking the live transcript (chars/4), which an average cannot
    // represent; usage is attributed only when the adapter reported it.
    const usage = event.data.usage
    if (usage !== undefined && typeof usage.outputTokens === 'number' && usage.outputTokens > 0) {
      const samples = agentState.outputSamples.get(source.provider)
      if (samples === undefined) {
        agentState.outputSamples.set(source.provider, [usage.outputTokens])
      } else {
        samples.push(usage.outputTokens)
        if (samples.length > OUTPUT_SAMPLE_CAP) samples.shift()
      }
    }
  }, { global: true })
  // If the internal dispatch mechanism is absent (DSH refactor), the healthy
  // cache is silently disabled. Warn once after 30s so the degradation is
  // visible without spamming every request.
  const dispatchProbe = setTimeout(() => {
    if (!dispatchSeen) {
      ctx.logger('llm-fallback').warn(
        'internal/dispatch events not observed after 30s; healthy-route promotion is disabled. ' +
        'This may indicate a DSH runtime version mismatch.',
      )
    }
  }, 30_000)
  dispatchProbe.unref?.()
  ctx.effect(() => () => { clearTimeout(dispatchProbe) }, 'llm-fallback: clear dispatch probe')
}
