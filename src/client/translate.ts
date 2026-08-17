/**
 * Bound translate holder for the two chat notice rows.
 *
 * The keyed chat seat passes components a `t` bound to ui-conversation's own
 * namespace, so the rows read their copy through this apply-time bound thunk
 * instead. `bind` stores the live thunk (it resolves through the active
 * locale at call time); components are intentionally not memoized, so any
 * parent re-render — including a locale switch — re-reads current copy.
 *
 * @module @deepseek-ai/dsh-llm-fallback/client/translate
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

let bound: TranslateNS<'llmFallback'> | undefined

/**
 * Install the live translate thunk (called once from apply).
 * @param t - translate bound to the llmFallback namespace.
 */
export function bindFallbackTranslate(t: TranslateNS<'llmFallback'>): void {
  bound = t
}

/**
 * Translate one llmFallback key, degrading to the key itself before apply.
 * @param key - dictionary key.
 * @param params - interpolation parameters.
 * @returns the localized string, or the bare key when unbound.
 */
export function fbT(
  key: Parameters<TranslateNS<'llmFallback'>>[0],
  params?: Record<string, string | number>,
): string {
  return bound?.(key, params) ?? key
}
