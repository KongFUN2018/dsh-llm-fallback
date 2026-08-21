import { jsx as _jsx } from "react/jsx-runtime";
/**
 * The one-click escape-hatch button in the composer tool row
 * (`conversation.input.right`): restores every configured model's usability by
 * issuing the host `/llm-fallback:reset` command against the current session.
 *
 * Intentionally subtle to match the composer's resident chrome — a transparent
 * secondary-text affordance that only highlights on hover (and shows a busy
 * ellipsis while the command is in flight), so it reads as a quiet status-bound
 * control rather than a prominent button.
 *
 * @module @kongfun2018/dsh-llm-fallback/client/resetButton
 */
import { useCallback, useState } from 'react';
import { fbT } from "./translate.js";
const baseStyle = {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, rgba(140,140,148,0.82))',
    fontSize: '12px',
    padding: '4px 8px',
    borderRadius: '6px',
    lineHeight: 1,
    cursor: 'default',
};
const idleStyle = {
    ...baseStyle,
    color: 'var(--dsw-alias-label-secondary, rgba(140,140,148,0.82))',
};
/** Hover highlights the affordance so the user knows it is clickable. */
const hoverStyle = {
    ...baseStyle,
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary, #e4e4e9)',
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.10))',
};
/**
 * The reset button. It dispatches `runReset` on click and toggles between a
 * muted idle look and a hover-highlighted look, both derived from theme alias
 * tokens so the control adapts to the active theme without owning CSS.
 * @param props - injected face plus the locale seat.
 */
export function ResetButton(props) {
    const { runReset, t } = props;
    const [hover, setHover] = useState(false);
    const [busy, setBusy] = useState(false);
    const onClick = useCallback(async () => {
        if (busy)
            return;
        setBusy(true);
        try {
            await runReset();
        }
        finally {
            setBusy(false);
        }
    }, [busy, runReset]);
    const title = t('reset.title');
    return (_jsx("button", { type: "button", title: title, "aria-label": title, onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), onClick: () => { onClick(); }, style: hover ? hoverStyle : idleStyle, children: busy ? '…' : fbT('reset.label') }));
}
//# sourceMappingURL=resetButton.js.map