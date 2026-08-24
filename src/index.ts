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
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'
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
  }
}

export const Config: z<Config> = z.object({
  fallbacks: z.array(z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
  })).required(),
  codes: z.array(z.string().min(1)),
  unusableCodes: z.array(z.string().min(1)),
  cooldownMs: z.number().min(0).default(60_000),
  pollIntervalMs: z.number().min(1),
  allowDegrade: z.boolean().default(false),
  allowUnknownCapacity: z.boolean().default(false),
  preference: z.union(['closest', 'price', 'speed', 'reasoning']).default('closest'),
  strategy: z.object({
    mode: z.union(['cost', 'performance', 'closest']).required(),
    floor: z.object({
      marginTokens: z.number().min(1).default(8192),
    }),
    cost: z.object({
      futureSteps: z.number().min(1).default(1),
      sessionFailurePenalty: z.number().min(1).default(2),
      cliffPenalty: z.number().min(1).default(1.5),
    }),
    performance: z.object({
      axes: z.array(z.union(['reasoning', 'context', 'output'])),
      significantRatio: z.number().min(1).default(1.5),
    }),
    escalation: z.object({
      afterFailures: z.number().min(1).default(2),
    }),
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
}

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

/** Rough input-token estimate from the serialized message history (chars / 4). */
function estimateInputTokens(session: Session): number {
  const serialized = JSON.stringify(session.deriveMessages())
  return Math.max(1, Math.ceil(serialized.length / 4))
}

/** Projected cost in the provider's unit, when a price is configured for the route. */
function estimateCost(
  quota: QuotaConfig | undefined,
  provider: string,
  model: string,
  session: Session,
): { cost: number; inputPrice: number; outputPrice: number } | undefined {
  const price = priceOf(quota?.prices, provider, model)
  if (price === undefined || (price.input === undefined && price.output === undefined)) return undefined
  const inputPrice = price.input ?? 0
  const outputPrice = price.output ?? 0
  const inputTokens = estimateInputTokens(session)
  const outputTokens = quota?.estimatedOutputTokens ?? 1024
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

/** Resolve one provider's candidate catalog with per-candidate capability. */
async function selectModel(
  catalog: CatalogCache,
  primary: Capability,
  provider: string,
  opts: MatchOptions,
): Promise<string | undefined> {
  const models = await catalog.listModels(provider)
  const candidates: Candidate[] = []
  for (const model of models) {
    const info = await catalog.resolveModelInfo(provider, model.id)
    candidates.push({
      id: model.id,
      capability: {
        ...info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
        ...info.inputModalities === undefined ? {} : { modalities: info.inputModalities },
      },
      ...info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens },
      ...info.reasoning === undefined ? {} : { hasReasoning: true },
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
    for (const id of ids) {
      const until = banned.get(routeKey({ provider: entry.provider, model: id }))
      if (until !== undefined && until > now) continue
      const info = await catalog.resolveModelInfo(entry.provider, id)
      const price = priceOf(run.prices, entry.provider, id)
      const projected = price === undefined || (price.input === undefined && price.output === undefined)
        ? undefined
        : (inputTokens * (price.input ?? 0) + run.settings.estimatedOutputTokens * (price.output ?? 0)) / 1_000_000
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
        ...info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
        ...info.inputModalities === undefined ? {} : { modalities: info.inputModalities },
        ...info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens },
        ...info.reasoning === undefined ? {} : { hasReasoning: true },
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
function createAgentTracker(ctx: Context, clearQuota: () => void): AgentTracker {
  const states = new WeakMap<Agent, AgentState>()
  const sessionAgents = new WeakMap<Session, Agent>()
  const knownAgents = new Set<Agent>()
  const stats = (): { agents: number; steps: number } => {
    let steps = 0
    for (const agent of knownAgents) {
      const agentState = states.get(agent)
      if (agentState !== undefined) steps += agentState.steps.size
    }
    return { agents: knownAgents.size, steps }
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
    }
    // Also drop cached/in-flight allowances so the next request re-interrogates.
    clearQuota()
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
      state = { steps: new Map(), healthyRoute: undefined, switchedKeys: new Set(), bannedUntil: new Map(), failedRoutes: new Set(), lastTurn: undefined, primaryRoute: undefined }
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
  ): StrategyRun | undefined => mode === undefined || strategySettings === undefined ? undefined : {
    mode,
    settings: { ...strategySettings, mode },
    session,
    prices: quota?.prices,
    failedRoutes,
    checkQuota,
    signal,
  }
  const tracker = createAgentTracker(ctx, engine.clearAll)
  const { states, sessionAgents, knownAgents, stateFor, stepFor } = tracker

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

  // Outermost listener (registered before per-agent model selection): snapshot
  // the primary route, record the issued route, and rewrite it when a recovery
  // has resolved a fallback route.
  ctx.on('agent/request', async (payload, next) => {
    const { agent, turn, step, signal } = payload
    const agentState = stateFor(agent)
    if (agentState.lastTurn !== undefined && agentState.lastTurn !== turn) {
      const retired = `${agentState.lastTurn}/`
      for (const key of [...agentState.steps.keys()]) {
        if (key.startsWith(retired)) {
          agentState.steps.delete(key)
        }
      }
    }
    agentState.lastTurn = turn
    sessionAgents.set(agent.session, agent)
    const state = stepFor(agent, turn, step)
    state.attempts += 1
    const resolved = await next()
    const previousPrimary = agentState.primaryRoute
    const isFreshPrimary = state.primary === undefined
    if (isFreshPrimary) {
      state.primary = { provider: resolved.provider, model: resolved.model }
      agentState.primaryRoute = { provider: resolved.provider, model: resolved.model }
    }
    // A fresh primary that differs from the previous step's is a user-initiated
    // model switch (the plugin never rewrites primaryRoute to a fallback, so a
    // change here reflects the user's own selection change).
    const userSwitched = isFreshPrimary && previousPrimary !== undefined
      && (previousPrimary.provider !== resolved.provider || previousPrimary.model !== resolved.model)
    knownAgents.add(agent)
    const pending = state.pendingRoute
    state.pendingRoute = undefined
    if (pending !== undefined) {
      const replaced = withRoute(resolved, pending)
      state.lastRoute = { provider: replaced.provider, model: replaced.model }
      return replaced
    }
    // Respect a user's explicit model switch: don't force the request back to
    // the session's healthy fallback route — the new model gets its own fresh
    // quota re-check below instead of silently being overridden.
    const healthy = agentState.healthyRoute
    if (!userSwitched && healthy !== undefined && (healthy.provider !== resolved.provider || healthy.model !== resolved.model)) {
      const redirected = withRoute(resolved, healthy)
      state.lastRoute = { provider: redirected.provider, model: redirected.model }
      return redirected
    }
    // Preemptive switch when the resolved route's allowance trips a threshold
    // or cannot cover the projected cost of this request. A user-switched model
    // is interrogated fresh (force=true) to notice an underfunded selection
    // rather than trusting a stale cached allowance.
    const quotaCheck = await checkQuota(resolved.provider, resolved.model, signal, userSwitched)
    const trip = quotaCheck === undefined ? { below: false } : belowThreshold(quotaCheck, quota)
    const projected = estimateCost(quota, resolved.provider, resolved.model, agent.session)
    const costTrip = projected !== undefined
      && quotaCheck?.remaining !== undefined
      && quotaCheck.remaining < projected.cost
    if (trip.below || costTrip) {
      const primaryCapability = await capabilityOf(catalog, resolved)
      const result = await selectNext(
        catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(),
        strategyRun(strategySettings?.mode, agent.session, agentState.failedRoutes, checkQuota, signal),
      )
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
    } else if (userSwitched && quotaCheck?.remaining === undefined) {
      // The user picked a model whose allowance is unobservable (no fresh quota
      // disclosed). Honor the selection and let this very request act as the
      // probe: a failure will ban + fall back, and a warning surfaces that the
      // model was probed with the request itself.
      agent.session.append('llm/quota-warning', {
        turn,
        step,
        provider: resolved.provider,
        model: resolved.model,
        reason: 'unobservable' as const,
      })
      state.lastRoute = { provider: resolved.provider, model: resolved.model }
      return resolved
    }
    state.lastRoute = { provider: resolved.provider, model: resolved.model }
    return resolved
  })

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
    const effectiveMode: Exclude<StrategyMode, 'closest'> | undefined = strategySettings === undefined
      ? undefined
      : strategySettings.mode === 'cost' && state.strategyFailures >= escalationAfter
        ? 'performance'
        : strategySettings.mode
    const primaryCapability = await capabilityOf(catalog, primary)
    const result = await selectNext(
      catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(),
      strategyRun(effectiveMode, agent.session, agentState.failedRoutes, checkQuota, signal),
    )
    if (result === undefined) return next()
    agentState.switchedKeys.add(routeKey(result.route))
    state.pendingRoute = result.route
    state.chainCursor = cursorIndexOf(result.cursor)
    state.selectedMode = result.mode
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
  // session-wide healthy cache in time for the next request.
  if (config.pollIntervalMs !== undefined && config.pollIntervalMs > 0) {
    const pollAbort = new AbortController()
    const timer = setInterval(async () => {
      for (const agent of knownAgents) {
        const agentState = states.get(agent)
        if (agentState === undefined || agentState.healthyRoute === undefined) continue
        const primary = agentState.primaryRoute
        if (primary === undefined) continue
        const check = await checkQuota(primary.provider, primary.model, pollAbort.signal)
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
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
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
    }
  }, { global: true })
}
