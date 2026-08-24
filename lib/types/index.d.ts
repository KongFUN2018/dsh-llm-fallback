/**
 * Automatic cross-provider model fallback on the agent loop's request
 * recovery and request-routing extension points.
 *
 * @module @kongfun2018/dsh-llm-fallback
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { LlmFallbackRoute, QuotaProvider, QuotaStaticEntry, SelectionPreference, StrategyConfig } from './types.ts';
export type { LlmFallbackEventData, LlmFallbackRoute, LlmQuotaWarningEventData, QuotaCheck, QuotaKind, QuotaProvider, QuotaStaticEntry, SelectionPreference, StrategyAxis, StrategyConfig, StrategyMode, } from './types.ts';
export { buildFloor, comparePerformance, costScore, passesFloor, priceOf, selectByStrategy, } from './strategy.ts';
export type { PriceTable, StrategyCandidate, StrategySelection, StrategySettings } from './strategy.ts';
export declare const name = "llm-fallback";
export declare const inject: string[];
interface FallbackStats {
    agents: number;
    steps: number;
}
/** Read a live plugin instance's step-state statistics, if installed. */
export declare function getFallbackStats(ctx: Context): FallbackStats | undefined;
/** What a {@link resetFallback} call cleared, for diagnostics and tool output. */
export interface ResetSummary {
    /** Number of agent states whose runtime routing state was cleared. */
    resetAgents: number;
    /** Number of banned-until entries removed. */
    clearedBans: number;
    /** Number of session failure-risk routes cleared. */
    clearedFailures: number;
    /** Number of step-level states discarded. */
    clearedSteps: number;
}
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
export declare function resetFallback(ctx: Context): ResetSummary | undefined;
/** Failure codes that trigger a switch; transient + exhausted-account codes. */
export declare const DEFAULT_FALLBACK_CODES: readonly string[];
/** Structural "candidate unusable" codes: advance the chain without banning. */
export declare const DEFAULT_UNUSABLE_CODES: readonly string[];
/** Plugin configuration. */
export interface Config {
    /** Ordered fallback chain; first entry is tried after the first eligible failure. */
    fallbacks: LlmFallbackRoute[];
    /** Failure codes eligible for switching; defaults to {@link DEFAULT_FALLBACK_CODES}. */
    codes?: string[];
    /** Structural codes that advance the chain without cooling the failed route. */
    unusableCodes?: string[];
    /** How long a failed route stays excluded; 0 excludes it for the session. */
    cooldownMs?: number;
    /** Optional interval for re-checking the primary route's allowance to clear stale fallbacks. */
    pollIntervalMs?: number;
    /** When no capacity non-degrading candidate exists, allow a degrading one. */
    allowDegrade?: boolean;
    /** Accept candidates whose capacity metadata is unknown. */
    allowUnknownCapacity?: boolean;
    /** Tie-break preference among capability-matched candidates; defaults to `closest`. */
    preference?: SelectionPreference;
    /** Strategy-mode selection (see docs/strategy-design.md); `closest` (or absent) keeps the legacy lazy chain walk. */
    strategy?: StrategyConfig;
    /** Preemptive quota warnings. */
    quota?: {
        /** Switch when remaining allowance falls below this absolute amount. */
        thresholdAbsolute?: number;
        /** Switch when remaining/total falls below this ratio (0..1). */
        thresholdRatio?: number;
        /** Static allowance table keyed by provider route (highest precedence). */
        static?: Record<string, QuotaStaticEntry>;
        /** Pluggable quota sources consulted in order after the static table. */
        providers?: QuotaProvider[];
        /** Cache TTL for successful and unknown interrogations (default 30s). */
        cacheMs?: number;
        /** Declarative HTTP balance endpoints keyed by provider (DeepSeek-shaped response). */
        queryers?: Record<string, {
            endpoint: string;
            apiKeyEnv?: string;
        }>;
        /** Built-in DeepSeek `/user/balance` source. */
        deepseek?: {
            /** Provider route the source owns; defaults to `deepseek-official`. */
            provider?: string;
            /** Credential reference resolved per check; defaults to `DEEPSEEK_API_KEY`. */
            apiKeyEnv?: string;
            /** Endpoint base; defaults to `https://api.deepseek.com`. */
            baseURL?: string;
        };
        /** Unit prices (per million tokens) keyed by provider, for cost estimates. */
        prices?: Record<string, {
            input?: number;
            output?: number;
        }>;
        /** Estimated output tokens per request for cost projection (default 1024). */
        estimatedOutputTokens?: number;
    };
}
export declare const Config: z<Config>;
/**
 * Install automatic model fallback.
 * @param ctx - plugin context.
 * @param config - fallback chain and policy.
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map