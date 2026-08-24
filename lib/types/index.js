/**
 * Automatic cross-provider model fallback on the agent loop's request
 * recovery and request-routing extension points.
 *
 * @module @kongfun2018/dsh-llm-fallback
 */
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { priceOf, selectByStrategy } from "./strategy.js";
export { buildFloor, comparePerformance, costScore, passesFloor, priceOf, selectByStrategy, } from "./strategy.js";
export const name = 'llm-fallback';
export const inject = ['agents', 'llm'];
/** Per-apply stats handles, keyed by the plugin context (test/diagnostics seam). */
const fallbackStatsRegistry = new WeakMap();
/** Read a live plugin instance's step-state statistics, if installed. */
export function getFallbackStats(ctx) {
    return fallbackStatsRegistry.get(ctx)?.();
}
/** Per-apply reset handles, keyed by the plugin context. */
const resetRegistry = new WeakMap();
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
export function resetFallback(ctx) {
    return resetRegistry.get(ctx)?.();
}
/** Failure codes that trigger a switch; transient + exhausted-account codes. */
export const DEFAULT_FALLBACK_CODES = Object.freeze([
    'QUOTA',
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'EMPTY_RESPONSE',
]);
/** Structural "candidate unusable" codes: advance the chain without banning. */
export const DEFAULT_UNUSABLE_CODES = Object.freeze([
    'NO_ADAPTER',
    'UNSUPPORTED_REASONING_EFFORT',
    'INVALID_MODEL_INFO',
    'INVALID_MODEL_CONTEXT',
    'INVALID_MODEL_MAX_TOKENS',
    'INVALID_MODEL_REASONING',
]);
export const Config = z.object({
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
});
function stepKey(turn, step) {
    return `${turn}/${step}`;
}
function routeKey(route) {
    return `${route.provider}\u0000${route.model}`;
}
/** Rewrite a call config to a resolved fallback route, dropping an inherited effort. */
function withRoute(config, route) {
    const { reasoningEffort: _dropped, ...rest } = config;
    return {
        ...rest,
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
    };
}
/** Whether candidate modalities cover every required modality. */
function covers(candidate, required) {
    if (candidate === undefined)
        return false;
    return required.every(modality => candidate.includes(modality));
}
/**
 * Choose one model id from a provider's resolved candidates by rule:
 * modality coverage, then capacity non-degradation, then closeness, then cost.
 */
function matchModel(primary, candidates, opts) {
    const required = primary.modalities;
    let pool = candidates;
    if (required !== undefined && required.length > 0) {
        pool = pool.filter(candidate => covers(candidate.capability.modalities, required));
    }
    if (pool.length === 0)
        return undefined;
    const target = primary.contextWindow;
    const nonDegrading = [];
    const degrading = [];
    const unknown = [];
    for (const candidate of pool) {
        const window = candidate.capability.contextWindow;
        if (window === undefined)
            unknown.push(candidate);
        else if (target === undefined || window >= target)
            nonDegrading.push(candidate);
        else
            degrading.push(candidate);
    }
    let group;
    group = nonDegrading.length > 0 ? nonDegrading
        : opts.allowDegrade ? degrading
            : opts.allowUnknownCapacity ? unknown
                : [];
    if (group.length === 0)
        return undefined;
    if (opts.preference !== 'closest' || target !== undefined) {
        group = [...group].sort((a, b) => compareCandidates(a, b, target, opts.preference));
    }
    return group[0]?.id;
}
/** Order two capability-matched candidates by the configured tie-break preference. */
function compareCandidates(a, b, target, preference) {
    const windowOf = (c) => c.capability.contextWindow ?? Number.POSITIVE_INFINITY;
    const maxTokensOf = (c) => c.maxTokens ?? Number.POSITIVE_INFINITY;
    const closenessOf = (c) => target === undefined ? 0 : Math.abs(windowOf(c) - target);
    switch (preference) {
        case 'price':
            return windowOf(a) - windowOf(b) || closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id);
        case 'speed':
            return maxTokensOf(a) - maxTokensOf(b) || closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id);
        case 'reasoning':
            return (Number(b.hasReasoning ?? false) - Number(a.hasReasoning ?? false))
                || closenessOf(a) - closenessOf(b)
                || a.id.localeCompare(b.id);
        case 'closest':
        default:
            return closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id);
    }
}
/** How long a provider's catalog (model list + per-model info) stays cached;
 * catalogs change at provider pace, not request pace. */
const CATALOG_CACHE_TTL_MS = 60_000;
function createCatalogCache(ctx) {
    const modelsCache = new Map();
    const infoCache = new Map();
    const listModels = (provider) => {
        const hit = modelsCache.get(provider);
        if (hit !== undefined && Date.now() - hit.at < CATALOG_CACHE_TTL_MS)
            return Promise.resolve(hit.models);
        return ctx.llm.listModels(provider).then(models => {
            modelsCache.set(provider, { at: Date.now(), models });
            return models;
        });
    };
    const resolveModelInfo = (provider, model) => {
        const hit = infoCache.get(routeKey({ provider, model }));
        if (hit !== undefined && Date.now() - hit.at < CATALOG_CACHE_TTL_MS)
            return Promise.resolve(hit.info);
        return ctx.llm.resolveModelInfo(provider, model).then(info => {
            infoCache.set(routeKey({ provider, model }), { at: Date.now(), info });
            return info;
        });
    };
    return { listModels, resolveModelInfo };
}
/** Resolve one exact route's capability signals; a resolve failure degrades to
 * an empty capability (unknown window/modalities) rather than blocking the
 * request — consistent with the plugin's "never block" philosophy. */
async function capabilityOf(catalog, route) {
    const info = await catalog.resolveModelInfo(route.provider, route.model).catch(() => undefined);
    return {
        ...info === undefined || info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
        ...info === undefined || info.inputModalities === undefined ? {} : { modalities: info.inputModalities },
    };
}
/** Rough input-token estimate from the serialized message history (chars / 4). */
function estimateInputTokens(session) {
    const serialized = JSON.stringify(session.deriveMessages());
    return Math.max(1, Math.ceil(serialized.length / 4));
}
/** Projected cost in the provider's unit, when a price is configured for the route. */
function estimateCost(quota, provider, model, session) {
    const price = priceOf(quota?.prices, provider, model);
    if (price === undefined || (price.input === undefined && price.output === undefined))
        return undefined;
    const inputPrice = price.input ?? 0;
    const outputPrice = price.output ?? 0;
    const inputTokens = estimateInputTokens(session);
    const outputTokens = quota?.estimatedOutputTokens ?? 1024;
    return { cost: (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000, inputPrice, outputPrice };
}
/** Fetch one balance endpoint and parse the DeepSeek `/user/balance` shape.
 * Throws on transport/HTTP/parse failure (probe failure); returns `undefined`
 * only for a well-formed response that discloses no balance (unobservable). */
async function queryBalanceEndpoint(endpoint, apiKey, signal) {
    const response = await fetch(endpoint, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal,
    });
    if (!response.ok)
        throw new Error(`balance endpoint ${endpoint} responded ${response.status}`);
    const data = await response.json();
    // `is_available: false` marks the account unusable (frozen or blocked), which
    // the kind vocabulary cannot distinguish from an exhausted balance; mapping
    // it to balance-0 makes the preemptive check treat it as underfunded.
    if (data.is_available === false)
        return { kind: 'balance', remaining: 0 };
    const total = data.balance_infos?.[0]?.total_balance === undefined
        ? undefined
        : Number.parseFloat(data.balance_infos[0].total_balance);
    if (total === undefined || Number.isNaN(total))
        return undefined;
    return { kind: 'balance', remaining: total };
}
/** Exclude a failed route until, based on its allowance kind. */
function banUntil(provider, cooldownMs, quota, now) {
    const entry = quota?.static?.[provider];
    if (entry?.kind === 'balance')
        return Number.POSITIVE_INFINITY;
    if (entry?.kind === 'quota' && entry.resetAt !== undefined)
        return entry.resetAt;
    return cooldownMs === 0 ? Number.POSITIVE_INFINITY : now + cooldownMs;
}
/** Whether a disclosed remaining allowance trips a configured threshold. */
function belowThreshold(check, quota) {
    if (check.remaining === undefined)
        return { below: false };
    if (quota?.thresholdAbsolute !== undefined && check.remaining < quota.thresholdAbsolute) {
        return { below: true, threshold: quota.thresholdAbsolute, thresholdKind: 'absolute' };
    }
    if (quota?.thresholdRatio !== undefined && check.total !== undefined && check.total > 0) {
        if (check.remaining / check.total < quota.thresholdRatio) {
            return { below: true, threshold: quota.thresholdRatio, thresholdKind: 'ratio' };
        }
    }
    return { below: false };
}
/** Resolve one provider's candidate catalog with per-candidate capability. */
async function selectModel(catalog, primary, provider, opts) {
    const models = await catalog.listModels(provider);
    const candidates = [];
    for (const model of models) {
        const info = await catalog.resolveModelInfo(provider, model.id);
        candidates.push({
            id: model.id,
            capability: {
                ...info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
                ...info.inputModalities === undefined ? {} : { modalities: info.inputModalities },
            },
            ...info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens },
            ...info.reasoning === undefined ? {} : { hasReasoning: true },
        });
    }
    return matchModel(primary, candidates, opts);
}
/** The numeric chain index a cursor directive leaves the walk at. */
function cursorIndexOf(directive) {
    return 'advanceTo' in directive ? directive.advanceTo : directive.reselectFrom;
}
/** Walk the chain from a cursor, resolving each entry to a concrete route. */
async function selectNext(catalog, chain, cursor, primary, opts, banned, now, strategy) {
    if (strategy !== undefined) {
        const strategic = await selectNextByStrategy(catalog, chain, cursor, primary, opts, strategy, banned, now);
        if (strategic !== undefined)
            return strategic;
    }
    return selectNextByRules(catalog, chain, cursor, primary, opts, banned, now);
}
/** Rule-based lazy walk over the chain. */
async function selectNextByRules(catalog, chain, cursor, primary, opts, banned, now) {
    let index = cursor;
    while (index < chain.length) {
        const entry = chain[index];
        if (entry === undefined)
            return undefined;
        if (entry.model !== undefined) {
            const until = banned.get(routeKey({ provider: entry.provider, model: entry.model }));
            if (until !== undefined && until > now) {
                index += 1;
                continue;
            }
            return {
                route: {
                    provider: entry.provider,
                    model: entry.model,
                    ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
                },
                cursor: { advanceTo: index + 1 },
            };
        }
        const selected = await selectModel(catalog, primary, entry.provider, opts);
        if (selected !== undefined) {
            const until = banned.get(routeKey({ provider: entry.provider, model: selected }));
            if (until !== undefined && until > now) {
                index += 1;
                continue;
            }
            return {
                route: {
                    provider: entry.provider,
                    model: selected,
                    ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
                },
                cursor: { advanceTo: index + 1 },
            };
        }
        index += 1;
    }
    return undefined;
}
/** Strategy path (docs/strategy-design.md): expand the whole chain, apply the
 * hard task-completion floor, then score globally under the active mode. */
async function selectNextByStrategy(catalog, chain, cursor, primary, opts, run, banned, now) {
    const inputTokens = estimateInputTokens(run.session);
    const candidates = [];
    for (let index = cursor; index < chain.length; index++) {
        const entry = chain[index];
        if (entry === undefined)
            continue;
        const ids = [];
        if (entry.model !== undefined) {
            ids.push(entry.model);
        }
        else {
            const models = await catalog.listModels(entry.provider);
            ids.push(...models.map(model => model.id));
        }
        for (const id of ids) {
            const until = banned.get(routeKey({ provider: entry.provider, model: id }));
            if (until !== undefined && until > now)
                continue;
            const info = await catalog.resolveModelInfo(entry.provider, id);
            const price = priceOf(run.prices, entry.provider, id);
            const projected = price === undefined || (price.input === undefined && price.output === undefined)
                ? undefined
                : (inputTokens * (price.input ?? 0) + run.settings.estimatedOutputTokens * (price.output ?? 0)) / 1_000_000;
            // Floor F4: a disclosed allowance that cannot cover this very request
            // would switch again immediately — exclude the route up front.
            if (projected !== undefined) {
                const check = await run.checkQuota(entry.provider, id, run.signal);
                if (check?.remaining !== undefined && check.remaining < projected)
                    continue;
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
            });
        }
    }
    if (candidates.length === 0)
        return undefined;
    const selection = selectByStrategy(candidates, run.settings, inputTokens, primary.modalities, opts.allowUnknownCapacity);
    if (selection === undefined)
        return undefined;
    const candidate = selection.candidate;
    return {
        route: {
            provider: candidate.provider,
            model: candidate.model,
            ...candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort },
        },
        cursor: { reselectFrom: candidate.chainIndex },
        mode: selection.mode,
        ...selection.score === undefined ? {} : { score: selection.score },
    };
}
/** Build the quota engine over the resolved precedence chain: static table,
 * pluggable providers, declarative queryers, then the built-in DeepSeek source.
 * Any interrogation failure resolves to `undefined` (unobservable) and never
 * blocks a request, but is counted and logged as a probe failure. */
function createQuotaEngine(ctx, quota) {
    const quotaCache = new Map();
    const quotaInFlight = new Map();
    const quotaCacheMs = quota?.cacheMs ?? 30_000;
    const log = ctx.logger('llm-fallback');
    const resolveApiKey = async (ref) => {
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(credentialRef(ref));
            if (hit !== undefined)
                return hit.value;
        }
        const ambient = process.env[ref];
        return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
    };
    const checkQuota = async (provider, model, signal, force = false) => {
        const staticEntry = quota?.static?.[provider];
        if (staticEntry !== undefined)
            return staticEntry;
        // A forced check (e.g. right after the user switches models) bypasses the
        // TTL cache and any in-flight dedup so the new route is interrogated fresh;
        // its result is still written back to the cache for later reads.
        if (!force) {
            const cached = quotaCache.get(provider);
            if (cached !== undefined && Date.now() - cached.at < quotaCacheMs)
                return cached.check;
            const pending = quotaInFlight.get(provider);
            if (pending !== undefined)
                return pending;
        }
        const task = (async () => {
            let probeFailures = 0;
            const probe = (attempt) => attempt.catch(() => { probeFailures += 1; return undefined; });
            for (const source of quota?.providers ?? []) {
                const result = await probe(source.check(provider, model, signal));
                if (result !== undefined)
                    return result;
            }
            const queryer = quota?.queryers?.[provider];
            if (queryer !== undefined) {
                const result = await probe((async () => {
                    const key = await resolveApiKey(queryer.apiKeyEnv ?? '');
                    return queryBalanceEndpoint(queryer.endpoint, key ?? '', signal);
                })());
                if (result !== undefined)
                    return result;
            }
            const deepseek = quota?.deepseek;
            if (deepseek !== undefined && provider === (deepseek.provider ?? 'deepseek-official')) {
                const result = await probe((async () => {
                    const key = await resolveApiKey(deepseek.apiKeyEnv ?? 'DEEPSEEK_API_KEY');
                    if (key === undefined)
                        return undefined;
                    return queryBalanceEndpoint(`${deepseek.baseURL ?? 'https://api.deepseek.com'}/user/balance`, key, signal);
                })());
                if (result !== undefined)
                    return result;
            }
            // Distinguish "probe failed" from "genuinely unobservable": a failed
            // interrogation is a transient fault, not an absent source.
            if (probeFailures > 0) {
                log.warn(`quota probe failed for provider "${provider}" (${probeFailures} source(s) threw); treating as unobservable`);
            }
            return undefined;
        })();
        quotaInFlight.set(provider, task);
        try {
            const result = await task;
            quotaCache.set(provider, { check: result, at: Date.now() });
            return result;
        }
        finally {
            quotaInFlight.delete(provider);
        }
    };
    return {
        checkQuota,
        clearAll: () => {
            quotaCache.clear();
            quotaInFlight.clear();
        },
    };
}
/** Build the agent tracker and register its stats/reset faces plus the
 * `agent/disposed` strong-reference cleanup on the given context. */
function createAgentTracker(ctx, clearQuota) {
    const states = new WeakMap();
    const sessionAgents = new WeakMap();
    const knownAgents = new Set();
    const stats = () => {
        let steps = 0;
        for (const agent of knownAgents) {
            const agentState = states.get(agent);
            if (agentState !== undefined)
                steps += agentState.steps.size;
        }
        return { agents: knownAgents.size, steps };
    };
    fallbackStatsRegistry.set(ctx, stats);
    // Drop a disposed agent's strong reference so the set tracks live agents only
    // (WeakMap already lets `states`/`sessionAgents` GC; `knownAgents` is iterated
    // by reset/poll, so it must be pruned explicitly on registry removal).
    ctx.on('agent/disposed', (payload) => {
        knownAgents.delete(payload.agent);
    }, { global: true });
    const reset = () => {
        let clearedBans = 0;
        let clearedFailures = 0;
        let clearedSteps = 0;
        for (const agent of [...knownAgents]) {
            const agentState = states.get(agent);
            if (agentState === undefined)
                continue;
            clearedBans += agentState.bannedUntil.size;
            clearedFailures += agentState.failedRoutes.size;
            clearedSteps += agentState.steps.size;
            agentState.bannedUntil.clear();
            agentState.failedRoutes.clear();
            agentState.steps.clear();
            agentState.healthyRoute = undefined;
            agentState.switchedKeys.clear();
        }
        // Also drop cached/in-flight allowances so the next request re-interrogates.
        clearQuota();
        return {
            resetAgents: knownAgents.size,
            clearedBans,
            clearedFailures,
            clearedSteps,
        };
    };
    resetRegistry.set(ctx, reset);
    const stateFor = (agent) => {
        let state = states.get(agent);
        if (state === undefined) {
            state = { steps: new Map(), healthyRoute: undefined, switchedKeys: new Set(), bannedUntil: new Map(), failedRoutes: new Set(), lastTurn: undefined, primaryRoute: undefined };
            states.set(agent, state);
        }
        return state;
    };
    const stepFor = (agent, turn, step) => {
        const state = stateFor(agent);
        const key = stepKey(turn, step);
        let stepState = state.steps.get(key);
        if (stepState === undefined) {
            stepState = {
                attempts: 0,
                primary: undefined,
                lastRoute: { provider: '', model: '' },
                chainCursor: 0,
                pendingRoute: undefined,
                strategyFailures: 0,
                selectedMode: undefined,
            };
            state.steps.set(key, stepState);
        }
        return stepState;
    };
    return { states, sessionAgents, knownAgents, stats, reset, stateFor, stepFor };
}
/**
 * Install automatic model fallback.
 * @param ctx - plugin context.
 * @param config - fallback chain and policy.
 */
export function apply(ctx, config = { fallbacks: [] }) {
    const chain = config.fallbacks ?? [];
    const seenRoutes = new Set();
    for (const entry of chain) {
        if (entry.provider === '' || (entry.model !== undefined && entry.model === '')) {
            throw new Error('llm-fallback: fallback route provider/model must not be empty');
        }
        const key = routeKey({ provider: entry.provider, model: entry.model ?? '' });
        if (seenRoutes.has(key)) {
            throw new Error('llm-fallback: duplicate fallback route ' + entry.provider + '/' + (entry.model ?? '*'));
        }
        seenRoutes.add(key);
    }
    const codes = new Set(config.codes ?? DEFAULT_FALLBACK_CODES);
    const unusableCodes = new Set(config.unusableCodes ?? DEFAULT_UNUSABLE_CODES);
    const cooldownMs = config.cooldownMs ?? 60_000;
    const quota = config.quota;
    const engine = createQuotaEngine(ctx, quota);
    const { checkQuota } = engine;
    const catalog = createCatalogCache(ctx);
    const opts = {
        allowDegrade: config.allowDegrade ?? false,
        allowUnknownCapacity: config.allowUnknownCapacity ?? false,
        preference: config.preference ?? 'closest',
    };
    const strategyConfig = config.strategy;
    if (strategyConfig !== undefined) {
        for (const axis of strategyConfig.performance?.axes ?? []) {
            if (axis !== 'reasoning' && axis !== 'context' && axis !== 'output') {
                throw new Error(`llm-fallback: unknown strategy axis "${String(axis)}"`);
            }
        }
    }
    const strategySettings = strategyConfig === undefined || strategyConfig.mode === 'closest' ? undefined : {
        mode: strategyConfig.mode,
        marginTokens: strategyConfig.floor?.marginTokens ?? 8192,
        estimatedOutputTokens: quota?.estimatedOutputTokens ?? 1024,
        futureSteps: strategyConfig.cost?.futureSteps ?? 1,
        sessionFailurePenalty: strategyConfig.cost?.sessionFailurePenalty ?? 2,
        cliffPenalty: strategyConfig.cost?.cliffPenalty ?? 1.5,
        axes: strategyConfig.performance?.axes ?? ['reasoning', 'context', 'output'],
        significantRatio: strategyConfig.performance?.significantRatio ?? 1.5,
    };
    const escalationAfter = strategyConfig?.escalation?.afterFailures ?? 2;
    /** The strategy run for one selection: possibly an escalated mode. */
    const strategyRun = (mode, session, failedRoutes, checkQuota, signal) => mode === undefined || strategySettings === undefined ? undefined : {
        mode,
        settings: { ...strategySettings, mode },
        session,
        prices: quota?.prices,
        failedRoutes,
        checkQuota,
        signal,
    };
    const tracker = createAgentTracker(ctx, engine.clearAll);
    const { states, sessionAgents, knownAgents, stateFor, stepFor } = tracker;
    // Escape-hatch tool: an agent can restore every configured model's usability
    // in one call by discarding all of the plugin's routing decisions.
    const tools = ctx.get('tools');
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
                render: (_args, value) => [{
                        type: 'text',
                        text: `Reset ${value.resetAgents} agent(s): removed ${value.clearedBans} ban(s), ${value.clearedFailures} failure-risk route(s), ${value.clearedSteps} step state(s).`,
                    }],
            },
            execute: async (args) => {
                if (args !== null && typeof args === 'object' && args.confirm !== true) {
                    throw new Error('llm-fallback-reset requires confirm: true');
                }
                return resetRegistry.get(ctx)?.() ?? { resetAgents: 0, clearedBans: 0, clearedFailures: 0, clearedSteps: 0 };
            },
        });
        ctx.effect(() => disposeTool, 'llm-fallback: reset tool');
    }
    // Mouse-independent escape hatch: a `/llm-fallback:reset` command any
    // surface (the status-bar button) can invoke via `session.command(...)`.
    // The handler clears every route decision for the whole plugin instance and
    // reports a plain summary text; registration is optional so the plugin
    // keeps working even when the commands registry is not mounted.
    const commands = ctx.get('commands');
    if (commands !== undefined) {
        const disposeCommand = commands.register({
            name: 'llm-fallback-reset',
            description: 'Restore every configured model\'s usability \u2014 clear all fallback bans, the session-healthy route, risk scores, and step state.',
            handler: () => {
                const summary = resetRegistry.get(ctx)?.() ?? { resetAgents: 0, clearedBans: 0, clearedFailures: 0, clearedSteps: 0 };
                return { kind: 'success', text: `Restored ${summary.resetAgents} agent(s): cleared ${summary.clearedBans} ban(s), ${summary.clearedFailures} risk route(s), ${summary.clearedSteps} step state(s).` };
            },
        });
        ctx.effect(() => disposeCommand, 'llm-fallback: reset command');
    }
    // Outermost listener (registered before per-agent model selection): snapshot
    // the primary route, record the issued route, and rewrite it when a recovery
    // has resolved a fallback route.
    ctx.on('agent/request', async (payload, next) => {
        const { agent, turn, step, signal } = payload;
        const agentState = stateFor(agent);
        if (agentState.lastTurn !== undefined && agentState.lastTurn !== turn) {
            const retired = `${agentState.lastTurn}/`;
            for (const key of [...agentState.steps.keys()]) {
                if (key.startsWith(retired)) {
                    agentState.steps.delete(key);
                }
            }
        }
        agentState.lastTurn = turn;
        sessionAgents.set(agent.session, agent);
        const state = stepFor(agent, turn, step);
        state.attempts += 1;
        const resolved = await next();
        const previousPrimary = agentState.primaryRoute;
        const isFreshPrimary = state.primary === undefined;
        if (isFreshPrimary) {
            state.primary = { provider: resolved.provider, model: resolved.model };
            agentState.primaryRoute = { provider: resolved.provider, model: resolved.model };
        }
        // A fresh primary that differs from the previous step's is a user-initiated
        // model switch (the plugin never rewrites primaryRoute to a fallback, so a
        // change here reflects the user's own selection change).
        const userSwitched = isFreshPrimary && previousPrimary !== undefined
            && (previousPrimary.provider !== resolved.provider || previousPrimary.model !== resolved.model);
        knownAgents.add(agent);
        const pending = state.pendingRoute;
        state.pendingRoute = undefined;
        if (pending !== undefined) {
            const replaced = withRoute(resolved, pending);
            state.lastRoute = { provider: replaced.provider, model: replaced.model };
            return replaced;
        }
        // Respect a user's explicit model switch: don't force the request back to
        // the session's healthy fallback route — the new model gets its own fresh
        // quota re-check below instead of silently being overridden.
        const healthy = agentState.healthyRoute;
        if (!userSwitched && healthy !== undefined && (healthy.provider !== resolved.provider || healthy.model !== resolved.model)) {
            const redirected = withRoute(resolved, healthy);
            state.lastRoute = { provider: redirected.provider, model: redirected.model };
            return redirected;
        }
        // Preemptive switch when the resolved route's allowance trips a threshold
        // or cannot cover the projected cost of this request. A user-switched model
        // is interrogated fresh (force=true) to notice an underfunded selection
        // rather than trusting a stale cached allowance.
        const quotaCheck = await checkQuota(resolved.provider, resolved.model, signal, userSwitched);
        const trip = quotaCheck === undefined ? { below: false } : belowThreshold(quotaCheck, quota);
        const projected = estimateCost(quota, resolved.provider, resolved.model, agent.session);
        const costTrip = projected !== undefined
            && quotaCheck?.remaining !== undefined
            && quotaCheck.remaining < projected.cost;
        if (trip.below || costTrip) {
            const primaryCapability = await capabilityOf(catalog, resolved);
            const result = await selectNext(catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(), strategyRun(strategySettings?.mode, agent.session, agentState.failedRoutes, checkQuota, signal));
            if (result !== undefined) {
                agentState.switchedKeys.add(routeKey(result.route));
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
                    reason: trip.below ? 'below-threshold' : 'insufficient-cost',
                    ...result.mode === undefined ? {} : { mode: result.mode },
                });
                state.lastRoute = { provider: result.route.provider, model: result.route.model };
                state.chainCursor = cursorIndexOf(result.cursor);
                return withRoute(resolved, result.route);
            }
        }
        else if (userSwitched && quotaCheck?.remaining === undefined) {
            // The user picked a model whose allowance is unobservable (no fresh quota
            // disclosed). Honor the selection and let this very request act as the
            // probe: a failure will ban + fall back, and a warning surfaces that the
            // model was probed with the request itself.
            agent.session.append('llm/quota-warning', {
                turn,
                step,
                provider: resolved.provider,
                model: resolved.model,
                reason: 'unobservable',
            });
            state.lastRoute = { provider: resolved.provider, model: resolved.model };
            return resolved;
        }
        state.lastRoute = { provider: resolved.provider, model: resolved.model };
        return resolved;
    });
    // On an eligible failure, resolve the next fallback route (skipping providers
    // with no matching model) and ask the loop to re-derive the request with the
    // same turn/step (preserving the conversation so far).
    ctx.on('agent/request-error', async (payload, next) => {
        const { agent, turn, step, failure, signal } = payload;
        if (signal.aborted)
            return next();
        const eligible = codes.has(failure.code);
        const unusable = unusableCodes.has(failure.code);
        if (!eligible && !unusable)
            return next();
        const state = stepFor(agent, turn, step);
        const primary = state.primary;
        if (primary === undefined)
            return next();
        const agentState = stateFor(agent);
        const from = state.lastRoute;
        if (eligible) {
            agentState.bannedUntil.set(routeKey(from), banUntil(from.provider, cooldownMs, quota, Date.now()));
            agentState.failedRoutes.add(routeKey(from));
        }
        // Escalation ladder: cost-mode candidate failures escalate this step to
        // performance mode — task completion outranks the cost preference.
        if (eligible && state.selectedMode === 'cost')
            state.strategyFailures += 1;
        const effectiveMode = strategySettings === undefined
            ? undefined
            : strategySettings.mode === 'cost' && state.strategyFailures >= escalationAfter
                ? 'performance'
                : strategySettings.mode;
        const primaryCapability = await capabilityOf(catalog, primary);
        const result = await selectNext(catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(), strategyRun(effectiveMode, agent.session, agentState.failedRoutes, checkQuota, signal));
        if (result === undefined)
            return next();
        agentState.switchedKeys.add(routeKey(result.route));
        state.pendingRoute = result.route;
        state.chainCursor = cursorIndexOf(result.cursor);
        state.selectedMode = result.mode;
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
        });
        return { kind: 'retry' };
    });
    // Poll the primary route's allowance so a recovered allowance clears the
    // session-wide healthy cache in time for the next request.
    if (config.pollIntervalMs !== undefined && config.pollIntervalMs > 0) {
        const pollAbort = new AbortController();
        const timer = setInterval(async () => {
            for (const agent of knownAgents) {
                const agentState = states.get(agent);
                if (agentState === undefined || agentState.healthyRoute === undefined)
                    continue;
                const primary = agentState.primaryRoute;
                if (primary === undefined)
                    continue;
                const check = await checkQuota(primary.provider, primary.model, pollAbort.signal);
                if (check === undefined)
                    continue;
                if (!belowThreshold(check, quota).below)
                    agentState.healthyRoute = undefined;
            }
        }, config.pollIntervalMs);
        ctx.effect(() => () => {
            clearInterval(timer);
            pollAbort.abort();
        }, 'llm-fallback: stop quota polling');
    }
    // Promote a fallback switch to the session-wide healthy cache once the
    // switched route completes a model message successfully.
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
        if (eventName !== 'session/event')
            return;
        const [session, event] = args;
        if (event.type !== 'assistant/message')
            return;
        const agent = sessionAgents.get(session);
        if (agent === undefined)
            return;
        const agentState = states.get(agent);
        if (agentState === undefined)
            return;
        const source = event.data.message.source;
        if (agentState.switchedKeys.has(routeKey(source))) {
            agentState.healthyRoute = { provider: source.provider, model: source.model };
        }
    }, { global: true });
}
//# sourceMappingURL=index.js.map