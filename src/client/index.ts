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
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.conversationEvents Context merge and the conversation contracts.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the conversation.chat.node seat and ChatNodeDataMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, zh, type FallbackKey } from './locales.ts'
import { fallbackNodeDefinition, quotaWarningNodeDefinition } from './nodes.ts'
import { bindFallbackTranslate } from './translate.ts'
import { FallbackNodeView, QuotaWarningNodeView } from './views.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The llm-fallback notice rows' copy. */
    llmFallback: FallbackKey
  }
}

/** The llmFallback locale namespace. */
const NS = 'llmFallback'

/** Required services: the event registry, the slot registry, and locale. */
export const inject = ['conversationEvents', 'locale', 'slots']

/**
 * Mount the browser half: dictionaries, the two Conversation Definitions, and
 * the two keyed chat renderers.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallback: dictionaries')
  bindFallbackTranslate(ctx.locale.bind(NS))
  ctx.conversationEvents.register(fallbackNodeDefinition)
  ctx.conversationEvents.register(quotaWarningNodeDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'llm-fallback', locale: NS }, FallbackNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'llm-quota-warning', locale: NS }, QuotaWarningNodeView))
}
