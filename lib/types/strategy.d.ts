/**
 * Strategy-mode selection: the pure decision layer of docs/strategy-design.md.
 *
 * Two modes share one architecture — a hard task-completion floor, then a
 * mode-specific soft score, then deterministic tie-breaks (chain position,
 * then id). The floor guarantees the switch target can carry the current
 * task; the score only decides …among candidates that already can:
 *
 * - cost — expected request cost × session-learned risk multipliers, minimum wins;
 * - performance — capability lexicographic order with significance thresholds, strongest wins.
 *
 * Everything here is pure and synchronous; the host half owns expansion,
 * quota interrogation, and session-memory side effects.
 *
 * @module @deepseek-ai/dsh-llm-fallback/strategy
 */
import type { ModelModality } from '@deepseek-ai/dsh-llm';
import type { StrategyAxis, StrategyMode } from './types.ts';
/** Unit prices per million tokens keyed by provider or provider/model. */
export type PriceTable = Record<string, {
    input?: number;
    output?: number;
} | undefined>;
/** One expanded fallback candidate with its resolved selection signals. */
export interface StrategyCandidate {
    readonly provider: string;
    readonly model: string;
    /** Index of the chain entry that produced this candidate. */
    readonly chainIndex: number;
    readonly reasoningEffort?: string;
    readonly contextWindow?: number;
    readonly modalities?: readonly ModelModality[];
    readonly maxTokens?: number;
    readonly hasReasoning?: boolean;
    /** Input unit price per million tokens, when priced. */
    readonly inputPrice?: number;
    /** Output unit price per million tokens, when priced. */
    readonly outputPrice?: number;
    /** Whether this exact route already failed earlier this session. */
    readonly sessionFailed?: boolean;
}
/** Resolved strategy settings (defaults already applied by the host half). */
export interface StrategySettings {
    /** Active soft objective; `closest` never reaches this layer. */
    readonly mode: Exclude<StrategyMode, 'closest'>;
    readonly marginTokens: number;
    readonly estimatedOutputTokens: number;
    readonly futureSteps: number;
    readonly sessionFailurePenalty: number;
    readonly cliffPenalty: number;
    readonly axes: readonly StrategyAxis[];
    readonly significantRatio: number;
}
/** The selection outcome: the winning candidate plus its mode's score. */
export interface StrategySelection {
    readonly candidate: StrategyCandidate;
    readonly mode: Exclude<StrategyMode, 'closest'>;
    /** Cost-mode projected cost of the winner; absent for performance mode. */
    readonly score?: number;
}
/**
 * Resolve a route's unit price with two-level fallback: the exact
 * `provider/model` key first, then the bare provider key.
 * @param prices - configured price table.
 * @param provider - route provider.
 * @param model - route model id.
 * @returns the price entry, or undefined when unpriced.
 */
export declare function priceOf(prices: PriceTable | undefined, provider: string, model: string): {
    input?: number;
    output?: number;
} | undefined;
/**
 * The dynamic task-completion floor: current context usage plus margin.
 * @param inputTokens - estimated tokens of the current request.
 * @param marginTokens - reserved headroom for the step's output.
 * @returns the minimum acceptable context window.
 */
export declare function buildFloor(inputTokens: number, marginTokens: number): number;
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
export declare function passesFloor(candidate: StrategyCandidate, floor: number, requiredModalities: readonly ModelModality[] | undefined, allowUnknownCapacity: boolean): boolean;
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
export declare function costScore(candidate: StrategyCandidate, inputTokens: number, floor: number, settings: StrategySettings): number | undefined;
/**
 * Compare two floor-passing candidates by the performance-mode lexicographic
 * order: each axis decides only on a significant difference, undecided axes
 * fall through, and full ties resolve by chain position then id.
 * @param a - left candidate.
 * @param b - right candidate.
 * @param settings - resolved strategy settings.
 * @returns negative when a ranks stronger, positive when b does.
 */
export declare function comparePerformance(a: StrategyCandidate, b: StrategyCandidate, settings: StrategySettings): number;
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
export declare function selectByStrategy(candidates: readonly StrategyCandidate[], settings: StrategySettings, inputTokens: number, requiredModalities: readonly ModelModality[] | undefined, allowUnknownCapacity: boolean): StrategySelection | undefined;
//# sourceMappingURL=strategy.d.ts.map