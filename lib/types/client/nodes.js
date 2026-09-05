import { fbT } from "./translate.js";
/** A finite non-negative integer read from an untrusted payload field. */
function count(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** A non-empty string read from an untrusted payload field. */
function label(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** A strategy-mode enum read from an untrusted payload field, or undefined. */
function strategyMode(value) {
    return value === 'cost' || value === 'performance' || value === 'closest' ? value : undefined;
}
/** A finite non-negative score read from an untrusted payload field. */
function scoreOf(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** A finite non-negative amount (balance, threshold, price, or cost) read from
 * an untrusted payload field. Unlike `count`, fractional values are legitimate:
 * disclosed balances and per-million-token prices are routinely fractional. */
function amountOf(value) {
    return scoreOf(value);
}
/** Structurally narrow one llm/fallback event payload. */
function fallbackOf(event) {
    if (event.type !== 'llm/fallback')
        return undefined;
    const data = event.data;
    if (data === undefined)
        return undefined;
    const turn = count(data.turn);
    const step = count(data.step);
    const fromProvider = label(data.fromProvider);
    const fromModel = label(data.fromModel);
    const toProvider = label(data.toProvider);
    const toModel = label(data.toModel);
    const code = label(data.code);
    const remaining = count(data.remaining);
    if (turn === undefined || step === undefined || fromProvider === undefined
        || fromModel === undefined || toProvider === undefined || toModel === undefined
        || code === undefined || remaining === undefined)
        return undefined;
    const mode = strategyMode(data.mode);
    const score = scoreOf(data.score);
    const reason = data.reason === 'probe-failed' ? data.reason : undefined;
    return {
        turn, step, fromProvider, fromModel, toProvider, toModel, code, remaining,
        ...(mode !== undefined ? { mode } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(reason !== undefined ? { reason } : {}),
    };
}
/** Structurally narrow one llm/quota-warning event payload. */
function warningOf(event) {
    if (event.type !== 'llm/quota-warning')
        return undefined;
    const data = event.data;
    if (data === undefined)
        return undefined;
    const turn = count(data.turn);
    const step = count(data.step);
    const provider = label(data.provider);
    const model = label(data.model);
    if (turn === undefined || step === undefined || provider === undefined || model === undefined) {
        return undefined;
    }
    if (data.reason !== 'below-threshold' && data.reason !== 'insufficient-cost'
        && data.reason !== 'cost-cap-reached' && data.reason !== 'unobservable'
        && data.reason !== 'forecast-low' && data.reason !== 'probe-failed')
        return undefined;
    const remaining = amountOf(data.remaining);
    const total = amountOf(data.total);
    const threshold = amountOf(data.threshold);
    const estimatedCost = amountOf(data.estimatedCost);
    const inputPrice = amountOf(data.inputPrice);
    const outputPrice = amountOf(data.outputPrice);
    const costCap = amountOf(data.costCap);
    const cumulativeCost = amountOf(data.cumulativeCost);
    // projectedBurn is a projected currency amount, not an integer count.
    const projectedBurn = scoreOf(data.projectedBurn);
    const forecastSteps = count(data.forecastSteps);
    const mode = strategyMode(data.mode);
    return {
        turn, step, provider, model, reason: data.reason,
        ...(remaining !== undefined ? { remaining } : {}),
        ...(total !== undefined ? { total } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(estimatedCost !== undefined ? { estimatedCost } : {}),
        ...(inputPrice !== undefined ? { inputPrice } : {}),
        ...(outputPrice !== undefined ? { outputPrice } : {}),
        ...(costCap !== undefined ? { costCap } : {}),
        ...(cumulativeCost !== undefined ? { cumulativeCost } : {}),
        ...(projectedBurn !== undefined ? { projectedBurn } : {}),
        ...(forecastSteps !== undefined ? { forecastSteps } : {}),
        ...(mode !== undefined ? { mode } : {}),
    };
}
/** Structurally narrow one llm/fallback-exhausted event payload. */
function exhaustedOf(event) {
    if (event.type !== 'llm/fallback-exhausted')
        return undefined;
    const data = event.data;
    if (data === undefined)
        return undefined;
    const turn = count(data.turn);
    const step = count(data.step);
    const provider = label(data.provider);
    const model = label(data.model);
    const code = label(data.code);
    const attempts = count(data.attempts);
    if (turn === undefined || step === undefined || provider === undefined
        || model === undefined || code === undefined || attempts === undefined || attempts < 1) {
        return undefined;
    }
    return { turn, step, provider, model, code, attempts };
}
/** Best currently loaded event Location of one Context. */
function contextLocation(context) {
    return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
}
/**
 * Translated strategy-detail segments for one switch notice: a mode tag, plus
 * the projected cost when a cost-mode score is present. Empty for a rule-based
 * (no-strategy) switch, so the view renders no trailing detail.
 */
export function strategyDetailParts(mode, score) {
    if (mode === undefined)
        return [];
    const parts = [fbT('strategy.mode', { mode })];
    if (mode === 'cost' && score !== undefined) {
        parts.push(fbT('strategy.score', { score: score.toPrecision(4) }));
    }
    return parts;
}
/** Definition for the durable llm/fallback switch notice. */
export const fallbackNodeDefinition = {
    kind: 'llm-fallback',
    target: 'chat',
    match: (event) => {
        const payload = fallbackOf(event);
        return payload === undefined ? null : { id: `llm-fallback:${event.seq}`, role: 'start' };
    },
    start: (_context, match) => {
        const payload = fallbackOf(match.event);
        if (payload === undefined)
            throw new Error('llm-fallback start requires a valid llm/fallback event');
        return {
            switches: [{
                    seq: match.event.seq,
                    time: match.event.time,
                    from: `${payload.fromProvider}/${payload.fromModel}`,
                    to: `${payload.toProvider}/${payload.toModel}`,
                    code: payload.code,
                    remaining: payload.remaining,
                    ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
                    ...(payload.score !== undefined ? { score: payload.score } : {}),
                    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
                }],
        };
    },
    update: context => context.state,
    buildViewNode: (context) => {
        if (context.state === undefined || context.state.switches.length === 0)
            return null;
        return {
            key: context.key,
            kind: 'llm-fallback',
            id: context.id,
            target: 'chat',
            anchorSeq: context.state.switches[0].seq,
            location: contextLocation(context),
            visibility: 'visible',
            data: context.state,
        };
    },
};
/** Definition for the durable llm/quota-warning preemptive-switch notice. */
export const quotaWarningNodeDefinition = {
    kind: 'llm-quota-warning',
    target: 'chat',
    match: (event) => {
        const payload = warningOf(event);
        return payload === undefined ? null : { id: `llm-quota-warning:${event.seq}`, role: 'start' };
    },
    start: (_context, match) => {
        const payload = warningOf(match.event);
        if (payload === undefined) {
            throw new Error('llm-quota-warning start requires a valid llm/quota-warning event');
        }
        return {
            seq: match.event.seq,
            time: match.event.time,
            route: `${payload.provider}/${payload.model}`,
            reason: payload.reason,
            ...(payload.remaining !== undefined ? { remaining: payload.remaining } : {}),
            ...(payload.total !== undefined ? { total: payload.total } : {}),
            ...(payload.threshold !== undefined ? { threshold: payload.threshold } : {}),
            ...(payload.estimatedCost !== undefined ? { estimatedCost: payload.estimatedCost } : {}),
            ...(payload.projectedBurn !== undefined ? { projectedBurn: payload.projectedBurn } : {}),
            ...(payload.forecastSteps !== undefined ? { forecastSteps: payload.forecastSteps } : {}),
            ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
        };
    },
    update: context => context.state,
    buildViewNode: (context) => {
        if (context.state === undefined)
            return null;
        return {
            key: context.key,
            kind: 'llm-quota-warning',
            id: context.id,
            target: 'chat',
            anchorSeq: context.state.seq,
            location: contextLocation(context),
            visibility: 'visible',
            data: context.state,
        };
    },
};
/** Definition for the durable llm/fallback-exhausted notice. */
export const fallbackExhaustedNodeDefinition = {
    kind: 'llm-fallback-exhausted',
    target: 'chat',
    match: (event) => {
        const payload = exhaustedOf(event);
        return payload === undefined ? null : { id: `llm-fallback-exhausted:${event.seq}`, role: 'start' };
    },
    start: (_context, match) => {
        const payload = exhaustedOf(match.event);
        if (payload === undefined) {
            throw new Error('llm-fallback-exhausted start requires a valid llm/fallback-exhausted event');
        }
        return {
            seq: match.event.seq,
            time: match.event.time,
            route: `${payload.provider}/${payload.model}`,
            code: payload.code,
            attempts: payload.attempts,
        };
    },
    update: context => context.state,
    buildViewNode: (context) => {
        if (context.state === undefined)
            return null;
        return {
            key: context.key,
            kind: 'llm-fallback-exhausted',
            id: context.id,
            target: 'chat',
            anchorSeq: context.state.seq,
            location: contextLocation(context),
            visibility: 'visible',
            data: context.state,
        };
    },
};
//# sourceMappingURL=nodes.js.map