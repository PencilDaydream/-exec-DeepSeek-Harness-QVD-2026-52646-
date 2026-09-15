# `exec.agent.ctx` 暴露链——证据清单

> 目的：把"为什么 `exec.agent.ctx` 会存在、它本来为谁设计、在哪里被沙箱复用"这条链上的
> **设计文档、代码、注释**集中到一处，便于逐条核对实际情况。
> 源码基准：`deepseek-harness` @ `c291e7961a`（0.1.5-rc.2，本文**实机验证**版本）；并在 npm 发布版 `0.1.6-alpha.1` 上做实机复现（`../verify/npm-alpha/`）；上游 master tip（`0d1f5000`）为静态核对，断点整包相同。
> 本目录只做**摘录与索引**，不改动源码；所有引用均给出 `file:line` 可回查。

## 目录内容

| 文件 | 内容 |
|---|---|
| `README.md` | 本清单：文档清单 / 代码清单 / 注释清单 / 暴露面 / 自查方法 |
| `code-excerpts.md` | **17 段逐字抽取的代码与注释**（`sed` 原样导出，注释为源码英文原文） |
| `notes/` | 6 份设计注记原文，每份含**英文原版 + 中文版**（`.zh.md`） |

## 一句话结论

`exec.agent`（显式身份）与 `agent.ctx`（agent 的注册作用域）都是**架构设计的一部分**（`exec.agent` 提供显式身份、`agent.ctx` 提供注册作用域），面向**宿主侧受信工具**；**超出设计假设的是传递路径**：未经投影的 `exec` 把它带过了沙箱边界；
断点在于**动态插件沙箱复用了同一个 `exec` 对象**：`apply(ctx)` 有 façade（明确要"关闭未受保护的 Context 逃逸"），
而 `execute(args, exec)` 的第二入参没有做任何投影。

```
agent loop ──ctx.tools.execute({ agent })──▶ 工具注册表 createExecution
                                                  │ 把 agent 原样放进 exec 的 base
                                                  ▼
                    ToolRunContext { callId, signal, agent, parent, token, deferContext, concludeTurn }
                                                  │
                     ┌────────────────────────────┴────────────────────────────┐
        宿主受信工具 execute(args, exec)                     动态包 execute(args, exec)（vm 沙箱）
        exec.agent.ctx = 该 agent 的注册层                   exec.agent.ctx = 同一个对象
        ✔ 设计本意（注册归属 / 隔离 / 回收）                   ✘ 断点（façade 未覆盖此路径）
```

---

## A. 文档清单（6 份注记，`notes/` 内为副本）

| # | 原件路径（checkout 内） | 中文版 | 它回答什么 | 关键原文（摘） |
|---|---|---|---|---|
| A1 | `.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md` | ✅ 同名 `.zh.md` | **为什么 agent 需要 ctx** | *"Every live agent owns one flat registration layer exposed as **`agent.ctx`**. Code registers through the context that owns a contribution…"* · *"`agent.ctx` carries registration ownership and the scope key; **it does not expose a reverse `agent` property**."* |
| A2 | `.agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.md` | ✅ | `agent.ctx` 的**运行时实现与正确性** | *"All agents share one Cordis service graph. A derived context **does not clone** `ToolRuntime`/`SystemPrompt`/persistence… Service calls **still reach the shared instances**."*（→ 说明 agent.ctx 不是降权上下文，而是同一服务图 + 作用域标签） |
| A3 | `.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md` | ✅ | **两个正交概念**：Context=注册/生命周期，Agent=操作主体；为什么身份要显式传 | *"A Cordis `Context` selects services, **registration ownership**, and lifetime; `agent.ctx` is the flat registration scope owned by one live Agent. Agent and Session identity instead describe **the subject of an asynchronous operation**."* · 并点名 `ToolExecution.agent` 属"显式契约" · 结论段：*"carries a **capability-bearing Agent object**. Consumers must **restrict it to cross-cutting infrastructure**…"* |
| A4 | `.agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.md` | ✅ | 为什么**禁止 Context 反向携带 Agent** | *"`agent.ctx` remains the registration and lifecycle owner and **exposes no reverse Agent property**."* |
| A5 | `.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md` | ✅ | **动态包的定位（信任立场）** | *"This is an opt-in development tool with **bash-equivalent trust, not a security boundary or product default**."* · *"the façade … **to close the unguarded-context escape**, but the capabilities the façade exposes (`ctx.shell`, `ctx.fs`, `ctx.web`) reach the real runtime, so it is not a security boundary … would fight the entire point — **handing the model the live runtime**."* |
| A6 | `.agents/notes/implemented/bug-fix/2026-08-06-bwrap-private-pid-namespace.md` | ✅ | 新版 `--unshare-pid` 实际修的是什么（**另一个**逃生口） | *"A confined command could therefore see host processes and follow procfs magic links such as `/proc/<pid>/root` … **escaped the profile's read-only host-root bind and `workspace-write` allow-list**."* |

---

## B. 代码清单（详见 `code-excerpts.md` 对应小节）

| # | 位置 | 是什么 | 在证据链里的角色 |
|---|---|---|---|
| B1 | `packages/core/tools/src/index.ts:307-331` | `ToolExecutionInput`（含 `readonly agent?: Agent`） | **exec 里为什么有 agent**：文档化字段，注释写明 "set by the agent loop" |
| B2 | `packages/core/tools/src/index.ts:372-417` | `ToolExecution` / `ToolRunContext` 全部字段 | exec 的完整能力面（token/rootCallId/deferContext/concludeTurn…） |
| B3 | `packages/core/tools/src/index.ts:1354-1400` | `createExecution()` | **组装点**：`const agent = exec.agent` → `base = { …, agent }`，原样进入运行时上下文 |
| B4 | `packages/core/agent-loop/src/tool-calls.ts:62-80` | 真实派发 | `const agent = ctx.agents.requireInitiator()` → `exec: { callId, name, arguments, agent, signal }` |
| B5 | `packages/core/agent/src/types.ts:12-18` | 公开 `Agent` 契约 | **只有 `{ readonly id }`**（契约面很窄） |
| B6 | `packages/core/agent/src/runtime-types.ts:160-245` | Agent 运行时增补 | 实际多出 `options / session / inbox / status / **ctx**` 与方法（cancel/whenIdle/send/steer/inject…） |
| B7 | `packages/extensions/cordis-host-runner/src/guard.ts:558-592` | `harness.defineTool` 包装 | **断点代码**：`async execute(args, exec){ return cloneJson(await rawExecute(args, exec)) }` —— 只规范化返回值，`exec` 原样进 vm |
| B8 | `guard.ts:630-700` | apply 的 façade（`CTX_VERBS` + `denyContext`） | 设计意图：白名单动词；**拒绝返回 Context 的服务** |
| B9 | `guard.ts:712-800` | `sandboxContext()` | 拒绝框架内部（root/fiber/registry/extend/plugin…），inject 需声明 |
| B10 | `packages/extensions/cordis-client-runner/src/client/guard.ts:1-30` | 浏览器半边 | 自述 *"The browser twin of the tool-cordis context facade"* —— **两侧都建了 façade**，说明"不给沙箱 Context"是明确意图 |
| B11 | `packages/extensions/cordis-host-runner/README.md:50-56` | §Trust stance | *"The sandbox isolates globals but **is not a security boundary** … **Treat a dynamic package like bash access**"* |
| B12 | `packages/extensions/cordis-host-runner/src/sandbox.ts:96-145`（另见文件头 :7） | vm 全局与陷阱 | 注入仅 `harness/console/btoa/atob/TextEncoder/Decoder`；`require/fetch/timers` 抛错陷阱；`process` 为 undefined。文件头自陈 *"is not containment…"* |
| B13 | `packages/extensions/tool-cordis/src/api-catalog.ts:3575-3581` | **模型可见**类型目录 | `export interface Agent { readonly id: SessionId }` —— 契约上没打算给 `ctx` |
| B14 | `packages/extensions/tool-cordis/src/api-catalog.ts:6119-6126` | 模型可见 `ToolRunContext` 声明 | 与运行时一致地列出字段；`agent` 指向上面那个窄 `Agent` |
| B15 | `packages/subprocess/subprocess-local/src/index.ts:1-12` | subprocess 缝自述 | *"It has no config: every disposition and limit arrives on the spec…"*（**缝对沙箱无感知**，约束外包给调用方） |
| B16 | `packages/sandbox/sandbox-local/src/profiles.ts:10-24` | bwrap profile | 新版含 `--unshare-pid`；`workspace-write` 追加 `--tmpfs /tmp` 与 workspace bind |

---

## C. 注释清单（代码里逐字可查的关键注释）

| 位置 | 原文 | 中文 |
|---|---|---|
| `packages/core/tools/src/index.ts:317` | The agent on whose behalf the call runs (set by the agent loop). | 本次调用所代表的 agent（由 agent loop 设置）。 |
| `packages/core/agent/src/types.ts:11` | Public live-agent handle; the runtime face augments its live capabilities. | 公开的活 agent 句柄；运行时面会增补其活能力。 |
| `packages/core/agent/src/runtime-types.ts:173` | Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. | agent 作用域上下文；其贡献仅对该 agent 可见，随销毁回收，之后拒绝注册。 |
| `packages/core/tools/src/index.ts:320-322` | …so commit-style observers can wait for the outer `run_code` outcome **without receiving its live mutable execution**. | （parent 用不透明 token 的用意）让观察者能等外层结果，**而拿不到活的、可变执行对象**——同一份 exec 里"知道要投影"的先例。 |
| `packages/extensions/cordis-host-runner/src/guard.ts:657-661` | Harness services return data, never a context; a value that is one would be a fresh, unguarded handle back into the runtime — **the exact escape the façade exists to close** — so it fails loud instead of reaching sandbox code. | harness 服务只返回数据、绝不返回 context；返回 context 就等于把一把**未受保护的运行时把手**交给沙箱——**这正是 façade 存在的意义所在**，故响亮失败。 |
| `packages/extensions/cordis-host-runner/src/guard.ts:730-733` | `sandbox ctx does not expose "…"…` / **Framework internals (root, fiber, registry, extend, plugin, …) are withheld by design.** | 沙箱 ctx 不暴露该属性；框架内部按设计不提供。 |
| `packages/extensions/cordis-host-runner/README.md:54` | The sandbox isolates globals but is not a security boundary … **Treat a dynamic package like bash access**. | 沙箱只隔离全局，**不是安全边界**……把动态包**当作 bash 访问**对待。 |
| `.agents/notes/…/2026-07-08-self-referential-cordis-toolset.md:80` | …narrow the API mount code sees … **to close the unguarded-context escape** … it is not a security boundary … would fight the entire point — **handing the model the live runtime**. | façade 把 API 收窄到 cordis 服务、**以关闭未受保护的 context 逃逸**；但它不是安全边界；做真正的沙箱会违背整个要点——**把活运行时交给模型**。 |
| `.agents/notes/…/2026-07-15-agent-initiator-scope.md`（Consequences） | …carries a **capability-bearing Agent object**. Consumers must **restrict it to cross-cutting infrastructure**, treat ambient presence as neither liveness nor authorization… | 它**自带能力**；消费者必须**只把它用于跨切面基础设施**，且不得把它的存在当作存活或授权依据。 |
| `.agents/notes/…/2026-07-08-agent-scope-contexts.md:17,19` | Every live agent owns one flat registration layer exposed as `agent.ctx`… it does not expose a reverse `agent` property. | 每个活 agent 拥有一个扁平注册层即 `agent.ctx`……它不反向暴露 `agent` 属性。 |
| `.agents/notes/…/2026-08-31-explicit-agent-runtime-identity.md:17` | `agent.ctx` remains the registration and lifecycle owner and exposes no reverse Agent property. | `agent.ctx` 仍是注册与生命周期所有者，且不反向暴露 Agent。 |

---

## D. 三个对象的暴露面（核对结论）

| 对象 | 文档/公开契约 | 运行时实际 | 沙箱路径是否投影 |
|---|---|---|---|
| `exec` | `ToolRunContext`：`callId, rootCallId, name, arguments, agent?, parent?, signal, token, deferContext(), concludeTurn()` | 完全一致，**原样**（只对返回值 `cloneJson`） | ❌ |
| `agent` | `{ readonly id: SessionId }`（连模型可见目录也这么写） | `id` + `options / session / inbox / status / **ctx**` + 方法 | ❌ |
| `ctx` | —— | 完整 cordis Context（`get/provide/plugin/effect/on/emit/inject/isolate/reflect/registry/fiber/root` + 全部服务） | ❌（façade 只覆盖 `apply`） |
| 附带 | —— | `agent.session` 也是完整 Session 对象 | ❌ |

**用量佐证（源码，非测试）**：`exec.signal` 135 处、`exec.agent` **116 处**、`exec.callId` 16、`exec.parent` 15、`exec.rootCallId` 4、`exec.deferContext` 3、`exec.concludeTurn` 2。
典型消费：`tool-jobs` 用 `exec.agent` 做作业归属隔离；`session-query/workspace-access` 用它定工作区；`repeat-tool-reminder` 用它做按 agent 计数；`tool-cordis` inspect 必须 `requireAgent(exec)`。

---

## E. 自己核对 / 复现的方法

```bash
CO=/path/to/deepseek-harness

# 1) 断点代码：exec 原样进 vm
sed -n '558,592p' $CO/packages/extensions/cordis-host-runner/src/guard.ts

# 2) agent 组装点
sed -n '1354,1400p' $CO/packages/core/tools/src/index.ts
sed -n '62,80p'    $CO/packages/core/agent-loop/src/tool-calls.ts

# 3) 公开契约 vs 运行时面
sed -n '12,18p'    $CO/packages/core/agent/src/types.ts
sed -n '160,200p'  $CO/packages/core/agent/src/runtime-types.ts

# 4) 信任立场与 façade 意图
sed -n '50,56p'    $CO/packages/extensions/cordis-host-runner/README.md
grep -rn "exists to close" $CO/packages/extensions/cordis-host-runner/src   # 注意该句在源码中跨两行

# 5) 模型可见契约
sed -n '3575,3581p' $CO/packages/extensions/tool-cordis/src/api-catalog.ts

# 6) 实测（沙箱内拿到 ctx 能做什么）：workspace-write 下运行
cd $CO && node_modules/.bin/tsx ../dsh-security-pocs/scripts/verify-v4-v4b-0.1.5.ts
cd $CO && node_modules/.bin/tsx ../dsh-security-pocs/scripts/ctx-capabilities-probe.ts
```

相关实测脚本与结论：
- `../scripts/verify-v4-v4b-0.1.5.ts` —— 在本文测试版本（0.1.5-rc.2）上 V4b 复验（仍可复现）
- `../scripts/ctx-capabilities-probe.ts` —— 沙箱内 ctx 能力实测（inject 绕过 / 注册服务 / 事件 / spawn）
- `../analysis/ctx-capabilities.md` —— 拿到 ctx 后的完整能力分类
- `../analysis/v4b-attack-chain.md` —— 攻击链与边界分析主文档

---

## F. 一句话

`exec.agent` 与 `agent.ctx` 的每一环都是为**受信宿主工具**设计的（正确的作用域归属与生命周期回收）；
它们从未打算成为不可信插件的能力来源——**沙箱边界少了 `exec` 的投影**，才是需要修的那一处。
