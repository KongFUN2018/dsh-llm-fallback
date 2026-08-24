/** Package-owned durable fallback-event invariants. @module @kongfun2018/dsh-llm-fallback/invariant */
const PACKAGE_NAME = '@kongfun2018/dsh-llm-fallback';
/** The strategy-mode vocabulary shared by both switch events. */
const STRATEGY_MODES = "'cost' | 'performance' | 'closest'";
/** Cordis companion plugin name. */
export const name = 'llm-fallback-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** Validate one fallback record against the currently open request step. */
function validateFallback(history, event, fail) {
    const { turn, step, fromProvider, fromModel, toProvider, toModel, code, remaining, mode, score } = event.data;
    if (!Number.isSafeInteger(turn) || turn < 1)
        fail('llm/fallback turn must be a positive safe integer');
    if (!Number.isSafeInteger(step) || step < 1)
        fail('llm/fallback step must be a positive safe integer');
    if (typeof fromProvider !== 'string' || fromProvider.length === 0)
        fail('llm/fallback fromProvider must be a non-empty string');
    if (typeof fromModel !== 'string' || fromModel.length === 0)
        fail('llm/fallback fromModel must be a non-empty string');
    if (typeof toProvider !== 'string' || toProvider.length === 0)
        fail('llm/fallback toProvider must be a non-empty string');
    if (typeof toModel !== 'string' || toModel.length === 0)
        fail('llm/fallback toModel must be a non-empty string');
    if (typeof code !== 'string' || code.length === 0)
        fail('llm/fallback code must be a non-empty string');
    if (!Number.isSafeInteger(remaining) || remaining < 0)
        fail('llm/fallback remaining must be a non-negative safe integer');
    if (mode !== undefined && mode !== 'cost' && mode !== 'performance' && mode !== 'closest') {
        fail(`llm/fallback mode must be ${STRATEGY_MODES} when present`);
    }
    if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0)) {
        fail('llm/fallback score must be a finite non-negative number when present');
    }
    if (fromProvider === toProvider && fromModel === toModel)
        fail('llm/fallback must switch to a different route');
    const turnBoundary = history.findLast(prior => prior.type === 'turn/start' || prior.type === 'turn/end');
    if (turnBoundary?.type !== 'turn/start')
        fail('llm/fallback must be appended inside an open turn');
    if (turn !== turnBoundary.data.turn)
        fail(`llm/fallback names turn ${turn}, but the open turn is ${turnBoundary.data.turn}`);
    const stepBoundary = history.findLast(prior => prior.type === 'step/start' || prior.type === 'step/end');
    if (stepBoundary?.type !== 'step/start')
        fail('llm/fallback must be appended inside an open step');
    if (step !== stepBoundary.data.step || turn !== stepBoundary.data.turn) {
        fail(`llm/fallback names turn ${turn}/step ${step}, but the open step is ${stepBoundary.data.turn}/${stepBoundary.data.step}`);
    }
}
/** Validate one quota-warning record against the currently open request step. */
function validateWarning(history, event, fail) {
    const { turn, step, provider, model, remaining, total, threshold, thresholdKind, estimatedCost, inputPrice, outputPrice, reason, mode } = event.data;
    if (!Number.isSafeInteger(turn) || turn < 1)
        fail('llm/quota-warning turn must be a positive safe integer');
    if (!Number.isSafeInteger(step) || step < 1)
        fail('llm/quota-warning step must be a positive safe integer');
    if (typeof provider !== 'string' || provider.length === 0)
        fail('llm/quota-warning provider must be a non-empty string');
    if (typeof model !== 'string' || model.length === 0)
        fail('llm/quota-warning model must be a non-empty string');
    if (remaining !== undefined && (typeof remaining !== 'number' || remaining < 0))
        fail('llm/quota-warning remaining must be non-negative when present');
    if (total !== undefined && (typeof total !== 'number' || total < 0))
        fail('llm/quota-warning total must be non-negative when present');
    if (threshold !== undefined && (typeof threshold !== 'number' || threshold < 0))
        fail('llm/quota-warning threshold must be non-negative when present');
    if (thresholdKind !== undefined && thresholdKind !== 'absolute' && thresholdKind !== 'ratio')
        fail("llm/quota-warning thresholdKind must be 'absolute' | 'ratio' when present");
    if (estimatedCost !== undefined && (typeof estimatedCost !== 'number' || estimatedCost < 0))
        fail('llm/quota-warning estimatedCost must be non-negative when present');
    if (inputPrice !== undefined && (typeof inputPrice !== 'number' || inputPrice < 0))
        fail('llm/quota-warning inputPrice must be non-negative when present');
    if (outputPrice !== undefined && (typeof outputPrice !== 'number' || outputPrice < 0))
        fail('llm/quota-warning outputPrice must be non-negative when present');
    if (reason !== 'below-threshold' && reason !== 'insufficient-cost' && reason !== 'unobservable')
        fail('llm/quota-warning reason must be a known reason');
    if (mode !== undefined && mode !== 'cost' && mode !== 'performance' && mode !== 'closest') {
        fail(`llm/quota-warning mode must be ${STRATEGY_MODES} when present`);
    }
    const turnBoundary = history.findLast(prior => prior.type === 'turn/start' || prior.type === 'turn/end');
    if (turnBoundary?.type !== 'turn/start')
        fail('llm/quota-warning must be appended inside an open turn');
    if (turn !== turnBoundary.data.turn)
        fail(`llm/quota-warning names turn ${turn}, but the open turn is ${turnBoundary.data.turn}`);
    const stepBoundary = history.findLast(prior => prior.type === 'step/start' || prior.type === 'step/end');
    if (stepBoundary?.type !== 'step/start')
        fail('llm/quota-warning must be appended inside an open step');
    if (step !== stepBoundary.data.step || turn !== stepBoundary.data.turn) {
        fail(`llm/quota-warning names turn ${turn}/step ${step}, but the open step is ${stepBoundary.data.turn}/${stepBoundary.data.step}`);
    }
}
/** Validate every fallback record already present in one loaded session. */
function validateSession(session, fail) {
    for (const [index, event] of session.events.entries()) {
        if (event.type === 'llm/fallback')
            validateFallback(session.events.slice(0, index), event, fail);
        if (event.type === 'llm/quota-warning')
            validateWarning(session.events.slice(0, index), event, fail);
    }
}
/** Install validation for loaded and newly appended fallback records. */
const install = Object.assign((ctx, fail) => {
    for (const session of ctx.sessions.list())
        validateSession(session, fail);
    ctx.on('session/created', (session) => { validateSession(session, fail); }, { global: true });
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
        if (eventName !== 'session/event')
            return;
        const [session, event] = args;
        if (event.type === 'llm/fallback')
            validateFallback(session.events, event, fail);
        if (event.type === 'llm/quota-warning')
            validateWarning(session.events, event, fail);
    }, { global: true });
}, { inject: ['sessions'] });
/**
 * Register the LLM fallback invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map