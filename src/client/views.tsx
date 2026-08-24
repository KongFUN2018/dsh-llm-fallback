/**
 * The two chat notice rows: fallback switches and preemptive quota warnings.
 *
 * Styling is inline on purpose: the rows live in a bundle the DSH shell loads
 * outside its CSS pipeline, so they must not depend on stylesheet imports or
 * theme class names; the muted grays sit acceptably on both light and dark
 * themes.
 *
 * @module @kongfun2018/dsh-llm-fallback/client/views
 */
import type { CSSProperties } from 'react'
import type { FallbackChatData, QuotaWarningChatData } from './nodes.ts'
import { strategyDetailParts } from './nodes.ts'
import { fbT } from './translate.ts'

const rowStyle: CSSProperties = {
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
}

const lineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
  flexWrap: 'wrap',
}

const iconStyle: CSSProperties = { flexShrink: 0, fontSize: '12px' }

const detailStyle: CSSProperties = { opacity: 0.75 }

const routeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '11.5px',
}

/** Render a strategy-mode tag and (cost) score as a muted segment, or nothing. */
function strategyDetail(mode: 'cost' | 'performance' | 'closest' | undefined, score: number | undefined) {
  const parts = strategyDetailParts(mode, score)
  if (parts.length === 0) return null
  return <span style={detailStyle}> · {parts.join(' · ')}</span>
}

/** Keyed chat renderer for one llm/fallback switch notice. */
export function FallbackNodeView({ node }: { node: { readonly data: FallbackChatData } }) {
  return (
    <div style={rowStyle} data-dsh-llm-fallback="switch">
      {node.data.switches.map(switched => (
        <div key={switched.seq} style={lineStyle}>
          <span style={iconStyle} aria-hidden>⇄</span>
          <span>
            {fbT('fallback.prefix')}
            <span style={routeStyle}>{switched.from}</span>
            {' → '}
            <span style={routeStyle}>{switched.to}</span>
          </span>
          <span style={detailStyle}>
            {switched.remaining > 0
              ? fbT('fallback.detail', { code: switched.code, count: switched.remaining })
              : fbT('fallback.detailLast', { code: switched.code })}
          </span>
          {strategyDetail(switched.mode, switched.score)}
        </div>
      ))}
    </div>
  )
}

/** Pick the warning copy for one quota-warning row. A `below-threshold` event
 * always carries remaining and threshold (the trip requires a disclosed
 * remaining), so the unknown-remainder variant only guards against externally
 * forged payloads. */
function warningText(data: QuotaWarningChatData): string {
  switch (data.reason) {
    case 'unobservable':
      return fbT('warning.unobservableProbe', { route: data.route })
    case 'insufficient-cost':
      return data.remaining !== undefined
        ? fbT('warning.insufficientCost', { route: data.route, remaining: String(data.remaining) })
        : fbT('warning.belowThresholdUnknown', { route: data.route })
    case 'below-threshold':
      return data.remaining !== undefined && data.threshold !== undefined
        ? fbT('warning.belowThreshold', {
          route: data.route,
          remaining: String(data.remaining),
          threshold: String(data.threshold),
        })
        : fbT('warning.belowThresholdUnknown', { route: data.route })
  }
}

/** Keyed chat renderer for one llm/quota-warning preemptive-switch notice. */
export function QuotaWarningNodeView({ node }: { node: { readonly data: QuotaWarningChatData } }) {
  const data = node.data
  return (
    <div style={rowStyle} data-dsh-llm-fallback="quota-warning">
      <div style={lineStyle}>
        <span style={iconStyle} aria-hidden>⚠</span>
        <span>{warningText(data)}</span>
        {strategyDetail(data.mode, undefined)}
      </div>
    </div>
  )
}
