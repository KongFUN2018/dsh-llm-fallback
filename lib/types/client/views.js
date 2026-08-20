import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
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
    return (_jsx("div", { style: rowStyle, "data-dsh-llm-fallback": "switch", children: node.data.switches.map(switched => (_jsxs("div", { style: lineStyle, children: [_jsx("span", { style: iconStyle, "aria-hidden": true, children: "\u21C4" }), _jsxs("span", { children: [fbT('fallback.prefix'), _jsx("span", { style: routeStyle, children: switched.from }), ' → ', _jsx("span", { style: routeStyle, children: switched.to })] }), _jsx("span", { style: detailStyle, children: switched.remaining > 0
                        ? fbT('fallback.detail', { code: switched.code, count: switched.remaining })
                        : fbT('fallback.detailLast', { code: switched.code }) }), strategyDetail(switched.mode, switched.score)] }, switched.seq))) }));
}
/** Keyed chat renderer for one llm/quota-warning preemptive-switch notice. */
export function QuotaWarningNodeView({ node }) {
    const data = node.data;
    const remaining = data.remaining;
    const main = data.reason === 'unobservable'
        ? fbT('warning.unobservableProbe', { route: data.route })
        : data.reason === 'insufficient-cost' && remaining !== undefined
            ? fbT('warning.insufficientCost', { route: data.route, remaining: String(remaining) })
            : remaining !== undefined && data.threshold !== undefined
                ? fbT('warning.belowThreshold', {
                    route: data.route,
                    remaining: String(remaining),
                    threshold: String(data.threshold),
                })
                : fbT('warning.belowThresholdUnknown', { route: data.route });
    return (_jsx("div", { style: rowStyle, "data-dsh-llm-fallback": "quota-warning", children: _jsxs("div", { style: lineStyle, children: [_jsx("span", { style: iconStyle, "aria-hidden": true, children: "\u26A0" }), _jsx("span", { children: main }), strategyDetail(data.mode, undefined)] }) }));
}
//# sourceMappingURL=views.js.map