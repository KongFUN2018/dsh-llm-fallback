import { en, zh } from "./locales.js";
import { fallbackNodeDefinition, quotaWarningNodeDefinition, fallbackExhaustedNodeDefinition } from "./nodes.js";
import { bindFallbackTranslate } from "./translate.js";
import { FallbackNodeView, QuotaWarningNodeView, FallbackExhaustedNodeView } from "./views.js";
import { ResetButton } from "./resetButton.js";
/** The llmFallback locale namespace. */
const NS = 'llmFallback';
/** Required services: the event registry, the slot registry, locale, and sessions. */
export const inject = ['conversationEvents', 'locale', 'slots', 'sessions'];
/**
 * Mount the browser half: dictionaries, the three Conversation Definitions,
 * and the three keyed chat renderers.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallback: dictionaries');
    bindFallbackTranslate(ctx.locale.bind(NS));
    ctx.conversationEvents.register(fallbackNodeDefinition);
    ctx.conversationEvents.register(quotaWarningNodeDefinition);
    ctx.conversationEvents.register(fallbackExhaustedNodeDefinition);
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'llm-fallback', locale: NS }, FallbackNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'llm-quota-warning', locale: NS }, QuotaWarningNodeView));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'llm-fallback-exhausted', locale: NS }, FallbackExhaustedNodeView));
    // One-click escape hatch: a subtle status-bar-style button in the composer
    // tool row that issues `/llm-fallback:reset` against the current session,
    // restoring every configured model's usability.
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'llm-fallback-reset',
        order: 0,
        locale: NS,
        inject: (sessionId) => ({
            runReset: () => {
                // `dsh-session` shadows `ctx.sessions` with the host SessionStore in
                // the shared type space; at runtime it is the client ISessions face.
                const sessions = ctx.sessions;
                const session = sessions.binding(sessionId)?.session;
                if (session === undefined)
                    return Promise.resolve(false);
                return session.command('/llm-fallback-reset')
                    .then(result => result.ok && result.value.matched);
            },
        }),
    }, ResetButton));
}
//# sourceMappingURL=index.js.map