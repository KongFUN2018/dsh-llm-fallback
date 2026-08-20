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
 * @module @deepseek-ai/dsh-llm-fallback/client/resetButton
 */
import { useCallback, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { fbT } from './translate.ts'

/** Per-session face injected by the owning slot registration. */
export interface ResetButtonInjected {
  /** Issue `/llm-fallback:reset` against this session; resolves whether it matched. */
  runReset: () => Promise<boolean>
}

/** Props the owning slot registration composes for this component. */
export interface ResetButtonProps extends ResetButtonInjected {
  /** The llmFallback namespace translate seat (declared via `locale: NS`). */
  t: TranslateNS<'llmFallback'>
}

const baseStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, rgba(140,140,148,0.82))',
  fontSize: '12px',
  padding: '4px 8px',
  borderRadius: '6px',
  lineHeight: 1,
  cursor: 'default',
}

const idleStyle: CSSProperties = {
  ...baseStyle,
  color: 'var(--dsw-alias-label-secondary, rgba(140,140,148,0.82))',
}

/** Hover highlights the affordance so the user knows it is clickable. */
const hoverStyle: CSSProperties = {
  ...baseStyle,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary, #e4e4e9)',
  background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.10))',
}

/**
 * The reset button. It dispatches `runReset` on click and toggles between a
 * muted idle look and a hover-highlighted look, both derived from theme alias
 * tokens so the control adapts to the active theme without owning CSS.
 * @param props - injected face plus the locale seat.
 */
export function ResetButton(props: ResetButtonProps): React.ReactElement {
  const { runReset, t } = props
  const [hover, setHover] = useState(false)
  const [busy, setBusy] = useState(false)
  const onClick = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await runReset()
    } finally {
      setBusy(false)
    }
  }, [busy, runReset])
  const title = t('reset.title')
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => { onClick() }}
      style={hover ? hoverStyle : idleStyle}
    >
      {busy ? '…' : fbT('reset.label')}
    </button>
  )
}
