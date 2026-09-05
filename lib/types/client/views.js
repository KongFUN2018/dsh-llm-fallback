import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { strategyDetailParts } from "./nodes.js";
import { fbT } from "./translate.js";
const rowStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    margin: '2px 0 2px 12px',
    padding: '3px 10px',
    borderRadius: '8px',
    background: 'rgba(128,128,128,0.08)',
    fontSize: '12px',
    lineHeight: '18px',
    color: 'rgba(140,140,148,0.98)',
    userSelect: 'text',
};
const lineStyle = {
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    flexWrap: 'wrap',
};
const iconStyle = { flexShrink: 0, fontSize: '12px' };
const detailStyle = { opacity: 0.75 };
const routeStyle = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
};
/** Render a strategy-mode tag and (cost) score as a muted segment, or nothing. */
function strategyDetail(mode, score) {
    const parts = strategyDetailParts(mode, score);
    if (parts.length === 0)
        return null;
    return _jsxs("span", { style: detailStyle, children: [" \u00B7 ", parts.join(' · ')] });
}
/** Keyed chat renderer for one llm/fallback switch notice. */
export function FallbackNodeView({ node }) {
    return (_jsx("div", { style: rowStyle, "data-dsh-llm-fallback": "switch", children: node.data.switches.map(switched => (_jsxs("div", { style: lineStyle, children: [_jsx("span", { style: iconStyle, "aria-hidden": true, children: "\u21C4" }), _jsx("span", { children: switched.reason === 'probe-failed'
                        ? fbT('warning.probeFailed', { route: switched.to })
                        : _jsxs(_Fragment, { children: [fbT('fallback.prefix'), _jsx("span", { style: routeStyle, children: switched.from }), ' → ', _jsx("span", { style: routeStyle, children: switched.to })] }) }), _jsx("span", { style: detailStyle, children: switched.reason === 'probe-failed'
                        ? ' '
                        : switched.remaining > 0
                            ? fbT('fallback.detail', { code: switched.code, count: switched.remaining })
                            : fbT('fallback.detailLast', { code: switched.code }) }), strategyDetail(switched.mode, switched.score)] }, switched.seq))) }));
}
/** Pick the warning copy for one quota-warning row. A `below-threshold` event
 * always carries remaining and threshold (the trip requires a disclosed
 * remaining), so the unknown-remainder variant only guards against externally
 * forged payloads. */
function warningText(data) {
    switch (data.reason) {
        case 'cost-cap-reached':
            return data.costCap !== undefined && data.cumulativeCost !== undefined
                ? fbT('warning.costCapReached', {
                    route: data.route,
                    cumulative: String(data.cumulativeCost),
                    cap: String(data.costCap),
                })
                : fbT('warning.costCapReachedUnknown', { route: data.route });
        case 'unobservable':
            return fbT('warning.unobservableProbe', { route: data.route });
        case 'forecast-low':
            return data.remaining !== undefined
                ? data.projectedBurn !== undefined && data.forecastSteps !== undefined
                    ? fbT('warning.forecastLow', {
                        route: data.route,
                        remaining: String(data.remaining),
                        burn: String(data.projectedBurn),
                        steps: String(data.forecastSteps),
                    })
                    : fbT('warning.forecastLowUnknown', { route: data.route, remaining: String(data.remaining) })
                : fbT('warning.belowThresholdUnknown', { route: data.route });
        case 'insufficient-cost':
            return data.remaining !== undefined
                ? fbT('warning.insufficientCost', { route: data.route, remaining: String(data.remaining) })
                : fbT('warning.belowThresholdUnknown', { route: data.route });
        case 'below-threshold':
            return data.remaining !== undefined && data.threshold !== undefined
                ? fbT('warning.belowThreshold', {
                    route: data.route,
                    remaining: String(data.remaining),
                    threshold: String(data.threshold),
                })
                : fbT('warning.belowThresholdUnknown', { route: data.route });
        case 'probe-failed':
            return fbT('warning.probeFailed', { route: data.route });
    }
}
/** Keyed chat renderer for one llm/quota-warning preemptive-switch notice. */
export function QuotaWarningNodeView({ node }) {
    const data = node.data;
    return (_jsx("div", { style: rowStyle, "data-dsh-llm-fallback": "quota-warning", children: _jsxs("div", { style: lineStyle, children: [_jsx("span", { style: iconStyle, "aria-hidden": true, children: "\u26A0" }), _jsx("span", { children: warningText(data) }), strategyDetail(data.mode, undefined)] }) }));
}
/** Keyed chat renderer for one exhausted-fallback-chain notice. */
export function FallbackExhaustedNodeView({ node }) {
    const data = node.data;
    return (_jsx("div", { style: rowStyle, "data-dsh-llm-fallback": "fallback-exhausted", children: _jsxs("div", { style: lineStyle, children: [_jsx("span", { style: iconStyle, "aria-hidden": true, children: "\u26D4" }), _jsx("span", { children: fbT('exhausted.message', { route: data.route, attempts: String(data.attempts), code: data.code }) })] }) }));
}
//# sourceMappingURL=views.js.map