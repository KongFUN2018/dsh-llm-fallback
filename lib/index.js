import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
//#region lib/types/strategy.js
/**
* Resolve a route's unit price with two-level fallback: the exact
* `provider/model` key first, then the bare provider key.
* @param prices - configured price table.
* @param provider - route provider.
* @param model - route model id.
* @returns the price entry, or undefined when unpriced.
*/
function priceOf(prices, provider, model) {
	const exact = prices?.[`${provider}/${model}`];
	if (exact !== void 0) return exact;
	return prices?.[provider];
}
/**
* The dynamic task-completion floor: current context usage plus margin.
* @param inputTokens - estimated tokens of the current request.
* @param marginTokens - reserved headroom for the step's output.
* @returns the minimum acceptable context window.
*/
function buildFloor(inputTokens, marginTokens) {
	return Math.max(1, inputTokens) + marginTokens;
}
/**
* Whether one candidate clears the hard floor: modality coverage plus a
* dynamically-sized context window. Unknown windows fail the floor unless
* explicitly allowed (they cannot be verified, and the strategy path
* demands verifiability); with `allowUnknownCapacity` set they are kept but
* ranked strictly below every floor-passing candidate with a known window
* (see {@link selectByStrategy}).
* @param candidate - expanded candidate.
* @param floor - minimum acceptable context window.
* @param requiredModalities - modalities the primary route required.
* @param allowUnknownCapacity - accept candidates with unknown windows.
* @returns whether the candidate may be scored at all.
*/
function passesFloor(candidate, floor, requiredModalities, allowUnknownCapacity) {
	if (requiredModalities !== void 0 && requiredModalities.length > 0) {
		const covered = candidate.modalities;
		if (covered === void 0 || !requiredModalities.every((modality) => covered.includes(modality))) return false;
	}
	const window = candidate.contextWindow;
	if (window === void 0) return allowUnknownCapacity;
	return window >= floor;
}
/**
* The cost-mode score: projected request cost times session-learned risk.
* Unpriced candidates have no score — they are uncomparable and rank last.
* @param candidate - floor-passing candidate.
* @param inputTokens - estimated tokens of the current request.
* @param floor - the computed task-completion floor.
* @param settings - resolved strategy settings.
* @param sessionFailed - whether this exact route already failed this session.
* @returns the risk-adjusted expected cost, or undefined when unpriced.
*/
function costScore(candidate, inputTokens, floor, settings) {
	if (candidate.inputPrice === void 0 && candidate.outputPrice === void 0) return void 0;
	const inputPrice = candidate.inputPrice ?? 0;
	const outputPrice = candidate.outputPrice ?? 0;
	const base = (inputTokens * inputPrice + settings.estimatedOutputTokens * outputPrice) / 1e6 * settings.futureSteps;
	let risk = 1;
	if (candidate.sessionFailed === true) risk *= settings.sessionFailurePenalty;
	if (candidate.contextWindow !== void 0 && candidate.contextWindow < floor + settings.marginTokens / 2) risk *= settings.cliffPenalty;
	return base * risk;
}
/**
* Compare two floor-passing candidates by the performance-mode lexicographic
* order: each axis decides only on a significant difference, undecided axes
* fall through, and full ties resolve by chain position then id.
* @param a - left candidate.
* @param b - right candidate.
* @param settings - resolved strategy settings.
* @returns negative when a ranks stronger, positive when b does.
*/
function comparePerformance(a, b, settings) {
	const ratio = settings.significantRatio;
	for (const axis of settings.axes) if (axis === "reasoning") {
		const stronger = Number(b.hasReasoning ?? false) - Number(a.hasReasoning ?? false);
		if (stronger !== 0) return stronger;
	} else if (axis === "context") {
		if (a.contextWindow !== void 0 && b.contextWindow !== void 0) {
			if (a.contextWindow >= b.contextWindow * ratio) return -1;
			if (b.contextWindow >= a.contextWindow * ratio) return 1;
		}
	} else if (axis === "output") {
		if (a.maxTokens !== void 0 && b.maxTokens !== void 0) {
			if (a.maxTokens >= b.maxTokens * ratio) return -1;
			if (b.maxTokens >= a.maxTokens * ratio) return 1;
		}
	}
	return a.chainIndex - b.chainIndex || a.model.localeCompare(b.model);
}
/**
* Order two candidates under cost mode: lower risk-adjusted cost first;
* unpriced candidates rank after every priced one; ties resolve by chain
* position then id.
*/
function compareCost(a, aScore, b, bScore) {
	if (aScore === void 0 && bScore === void 0) return a.chainIndex - b.chainIndex || a.model.localeCompare(b.model);
	if (aScore === void 0) return 1;
	if (bScore === void 0) return -1;
	return aScore - bScore || a.chainIndex - b.chainIndex || a.model.localeCompare(b.model);
}
/**
* Select the switch target among expanded candidates under the active mode:
* floor first, then the mode's soft objective, then deterministic tie-breaks.
* Unknown-window candidates (when `allowUnknownCapacity`) are tiered strictly
* below every known-window candidate that clears the floor: they are only
* reached when no floor-passing candidate has a known window, and are then
* settled by chain position, then id (docs/strategy-design.md §四 F2).
* @param candidates - every expanded, ban-filtered candidate.
* @param settings - resolved strategy settings.
* @param inputTokens - estimated tokens of the current request.
* @param requiredModalities - modalities the primary route required.
* @param allowUnknownCapacity - accept candidates with unknown windows.
* @returns the winning candidate with its mode's score, or undefined when
*   no candidate clears the floor.
*/
function selectByStrategy(candidates, settings, inputTokens, requiredModalities, allowUnknownCapacity) {
	const floor = buildFloor(inputTokens, settings.marginTokens);
	const known = [];
	const unknown = [];
	for (const candidate of candidates) {
		if (!passesFloor(candidate, floor, requiredModalities, allowUnknownCapacity)) continue;
		if (candidate.contextWindow === void 0) unknown.push(candidate);
		else known.push(candidate);
	}
	const pool = known.length > 0 ? known : unknown;
	if (pool.length === 0) return void 0;
	if (known.length === 0) return {
		candidate: [...pool].sort((a, b) => a.chainIndex - b.chainIndex || a.model.localeCompare(b.model))[0],
		mode: settings.mode
	};
	if (settings.mode === "performance") {
		let best = pool[0];
		for (const candidate of pool.slice(1)) if (comparePerformance(candidate, best, settings) < 0) best = candidate;
		return {
			candidate: best,
			mode: settings.mode
		};
	}
	const scored = pool.map((candidate) => ({
		candidate,
		score: costScore(candidate, inputTokens, floor, settings)
	}));
	scored.sort((left, right) => compareCost(left.candidate, left.score, right.candidate, right.score));
	const winner = scored[0];
	return {
		candidate: winner.candidate,
		mode: settings.mode,
		...winner.score !== void 0 ? { score: winner.score } : {}
	};
}
//#endregion
//#region lib/types/index.js
/**
* Automatic cross-provider model fallback on the agent loop's request
* recovery and request-routing extension points.
*
* @module @kongfun2018/dsh-llm-fallback
*/
const name = "llm-fallback";
const inject = ["agents", "llm"];
/** Per-apply stats handles, keyed by the plugin context (test/diagnostics seam). */
const fallbackStatsRegistry = /* @__PURE__ */ new WeakMap();
/** Read a live plugin instance's step-state statistics, if installed. */
function getFallbackStats(ctx) {
	return fallbackStatsRegistry.get(ctx)?.();
}
/** Per-apply reset handles, keyed by the plugin context. */
const resetRegistry = /* @__PURE__ */ new WeakMap();
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
function resetFallback(ctx) {
	return resetRegistry.get(ctx)?.();
}
/** Failure codes that trigger a switch; transient + exhausted-account codes. */
const DEFAULT_FALLBACK_CODES = Object.freeze([
	"QUOTA",
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT",
	"EMPTY_RESPONSE"
]);
/** Structural "candidate unusable" codes: advance the chain without banning. */
const DEFAULT_UNUSABLE_CODES = Object.freeze([
	"NO_ADAPTER",
	"UNSUPPORTED_REASONING_EFFORT",
	"INVALID_MODEL_INFO",
	"INVALID_MODEL_CONTEXT",
	"INVALID_MODEL_MAX_TOKENS",
	"INVALID_MODEL_REASONING"
]);
const Config = z.object({
	fallbacks: z.array(z.object({
		provider: z.string().min(1).required(),
		model: z.string().min(1),
		reasoningEffort: z.string().min(1)
	})).required(),
	codes: z.array(z.string().min(1)),
	unusableCodes: z.array(z.string().min(1)),
	cooldownMs: z.number().min(0).default(6e4),
	pollIntervalMs: z.number().min(1),
	allowDegrade: z.boolean().default(false),
	allowUnknownCapacity: z.boolean().default(false),
	preference: z.union([
		"closest",
		"price",
		"speed",
		"reasoning"
	]).default("closest"),
	strategy: z.object({
		mode: z.union([
			"cost",
			"performance",
			"closest"
		]).required(),
		floor: z.object({ marginTokens: z.number().min(1).default(8192) }),
		cost: z.object({
			futureSteps: z.number().min(1).default(1),
			sessionFailurePenalty: z.number().min(1).default(2),
			cliffPenalty: z.number().min(1).default(1.5)
		}),
		performance: z.object({
			axes: z.array(z.union([
				"reasoning",
				"context",
				"output"
			])),
			significantRatio: z.number().min(1).default(1.5)
		}),
		escalation: z.object({ afterFailures: z.number().min(1).default(2) })
	}),
	quota: z.object({
		thresholdAbsolute: z.number().min(0),
		thresholdRatio: z.number().min(0).max(1),
		static: z.dict(z.object({
			kind: z.union(["balance", "quota"]).required(),
			remaining: z.number().min(0).required(),
			total: z.number().min(0),
			resetAt: z.number()
		})),
		providers: z.array(z.any()),
		cacheMs: z.number().min(0),
		queryers: z.dict(z.object({
			endpoint: z.string().min(1).required(),
			apiKeyEnv: z.string().min(1)
		})),
		deepseek: z.object({
			provider: z.string().min(1),
			apiKeyEnv: z.string().min(1),
			baseURL: z.string().min(1)
		}),
		prices: z.dict(z.object({
			input: z.number().min(0),
			output: z.number().min(0)
		})),
		estimatedOutputTokens: z.number().min(1)
	})
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
		...route.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }
	};
}
/** Whether candidate modalities cover every required modality. */
function covers(candidate, required) {
	if (candidate === void 0) return false;
	return required.every((modality) => candidate.includes(modality));
}
/**
* Choose one model id from a provider's resolved candidates by rule:
* modality coverage, then capacity non-degradation, then closeness, then cost.
*/
function matchModel(primary, candidates, opts) {
	const required = primary.modalities;
	let pool = candidates;
	if (required !== void 0 && required.length > 0) pool = pool.filter((candidate) => covers(candidate.capability.modalities, required));
	if (pool.length === 0) return void 0;
	const target = primary.contextWindow;
	const nonDegrading = [];
	const degrading = [];
	const unknown = [];
	for (const candidate of pool) {
		const window = candidate.capability.contextWindow;
		if (window === void 0) unknown.push(candidate);
		else if (target === void 0 || window >= target) nonDegrading.push(candidate);
		else degrading.push(candidate);
	}
	let group;
	group = nonDegrading.length > 0 ? nonDegrading : opts.allowDegrade ? degrading : opts.allowUnknownCapacity ? unknown : [];
	if (group.length === 0) return void 0;
	if (opts.preference !== "closest" || target !== void 0) group = [...group].sort((a, b) => compareCandidates(a, b, target, opts.preference));
	return group[0]?.id;
}
/** Order two capability-matched candidates by the configured tie-break preference. */
function compareCandidates(a, b, target, preference) {
	const windowOf = (c) => c.capability.contextWindow ?? Number.POSITIVE_INFINITY;
	const maxTokensOf = (c) => c.maxTokens ?? Number.POSITIVE_INFINITY;
	const closenessOf = (c) => target === void 0 ? 0 : Math.abs(windowOf(c) - target);
	switch (preference) {
		case "price": return windowOf(a) - windowOf(b) || closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id);
		case "speed": return maxTokensOf(a) - maxTokensOf(b) || closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id);
		case "reasoning": return Number(b.hasReasoning ?? false) - Number(a.hasReasoning ?? false) || closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id);
		default: return closenessOf(a) - closenessOf(b) || a.id.localeCompare(b.id);
	}
}
/** How long a provider's catalog (model list + per-model info) stays cached;
* catalogs change at provider pace, not request pace. */
const CATALOG_CACHE_TTL_MS = 6e4;
function createCatalogCache(ctx) {
	const modelsCache = /* @__PURE__ */ new Map();
	const infoCache = /* @__PURE__ */ new Map();
	const listModels = (provider) => {
		const hit = modelsCache.get(provider);
		if (hit !== void 0 && Date.now() - hit.at < CATALOG_CACHE_TTL_MS) return Promise.resolve(hit.models);
		return ctx.llm.listModels(provider).then((models) => {
			modelsCache.set(provider, {
				at: Date.now(),
				models
			});
			return models;
		});
	};
	const resolveModelInfo = (provider, model) => {
		const hit = infoCache.get(routeKey({
			provider,
			model
		}));
		if (hit !== void 0 && Date.now() - hit.at < CATALOG_CACHE_TTL_MS) return Promise.resolve(hit.info);
		return ctx.llm.resolveModelInfo(provider, model).then((info) => {
			infoCache.set(routeKey({
				provider,
				model
			}), {
				at: Date.now(),
				info
			});
			return info;
		});
	};
	return {
		listModels,
		resolveModelInfo
	};
}
/** Resolve one exact route's capability signals; a resolve failure degrades to
* an empty capability (unknown window/modalities) rather than blocking the
* request — consistent with the plugin's "never block" philosophy. */
async function capabilityOf(catalog, route) {
	const info = await catalog.resolveModelInfo(route.provider, route.model).catch(() => void 0);
	return {
		...info === void 0 || info.context === void 0 ? {} : { contextWindow: info.context.contextWindow },
		...info === void 0 || info.inputModalities === void 0 ? {} : { modalities: info.inputModalities }
	};
}
/** Rough input-token estimate from the serialized message history (chars / 4).
* Cached per session: the message list only grows within a turn, so we track
* the message count and re-serialize only when it changes. */
const tokenEstimateCache = /* @__PURE__ */ new WeakMap();
function estimateInputTokens(session) {
	const messages = session.deriveMessages();
	const cached = tokenEstimateCache.get(session);
	if (cached !== void 0 && cached.count === messages.length) return cached.tokens;
	const serialized = JSON.stringify(messages);
	const tokens = Math.max(1, Math.ceil(serialized.length / 4));
	tokenEstimateCache.set(session, {
		count: messages.length,
		tokens
	});
	return tokens;
}
/** Projected cost in the provider's unit, when a price is configured for the route. */
function estimateCost(quota, provider, model, session) {
	const price = priceOf(quota?.prices, provider, model);
	if (price === void 0 || price.input === void 0 && price.output === void 0) return void 0;
	const inputPrice = price.input ?? 0;
	const outputPrice = price.output ?? 0;
	const inputTokens = estimateInputTokens(session);
	const outputTokens = quota?.estimatedOutputTokens ?? 1024;
	return {
		cost: (inputTokens * inputPrice + outputTokens * outputPrice) / 1e6,
		inputPrice,
		outputPrice
	};
}
/** Fetch one balance endpoint and parse the DeepSeek `/user/balance` shape.
* Throws on transport/HTTP/parse failure (probe failure); returns `undefined`
* only for a well-formed response that discloses no balance (unobservable). */
async function queryBalanceEndpoint(endpoint, apiKey, signal) {
	const response = await fetch(endpoint, {
		method: "GET",
		headers: {
			authorization: `Bearer ${apiKey}`,
			accept: "application/json"
		},
		signal
	});
	if (!response.ok) throw new Error(`balance endpoint ${endpoint} responded ${response.status}`);
	const data = await response.json();
	if (data.is_available === false) return {
		kind: "balance",
		remaining: 0
	};
	const total = data.balance_infos?.[0]?.total_balance === void 0 ? void 0 : Number.parseFloat(data.balance_infos[0].total_balance);
	if (total === void 0 || Number.isNaN(total)) return void 0;
	return {
		kind: "balance",
		remaining: total
	};
}
/** Exclude a failed route until, based on its allowance kind. */
function banUntil(provider, cooldownMs, quota, now) {
	const entry = quota?.static?.[provider];
	if (entry?.kind === "balance") return Number.POSITIVE_INFINITY;
	if (entry?.kind === "quota" && entry.resetAt !== void 0) return entry.resetAt;
	return cooldownMs === 0 ? Number.POSITIVE_INFINITY : now + cooldownMs;
}
/** Whether a disclosed remaining allowance trips a configured threshold. */
function belowThreshold(check, quota) {
	if (check.remaining === void 0) return { below: false };
	if (quota?.thresholdAbsolute !== void 0 && check.remaining < quota.thresholdAbsolute) return {
		below: true,
		threshold: quota.thresholdAbsolute,
		thresholdKind: "absolute"
	};
	if (quota?.thresholdRatio !== void 0 && check.total !== void 0 && check.total > 0) {
		if (check.remaining / check.total < quota.thresholdRatio) return {
			below: true,
			threshold: quota.thresholdRatio,
			thresholdKind: "ratio"
		};
	}
	return { below: false };
}
/** Resolve one provider's candidate catalog with per-candidate capability.
* Model info lookups are parallelized (no data dependency between models). */
async function selectModel(catalog, primary, provider, opts) {
	const models = await catalog.listModels(provider);
	const infos = await Promise.all(models.map((model) => catalog.resolveModelInfo(provider, model.id).catch(() => void 0)));
	const candidates = [];
	for (let i = 0; i < models.length; i++) {
		const model = models[i];
		const info = infos[i];
		if (model === void 0) continue;
		candidates.push({
			id: model.id,
			capability: {
				...info === void 0 || info.context === void 0 ? {} : { contextWindow: info.context.contextWindow },
				...info === void 0 || info.inputModalities === void 0 ? {} : { modalities: info.inputModalities }
			},
			...info === void 0 || info.defaultMaxTokens === void 0 ? {} : { maxTokens: info.defaultMaxTokens },
			...info === void 0 || info.reasoning === void 0 ? {} : { hasReasoning: true }
		});
	}
	return matchModel(primary, candidates, opts);
}
/** The numeric chain index a cursor directive leaves the walk at. */
function cursorIndexOf(directive) {
	return "advanceTo" in directive ? directive.advanceTo : directive.reselectFrom;
}
/** Walk the chain from a cursor, resolving each entry to a concrete route. */
async function selectNext(catalog, chain, cursor, primary, opts, banned, now, strategy) {
	if (strategy !== void 0) {
		const strategic = await selectNextByStrategy(catalog, chain, cursor, primary, opts, strategy, banned, now);
		if (strategic !== void 0) return strategic;
	}
	return selectNextByRules(catalog, chain, cursor, primary, opts, banned, now);
}
/** Rule-based lazy walk over the chain. */
async function selectNextByRules(catalog, chain, cursor, primary, opts, banned, now) {
	let index = cursor;
	while (index < chain.length) {
		const entry = chain[index];
		if (entry === void 0) return void 0;
		if (entry.model !== void 0) {
			const until = banned.get(routeKey({
				provider: entry.provider,
				model: entry.model
			}));
			if (until !== void 0 && until > now) {
				index += 1;
				continue;
			}
			return {
				route: {
					provider: entry.provider,
					model: entry.model,
					...entry.reasoningEffort === void 0 ? {} : { reasoningEffort: entry.reasoningEffort }
				},
				cursor: { advanceTo: index + 1 }
			};
		}
		const selected = await selectModel(catalog, primary, entry.provider, opts);
		if (selected !== void 0) {
			const until = banned.get(routeKey({
				provider: entry.provider,
				model: selected
			}));
			if (until !== void 0 && until > now) {
				index += 1;
				continue;
			}
			return {
				route: {
					provider: entry.provider,
					model: selected,
					...entry.reasoningEffort === void 0 ? {} : { reasoningEffort: entry.reasoningEffort }
				},
				cursor: { advanceTo: index + 1 }
			};
		}
		index += 1;
	}
}
/** Strategy path (docs/strategy-design.md): expand the whole chain, apply the
* hard task-completion floor, then score globally under the active mode. */
async function selectNextByStrategy(catalog, chain, cursor, primary, opts, run, banned, now) {
	const inputTokens = estimateInputTokens(run.session);
	const candidates = [];
	for (let index = cursor; index < chain.length; index++) {
		const entry = chain[index];
		if (entry === void 0) continue;
		const ids = [];
		if (entry.model !== void 0) ids.push(entry.model);
		else {
			const models = await catalog.listModels(entry.provider);
			ids.push(...models.map((model) => model.id));
		}
		const infos = await Promise.all(ids.map((id) => catalog.resolveModelInfo(entry.provider, id).catch(() => void 0)));
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			if (id === void 0) continue;
			const until = banned.get(routeKey({
				provider: entry.provider,
				model: id
			}));
			if (until !== void 0 && until > now) continue;
			const info = infos[i];
			const price = priceOf(run.prices, entry.provider, id);
			const projected = price === void 0 || price.input === void 0 && price.output === void 0 ? void 0 : (inputTokens * (price.input ?? 0) + run.settings.estimatedOutputTokens * (price.output ?? 0)) / 1e6;
			if (projected !== void 0) {
				const check = await run.checkQuota(entry.provider, id, run.signal);
				if (check?.remaining !== void 0 && check.remaining < projected) continue;
			}
			candidates.push({
				provider: entry.provider,
				model: id,
				chainIndex: index,
				...entry.reasoningEffort === void 0 ? {} : { reasoningEffort: entry.reasoningEffort },
				...info === void 0 || info.context === void 0 ? {} : { contextWindow: info.context.contextWindow },
				...info === void 0 || info.inputModalities === void 0 ? {} : { modalities: info.inputModalities },
				...info === void 0 || info.defaultMaxTokens === void 0 ? {} : { maxTokens: info.defaultMaxTokens },
				...info === void 0 || info.reasoning === void 0 ? {} : { hasReasoning: true },
				...price?.input === void 0 ? {} : { inputPrice: price.input },
				...price?.output === void 0 ? {} : { outputPrice: price.output },
				...run.failedRoutes.has(routeKey({
					provider: entry.provider,
					model: id
				})) ? { sessionFailed: true } : {}
			});
		}
	}
	if (candidates.length === 0) return void 0;
	const selection = selectByStrategy(candidates, run.settings, inputTokens, primary.modalities, opts.allowUnknownCapacity);
	if (selection === void 0) return void 0;
	const candidate = selection.candidate;
	return {
		route: {
			provider: candidate.provider,
			model: candidate.model,
			...candidate.reasoningEffort === void 0 ? {} : { reasoningEffort: candidate.reasoningEffort }
		},
		cursor: { reselectFrom: candidate.chainIndex },
		mode: selection.mode,
		...selection.score === void 0 ? {} : { score: selection.score }
	};
}
/** Build the quota engine over the resolved precedence chain: static table,
* pluggable providers, declarative queryers, then the built-in DeepSeek source.
* Any interrogation failure resolves to `undefined` (unobservable) and never
* blocks a request, but is counted and logged as a probe failure. */
function createQuotaEngine(ctx, quota) {
	const quotaCache = /* @__PURE__ */ new Map();
	const quotaInFlight = /* @__PURE__ */ new Map();
	const quotaCacheMs = quota?.cacheMs ?? 3e4;
	const log = ctx.logger("llm-fallback");
	const resolveApiKey = async (ref) => {
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(credentialRef(ref));
			if (hit !== void 0) return hit.value;
		}
		const ambient = process.env[ref];
		return ambient !== void 0 && ambient.length > 0 ? ambient : void 0;
	};
	const checkQuota = async (provider, model, signal, force = false) => {
		const staticEntry = quota?.static?.[provider];
		if (staticEntry !== void 0) return staticEntry;
		if (!force) {
			const cached = quotaCache.get(provider);
			if (cached !== void 0 && Date.now() - cached.at < quotaCacheMs) return cached.check;
			const pending = quotaInFlight.get(provider);
			if (pending !== void 0) return pending;
		}
		const task = (async () => {
			let probeFailures = 0;
			const probe = (attempt) => attempt.catch(() => {
				probeFailures += 1;
			});
			for (const source of quota?.providers ?? []) {
				const result = await probe(source.check(provider, model, signal));
				if (result !== void 0) return result;
			}
			const queryer = quota?.queryers?.[provider];
			if (queryer !== void 0) {
				const result = await probe((async () => {
					const key = await resolveApiKey(queryer.apiKeyEnv ?? "");
					return queryBalanceEndpoint(queryer.endpoint, key ?? "", signal);
				})());
				if (result !== void 0) return result;
			}
			const deepseek = quota?.deepseek;
			if (deepseek !== void 0 && provider === (deepseek.provider ?? "deepseek-official")) {
				const result = await probe((async () => {
					const key = await resolveApiKey(deepseek.apiKeyEnv ?? "DEEPSEEK_API_KEY");
					if (key === void 0) return void 0;
					return queryBalanceEndpoint(`${deepseek.baseURL ?? "https://api.deepseek.com"}/user/balance`, key, signal);
				})());
				if (result !== void 0) return result;
			}
			if (probeFailures > 0) log.warn(`quota probe failed for provider "${provider}" (${probeFailures} source(s) threw); treating as unobservable`);
		})();
		quotaInFlight.set(provider, task);
		try {
			const result = await task;
			quotaCache.set(provider, {
				check: result,
				at: Date.now()
			});
			return result;
		} finally {
			quotaInFlight.delete(provider);
		}
	};
	return {
		checkQuota,
		clearAll: () => {
			quotaCache.clear();
			quotaInFlight.clear();
		}
	};
}
/** Build the agent tracker and register its stats/reset faces plus the
* `agent/disposed` strong-reference cleanup on the given context. */
function createAgentTracker(ctx, clearQuota) {
	const states = /* @__PURE__ */ new WeakMap();
	const sessionAgents = /* @__PURE__ */ new WeakMap();
	const knownAgents = /* @__PURE__ */ new Set();
	const stats = () => {
		let steps = 0;
		for (const agent of knownAgents) {
			const agentState = states.get(agent);
			if (agentState !== void 0) steps += agentState.steps.size;
		}
		return {
			agents: knownAgents.size,
			steps
		};
	};
	fallbackStatsRegistry.set(ctx, stats);
	ctx.on("agent/disposed", (payload) => {
		knownAgents.delete(payload.agent);
	}, { global: true });
	const reset = () => {
		let clearedBans = 0;
		let clearedFailures = 0;
		let clearedSteps = 0;
		for (const agent of [...knownAgents]) {
			const agentState = states.get(agent);
			if (agentState === void 0) continue;
			clearedBans += agentState.bannedUntil.size;
			clearedFailures += agentState.failedRoutes.size;
			clearedSteps += agentState.steps.size;
			agentState.bannedUntil.clear();
			agentState.failedRoutes.clear();
			agentState.steps.clear();
			agentState.healthyRoute = void 0;
			agentState.switchedKeys.clear();
		}
		clearQuota();
		return {
			resetAgents: knownAgents.size,
			clearedBans,
			clearedFailures,
			clearedSteps
		};
	};
	resetRegistry.set(ctx, reset);
	const stateFor = (agent) => {
		let state = states.get(agent);
		if (state === void 0) {
			state = {
				steps: /* @__PURE__ */ new Map(),
				healthyRoute: void 0,
				switchedKeys: /* @__PURE__ */ new Set(),
				bannedUntil: /* @__PURE__ */ new Map(),
				failedRoutes: /* @__PURE__ */ new Set(),
				lastTurn: void 0,
				primaryRoute: void 0
			};
			states.set(agent, state);
		}
		return state;
	};
	const stepFor = (agent, turn, step) => {
		const state = stateFor(agent);
		const key = stepKey(turn, step);
		let stepState = state.steps.get(key);
		if (stepState === void 0) {
			stepState = {
				attempts: 0,
				primary: void 0,
				lastRoute: {
					provider: "",
					model: ""
				},
				chainCursor: 0,
				pendingRoute: void 0,
				strategyFailures: 0,
				selectedMode: void 0
			};
			state.steps.set(key, stepState);
		}
		return stepState;
	};
	return {
		states,
		sessionAgents,
		knownAgents,
		stats,
		reset,
		stateFor,
		stepFor
	};
}
/**
* Install automatic model fallback.
* @param ctx - plugin context.
* @param config - fallback chain and policy.
*/
function apply(ctx, config = { fallbacks: [] }) {
	const chain = config.fallbacks ?? [];
	const seenRoutes = /* @__PURE__ */ new Set();
	for (const entry of chain) {
		if (entry.provider === "" || entry.model !== void 0 && entry.model === "") throw new Error("llm-fallback: fallback route provider/model must not be empty");
		const key = routeKey({
			provider: entry.provider,
			model: entry.model ?? ""
		});
		if (seenRoutes.has(key)) throw new Error("llm-fallback: duplicate fallback route " + entry.provider + "/" + (entry.model ?? "*"));
		seenRoutes.add(key);
	}
	const codes = new Set(config.codes ?? DEFAULT_FALLBACK_CODES);
	const unusableCodes = new Set(config.unusableCodes ?? DEFAULT_UNUSABLE_CODES);
	const cooldownMs = config.cooldownMs ?? 6e4;
	const quota = config.quota;
	const engine = createQuotaEngine(ctx, quota);
	const { checkQuota } = engine;
	const catalog = createCatalogCache(ctx);
	const opts = {
		allowDegrade: config.allowDegrade ?? false,
		allowUnknownCapacity: config.allowUnknownCapacity ?? false,
		preference: config.preference ?? "closest"
	};
	const strategyConfig = config.strategy;
	if (strategyConfig !== void 0) {
		for (const axis of strategyConfig.performance?.axes ?? []) if (axis !== "reasoning" && axis !== "context" && axis !== "output") throw new Error(`llm-fallback: unknown strategy axis "${String(axis)}"`);
	}
	const strategySettings = strategyConfig === void 0 || strategyConfig.mode === "closest" ? void 0 : {
		mode: strategyConfig.mode,
		marginTokens: strategyConfig.floor?.marginTokens ?? 8192,
		estimatedOutputTokens: quota?.estimatedOutputTokens ?? 1024,
		futureSteps: strategyConfig.cost?.futureSteps ?? 1,
		sessionFailurePenalty: strategyConfig.cost?.sessionFailurePenalty ?? 2,
		cliffPenalty: strategyConfig.cost?.cliffPenalty ?? 1.5,
		axes: strategyConfig.performance?.axes ?? [
			"reasoning",
			"context",
			"output"
		],
		significantRatio: strategyConfig.performance?.significantRatio ?? 1.5
	};
	const escalationAfter = strategyConfig?.escalation?.afterFailures ?? 2;
	/** The strategy run for one selection: possibly an escalated mode. */
	const strategyRun = (mode, session, failedRoutes, checkQuota, signal) => mode === void 0 || strategySettings === void 0 ? void 0 : {
		mode,
		settings: {
			...strategySettings,
			mode
		},
		session,
		prices: quota?.prices,
		failedRoutes,
		checkQuota,
		signal
	};
	const { states, sessionAgents, knownAgents, stateFor, stepFor } = createAgentTracker(ctx, engine.clearAll);
	/** Retire step state for finished turns (turn numbers before `turn`). */
	function retireFinishedTurns(agentState, turn) {
		if (agentState.lastTurn !== void 0 && agentState.lastTurn !== turn) {
			const retired = `${agentState.lastTurn}/`;
			for (const key of [...agentState.steps.keys()]) if (key.startsWith(retired)) agentState.steps.delete(key);
		}
	}
	/** Record the primary route on first request and detect a user model switch.
	* Returns `userSwitched: true` when a fresh primary differs from the previous
	* step's primary (the plugin never rewrites primaryRoute to a fallback, so a
	* change there is the user's own selection). */
	function trackPrimary(agentState, state, resolved) {
		const previousPrimary = agentState.primaryRoute;
		const isFreshPrimary = state.primary === void 0;
		if (isFreshPrimary) {
			state.primary = {
				provider: resolved.provider,
				model: resolved.model
			};
			agentState.primaryRoute = {
				provider: resolved.provider,
				model: resolved.model
			};
		}
		return { userSwitched: isFreshPrimary && previousPrimary !== void 0 && (previousPrimary.provider !== resolved.provider || previousPrimary.model !== resolved.model) };
	}
	const tools = ctx.get("tools");
	if (tools !== void 0) {
		const disposeTool = tools.register({
			name: "llm-fallback-reset",
			description: "Restore every configured model's usability in one call: clear all fallback bans, the session-healthy route, cost-risk scores, and step-level selection state owned by the llm-fallback plugin, so the next request re-decides from the user's model selection and fallback chain. Use this as an escape hatch when the plugin's routing decisions need to be discarded entirely.",
			parameters: {
				type: "object",
				properties: { confirm: {
					type: "boolean",
					description: "Must be true to confirm the reset; require explicit consent to avoid an accidental wipe of routing state."
				} },
				required: ["confirm"]
			},
			output: {
				schema: {
					type: "object",
					properties: {
						resetAgents: {
							type: "number",
							description: "Number of agent states cleared."
						},
						clearedBans: {
							type: "number",
							description: "Number of banned-until entries removed."
						},
						clearedFailures: {
							type: "number",
							description: "Number of session failure-risk routes cleared."
						},
						clearedSteps: {
							type: "number",
							description: "Number of step-level states discarded."
						}
					},
					required: [
						"resetAgents",
						"clearedBans",
						"clearedFailures",
						"clearedSteps"
					]
				},
				render: (_args, value) => [{
					type: "text",
					text: `Reset ${value.resetAgents} agent(s): removed ${value.clearedBans} ban(s), ${value.clearedFailures} failure-risk route(s), ${value.clearedSteps} step state(s).`
				}]
			},
			execute: async (args) => {
				if (args !== null && typeof args === "object" && args.confirm !== true) throw new Error("llm-fallback-reset requires confirm: true");
				return resetRegistry.get(ctx)?.() ?? {
					resetAgents: 0,
					clearedBans: 0,
					clearedFailures: 0,
					clearedSteps: 0
				};
			}
		});
		ctx.effect(() => disposeTool, "llm-fallback: reset tool");
	}
	const commands = ctx.get("commands");
	if (commands !== void 0) {
		const disposeCommand = commands.register({
			name: "llm-fallback-reset",
			description: "Restore every configured model's usability — clear all fallback bans, the session-healthy route, risk scores, and step state.",
			handler: () => {
				const summary = resetRegistry.get(ctx)?.() ?? {
					resetAgents: 0,
					clearedBans: 0,
					clearedFailures: 0,
					clearedSteps: 0
				};
				return {
					kind: "success",
					text: `Restored ${summary.resetAgents} agent(s): cleared ${summary.clearedBans} ban(s), ${summary.clearedFailures} risk route(s), ${summary.clearedSteps} step state(s).`
				};
			}
		});
		ctx.effect(() => disposeCommand, "llm-fallback: reset command");
	}
	ctx.on("agent/request", async (payload, next) => {
		const { agent, turn, step, signal } = payload;
		const agentState = stateFor(agent);
		retireFinishedTurns(agentState, turn);
		agentState.lastTurn = turn;
		sessionAgents.set(agent.session, agent);
		const state = stepFor(agent, turn, step);
		state.attempts += 1;
		const resolved = await next();
		const { userSwitched } = trackPrimary(agentState, state, resolved);
		knownAgents.add(agent);
		const pending = state.pendingRoute;
		state.pendingRoute = void 0;
		if (pending !== void 0) {
			const replaced = withRoute(resolved, pending);
			state.lastRoute = {
				provider: replaced.provider,
				model: replaced.model
			};
			return replaced;
		}
		const healthy = agentState.healthyRoute;
		if (!userSwitched && healthy !== void 0 && (healthy.provider !== resolved.provider || healthy.model !== resolved.model)) {
			const redirected = withRoute(resolved, healthy);
			state.lastRoute = {
				provider: redirected.provider,
				model: redirected.model
			};
			return redirected;
		}
		const preemptive = await preemptiveQuotaCheck(resolved, agent, agentState, state, turn, step, signal, userSwitched);
		if (preemptive !== void 0) return preemptive;
		state.lastRoute = {
			provider: resolved.provider,
			model: resolved.model
		};
		return resolved;
	});
	/** The preemptive quota gate: checks the resolved route's allowance and
	* switches (or warns + probes) before the request goes out. Returns the
	* rewritten config when a switch occurs, or `undefined` to send as-is. */
	async function preemptiveQuotaCheck(resolved, agent, agentState, state, turn, step, signal, userSwitched) {
		const quotaCheck = await checkQuota(resolved.provider, resolved.model, signal, userSwitched);
		const trip = quotaCheck === void 0 ? { below: false } : belowThreshold(quotaCheck, quota);
		const projected = estimateCost(quota, resolved.provider, resolved.model, agent.session);
		const costTrip = projected !== void 0 && quotaCheck?.remaining !== void 0 && quotaCheck.remaining < projected.cost;
		if (trip.below || costTrip) {
			const primaryCapability = await capabilityOf(catalog, resolved);
			const result = await selectNext(catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(), strategyRun(strategySettings?.mode, agent.session, agentState.failedRoutes, checkQuota, signal));
			if (result !== void 0) {
				agentState.switchedKeys.add(routeKey(result.route));
				agent.session.append("llm/quota-warning", {
					turn,
					step,
					provider: resolved.provider,
					model: resolved.model,
					...quotaCheck?.remaining === void 0 ? {} : { remaining: quotaCheck.remaining },
					...quotaCheck?.total === void 0 ? {} : { total: quotaCheck.total },
					...trip.threshold === void 0 ? {} : { threshold: trip.threshold },
					...trip.thresholdKind === void 0 ? {} : { thresholdKind: trip.thresholdKind },
					...costTrip && projected !== void 0 ? {
						estimatedCost: projected.cost,
						inputPrice: projected.inputPrice,
						outputPrice: projected.outputPrice
					} : {},
					reason: trip.below ? "below-threshold" : "insufficient-cost",
					...result.mode === void 0 ? {} : { mode: result.mode }
				});
				state.lastRoute = {
					provider: result.route.provider,
					model: result.route.model
				};
				state.chainCursor = cursorIndexOf(result.cursor);
				return withRoute(resolved, result.route);
			}
			return;
		}
		if (userSwitched && quotaCheck?.remaining === void 0) {
			agent.session.append("llm/quota-warning", {
				turn,
				step,
				provider: resolved.provider,
				model: resolved.model,
				reason: "unobservable"
			});
			return resolved;
		}
	}
	ctx.on("agent/request-error", async (payload, next) => {
		const { agent, turn, step, failure, signal } = payload;
		if (signal.aborted) return next();
		const eligible = codes.has(failure.code);
		const unusable = unusableCodes.has(failure.code);
		if (!eligible && !unusable) return next();
		const state = stepFor(agent, turn, step);
		const primary = state.primary;
		if (primary === void 0) return next();
		const agentState = stateFor(agent);
		const from = state.lastRoute;
		if (eligible) {
			agentState.bannedUntil.set(routeKey(from), banUntil(from.provider, cooldownMs, quota, Date.now()));
			agentState.failedRoutes.add(routeKey(from));
		}
		if (eligible && state.selectedMode === "cost") state.strategyFailures += 1;
		const effectiveMode = strategySettings === void 0 ? void 0 : strategySettings.mode === "cost" && state.strategyFailures >= escalationAfter ? "performance" : strategySettings.mode;
		const primaryCapability = await capabilityOf(catalog, primary);
		const result = await selectNext(catalog, chain, state.chainCursor, primaryCapability, opts, agentState.bannedUntil, Date.now(), strategyRun(effectiveMode, agent.session, agentState.failedRoutes, checkQuota, signal));
		if (result === void 0) return next();
		agentState.switchedKeys.add(routeKey(result.route));
		state.pendingRoute = result.route;
		state.chainCursor = cursorIndexOf(result.cursor);
		state.selectedMode = result.mode;
		agent.session.append("llm/fallback", {
			turn,
			step,
			fromProvider: from.provider,
			fromModel: from.model,
			toProvider: result.route.provider,
			toModel: result.route.model,
			code: failure.code,
			remaining: chain.length - cursorIndexOf(result.cursor),
			...result.mode === void 0 ? {} : { mode: result.mode },
			...result.score === void 0 ? {} : { score: result.score }
		});
		return { kind: "retry" };
	});
	if (config.pollIntervalMs !== void 0 && config.pollIntervalMs > 0) {
		const pollAbort = new AbortController();
		const timer = setInterval(async () => {
			for (const agent of knownAgents) {
				const agentState = states.get(agent);
				if (agentState === void 0 || agentState.healthyRoute === void 0) continue;
				const primary = agentState.primaryRoute;
				if (primary === void 0) continue;
				const check = await checkQuota(primary.provider, primary.model, pollAbort.signal, true);
				if (check === void 0) continue;
				if (!belowThreshold(check, quota).below) agentState.healthyRoute = void 0;
			}
		}, config.pollIntervalMs);
		ctx.effect(() => () => {
			clearInterval(timer);
			pollAbort.abort();
		}, "llm-fallback: stop quota polling");
	}
	let dispatchSeen = false;
	ctx.on("internal/dispatch", (_mode, eventName, args) => {
		dispatchSeen = true;
		if (eventName !== "session/event") return;
		const [session, event] = args;
		if (event.type !== "assistant/message") return;
		const agent = sessionAgents.get(session);
		if (agent === void 0) return;
		const agentState = states.get(agent);
		if (agentState === void 0) return;
		const source = event.data.message.source;
		if (agentState.switchedKeys.has(routeKey(source))) agentState.healthyRoute = {
			provider: source.provider,
			model: source.model
		};
	}, { global: true });
	const dispatchProbe = setTimeout(() => {
		if (!dispatchSeen) ctx.logger("llm-fallback").warn("internal/dispatch events not observed after 30s; healthy-route promotion is disabled. This may indicate a DSH runtime version mismatch.");
	}, 3e4);
	dispatchProbe.unref?.();
	ctx.effect(() => () => {
		clearTimeout(dispatchProbe);
	}, "llm-fallback: clear dispatch probe");
}
//#endregion
export { Config, DEFAULT_FALLBACK_CODES, DEFAULT_UNUSABLE_CODES, apply, buildFloor, comparePerformance, costScore, getFallbackStats, inject, name, passesFloor, priceOf, resetFallback, selectByStrategy };
