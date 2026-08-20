window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-llm-fallback",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		/**
		* `llmFallback` namespace dictionaries: the copy of the two chat notice rows.
		*
		* @module @deepseek-ai/dsh-llm-fallback/client/locales
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
			"warning.belowThresholdUnknown": "额度预警：{route} 低于阈值，已提前切换"
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
			"warning.belowThresholdUnknown": "Quota warning: {route} fell below its threshold — switched preemptively"
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
				...score !== void 0 ? { score } : {}
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
			if (data.reason !== "below-threshold" && data.reason !== "insufficient-cost") return void 0;
			const remaining = count(data.remaining);
			const total = count(data.total);
			const threshold = count(data.threshold);
			const estimatedCost = count(data.estimatedCost);
			const inputPrice = count(data.inputPrice);
			const outputPrice = count(data.outputPrice);
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
				...mode !== void 0 ? { mode } : {}
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
					...payload.score !== void 0 ? { score: payload.score } : {}
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
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
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: detailStyle,
							children: switched.remaining > 0 ? fbT("fallback.detail", {
								code: switched.code,
								count: switched.remaining
							}) : fbT("fallback.detailLast", { code: switched.code })
						}),
						strategyDetail(switched.mode, switched.score)
					]
				}, switched.seq))
			});
		}
		/** Keyed chat renderer for one llm/quota-warning preemptive-switch notice. */
		function QuotaWarningNodeView({ node }) {
			const data = node.data;
			const remaining = data.remaining;
			const main = data.reason === "insufficient-cost" && remaining !== void 0 ? fbT("warning.insufficientCost", {
				route: data.route,
				remaining: String(remaining)
			}) : remaining !== void 0 && data.threshold !== void 0 ? fbT("warning.belowThreshold", {
				route: data.route,
				remaining: String(remaining),
				threshold: String(data.threshold)
			}) : fbT("warning.belowThresholdUnknown", { route: data.route });
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: main }),
						strategyDetail(data.mode, void 0)
					]
				})
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** The llmFallback locale namespace. */
		const NS = "llmFallback";
		/** Required services: the event registry, the slot registry, and locale. */
		const inject = [
			"conversationEvents",
			"locale",
			"slots"
		];
		/**
		* Mount the browser half: dictionaries, the two Conversation Definitions, and
		* the two keyed chat renderers.
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
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map