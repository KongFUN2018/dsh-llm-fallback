/**
 * Browser half of the llm-fallback plugin: surfaces the two durable events
 * (`llm/fallback`, `llm/quota-warning`) as chat notice rows, so a switch is
 * visible in the conversation exactly where it happened. The host half owns
 * the routing; this half only renders what it recorded — the composer's model
 * seat deliberately keeps showing the user's own selection.
 *
 * Loaded automatically by the DSH web shell through this package's `dsh.client`
 * declaration whenever the node half is loaded in the deployment tree.
 *
 * @module @deepseek-ai/dsh-llm-fallback/client
 */
import type { Context } from '@deepseek-ai/cordis';
import { type FallbackKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The llm-fallback notice rows' copy. */
        llmFallback: FallbackKey;
    }
}
/** Required services: the event registry, the slot registry, and locale. */
export declare const inject: string[];
/**
 * Mount the browser half: dictionaries, the two Conversation Definitions, and
 * the two keyed chat renderers.
 * @param ctx - Client Cordis context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map