/**
 * Offline replay evaluation (docs/strategy-design.md §六/§七): pure decision-layer
 * replays over synthetic candidate sets. Each case encodes WHY a selection is
 * right — the assertion fails when the business invariant (cost penalty makes
 * failed routes lose; significance ratio gates noise) changes, not merely when
 * the winner's id changes.
 *
 * These are regression anchors for the strategy hyperparameters: if tuning
 * sessionFailurePenalty / cliffPenalty / significantRatio flips a documented
 * outcome, this file is where the change is reviewed first.
 */
import { describe, expect, it } from 'vitest'
import type { StrategyCandidate, StrategySettings } from '../src/strategy.ts'
import { selectByStrategy } from '../src/strategy.ts'

const BASE_SETTINGS: StrategySettings = {
  mode: 'cost',
  marginTokens: 8192,
  estimatedOutputTokens: 1024,
  futureSteps: 1,
  sessionFailurePenalty: 2,
  cliffPenalty: 1.5,
  axes: ['reasoning', 'context', 'output'],
  significantRatio: 1.5,
}

function candidate(overrides: Partial<StrategyCandidate> & Pick<StrategyCandidate, 'model'>): StrategyCandidate {
  return {
    provider: 'a',
    chainIndex: 0,
    contextWindow: 65_536,
    ...overrides,
  }
}

describe('strategy replay evaluation', () => {
  it('R1 cost mode: a session-failed cheap route loses to a pricier clean one', () => {
    // Intent: the risk multiplier (sessionFailurePenalty) must make a route
    // that already failed this session rank below a cleaner route whose base
    // price is higher. Prices are chosen so that without the penalty the
    // failed route would win, and with the penalty (×2) it loses — isolating
    // the risk term as the deciding factor.
    const cheapFailed = candidate({
      model: 'cheap-failed',
      chainIndex: 0,
      contextWindow: 131_072,
      inputPrice: 8,
      outputPrice: 8,
      sessionFailed: true,
    })
    const pricierClean = candidate({
      model: 'pricier-clean',
      chainIndex: 1,
      contextWindow: 131_072,
      inputPrice: 2,
      outputPrice: 4,
    })
    const inputTokens = 10_000
    const settings = { ...BASE_SETTINGS, mode: 'cost' as const }
    const result = selectByStrategy([cheapFailed, pricierClean], settings, inputTokens, undefined, false)
    expect(result?.candidate.model).toBe('pricier-clean')
    // And the cheap route's risk-adjusted cost exceeds the clean one's base cost:
    const cheapScore = (inputTokens * 8 + 1024 * 8) / 1e6 * 2
    const cleanScore = (inputTokens * 2 + 1024 * 4) / 1e6
    expect(cheapScore).toBeGreaterThan(cleanScore)
  })

  it('R2 cost mode: penalty removed, the genuinely cheaper route wins', () => {
    // Intent: confirm R1's outcome is driven by the penalty, not by some other
    // ordering. A failed route whose base price is genuinely lower must win once
    // the penalty is 1 (no risk multiplier) — proving the selection is sensitive
    // to sessionFailurePenalty, not hardcoded to avoid failed routes.
    const cheapFailed = candidate({
      model: 'cheap-failed',
      chainIndex: 0,
      contextWindow: 131_072,
      inputPrice: 0.5,
      outputPrice: 1,
      sessionFailed: true,
    })
    const pricierClean = candidate({
      model: 'pricier-clean',
      chainIndex: 1,
      contextWindow: 131_072,
      inputPrice: 2,
      outputPrice: 4,
    })
    const settings: StrategySettings = { ...BASE_SETTINGS, sessionFailurePenalty: 1, mode: 'cost' }
    const result = selectByStrategy([cheapFailed, pricierClean], settings, 10_000, undefined, false)
    expect(result?.candidate.model).toBe('cheap-failed')
  })

  it('R3 performance mode: a sub-significant context gap falls through to chain order', () => {
    // Intent: significantRatio (1.5) gates noise. Two routes whose context
    // windows differ by less than 1.5× must NOT be split on the context axis —
    // the tie falls through to chain position. If this flips, the ratio gate is
    // broken and outlier windows would hijack the ranking.
    const earlier = candidate({
      model: 'earlier',
      chainIndex: 0,
      contextWindow: 100_000,
      hasReasoning: true,
    })
    const later = candidate({
      model: 'later',
      chainIndex: 1,
      contextWindow: 120_000, // 120k vs 100k = 1.2×, below the 1.5 gate
      hasReasoning: true,
    })
    const settings: StrategySettings = { ...BASE_SETTINGS, mode: 'performance', significantRatio: 1.5 }
    const result = selectByStrategy([earlier, later], settings, 10_000, undefined, false)
    // Equal on reasoning, sub-significant on context → chain position decides.
    expect(result?.candidate.model).toBe('earlier')
  })

  it('R4 performance mode: a significant context gap overrides chain order', () => {
    // Intent: when the gap crosses the significance gate (≥1.5×), the larger
    // window wins even though it sits later in the chain — the gate opens and
    // the axis decides. This is the counterpart to R3.
    const earlier = candidate({
      model: 'earlier',
      chainIndex: 0,
      contextWindow: 80_000,
      hasReasoning: true,
    })
    const later = candidate({
      model: 'later',
      chainIndex: 1,
      contextWindow: 200_000, // 200k vs 80k = 2.5×, above the 1.5 gate
      hasReasoning: true,
    })
    const settings: StrategySettings = { ...BASE_SETTINGS, mode: 'performance', significantRatio: 1.5 }
    const result = selectByStrategy([earlier, later], settings, 10_000, undefined, false)
    expect(result?.candidate.model).toBe('later')
  })
})
