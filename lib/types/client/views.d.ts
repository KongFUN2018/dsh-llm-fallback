import type { FallbackChatData, QuotaWarningChatData } from './nodes.ts';
/** Keyed chat renderer for one llm/fallback switch notice. */
export declare function FallbackNodeView({ node }: {
    node: {
        readonly data: FallbackChatData;
    };
}): import("react").JSX.Element;
/** Keyed chat renderer for one llm/quota-warning preemptive-switch notice. */
export declare function QuotaWarningNodeView({ node }: {
    node: {
        readonly data: QuotaWarningChatData;
    };
}): import("react").JSX.Element;
//# sourceMappingURL=views.d.ts.map