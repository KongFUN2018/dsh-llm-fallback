/**
 * Browser half of the llm-fallback plugin: surfaces the three durable events
 * (`llm/fallback`, `llm/quota-warning`, `llm/fallback-exhausted`) as chat
 * notice rows, so a switch is visible in the conversation exactly where it
 * happened. The host half owns
 * the routing; this half only renders what it recorded — the composer's model
 * seat deliberately keeps showing the user's own selection.
 *
 * Loaded automatically by the DSH web shell through this package's `dsh.client`
 * declaration whenever the node half is loaded in the deployment tree.
 *
 * @module @kongfun2018/dsh-llm-fallback/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.conversationEvents Context merge and the conversation contracts.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the conversation.chat.node seat and ChatNodeDataMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, zh, type FallbackKey } from './locales.ts'
import { fallbackNodeDefinition, quotaWarningNodeDefinition, fallbackExhaustedNodeDefinition } from './nodes.ts'
import { bindFallbackTranslate } from './translate.ts'
import { FallbackNodeView, QuotaWarningNodeView, FallbackExhaustedNodeView } from './views.tsx'
import { ResetButton, type ResetButtonInjected } from './resetButton.tsx'
import type { SessionId, ISessions } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The llm-fallback notice rows' copy. */
    llmFallback: FallbackKey
  }
}

/** The llmFallback locale namespace. */
const NS = 'llmFallback'

/** Required services: the event registry, the slot registry, locale, and sessions. */
export const inject = ['conversationEvents', 'locale', 'slots', 'sessions']

/**
 * Mount the browser half: dictionaries, the three Conversation Definitions,
 * and the three keyed chat renderers.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallback: dictionaries')
  bindFallbackTranslate(ctx.locale.bind(NS))
  ctx.conversationEvents.register(fallbackNodeDefinition)
  ctx.conversationEvents.register(quotaWarningNodeDefinition)
  ctx.conversationEvents.register(fallbackExhaustedNodeDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'llm-fallback', locale: NS }, FallbackNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'llm-quota-warning', locale: NS }, QuotaWarningNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'llm-fallback-exhausted', locale: NS }, FallbackExhaustedNodeView))

  // One-click escape hatch: a subtle status-bar-style button in the composer
  // tool row that issues `/llm-fallback:reset` against the current session,
  // restoring every configured model's usability.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    {
      name: 'conversation.input.right',
      id: 'llm-fallback-reset',
      order: 0,
      locale: NS,
      inject: (sessionId: SessionId): ResetButtonInjected => ({
        runReset: () => {
          // `dsh-session` shadows `ctx.sessions` with the host SessionStore in
          // the shared type space; at runtime it is the client ISessions face.
          const sessions = ctx.sessions as unknown as ISessions
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) return Promise.resolve(false)
          return session.command('/llm-fallback-reset')
            .then(result => result.ok && result.value.matched)
        },
      }),
    },
    ResetButton,
  ))
}
