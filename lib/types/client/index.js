import { en, zh } from "./locales.js";
import { fallbackNodeDefinition, quotaWarningNodeDefinition } from "./nodes.js";
import { bindFallbackTranslate } from "./translate.js";
import { FallbackNodeView, QuotaWarningNodeView } from "./views.js";
/** The llmFallback locale namespace. */
const NS = 'llmFallback';
/** Required services: the event registry, the slot registry, and locale. */
export const inject = ['conversationEvents', 'locale', 'slots'];
/**
 * Mount the browser half: dictionaries, the two Conversation Definitions, and
 * the two keyed chat renderers.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallback: dictionaries');
    bindFallbackTranslate(ctx.locale.bind(NS));
    ctx.conversationEvents.register(fallbackNodeDefinition);
    ctx.conversationEvents.register(quotaWarningNodeDefinition);
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'llm-fallback', locale: NS }, FallbackNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'llm-quota-warning', locale: NS }, QuotaWarningNodeView));
}
//# sourceMappingURL=index.js.map