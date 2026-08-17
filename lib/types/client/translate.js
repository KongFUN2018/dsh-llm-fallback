let bound;
/**
 * Install the live translate thunk (called once from apply).
 * @param t - translate bound to the llmFallback namespace.
 */
export function bindFallbackTranslate(t) {
    bound = t;
}
/**
 * Translate one llmFallback key, degrading to the key itself before apply.
 * @param key - dictionary key.
 * @param params - interpolation parameters.
 * @returns the localized string, or the bare key when unbound.
 */
export function fbT(key, params) {
    return bound?.(key, params) ?? key;
}
//# sourceMappingURL=translate.js.map