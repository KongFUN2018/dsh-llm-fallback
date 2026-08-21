/**
 * Conversation Definitions for the two durable llm-fallback events.
 *
 * Each event opens its own one-row Context (the events carry no producer
 * correlation id, so the event seq is the identity): an `llm/fallback`
 * switch renders one "switched from → to" row and an `llm/quota-warning`
 * renders one preemptive-switch row, anchored at the event's own seq so the
 * notice sits exactly where the switch happened inside the turn.
 *
 * @module @kongfun2018/dsh-llm-fallback/client/nodes
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client';
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ChatNodeDataMap {
        /** One automatic model fallback switch notice row. */
        'llm-fallback': FallbackChatData;
        /** One preemptive quota-warning switch notice row. */
        'llm-quota-warning': QuotaWarningChatData;
    }
}
/** One fallback switch as the chat row renders it. */
export interface FallbackSwitchRow {
    readonly seq: number;
    readonly time: number;
    /** Failed route, as "provider/model". */
    readonly from: string;
    /** Route switched to, as "provider/model". */
    readonly to: string;
    /** Provider-neutral failure code that triggered the switch. */
    readonly code: string;
    /** Chain positions remaining after this switch (see LlmFallbackEventData). */
    readonly remaining: number;
    /** Strategy mode that selected the target, when a strategy was active. */
    readonly mode?: 'cost' | 'performance' | 'closest';
    /** The mode's score for the selected route (cost mode: projected cost), when defined. */
    readonly score?: number;
}
/** Chat payload of one llm/fallback event. */
export interface FallbackChatData {
    readonly switches: readonly FallbackSwitchRow[];
}
/** Chat payload of one llm/quota-warning event. */
export interface QuotaWarningChatData {
    readonly seq: number;
    readonly time: number;
    /** Route that tripped the warning, as "provider/model". */
    readonly route: string;
    readonly remaining?: number;
    readonly total?: number;
    readonly threshold?: number;
    readonly estimatedCost?: number;
    readonly reason: 'below-threshold' | 'insufficient-cost' | 'unobservable';
    /** Strategy mode that selected the target, when a strategy was active. */
    readonly mode?: 'cost' | 'performance' | 'closest';
}
/** One mode for strategy-detail rendering. */
export type StrategyModeDisplay = 'cost' | 'performance' | 'closest';
/**
 * Translated strategy-detail segments for one switch notice: a mode tag, plus
 * the projected cost when a cost-mode score is present. Empty for a rule-based
 * (no-strategy) switch, so the view renders no trailing detail.
 */
export declare function strategyDetailParts(mode: StrategyModeDisplay | undefined, score: number | undefined): string[];
/** Definition for the durable llm/fallback switch notice. */
export declare const fallbackNodeDefinition: ConversationNodeDefinition<FallbackChatData>;
/** Definition for the durable llm/quota-warning preemptive-switch notice. */
export declare const quotaWarningNodeDefinition: ConversationNodeDefinition<QuotaWarningChatData>;
//# sourceMappingURL=nodes.d.ts.map