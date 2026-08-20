/**
 * Resolve a route's unit price with two-level fallback: the exact
 * `provider/model` key first, then the bare provider key.
 * @param prices - configured price table.
 * @param provider - route provider.
 * @param model - route model id.
 * @returns the price entry, or undefined when unpriced.
 */
export function priceOf(prices, provider, model) {
    const exact = prices?.[`${provider}/${model}`];
    if (exact !== undefined)
        return exact;
    return prices?.[provider];
}
/**
 * The dynamic task-completion floor: current context usage plus margin.
 * @param inputTokens - estimated tokens of the current request.
 * @param marginTokens - reserved headroom for the step's output.
 * @returns the minimum acceptable context window.
 */
export function buildFloor(inputTokens, marginTokens) {
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
export function passesFloor(candidate, floor, requiredModalities, allowUnknownCapacity) {
    if (requiredModalities !== undefined && requiredModalities.length > 0) {
        const covered = candidate.modalities;
        if (covered === undefined || !requiredModalities.every(modality => covered.includes(modality))) {
            return false;
        }
    }
    const window = candidate.contextWindow;
    if (window === undefined)
        return allowUnknownCapacity;
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
export function costScore(candidate, inputTokens, floor, settings) {
    if (candidate.inputPrice === undefined && candidate.outputPrice === undefined)
        return undefined;
    const inputPrice = candidate.inputPrice ?? 0;
    const outputPrice = candidate.outputPrice ?? 0;
    const base = (inputTokens * inputPrice + settings.estimatedOutputTokens * outputPrice)
        / 1_000_000 * settings.futureSteps;
    let risk = 1;
    if (candidate.sessionFailed === true)
        risk *= settings.sessionFailurePenalty;
    // Cliff: headroom under half the margin — context growth forces another switch.
    if (candidate.contextWindow !== undefined && candidate.contextWindow < floor + settings.marginTokens / 2) {
        risk *= settings.cliffPenalty;
    }
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
export function comparePerformance(a, b, settings) {
    const ratio = settings.significantRatio;
    for (const axis of settings.axes) {
        if (axis === 'reasoning') {
            const stronger = Number(b.hasReasoning ?? false) - Number(a.hasReasoning ?? false);
            if (stronger !== 0)
                return stronger;
        }
        else if (axis === 'context') {
            if (a.contextWindow !== undefined && b.contextWindow !== undefined) {
                if (a.contextWindow >= b.contextWindow * ratio)
                    return -1;
                if (b.contextWindow >= a.contextWindow * ratio)
                    return 1;
            }
        }
        else if (axis === 'output') {
            if (a.maxTokens !== undefined && b.maxTokens !== undefined) {
                if (a.maxTokens >= b.maxTokens * ratio)
                    return -1;
                if (b.maxTokens >= a.maxTokens * ratio)
                    return 1;
            }
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
    if (aScore === undefined && bScore === undefined) {
        return a.chainIndex - b.chainIndex || a.model.localeCompare(b.model);
    }
    if (aScore === undefined)
        return 1;
    if (bScore === undefined)
        return -1;
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
export function selectByStrategy(candidates, settings, inputTokens, requiredModalities, allowUnknownCapacity) {
    const floor = buildFloor(inputTokens, settings.marginTokens);
    // Tier the floor-passing candidates by confidence in their capacity. A
    // candidate with a known window that clears the floor always outranks one
    // whose window is unknown (the strategy path demands verifiability, so
    // unknown capacity is a last resort — docs/strategy-design.md §四 F2).
    const known = [];
    const unknown = [];
    for (const candidate of candidates) {
        if (!passesFloor(candidate, floor, requiredModalities, allowUnknownCapacity))
            continue;
        if (candidate.contextWindow === undefined)
            unknown.push(candidate);
        else
            known.push(candidate);
    }
    const pool = known.length > 0 ? known : unknown;
    if (pool.length === 0)
        return undefined;
    // With no known-window candidate, the unknown tier has no comparable
    // capability signals — settle deterministically on chain position, then id.
    if (known.length === 0) {
        const best = [...pool].sort((a, b) => a.chainIndex - b.chainIndex || a.model.localeCompare(b.model))[0];
        return { candidate: best, mode: settings.mode };
    }
    if (settings.mode === 'performance') {
        let best = pool[0];
        for (const candidate of pool.slice(1)) {
            if (comparePerformance(candidate, best, settings) < 0)
                best = candidate;
        }
        return { candidate: best, mode: settings.mode };
    }
    const scored = pool.map(candidate => ({
        candidate,
        score: costScore(candidate, inputTokens, floor, settings),
    }));
    scored.sort((left, right) => compareCost(left.candidate, left.score, right.candidate, right.score));
    const winner = scored[0];
    return {
        candidate: winner.candidate,
        mode: settings.mode,
        ...(winner.score !== undefined ? { score: winner.score } : {}),
    };
}
//# sourceMappingURL=strategy.js.map