# `@kongfun2018/dsh-llm-fallback`

[English](README.md) | 中文

面向 DeepSeek Harness 的自动跨供应商模型回退与额度感知插件。它在 agent 循环的 `agent/request` 瀑布外层安装监听，并在 `agent/request-error` 安装恢复监听：每次切换都会用相同的 turn/step 重新派生请求，保留已构建的会话上下文。它不包装 `ctx.llm.stream()`——每次适配器调用都是一次供应商请求，每次切换都是一次全新的模型选择。

## 安装与构建

这是一个独立仓库（不属于 DeepSeek Harness monorepo）。它针对已发布的 `@deepseek-ai/*` 运行时包独立构建与测试。

```bash
npm install
npm run build   # tsc 产出 lib/types/*.js + .d.ts，再由 tsdown 打包到 lib/
npm test        # 116 个 vitest 测试
npm run typecheck  # tsc --noEmit（快速类型检查）
```

要求：Node ≥ 24，npm（或 pnpm）。运行时 peer 依赖为 DeepSeek Harness 的 `0.1.0-rc.6` 包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-invariants`）。

作为依赖安装：`npm install @kongfun2018/dsh-llm-fallback`，然后在 DSH 配置里注册（见[配置](#配置)）。

## 功能

- **失败即切换** —— 命中可切换失败码（`QUOTA`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`）时，沿 `fallbacks` 链推进，跳过没有可用模型的供应商，并返回 `{ kind: 'retry' }` 让循环以相同 turn/step 重新派生请求。
- **能力对等选型** —— 回退路由省略 `model` 时，从该供应商真实的 `listModels` 目录中按「模态覆盖 > 能力不降级 > 接近度 > 成本」选择模型；结构性错误码（`NO_ADAPTER` 等）推进链但不冷却失败路由。
- **任务延续** —— 工具循环中途切换时，已完成的工具结果保留，后续步骤继续在新模型上执行。
- **切换前可用性探测** —— 开启 `probe.enabled` 后，每次选定的回退候选在正式切换前先用一次最小真实请求验证（默认 1 个 token）：探测失败的候选被会话内禁选，链条推进到下一候选，不可用路由永远不会拖垮当前 turn。被拒候选以 `llm/fallback` 事件记录，reason 为 `probe-failed`（切换从未完成）。
- **不可观测供应商兜底探测** —— 没有额度源的供应商退化为试错：按顺序尝试候选，首个成功者被记为「会话内健康」。
- **提前预警** —— 每次请求前检查当前路由额度：`warnAbsolute`/`warnRatio` 预警线按未来 `forecastSteps` 步投影，跌破时先发 `forecast-low` 提醒（不切换）；`thresholdAbsolute`/`thresholdRatio` 低于阈值时直接切换（不发失败请求），均记录 `llm/quota-warning`。
- **尊重用户切模型** —— 用户主动切换会话模型时，尊重其选择（不会被改回会话健康回退路由），并对新选模型做一次**强制（跳过缓存）额度复查**：若额度不足则预警并切到可用回退；若额度**不可观测**，则以本次请求作为真实可用性探测（`llm/quota-warning` reason 为 `unobservable`），失败则禁选该模型并回退。
- **一键恢复所有模型可用性** —— 逃生舱 `resetFallback(ctx)`（或 agent 可调用的 `llm-fallback-reset` 工具，需显式 `confirm: true`）清除插件对所有模型的全部路由决策（禁选、会话健康路由、失败风险、步进选择状态、额度缓存），使下一条请求从用户的模型选择与回退链重新决策。浏览器侧在输入框工具行提供一格低调按钮（`llm-fallback-reset` 状态行样式：次级文本、仅 hover 高亮提示可点），点击通过 `/llm-fallback-reset` 命令触发同样的复位。
- **按额度形态禁选** —— 充值 `balance` 耗尽即永久禁选；定时 `quota` 禁选至 `resetAt`；瞬时失败按 `cooldownMs` 冷却；不可观测路由只试错。

## Web 界面提示行

本包内置浏览器端伴生插件（通过包内 `dsh.client` 字段声明），DSH web 外壳在加载节点端的同时会自动加载它。它注册三个会话定义与三个键控聊天渲染器，把持久事件呈现在发生切换的确切位置：

- **`llm/fallback`** 每次切换渲染一行淡色提示 —— `⇄ 已自动切换模型：ds/chat → gl/haiku · 原因 QUOTA · 还可回退 2 个路由`。
- **`llm/quota-warning`** 每次提前切换、成本止损或余额预估预警渲染一行 —— `⚠ 额度预警：ds/chat 剩余 10（阈值 20），已提前切换`；预估预警为 `⚠ 余额预估：ds/chat 剩余 5，按未来 10 步约耗 0.01 预计不足，请留意余额`。
- **`llm/fallback-exhausted`** 回退链耗尽时渲染一行 —— `⛔ 回退链已耗尽：b/m2 第 3 次请求失败（原因 SERVER），已无可用路由`。

输入框的模型座位刻意继续显示你自己的选择：选择表达意图，路由由插件负责。每条回复实际使用的模型仍可在 Trajectory 视图的 provenance 中逐条查看，而这些提示行在会话内标记每一次切换。

部署方式：把本包安装进 DSH 部署树（即存放 `cordis.yml` 的目录）—— `npm install @kongfun2018/dsh-llm-fallback` —— 并在配置中注册节点端。`dsh web` 会自动把浏览器端以 `/plugins/@kongfun2018/dsh-llm-fallback/client.js` 提供并注入 boot manifest，无需额外接线。

## 切换策略模式

除默认的惰性链遍历外，`strategy` 以显式目标选择切换目标（完整设计见 [docs/strategy-design.md](docs/strategy-design.md)）：

- **`cost`（性价比）** —— 展开链上全部候选，只保留通过**任务支撑地板**者（模态覆盖 + 动态上下文窗口：当前用量 + `marginTokens`，且披露额度须覆盖本次请求），然后选**期望成本 × 风险**最低者（per-model 价格、provider 级回退；本会话失败过的路由与贴地板的窗口施加风险乘数）。
- **`performance`（性能）** —— 同一地板，按能力词典序（`reasoning` → `contextWindow` → `maxTokens`，每轴仅在显著比值下分胜负）选最强者，离群轴无法劫持选择。
- **`closest`（或不配 `strategy`）** —— 原惰性链遍历 + `preference` 平局偏好。

两模式共享一条不变式：**地板保证切换能完成任务，评分只在能完成者中选择**——撑不起上下文的最便宜模型永远不会被选中。性价比模式候选连续失败时，**升级阶梯**在 `afterFailures`（默认 2）次后以性能模式重新选择该步，任务完成优先于成本偏好。切换事件携带生效的 `mode`（性价比模式还有 `score`），且会话提示行会渲染该模式标签——性价比模式还带预估成本——于是每次切换都能在发生处直接解释（见 [docs/strategy-design.md §十三](docs/strategy-design.md)）。

## 配置

在宿主配置文件（`cordis.yml`）中注册插件——下面片段展示的是插件清单部分：第一个 `- name:` 是你的上游 provider 插件，第二个在本插件与之并列注册。

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'

- name: '@kongfun2018/dsh-llm-fallback'
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
    probe:
      enabled: true
      timeoutMs: 6000
      maxTokens: 1
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
      costCap: 5.0
      warnAbsolute: 100
      warnRatio: 0.4
      forecastSteps: 10
```

`fallbacks` 是有序回退链。带 `model` 的路由使用该确切模型；省略 `model` 的路由在其供应商内部按能力匹配选择。`codes` 是可切换失败码，`unusableCodes` 推进链但不禁选，`cooldownMs: 0` 表示会话内永久冷却瞬时失败。`pollIntervalMs` 定时复查主路由额度，额度恢复后在下一次请求前清除会话内健康缓存。`preference` 在同一供应商内多个能力对等候选之间打破平局：`closest`（默认，上下文窗口最接近）、`price`（非降级窗口最小）、`speed`（输出上限最小）、`reasoning`（优先暴露推理档位的模型）。

`probe`（默认关闭）在正式切换前，对选定的回退候选发送一次最小真实请求验证——目录里列得出 ≠ 实际可用，路由可能已上架却没有额度或适配器已损坏。`maxTokens`（默认 1）与 `timeoutMs`（默认 6000）保证探测开销极小；`prompt` 可自定义无操作 ping 文案。探测失败的候选被会话内禁选，链条推进到下一候选，并以 reason 为 `probe-failed` 的 `llm/fallback` 事件记录这次拒绝。在「不可用候选不能拖垮当前 turn」的部署里开启它——真实宿主的 `UNKNOWN_MODEL` 正是这一类失败。

额度查询按优先级依次解析：`static`（最高）→ `providers`（代码级可插拔查询源）→ `queryers`（声明式 HTTP 端点，响应采用 DeepSeek `/user/balance` 的 `{ is_available, balance_infos: [{ total_balance }] }` 形态）→ 内置 `deepseek` 源（DeepSeek `/user/balance` 端点，API key 经 `ctx.credentials` 或启动环境解析）。查询结果按 `cacheMs` 缓存并做单飞去重；任何查询失败都解析为「不可观测」，绝不阻塞请求。

`thresholdAbsolute` 与 `thresholdRatio`（剩余/总量）触发主动切换。当 `prices` 为某路由配置每百万 token 单价时，单次消耗预估（序列化会话估算的输入 token 数 + `estimatedOutputTokens`）也会在已披露的 `remaining` 不足以覆盖时触发切换；此时 `llm/quota-warning` 事件记录 `estimatedCost`、`inputPrice`、`outputPrice`。`costCap` 设定一个实例级累计预估成本预算：当插件累计的单次请求预估成本达到该上限，停止切换（让真实失败接管），并记录一条 reason 为 `cost-cap-reached` 的 `llm/quota-warning`。

`warnAbsolute` / `warnRatio`（可选 `forecastSteps`，默认 1）是**高于**切换阈值的提前预警层：当按未来 `forecastSteps` 步投影后的剩余额度（`remaining − 单步成本 × forecastSteps`；未配置单价的路由投影消耗为 0）跌破预警线时，记录一条 reason 为 `forecast-low` 的 `llm/quota-warning`——**只预警、不切换**。预警线应设置得比切换阈值更宽裕，让提醒先于降级发生。该预警按路由做水位锁存：进入预警区时触发一次，投影离开预警区（如充值）或路由变化后重新武装，因此缓慢消耗不会每步刷一行。`resetFallback` 会清除锁存。

## 事件

三类事件均为非表面事件，类型定义在浏览器安全的 `@kongfun2018/dsh-llm-fallback/types` 子路径中，远程渲染端无需加载运行时即可读取持久状态。

- `llm/fallback` —— 切换前记录：`{ turn, step, fromProvider, fromModel, toProvider, toModel, code, remaining, mode?, score?, reason? }`。`remaining` 数的是选中路由所在及之后的**链上位置数**，而非「确定可用的候选数」（策略/LLM 决策选择下，部分位置可能已被禁选或不满足地板）；且除非所选路由就是最后一条，否则它计入本次的 `remaining`。`mode` 是生效的策略模式、`score` 是该模式对所选路由的评分（性价比模式为预估成本）；`reason: 'probe-failed'` 标记候选被可用性探测拒绝——切换从未完成，事件记录这次拒绝。
- `llm/quota-warning` —— 请求前检查触发阈值、消耗预估、累计成本达上限（止损）、用户切换模型后额度不可观测，或提前预警跌破预警线时记录：`{ turn, step, provider, model, remaining?, total?, threshold?, estimatedCost?, inputPrice?, outputPrice?, costCap?, cumulativeCost?, projectedBurn?, forecastSteps?, reason }`，`reason` 为 `below-threshold`、`insufficient-cost`、`cost-cap-reached`、`unobservable` 或 `forecast-low`。
- `llm/fallback-exhausted` —— 合格失败且无回退候选（链条耗尽）时记录：`{ turn, step, provider, model, code, attempts }`，命名最后失败的路由与该步总请求数。

单独发布的 `./invariant` 伴随件校验每条记录都指向当前打开的 turn/step、标识非空、数值字段非负、`llm/fallback` 的 from/to 不同路由、`llm/fallback-exhausted` 的 `attempts ≥ 1`、`llm/quota-warning` 的 reason 合法。

## 已知限制与待办

- **输入 token 预估为粗略估算** —— 消耗校验将派生会话序列化后按每 4 字符 1 token 估算；精确 token 计量需要供应商计量数据源。**输出**侧已自动精化：当适配器在 `assistant/message` 事件上上报 `usage` 时，插件按供应商保留滚动均值（最近 8 个样本）用于投影，无样本时才回退到 `estimatedOutputTokens`（默认 1024）；`resetFallback` 会清空样本。
- **轮询为尽力而为** —— `pollIntervalMs` 复查主路由额度以清除过期的回退；它从不打断进行中的 turn，未披露重置时间的 quota 形态在两次请求之间仍保持不可观测。
- **健康缓存在会话内** —— 探测成功的路由持续优先，直到再次失败或额度检查否定；不跨会话持久化。
- **`llm/fallback` 记录的是切换而非完成** —— 后续 step 与 turn 事件确立成功或耗尽。
