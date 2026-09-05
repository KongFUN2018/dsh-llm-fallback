window.__ModuleLoader__.load({
	id: "@kongfun2018/dsh-llm-fallback",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/client/locales.ts
		/**
		* `llmFallback` namespace dictionaries: the copy of the two chat notice rows.
		*
		* @module @kongfun2018/dsh-llm-fallback/client/locales
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"fallback.prefix": "已自动切换模型：",
			"fallback.detail": "原因 {code} · 还可回退 {count} 个路由",
			"fallback.detailLast": "原因 {code} · 已是最后一个回退路由",
			"strategy.mode": "策略模式 {mode}",
			"strategy.score": "预估成本 {score}",
			"warning.belowThreshold": "额度预警：{route} 剩余 {remaining}（阈值 {threshold}），已提前切换",
			"warning.insufficientCost": "额度预警：{route} 剩余 {remaining}，低于本次请求估算成本，已提前切换",
			"warning.belowThresholdUnknown": "额度预警：{route} 低于阈值，已提前切换",
			"warning.unobservableProbe": "额度预警：{route} 额度不可观测，将用本次请求探测其可用性",
			"warning.costCapReached": "成本止损：{route} 累计成本 {cumulative} 已达上限 {cap}，停止切换",
			"warning.costCapReachedUnknown": "成本止损：{route} 累计成本已达上限，停止切换",
			"warning.forecastLow": "余额预估：{route} 剩余 {remaining}，按未来 {steps} 步约耗 {burn} 预计不足，请留意余额",
			"warning.forecastLowUnknown": "余额预估：{route} 剩余 {remaining}，已低于预警线，请留意余额",
			"warning.probeFailed": "切换校验：{route} 探测不可用，已跳过改用下一候选",
			"exhausted.message": "回退链已耗尽：{route} 第 {attempts} 次请求失败（原因 {code}），已无可用路由",
			"reset.label": "恢复所有模型",
			"reset.title": "一键恢复所有已配置模型的可用性（清除回退禁选/健康路由等全部决策）"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"fallback.prefix": "Switched model automatically: ",
			"fallback.detail": "reason {code} · {count} fallback route(s) left",
			"fallback.detailLast": "reason {code} · last fallback route",
			"strategy.mode": "mode {mode}",
			"strategy.score": "est. cost {score}",
			"warning.belowThreshold": "Quota warning: {route} has {remaining} left (threshold {threshold}) — switched preemptively",
			"warning.insufficientCost": "Quota warning: {route} has {remaining} left, below the estimated request cost — switched preemptively",
			"warning.belowThresholdUnknown": "Quota warning: {route} fell below its threshold — switched preemptively",
			"warning.unobservableProbe": "Quota warning: {route} has no disclosed allowance — probing usability with this request",
			"warning.costCapReached": "Cost stop-loss: {route} cumulative cost {cumulative} reached the cap {cap} — switching halted",
			"warning.costCapReachedUnknown": "Cost stop-loss: {route} cumulative cost reached the cap — switching halted",
			"warning.forecastLow": "Balance forecast: {route} has {remaining} left — projected short after ~{steps} more step(s) costing ~{burn}; consider topping up",
			"warning.forecastLowUnknown": "Balance forecast: {route} has {remaining} left — below the advisory floor; consider topping up",
			"warning.probeFailed": "Switch check: {route} probe unusable — skipped for the next candidate",
			"exhausted.message": "Fallback chain exhausted: {route} failed on request {attempts} (reason {code}), no routes left",
			"reset.label": "Restore models",
			"reset.title": "Restore every configured model's usability (clear all fallback bans / healthy-route / decisions)"
		};
		//#endregion
		//#region src/client/translate.ts
		let bound;
		/**
		* Install the live translate thunk (called once from apply).
		* @param t - translate bound to the llmFallback namespace.
		*/
		function bindFallbackTranslate(t) {
			bound = t;
		}
		/**
		* Translate one llmFallback key, degrading to the key itself before apply.
		* @param key - dictionary key.
		* @param params - interpolation parameters.
		* @returns the localized string, or the bare key when unbound.
		*/
		function fbT(key, params) {
			return bound?.(key, params) ?? key;
		}
		//#endregion
		//#region src/client/nodes.ts
		/** A finite non-negative integer read from an untrusted payload field. */
		function count(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
		}
		/** A non-empty string read from an untrusted payload field. */
		function label(value) {
			return typeof value === "string" && value !== "" ? value : void 0;
		}
		/** A strategy-mode enum read from an untrusted payload field, or undefined. */
		function strategyMode(value) {
			return value === "cost" || value === "performance" || value === "closest" ? value : void 0;
		}
		/** A finite non-negative score read from an untrusted payload field. */
		function scoreOf(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
		}
		/** A finite non-negative amount (balance, threshold, price, or cost) read from
		* an untrusted payload field. Unlike `count`, fractional values are legitimate:
		* disclosed balances and per-million-token prices are routinely fractional. */
		function amountOf(value) {
			return scoreOf(value);
		}
		/** Structurally narrow one llm/fallback event payload. */
		function fallbackOf(event) {
			if (event.type !== "llm/fallback") return void 0;
			const data = event.data;
			if (data === void 0) return void 0;
			const turn = count(data.turn);
			const step = count(data.step);
			const fromProvider = label(data.fromProvider);
			const fromModel = label(data.fromModel);
			const toProvider = label(data.toProvider);
			const toModel = label(data.toModel);
			const code = label(data.code);
			const remaining = count(data.remaining);
			if (turn === void 0 || step === void 0 || fromProvider === void 0 || fromModel === void 0 || toProvider === void 0 || toModel === void 0 || code === void 0 || remaining === void 0) return void 0;
			const mode = strategyMode(data.mode);
			const score = scoreOf(data.score);
			const reason = data.reason === "probe-failed" ? data.reason : void 0;
			return {
				turn,
				step,
				fromProvider,
				fromModel,
				toProvider,
				toModel,
				code,
				remaining,
				...mode !== void 0 ? { mode } : {},
				...score !== void 0 ? { score } : {},
				...reason !== void 0 ? { reason } : {}
			};
		}
		/** Structurally narrow one llm/quota-warning event payload. */
		function warningOf(event) {
			if (event.type !== "llm/quota-warning") return void 0;
			const data = event.data;
			if (data === void 0) return void 0;
			const turn = count(data.turn);
			const step = count(data.step);
			const provider = label(data.provider);
			const model = label(data.model);
			if (turn === void 0 || step === void 0 || provider === void 0 || model === void 0) return;
			if (data.reason !== "below-threshold" && data.reason !== "insufficient-cost" && data.reason !== "cost-cap-reached" && data.reason !== "unobservable" && data.reason !== "forecast-low" && data.reason !== "probe-failed") return void 0;
			const remaining = amountOf(data.remaining);
			const total = amountOf(data.total);
			const threshold = amountOf(data.threshold);
			const estimatedCost = amountOf(data.estimatedCost);
			const inputPrice = amountOf(data.inputPrice);
			const outputPrice = amountOf(data.outputPrice);
			const costCap = amountOf(data.costCap);
			const cumulativeCost = amountOf(data.cumulativeCost);
			const projectedBurn = scoreOf(data.projectedBurn);
			const forecastSteps = count(data.forecastSteps);
			const mode = strategyMode(data.mode);
			return {
				turn,
				step,
				provider,
				model,
				reason: data.reason,
				...remaining !== void 0 ? { remaining } : {},
				...total !== void 0 ? { total } : {},
				...threshold !== void 0 ? { threshold } : {},
				...estimatedCost !== void 0 ? { estimatedCost } : {},
				...inputPrice !== void 0 ? { inputPrice } : {},
				...outputPrice !== void 0 ? { outputPrice } : {},
				...costCap !== void 0 ? { costCap } : {},
				...cumulativeCost !== void 0 ? { cumulativeCost } : {},
				...projectedBurn !== void 0 ? { projectedBurn } : {},
				...forecastSteps !== void 0 ? { forecastSteps } : {},
				...mode !== void 0 ? { mode } : {}
			};
		}
		/** Structurally narrow one llm/fallback-exhausted event payload. */
		function exhaustedOf(event) {
			if (event.type !== "llm/fallback-exhausted") return void 0;
			const data = event.data;
			if (data === void 0) return void 0;
			const turn = count(data.turn);
			const step = count(data.step);
			const provider = label(data.provider);
			const model = label(data.model);
			const code = label(data.code);
			const attempts = count(data.attempts);
			if (turn === void 0 || step === void 0 || provider === void 0 || model === void 0 || code === void 0 || attempts === void 0 || attempts < 1) return;
			return {
				turn,
				step,
				provider,
				model,
				code,
				attempts
			};
		}
		/** Best currently loaded event Location of one Context. */
		function contextLocation(context) {
			return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
		}
		/**
		* Translated strategy-detail segments for one switch notice: a mode tag, plus
		* the projected cost when a cost-mode score is present. Empty for a rule-based
		* (no-strategy) switch, so the view renders no trailing detail.
		*/
		function strategyDetailParts(mode, score) {
			if (mode === void 0) return [];
			const parts = [fbT("strategy.mode", { mode })];
			if (mode === "cost" && score !== void 0) parts.push(fbT("strategy.score", { score: score.toPrecision(4) }));
			return parts;
		}
		/** Definition for the durable llm/fallback switch notice. */
		const fallbackNodeDefinition = {
			kind: "llm-fallback",
			target: "chat",
			match: (event) => {
				return fallbackOf(event) === void 0 ? null : {
					id: `llm-fallback:${event.seq}`,
					role: "start"
				};
			},
			start: (_context, match) => {
				const payload = fallbackOf(match.event);
				if (payload === void 0) throw new Error("llm-fallback start requires a valid llm/fallback event");
				return { switches: [{
					seq: match.event.seq,
					time: match.event.time,
					from: `${payload.fromProvider}/${payload.fromModel}`,
					to: `${payload.toProvider}/${payload.toModel}`,
					code: payload.code,
					remaining: payload.remaining,
					...payload.mode !== void 0 ? { mode: payload.mode } : {},
					...payload.score !== void 0 ? { score: payload.score } : {},
					...payload.reason !== void 0 ? { reason: payload.reason } : {}
				}] };
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === void 0 || context.state.switches.length === 0) return null;
				return {
					key: context.key,
					kind: "llm-fallback",
					id: context.id,
					target: "chat",
					anchorSeq: context.state.switches[0].seq,
					location: contextLocation(context),
					visibility: "visible",
					data: context.state
				};
			}
		};
		/** Definition for the durable llm/quota-warning preemptive-switch notice. */
		const quotaWarningNodeDefinition = {
			kind: "llm-quota-warning",
			target: "chat",
			match: (event) => {
				return warningOf(event) === void 0 ? null : {
					id: `llm-quota-warning:${event.seq}`,
					role: "start"
				};
			},
			start: (_context, match) => {
				const payload = warningOf(match.event);
				if (payload === void 0) throw new Error("llm-quota-warning start requires a valid llm/quota-warning event");
				return {
					seq: match.event.seq,
					time: match.event.time,
					route: `${payload.provider}/${payload.model}`,
					reason: payload.reason,
					...payload.remaining !== void 0 ? { remaining: payload.remaining } : {},
					...payload.total !== void 0 ? { total: payload.total } : {},
					...payload.threshold !== void 0 ? { threshold: payload.threshold } : {},
					...payload.estimatedCost !== void 0 ? { estimatedCost: payload.estimatedCost } : {},
					...payload.projectedBurn !== void 0 ? { projectedBurn: payload.projectedBurn } : {},
					...payload.forecastSteps !== void 0 ? { forecastSteps: payload.forecastSteps } : {},
					...payload.mode !== void 0 ? { mode: payload.mode } : {}
				};
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === void 0) return null;
				return {
					key: context.key,
					kind: "llm-quota-warning",
					id: context.id,
					target: "chat",
					anchorSeq: context.state.seq,
					location: contextLocation(context),
					visibility: "visible",
					data: context.state
				};
			}
		};
		/** Definition for the durable llm/fallback-exhausted notice. */
		const fallbackExhaustedNodeDefinition = {
			kind: "llm-fallback-exhausted",
			target: "chat",
			match: (event) => {
				return exhaustedOf(event) === void 0 ? null : {
					id: `llm-fallback-exhausted:${event.seq}`,
					role: "start"
				};
			},
			start: (_context, match) => {
				const payload = exhaustedOf(match.event);
				if (payload === void 0) throw new Error("llm-fallback-exhausted start requires a valid llm/fallback-exhausted event");
				return {
					seq: match.event.seq,
					time: match.event.time,
					route: `${payload.provider}/${payload.model}`,
					code: payload.code,
					attempts: payload.attempts
				};
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === void 0) return null;
				return {
					key: context.key,
					kind: "llm-fallback-exhausted",
					id: context.id,
					target: "chat",
					anchorSeq: context.state.seq,
					location: contextLocation(context),
					visibility: "visible",
					data: context.state
				};
			}
		};
		//#endregion
		//#region src/client/views.tsx
		const rowStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "2px",
			margin: "2px 0 2px 12px",
			padding: "3px 10px",
			borderRadius: "8px",
			background: "rgba(128,128,128,0.08)",
			fontSize: "12px",
			lineHeight: "18px",
			color: "rgba(140,140,148,0.98)",
			userSelect: "text"
		};
		const lineStyle = {
			display: "flex",
			alignItems: "baseline",
			gap: "6px",
			flexWrap: "wrap"
		};
		const iconStyle = {
			flexShrink: 0,
			fontSize: "12px"
		};
		const detailStyle = { opacity: .75 };
		const routeStyle = {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: "11.5px"
		};
		/** Render a strategy-mode tag and (cost) score as a muted segment, or nothing. */
		function strategyDetail(mode, score) {
			const parts = strategyDetailParts(mode, score);
			if (parts.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: detailStyle,
				children: [" · ", parts.join(" · ")]
			});
		}
		/** Keyed chat renderer for one llm/fallback switch notice. */
		function FallbackNodeView({ node }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: rowStyle,
				"data-dsh-llm-fallback": "switch",
				children: node.data.switches.map((switched) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: lineStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: iconStyle,
							"aria-hidden": true,
							children: "⇄"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: switched.reason === "probe-failed" ? fbT("warning.probeFailed", { route: switched.to }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							fbT("fallback.prefix"),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: routeStyle,
								children: switched.from
							}),
							" → ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: routeStyle,
								children: switched.to
							})
						] }) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: detailStyle,
							children: switched.reason === "probe-failed" ? " " : switched.remaining > 0 ? fbT("fallback.detail", {
								code: switched.code,
								count: switched.remaining
							}) : fbT("fallback.detailLast", { code: switched.code })
						}),
						strategyDetail(switched.mode, switched.score)
					]
				}, switched.seq))
			});
		}
		/** Pick the warning copy for one quota-warning row. A `below-threshold` event
		* always carries remaining and threshold (the trip requires a disclosed
		* remaining), so the unknown-remainder variant only guards against externally
		* forged payloads. */
		function warningText(data) {
			switch (data.reason) {
				case "cost-cap-reached": return data.costCap !== void 0 && data.cumulativeCost !== void 0 ? fbT("warning.costCapReached", {
					route: data.route,
					cumulative: String(data.cumulativeCost),
					cap: String(data.costCap)
				}) : fbT("warning.costCapReachedUnknown", { route: data.route });
				case "unobservable": return fbT("warning.unobservableProbe", { route: data.route });
				case "forecast-low": return data.remaining !== void 0 ? data.projectedBurn !== void 0 && data.forecastSteps !== void 0 ? fbT("warning.forecastLow", {
					route: data.route,
					remaining: String(data.remaining),
					burn: String(data.projectedBurn),
					steps: String(data.forecastSteps)
				}) : fbT("warning.forecastLowUnknown", {
					route: data.route,
					remaining: String(data.remaining)
				}) : fbT("warning.belowThresholdUnknown", { route: data.route });
				case "insufficient-cost": return data.remaining !== void 0 ? fbT("warning.insufficientCost", {
					route: data.route,
					remaining: String(data.remaining)
				}) : fbT("warning.belowThresholdUnknown", { route: data.route });
				case "below-threshold": return data.remaining !== void 0 && data.threshold !== void 0 ? fbT("warning.belowThreshold", {
					route: data.route,
					remaining: String(data.remaining),
					threshold: String(data.threshold)
				}) : fbT("warning.belowThresholdUnknown", { route: data.route });
				case "probe-failed": return fbT("warning.probeFailed", { route: data.route });
			}
		}
		/** Keyed chat renderer for one llm/quota-warning preemptive-switch notice. */
		function QuotaWarningNodeView({ node }) {
			const data = node.data;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: rowStyle,
				"data-dsh-llm-fallback": "quota-warning",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: lineStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: iconStyle,
							"aria-hidden": true,
							children: "⚠"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: warningText(data) }),
						strategyDetail(data.mode, void 0)
					]
				})
			});
		}
		/** Keyed chat renderer for one exhausted-fallback-chain notice. */
		function FallbackExhaustedNodeView({ node }) {
			const data = node.data;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: rowStyle,
				"data-dsh-llm-fallback": "fallback-exhausted",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: lineStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: iconStyle,
						"aria-hidden": true,
						children: "⛔"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: fbT("exhausted.message", {
						route: data.route,
						attempts: String(data.attempts),
						code: data.code
					}) })]
				})
			});
		}
		//#endregion
		//#region src/client/resetButton.tsx
		/**
		* The one-click escape-hatch button in the composer tool row
		* (`conversation.input.right`): restores every configured model's usability by
		* issuing the host `/llm-fallback:reset` command against the current session.
		*
		* Rendered as a compact refresh icon — transparent idle, highlighted on hover
		* (and a busy spinner glyph while the command is in flight) — so it reads as a
		* quiet status-bound control rather than a prominent text button.
		*
		* @module @kongfun2018/dsh-llm-fallback/client/resetButton
		*/
		const baseStyle = {
			border: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary, rgba(140,140,148,0.82))",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "24px",
			height: "24px",
			padding: 0,
			borderRadius: "6px",
			lineHeight: 1,
			cursor: "default",
			flex: "none"
		};
		const idleStyle = {
			...baseStyle,
			color: "var(--dsw-alias-label-secondary, rgba(140,140,148,0.82))"
		};
		/** Hover highlights the affordance so the user knows it is clickable. */
		const hoverStyle = {
			...baseStyle,
			cursor: "pointer",
			color: "var(--dsw-alias-label-primary, #e4e4e9)",
			background: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.10))"
		};
		/** Busy: slightly dimmed primary color to signal the reset is in flight. */
		const busyStyle = {
			...hoverStyle,
			color: "var(--dsw-alias-label-primary, #e4e4e9)",
			opacity: .65,
			cursor: "progress"
		};
		/**
		* The reset button. Dispatches `runReset` on click and toggles between a muted
		* idle look and a hover-highlighted look, both derived from theme alias tokens.
		* While the command is in flight it renders a busy spinner glyph.
		* @param props - injected face plus the locale seat.
		*/
		function ResetButton(props) {
			const { runReset, t } = props;
			const [hover, setHover] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const onClick = (0, react.useCallback)(async () => {
				if (busy) return;
				setBusy(true);
				try {
					await runReset();
				} finally {
					setBusy(false);
				}
			}, [busy, runReset]);
			const title = t("reset.title");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				title,
				"aria-label": title,
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				onClick: () => {
					onClick();
				},
				style: busy ? busyStyle : hover ? hoverStyle : idleStyle,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** The llmFallback locale namespace. */
		const NS = "llmFallback";
		/** Required services: the event registry, the slot registry, locale, and sessions. */
		const inject = [
			"conversationEvents",
			"locale",
			"slots",
			"sessions"
		];
		/**
		* Mount the browser half: dictionaries, the three Conversation Definitions,
		* and the three keyed chat renderers.
		* @param ctx - Client Cordis context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "llm-fallback: dictionaries");
			bindFallbackTranslate(ctx.locale.bind(NS));
			ctx.conversationEvents.register(fallbackNodeDefinition);
			ctx.conversationEvents.register(quotaWarningNodeDefinition);
			ctx.conversationEvents.register(fallbackExhaustedNodeDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "llm-fallback",
				locale: NS
			}, FallbackNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "llm-quota-warning",
				locale: NS
			}, QuotaWarningNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "llm-fallback-exhausted",
				locale: NS
			}, FallbackExhaustedNodeView));
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "llm-fallback-reset",
				order: 0,
				locale: NS,
				inject: (sessionId) => ({ runReset: () => {
					const session = ctx.sessions.binding(sessionId)?.session;
					if (session === void 0) return Promise.resolve(false);
					return session.command("/llm-fallback-reset").then((result) => result.ok && result.value.matched);
				} })
			}, ResetButton));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map