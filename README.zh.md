# `@deepseek-ai/dsh-llm-fallback`

[English](README.md) | 中文

面向 DeepSeek Harness 的自动跨供应商模型回退与额度感知插件。它在 agent 循环的 `agent/request` 瀑布外层安装监听，并在 `agent/request-error` 安装恢复监听：每次切换都会用相同的 turn/step 重新派生请求，保留已构建的会话上下文。它不包装 `ctx.llm.stream()`——每次适配器调用都是一次供应商请求，每次切换都是一次全新的模型选择。

## 安装与构建

这是一个独立仓库（不属于 DeepSeek Harness monorepo）。它针对已发布的 `@deepseek-ai/*` 运行时包独立构建与测试。

```bash
npm install
npm run build   # tsc 产出 lib/types/*.js + .d.ts，再由 tsdown 打包到 lib/
npm test        # 78 个 vitest 测试
```

要求：Node ≥ 24，npm（或 pnpm）。运行时 peer 依赖为 DeepSeek Harness 的 `0.1.0-rc.6` 包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-invariants`）。

作为依赖安装：`npm install @deepseek-ai/dsh-llm-fallback`，然后在 DSH 配置里注册（见[配置](#配置)）。

## 功能

- **失败即切换** —— 命中可切换失败码（`QUOTA`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`）时，沿 `fallbacks` 链推进，跳过没有可用模型的供应商，并返回 `{ kind: 'retry' }` 让循环以相同 turn/step 重新派生请求。
- **能力对等选型** —— 回退路由省略 `model` 时，从该供应商真实的 `listModels` 目录中按「模态覆盖 > 能力不降级 > 接近度 > 成本」选择模型；结构性错误码（`NO_ADAPTER` 等）推进链但不冷却失败路由。
- **任务延续** —— 工具循环中途切换时，已完成的工具结果保留，后续步骤继续在新模型上执行。
- **不可观测供应商兜底探测** —— 没有额度源的供应商退化为试错：按顺序尝试候选，首个成功者被记为「会话内健康」。
- **提前预警** —— 每次请求前检查当前路由额度，低于阈值时直接切换（不发失败请求），记录 `llm/quota-warning`。
- **尊重用户切模型** —— 用户主动切换会话模型时，尊重其选择（不会被改回会话健康回退路由），并对新选模型做一次**强制（跳过缓存）额度复查**：若额度不足则预警并切到可用回退。
- **按额度形态禁选** —— 充值 `balance` 耗尽即永久禁选；定时 `quota` 禁选至 `resetAt`；瞬时失败按 `cooldownMs` 冷却；不可观测路由只试错。
- **可选 LLM 决策** —— 可插拔 `decisionProvider` 收到主路由能力与展开后的候选列表，可任选路由；抛错、超时或非法路由自动回退规则匹配。

## Web 界面提示行

本包内置浏览器端伴生插件（通过包内 `dsh.client` 字段声明），DSH web 外壳在加载节点端的同时会自动加载它。它注册两个会话定义与两个键控聊天渲染器，把持久事件呈现在发生切换的确切位置：

- **`llm/fallback`** 每次切换渲染一行淡色提示 —— `⇄ 已自动切换模型：ds/chat → gl/haiku · 原因 QUOTA · 还可回退 2 个路由`。
- **`llm/quota-warning`** 每次提前切换渲染一行 —— `⚠ 额度预警：ds/chat 剩余 10（阈值 20），已提前切换`。

输入框的模型座位刻意继续显示你自己的选择：选择表达意图，路由由插件负责。每条回复实际使用的模型仍可在 Trajectory 视图的 provenance 中逐条查看，而这些提示行在会话内标记每一次切换。

部署方式：把本包安装进 DSH 部署树（即存放 `cordis.yml` 的目录）—— `npm install @deepseek-ai/dsh-llm-fallback` —— 并在配置中注册节点端。`dsh web` 会自动把浏览器端以 `/plugins/@deepseek-ai/dsh-llm-fallback/client.js` 提供并注入 boot manifest，无需额外接线。

## 切换策略模式

除默认的惰性链遍历外，`strategy` 以显式目标选择切换目标（完整设计见 [docs/strategy-design.md](docs/strategy-design.md)）：

- **`cost`（性价比）** —— 展开链上全部候选，只保留通过**任务支撑地板**者（模态覆盖 + 动态上下文窗口：当前用量 + `marginTokens`，且披露额度须覆盖本次请求），然后选**期望成本 × 风险**最低者（per-model 价格、provider 级回退；本会话失败过的路由与贴地板的窗口施加风险乘数）。
- **`performance`（性能）** —— 同一地板，按能力词典序（`reasoning` → `contextWindow` → `maxTokens`，每轴仅在显著比值下分胜负）选最强者，离群轴无法劫持选择。
- **`closest`（或不配 `strategy`）** —— 原惰性链遍历 + `preference` 平局偏好。

两模式共享一条不变式：**地板保证切换能完成任务，评分只在能完成者中选择**——撑不起上下文的最便宜模型永远不会被选中。性价比模式候选连续失败时，**升级阶梯**在 `afterFailures`（默认 2）次后以性能模式重新选择该步，任务完成优先于成本偏好。切换事件携带生效的 `mode`（性价比模式还有 `score`），且会话提示行会渲染该模式标签——性价比模式还带预估成本——于是每次切换都能在发生处直接解释（见 [docs/strategy-design.md §十三](docs/strategy-design.md)）。

## 配置

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'

- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    fallbacks:
      - provider: gl
      - provider: az
        model: gpt-4o
        reasoningEffort: high
    codes: [QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE]
    unusableCodes: [NO_ADAPTER, UNSUPPORTED_REASONING_EFFORT]
    cooldownMs: 60000
    pollIntervalMs: 30000
    allowDegrade: false
    allowUnknownCapacity: false
    preference: closest
    quota:
      thresholdAbsolute: 200
      thresholdRatio: 0.2
      cacheMs: 30000
      static:
        ds: { kind: balance, remaining: 150 }
        gl: { kind: quota, remaining: 30, total: 100, resetAt: 1735689600000 }
      queryers:
        az: { endpoint: 'https://gateway.example/credits', apiKeyEnv: AZ_API_KEY }
      deepseek:
        provider: deepseek-official
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
      prices:
        ds: { input: 0.27, output: 1.10 }
      estimatedOutputTokens: 1024
```

`fallbacks` 是有序回退链。带 `model` 的路由使用该确切模型；省略 `model` 的路由在其供应商内部按能力匹配选择。`codes` 是可切换失败码，`unusableCodes` 推进链但不禁选，`cooldownMs: 0` 表示会话内永久冷却瞬时失败。`pollIntervalMs` 定时复查主路由额度，额度恢复后在下一次请求前清除会话内健康缓存。`preference` 在同一供应商内多个能力对等候选之间打破平局：`closest`（默认，上下文窗口最接近）、`price`（非降级窗口最小）、`speed`（输出上限最小）、`reasoning`（优先暴露推理档位的模型）。

额度查询按优先级依次解析：`static`（最高）→ `providers`（代码级可插拔查询源）→ `queryers`（声明式 HTTP 端点，响应采用 DeepSeek `/user/balance` 的 `{ is_available, balance_infos: [{ total_balance }] }` 形态）→ 内置 `deepseek` 源（DeepSeek `/user/balance` 端点，API key 经 `ctx.credentials` 或启动环境解析）。查询结果按 `cacheMs` 缓存并做单飞去重；任何查询失败都解析为「不可观测」，绝不阻塞请求。

`thresholdAbsolute` 与 `thresholdRatio`（剩余/总量）触发主动切换。当 `prices` 为某路由配置每百万 token 单价时，单次消耗预估（序列化会话估算的输入 token 数 + `estimatedOutputTokens`）也会在已披露的 `remaining` 不足以覆盖时触发切换；此时 `llm/quota-warning` 事件记录 `estimatedCost`、`inputPrice`、`outputPrice`。

## 事件

两类事件均为非表面事件，类型定义在浏览器安全的 `@deepseek-ai/dsh-llm-fallback/types` 子路径中，远程渲染端无需加载运行时即可读取持久状态。

- `llm/fallback` —— 切换前记录：`{ turn, step, fromProvider, fromModel, toProvider, toModel, code, remaining }`。`remaining` 数的是选中路由所在及之后的**链上位置数**，而非"确定可用的候选数"（策略/LLM 决策选择下，部分位置可能已被禁选或不满足地板）；且除非所选路由就是最后一条，否则它计入本次的 `remaining`。
- `llm/quota-warning` —— 请求前检查触发阈值或消耗预估时记录：`{ turn, step, provider, model, remaining?, total?, threshold?, estimatedCost?, inputPrice?, outputPrice?, reason }`，`reason` 为 `below-threshold` 或 `insufficient-cost`。

单独发布的 `./invariant` 伴随件校验每条记录都指向当前打开的 turn/step、标识非空、数值字段非负、`llm/fallback` 的 from/to 不同路由、`llm/quota-warning` 的 reason 合法。

## 已知限制与待办

- **输入 token 预估为粗略估算** —— 消耗校验将派生会话序列化后按每 4 字符 1 token 估算；精确 token 计量需要供应商计量数据源。
- **轮询为尽力而为** —— `pollIntervalMs` 复查主路由额度以清除过期的回退；它从不打断进行中的 turn，未披露重置时间的 quota 形态在两次请求之间仍保持不可观测。
- **健康缓存在会话内** —— 探测成功的路由持续优先，直到再次失败或额度检查否定；不跨会话持久化。
- **`llm/fallback` 记录的是切换而非完成** —— 后续 step 与 turn 事件确立成功或耗尽。
