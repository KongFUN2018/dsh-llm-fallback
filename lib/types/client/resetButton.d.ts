import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
/** Per-session face injected by the owning slot registration. */
export interface ResetButtonInjected {
    /** Issue `/llm-fallback:reset` against this session; resolves whether it matched. */
    runReset: () => Promise<boolean>;
}
/** Props the owning slot registration composes for this component. */
export interface ResetButtonProps extends ResetButtonInjected {
    /** The llmFallback namespace translate seat (declared via `locale: NS`). */
    t: TranslateNS<'llmFallback'>;
}
/**
 * The reset button. It dispatches `runReset` on click and toggles between a
 * muted idle look and a hover-highlighted look, both derived from theme alias
 * tokens so the control adapts to the active theme without owning CSS.
 * @param props - injected face plus the locale seat.
 */
export declare function ResetButton(props: ResetButtonProps): React.ReactElement;
//# sourceMappingURL=resetButton.d.ts.map