# DSH Core Issue: llm-pi-ai 缺少 v2→v1 replay-state 迁移兼容，导致持久会话 `INVALID_REPLAY_STATE`

> 拟提交到 DSH 核心仓库（`deepseek-harness` / `@deepseek-ai/dsh-llm-pi-ai`）。本文件由 dsh-llm-fallback 调查时沉淀，用作 issue 底稿 + 最小补丁建议。
>
> **归属模块**：`packages/llm/llm-pi-ai/src/replay.ts`（`readReplayState` / `toPiReplayState`）
> **严重级**：高 —— 不升级兼容的话，任何携带旧格式 replay-state 的持久会话会永久损坏。
> **影响面**：所有把多个 provider 都挂到 pi-ai 适配器、且在版本升级前后跨会话续用的用户。

## 1. 现象

在 DSH Web 的一个旧会话中，`turn/end` 失败并打印：

```text
invalid pi-ai replay state: unknown state kind
INVALID_REPLAY_STATE
```

该会话此后**每次请求、切换任意模型都失败**（因为所有 provider 都由同一个 pi-ai 适配器服务，每次请求都要重建完整历史，而历史里有这条毒消息）。模型选择器因此表现为“整个模型列表不可选 / 路由不可用”。新开一个会话则完全正常。

## 2. 根因：replay-state 版本格式漂移

持久化在会话历史中的 assistant message，其 `source.replayState` 是**旧版 v2 形状**：

```json
{
  "response": {
    "kind": "pi-ai",
    "version": 2,
    "api": "openai-completions",
    "provider": "iwhalecloud",
    "model": "g-deepseek-v4-flash",
    "responseModel": "deepseek-v4-flash",
    "responseId": "…",
    "stopReason": "toolUse"
  },
  "blocks": [{ "type": "text" }, { "type": "tool-call" }]
}
```

而当前（`0.1.0-rc.6`）的 `toPiReplayState` 写入、`readReplayState` 读取的都是 **v1 平坦形状**：

```ts
{ kind: 'pi-ai', version: 1, api, provider, model, responseModel?, responseId?, stopReason, blocks[] }
```

`readReplayState` 第一行就要求顶层 `kind === "pi-ai"`：

```ts
if (state['kind'] !== 'pi-ai') return invalidReplay('unknown state kind')
if (state['version'] !== 1) return invalidReplay('unsupported version ' + String(state['version']))
```

旧 v2 的元数据被包在 `response` 里、顶层没有 `kind`，于是 `kind !== "pi-ai"` 成立 → 抛 `unknown state kind`。即使存在 `{ kind: "pi-ai", version: 2 }` 这种形态，也会被 `unsupported version 2` 拒绝。当前代码**没有任何 v2→v1 的读取/迁移兼容**。

版本漂移来自：会话在更早一版 pi-ai（写 v2）下产生 → 引擎升级到写/读 v1 的版本后，旧消息即成毒药。

## 3. 为什么会“所有模型都不可用”

- 用户的 provider（`iwhalecloud` / `zai-coding-cn` 等）全部由 **同一个 pi-ai 适配器** 服务。
- `LlmRuntime.forAdapter()` 只在“消息生产方的 adapter != 当前请求的 adapter”时剥离 replay-state；同 adapter 时**保留**。
- 于是毒消息的 replay-state 原样进入 `toPiAssistant` → `readReplayState` → 抛错。
- 切换模型只是换模型，换个**同 adapter** 的 provider 也一样读这段历史 → 同样抛错。
- 跨适配器的真正备用不存在时（本配置即如此），插件无法用“切到另一个适配器”来逃逸。

## 4. 期望行为 / 验收标准

1. 读侧：对持久化会话里出现的**旧 v2 形态**（`{ response: {...version:2...}, blocks: [...] }`）做向后兼容解析，等价于迁移为 v1 后再校验，正常重建 pi-ai 历史，不再抛 `INVALID_REPLAY_STATE`。
2. 写侧：继续写 v1（不写 v2），避免再次制造新格式漂移。
3. 兼容解析必须**足够严格**：只在确认是已知旧 v2 结构时才接受，其余仍按现有的全套校验走（provider/model 必须匹配 assistant source、blocks 数量/类型必须与 durable content 一致等），防止“宽容模式”掩盖真实损坏。
4. 补测试：覆盖旧 v2 `{response:{...}}` 与 `{kind:"pi-ai",version:2}` 两种读入路径。

## 5. 建议的最小补丁（读侧向后兼容）

在 `packages/llm/llm-pi-ai/src/replay.ts` 的 `readReplayState` 入口增加一次“识别旧 v2 → 归一化为 v1”的前置步骤（示意，具体以核心维护者审阅为准）：

```ts
/** 旧版(v2)形状：元数据包在顶层 response 里，blocks 在顶层。 */
function normalizeLegacyV2(value) {
  const response = value["response"]
  if (typeof response !== "object" || response === null || Array.isArray(response)) return undefined
  const r = response
  if (r["kind"] !== "pi-ai" || r["version"] !== 2 || !Array.isArray(value["blocks"])) return undefined
  // 老 v2 响应没有顶层 kind，但 response.kind === "pi-ai" 可安全收起。
  return { ...r, kind: "pi-ai", version: 1, blocks: value["blocks"] };
}

function readReplayState(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay("expected an object")
  const raw = value;
  // 向后兼容：识别旧 v2，先归一化为 v1 再走统一校验；其余保持原样并由下方校验拒绝。
  const state = raw["kind"] !== undefined ? raw : (normalizeLegacyV2(raw) ?? raw);
  if (state["kind"] !== "pi-ai") return invalidReplay("unknown state kind")
  if (state["version"] !== 1) return invalidReplay("unsupported version " + String(state["version"]))
  // … 其余校验保持不变 …
}
```

> 说明：归一化后 `provider` / `model` 来自 v2 的 `response`，随后仍需通过 `provider !== source.provider`、`model !== source.model`、blocks 校验；这些已在 v2 实测数据里一致（`iwhalecloud/g-deepseek-v4-flash` + `{text,tool-call}` 与 durable content 吻合），因此迁移后能正常重建历史，且不会放宽审计。

## 6. 运维层恢复（兼容补丁上线前/后均可用的逃生口）

- `/llm-fallback-reset`、`llm-fallback/reset` 工具、状态栏复位按钮：**只能**清插件的 bans / 健康路由 / step 状态，**不触碰**会话里持久化的 replay-state，故对“历史毒消息”无效。
- 用户侧恢复：删除/rewrite 该会话中携带旧 v2 replay-state 的 assistant 消息，或直接开新会话。
- 补丁上线后：读侧兼容即可让旧会话自动恢复，无需手工清理。

## 7. 复现要点（供核心维护者）

- 需要一个曾在 v2 的 pi-ai 下产生 content、随后升级到 v1 pi-ai 的持久会话；
- 或在单测里构造 `source.replayState = { response: { kind: "pi-ai", version: 2, … }, blocks: [...] }`，断言当前会抛 `INVALID_REPLAY_STATE: unknown state kind`，改后不再抛且历史正确重建。
