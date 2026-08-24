# llm-fallback 代码审查报告（Linus 视角）

> 审查对象：`@kongfun2018/dsh-llm-fallback`（`E:\Codes\private\dsh-llm-fallback`）
> 覆盖版本：`main` 分支 HEAD `985027b` + 当前工作区未提交改动（`safeToolName` 重命名 + `lib` 产物 + 测试新增）
> 测试基线：`npm test` —— **87/87 通过**（fallback 51 + strategy 19 + client-ui 17）

---

## 结论：**驳回（有条件修复后重新提交）**

这插件**能治它想治的病**——跨 provider 失败切换、额度感知、两阶段探测、三种切换策略，逻辑上是自洽的，测试纪律是罕见的扎实。作为功能原型我很满意。

但我**不可能通过**一段会在常驻守护进程里**跨 session 泄漏引用**、在一个扩展点 handler 里**同步阻塞网络 I/O**、并且把**一千二百行逻辑堆进一个闭包**的代码。这三条都不谈风格——是运行时的正确性和存活性问题。

**驳回前必须修的（P0，三条）：**

1. **`knownAgents` 强引用泄漏。** `src/index.ts:873` `const knownAgents = new Set<Agent>()`，只在 `:1030` `knownAgents.add(agent)`，**从不 delete**。`states`/`sessionAgents` 用 WeakMap 是对的，但 `knownAgents` 用强 Set 收留了**每一个见过的 agent**，活到插件进程结束。在 web 这种常驻进程里，开几天就是几千个僵尸 agent 对象、以及每次 poll/reset 对它们的无谓遍历。**修法**：改 `WeakSet<Agent>`，或依赖 `agent` 生命周期事件主动 `delete`；`totalAgents` 也相应在删除时自减。诊断统计（`getFallbackStats`）必须与真实存活量一致，否则它本身就是误导。

2. **`agent/request` 瀑布里同步做网络 I/O，阻塞真实 LLM 请求。** 这个 handler 在每次请求时（`index.ts:1051`）`await checkQuota(...)`，冷缓存时是**一次 fetch 网络往返**，跑在请求派发的水管正中间；下面接着 `capabilityOf` + 策略 `selectNext` 的**全链展开 + 逐候选 resolveModelInfo + 逐候选 checkQuota**。等于说：这个插件在额度要报警的那一次请求上，先把每个候选的 catalog 和余额全问一遍，才把请求发出去。省下来的是一次注定失败的调用，代价是每次切换都拖慢主请求。**修法**：预选只读缓存/最近一次的成功选型；有地板必需的 resolve 只在真正需要时做；把与请求无关的预选移到 `agent/request` 之前、用 `signal` 短路（已经在 `request-error`/poll 里有了 `AbortController`，预选路径没有）。

3. **`apply()` 是 1200 行的单体闭包。** 一个函数塞了：配置 schema 之外的所有校验、可选模型匹配、目录解析、额度引擎（缓存/单飞/多源）、四路 `selectNext*`、事件接线、tool 注册、command 注册、poll 定时器、状态机。可读性和可维护性都不达标——任何一个行为改了都得先在这个函数里定位三处地方。**修法**：按已在 `strategy.ts` 做到的"纯函数分离"的好习惯，把 `apply` 拆成几个带明确依赖注入的构造器（quota 引擎 / 选择器 / 生命周期接线各一），每个都明确参数化 `(ctx, config) => handle`。

---

## 第一轴：代码质量与可维护性

### 做得对的
- **纯策略层 `strategy.ts` 是模范**：纯函数、同步、无副作用、顶层注释把"地板保证完成/评分只决定选谁"讲明白了。`selectByStrategy` / `comparePerformance` / `costScore` 都可单测、确定性、无隐藏 I/O。这才是 DSH 插件该有的分层。
- **JSDoc 密度和质量高**，几乎每个导出的类型/函数都写清了"为什么"。`QuotaProvider.check` 注释里那句"throw 表示探测本身失败，不可当作额度耗尽，返回 undefined 表示不可观测"——这是把领域陷阱写进接口的好做法。
- **事件 payload 有了 invariant 校验**（`invariant.ts`），还锁了 `SessionEventMap` 扩展一致（`types.ts:175`）。这种"事件落地前约束"在插件生态里太少见了。

### 没做对的
- **`apply` 巨型闭包**（见 P0-3）。
- **`index.ts` 里夹杂纯量工具与插件体**：`safeToolName`、`matchModel`、`compareCandidates`、`capabilityOf`、`queryBalanceEndpoint`、`estimateInputTokens`、`estimateCost` 等，有的导出有的不导出，散在 56–500 行之间，和 `apply` 同模块。要么全部进一个 `internals.ts`，要么留 `strategy.ts` 那种独立层。
- **`safeToolName` 是事后补丁。** 提交记录里工具名曾经是 `llm-fallback/reset`（非法，`/` 会被严格 function-calling 拒绝），现在未提交改动改成 `llm-fallback-reset` 并加了 `safeToolName` 兜底。兜底函数本身没错，但它包住的是一个**已发布的破坏性重命名**——已有会话里记下的 tool call 名会失效。改名应走版本化（alias 兼容），而不是默默换名再加个防回归图层。

## 第二轴：性能

- **请求内瀑布阻塞**（P0-2），最重一条。
- **全链 Eager 展开无上限。** `selectNextByStrategy`（`index.ts:679`）和 `selectNextByDecision`（`:616`）对链上每个 entry：`listModels(provider) → 逐 id resolveModelInfo`。候选多、provider 多的部署，一次切换就是几十次 catalog resolve。`selectNextByRules` 的 `selectModel` 也对每个无 model 的 provider **全目录重扫**一遍再匹配合法名。这些每次 `request-error` 都重跑，不做目录级缓存。
- **`estimateInputTokens` 每次全量 `JSON.stringify(deriveMessages())`**（`:428`）——在 request 瀑布里对一份可能上百 KB 的会话历史做序列化，只为了 `length/4`。成本预估低频需求犯不着每次全量序列化。
- poll 里 `new AbortController().signal` **每个 agent 每次 tick 现场 new 一个**（`:1164`），是纯浪费（`AbortSignal` 可直接复用），agent 多时放大。

## 第三轴：错误处理与健壮性

- **"永不阻断请求"哲学贯彻到位**：`capabilityOf(...).catch(()=>undefined)`、`checkQuota` 内部全 `.catch(()=>undefined)`、`source.check(...).catch`、decision/balance 全程吞错落 undefined。——这是加分项，方向对（fallback 不该因探测而杀死请求）。
- 但有代价：**错误被一律抹成 `undefined`，无法区分「不可观测」「探测失败」「额度耗尽」。** `QuotaCheck.kind = 'unobservable'` 是有意义的区分，但跨 `.catch(()=>undefined)` 全丢了——额度引擎里真正到 `unobservable` 的状态很少能产生，多数故障都塌缩成 undefined（被误当"没配"）。

## 第四轴：设计合理性

- **三层选型架构（决策 provider → 策略 → 规则）派发顺序**（`selectNext` `:543`）设计清晰，兼容旧 `closest` 路径，文档 `strategy-design.md` 与实现一致——这是高质量的取舍。
- **升级阶梯（cost→performance）放 `StepState` 里按步计数**（`:1124`），是正确的作用域（新步归零、同一步内连锁失败才升级），不是 session 级误伤。设计严谨。
- 设计遗留矛盾：`nextCursor` **语义在两条路径不一致**——规则路径返回 `index+1`（推进到下一链项），策略路径返回 `chainIndex`（"驻足"，靠 ban 表反重访，见 `:742` 注释）。这个分歧是刻意的，但**两处各写各的原因**，未来维护者极易被其中一个骗到。应当在 `SelectionOutcome` 上把"cursor 是否从赢得位置继续 vs 从链上推进"显式建模，而不是靠一句注释。

## 第五轴：工作区卫生与既成事实

- **未提交改动把 `lib/*`（构建产物）也改进了 diff。** 仓库 `git ls-files` 里 `lib/` 是被跟踪的（`31a4de1` "commit lib artifacts"），说明这是 git-based install 的刻意决定。但**手改产物 + 手改源码双轨**是风险源：这次 `src/index.ts` 和 `lib/index.js` 必须同步，若未来只改一个就漂移。建议 `build` 纳入 CI（CI 里已有），并接受产物提交是"发布物"，不在日常 diff 里混入手改。
- 测试里 `harness` 耦合了 `scripts`（Adapter 的脚本队列）+ `ctx.on('agent/request')` 自定义改写来模拟 `installModelSelection`——测试很聪明，但**每条用例的 setup 里埋了 4~8 行覆写样板**，是未来容易踩的坑；抽个 `switchPrimaryOnTurn(n, route)` helper 会干净很多。属非阻塞建议。

---

## 行动计划（按优先级）

| 级别 | 事项 | 位置 | 动作 |
|---|---|---|---|
| P0 | `knownAgents` 强引用泄漏 | `src/index.ts:873,1030` | 换 WeakSet 或接生命周期删引用；`totalAgents` 同步自减 |
| P0 | 请求瀑布内同步网络阻塞 | `src/index.ts:1051` 等 | 预选只读缓存/短路，把 catalog+余额探测移出 `agent/request` 水管 |
| P0 | `apply` 1200 行单体 | `src/index.ts:756-1187` | 拆 quota 引擎 / 选择器 / 生命周期接线三个构造器 |
| P1 | 全链 Eager 展开 + 无目录缓存 | `:616,679,594` | resolveModelInfo 目录级 TTL 缓存；规则路径最小化重扫 |
| P1 | 错误全塌缩成 undefined | 额度 / capability 各处 | 保留"不可观测 vs 探测失败"信号，别一刀 `.catch(()=>undefined)` |
| P1 | 破坏性工具改名无别名 | `safeToolName` 用例 | alias 兼容旧 `llm-fallback/reset` |
| P1 | `nextCursor` 双语义靠注释 | `:745,591` | 用显式类型建模 cursor 语义 |
| P2 | `estimateInputTokens` 全量序列化 | `:428` | 增量/采样，别每次 stringify 整个历史 |
| P2 | poll 每次 new AbortController | `:1164` | 复用共享 signal / `AbortSignal.timeout` |
| P2 | `totalSteps`/`totalAgents` 计数漂移 | `:1007-1011` | 归一到"由持有状态推导"，或从存储 size() 读取 |

**一句话给作者**：状态机和测试不是问题，问题在"常驻进程里的生命周期"和"扩展点里的阻塞"。把泄漏堵上、把瀑布拆开、把 apply 拆层，这三件做完，这插件就是过得去的工程，而不只是好原型。
