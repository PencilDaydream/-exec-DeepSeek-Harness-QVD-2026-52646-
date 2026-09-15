# V4b 复盘：exec 逃逸 → 裸子进程 → 无约束宿主 RCE

> 范围：`poc-v4b-exec-escape-to-rce.ts` 指向的漏洞与攻击链。
> 版本：deepseek-harness 0.1.0-rc.5（预发布）。所有行号均对应当前 checkout 源码。
> 本文只谈 V4b；V1/V2 不在讨论范围，仅在涉及其作为链的一环时顺带提及。

---

## 0. 一句话结论

动态插件（模型编写、本应被沙箱关住的代码）在**工具被执行**的那一刻，通过 `execute(args, exec)` 的第二个参数拿到了**宿主真实的 `ToolRunContext`**；`exec.agent.ctx` 就是宿主运行时 Context，从中 `ctx.get('subprocess')` 取到本地子进程服务，而该服务的 `spawn` **对沙箱无感知**——于是沙箱代码直接拉起一个**无任何 DSH 约束**的宿主进程。全程**不需要文件写入、不需要审批**。这是"内容 → 模型 → 动态包 → 宿主进程"链的最后一步，把一次 prompt injection 放大成 RCE。

---

## 1. 攻击链逐步复盘

```
① 恶意内容（网页/仓库/文档/邮件）
        │  prompt injection：诱导模型执行定义+运行+调用
        ▼
② 模型调用 cordis_define + cordis_run（默认组合零审批）
        │  代码进入 node:vm 沙箱 realm，被挂载成动态包
        ▼
③ 工具的 execute(args, exec) 被真实注册表调用
        │  guard 包装只对返回值 cloneJson，exec 原样透传进 vm
        ▼
④ exec.agent.ctx  = 宿主真实 Context（未被 facade 替换）
        │  ctx.get('subprocess')  → 本地子进程服务
        ▼
⑤ subprocess.spawn('/bin/sh -c "…"')  → 宿主进程
        │  无 landlock / seatbelt / bwrap / argv 包裹
        ▼
⑥ 任意宿主进程 → 读任意文件 / 外传 / 持久化（patch 配置 + !!js）
```

**关键语义**：加载（define+run）只是"上膛"，真正"开火"发生在**工具被调用**（`ctx.tools.execute`）那一刻。诱导模型注册完工具后，再诱导它调用一次即可。

---

## 2. 问题代码定位

| # | 位置 | 片段（要点） | 问题 |
|---|---|---|---|
| A | `packages/extensions/cordis-host-runner/src/guard.ts:581-583` | `async execute(args, exec){ return cloneJson(await rawExecute(args, exec), '…execute result') }` | `rawExecute` 是 vm 域函数；`exec`（宿主 `ToolRunContext`）**原样传进 vm**，只有返回值被 `cloneJson` |
| B | `packages/core/tools/src/index.ts:404` `ToolRunContext extends ToolExecution`；`:324` `agent` 字段（"set by the agent loop"） | `exec.agent` 是活的 `Agent` | `exec.agent.ctx` 即宿主 Context；这把"整个运行时"当参数交了出去 |
| C | `packages/extensions/cordis-host-runner/src/guard.ts:632-800`（facade） | `CTX_VERBS` 白名单、`denyContext`、`sandboxContext` Proxy、`guardedService` | **apply(ctx) 的 ctx 有 facade 加固**——但 execute 的第二入参没有走任何等价防护（不对称） |
| D | `packages/subprocess/subprocess-local/src/index.ts:2-8,146-147` | "Each spawn is a detached process tree… It has no config"；`spawn(spec)→spawnSubprocess(...)` | **seam 自身对沙箱无感知**：约束不在提供者，而在"约定只有 bash-sandbox 会调它" |
| E | `packages/shell/bash-sandbox/src/index.ts:177-179` | `confine(cmd, policy){ return this.ctx.sandbox.confine(['bash','-c',cmd], policy) }` | OS 级约束（landlock/seatbelt/bwrap argv 包裹）**只在 shell 层**；直连 subprocess 缝就绕过 |
| F | `packages/extensions/cordis-host-runner/src/sandbox.ts` | `createContext/runInContext`；全局只有 `harness/console/btoa/atob/TextEncoder/TextDecoder`；`require/fetch/setTimeout` 是抛错陷阱；`process` 保持 `undefined` | 沙箱本身"空手"是对的；但注释第 7 行自陈 **"vm is not containment: host-realm helper functions remain an escape route"** |

（`harness.defineTool` 对 `execute` 只做"校验是函数 + 包一层 cloneJson"，见 guard.ts:562-583；`harness.registerTool` 走 `ctx.tools.register`，本身无害。）

---

## 3. 出问题的逻辑，原本期望的能力是什么

1. **`harness.defineTool`**：让模型安全地**声明**一个工具——name/description/parameters/output.schema 被规范化与校验（`assertSupportedJsonSchema`），`render` 返回值被 shape-check + `cloneJson`，保证"进出注册表的都是宿主可用的普通 JSON"。期望：模型的代码只生产"数据形态"的工具定义，碰不到运行时对象。
2. **`execute(args, exec)`**：工具实现的执行上下文。`exec` 的设计用途是**回传通道与调度信息**——`signal`（取消）、`deferContext`、`concludeTurn`、callId/agent 标识等，供工具把结果、附带上下文、终态信号交给 agent 循环。**期望它只暴露这些最小信息，而不是整个运行时。**
3. **subprocess 能力缝（capability seam）**：一个通用的"进程能力"服务，`spawn(spec)` 按 spec（argv/cwd/stdio/graceMs）起进程。**期望**：约束在调用方（bash executor、LSP host…）按各自 policy 施加；`SubprocessRuntime` 保持通用、不掺沙箱逻辑。这个"期望"本身就是漏洞根因——它把**安全不变量**从提供者移到了调用方的自觉。
4. **facade ctx（apply 入参）**：只给白名单动词 + 声明过的服务 + 拒绝返回 Context。期望：模型代码通过它只能注册工具、观察事件、用注入的服务，**永远拿不到"另一个 Context"这把万能钥匙**。

一句话：**每个局部设计都"合理"，但 `execute` 的第二入参恰好是那条没有走 facade 的缝，而 subprocess 提供者恰好又是那条把约束外包给调用方的缝。两条缝一对接，沙箱就只剩一层 node:vm 的 JS 隔离——而它本身就不是围栏。**

---

## 4. 当前版本的安全策略与边界（本意）

| 层 | 机制 | 意图 |
|---|---|---|
| 信任分层 | 宿主 packages 可信；模型输出不可信 | 把"模型能干什么"当作攻击面治理 |
| vm 沙箱 | `node:vm` 新 realm + 受限全局 | 让模型代码无 `fs/process/require`，只能经注入 API 动作 |
| facade ctx | `guard.ts` 的 `sandboxContext` Proxy | apply 阶段白名单：动词 + 声明式 inject + 拒绝 Context 返回值 |
| 工具注册边界 | `harness.defineTool/registerTool` 规范化 + 校验 + cloneJson | 进出注册表只许"数据" |
| 能力缝 | subprocess / web / fs 等服务提供者 | 每个可替换能力一个提供者，组合可配置 |
| shell 层约束 | `bash-sandbox.confine` → landlock/seatbelt/bwrap | 模型调 bash 时把 argv 包进 OS 约束 |
| 审批 | 特权动作走审批管线 | 人批准才放行高风险操作 |
| 文件沙箱 | workspace-write 等 mode + writableRoots | 限制模型工具层可写范围 |

**这套模型的成立前提是**：模型代码永远只能通过"受治的缝"（facade ctx、被 confine 的 bash、被 allowlist 的服务）触达宿主。V4b 证明这个前提有一个洞：`execute` 缝裸传 `exec`，`subprocess` 缝裸出 `spawn`。

---

## 5. 安全边界的问题在哪里

1. **约束错位（最核心）**：进程执行的 OS 约束只存在于 shell 层（bash-sandbox），`SubprocessRuntime` 自己**对沙箱无感知**。任何直连 `ctx.subprocess.spawn` 的调用方都是裸奔。约束应当内聚到 seam 的执行点（README 的 P0）。
2. **最小权限缺失**：`exec` 携带 `agent` → `agent.ctx`（整个宿主 Context），等于把运行时根对象当普通参数传递。正确做法是传一个**剥离 `agent.ctx` 的 facade exec**（只留 signal/callId/deferContext/concludeTurn 等回传能力）。
3. **不对称防护**：同一份模型代码的两个入口，`apply(ctx)` 有 `sandboxContext` 白名单，`execute(args, exec)` 的 `exec` 却裸传。防住了第一个参数、漏了第二个——典型的"两个入口只守一个"。
4. **vm 不是围栏，且依赖"意外"**：`sandbox.ts` 官方注释自陈 vm 非 containment；V4b 文件头还记录了一次"第一版攻击"是被 `instanceof Object` 的**跨 realm 边界意外**挡住的（见 §6.5）。防线建立在 JS realm 细节而非显式不变量上，属于脆性防御。
5. **默认零审批**：`cordis_define` + `cordis_run` 在默认组合里没有接审批管线。整个链（define→run→调用工具）可被一次 prompt injection 全自动完成，无需任何用户交互。
6. **inject 无白名单**：动态包能 `inject` 服务名（V2 报告的 `['fs','web']` 读机密），缺 allowlist 与审批接线（README P1）。
7. **配置即代码的旁路**：`!!js` 配置在宿主 loader 插值期求值（V1），意味着模型一旦能写配置文件（自修改 / patch），就有一条**不依赖本漏洞**的宿主执行路径——它与 V4b 组合成"持久化腿"。
8. **检测与审计缺失**：seam 无运行时 invariant（例如"无 policy 的 spawn 拒绝 / 记录审计事件"），逃逸行为没有任何硬性拦截点。

---

## 6. 值得进一步分析的问题（我的思考）

**6.1 为什么约束没进 seam？如何在不牺牲通用性下强制它？**
`SubprocessRuntime` 有意不加 config、约束留给调用方，是为了让 bash/LSP/terminal 等复用。但"谁都能裸调"恰恰是洞。可以探讨把约束做成契约：`spawn` 要求调用方提供 confinement 证据（policy/token），类型或运行时强制"无 policy 不 spawn"——把自觉变成硬约束。

**6.2 除 bash-sandbox 外，还有哪些调用方直连 subprocess？**
bash executor 有 confine，但 LSP host、terminal、code-mode、各工具会不会也直连 `spawn`？每个漏网调用方都是同款 RCE。建议全仓审计 `ctx.subprocess.spawn` / `get('subprocess')` 的调用点。

**6.3 `exec` 里到底还携带了多少宿主对象？facade 化到哪个粒度？**
`ToolRunContext` 除 `agent` 外还有 `signal`、`deferContext`、`concludeTurn`、若干调度钩子。逐一评估：哪些必须保留、哪些必须剥掉。尤其 `agent` 能否降级成 `{ id, scope }` 这种纯数据，而不是带着 `.ctx` 的活对象。

**6.4 realm 泄漏面是否只有 `exec`？**
`harness` 的 `defineTool` 闭包、`render/presentationMeta/handle` 的宿主闭包、`cloneJson/denyContext` 等，都是"宿主函数进到 vm 作用域"的入口。闭包作用域链（`Function` 构造、`arguments.callee.caller`、原型链污染）值得逐一做逃逸测试。

**6.5 跨 realm `instanceof` 的"意外防御"能被打通吗？**
V4b 记录第一版 `loader.create({config:{__jsExpr}})` 被 vm 对象的 `instanceof Object` 拦下。若攻击者先让 vm 对象经 `JSON.stringify/parse`（或 cloneJson）往返变成宿主 Object，再塞回 `__jsExpr`，是否就绕过了这条 realm 边界、直接激活 V1 的宿主求值？值得实证——这可能是一条 V1×V4 组合的独立 RCE 路径。

**6.6 审批接入后，粒度该怎么定？**
define/run 接审批后：是"运行一个动态包"批一次，还是"每次工具调用"都批？前者对 agent 可用性友好但仍是 RCE 授权；后者安全但打断自主性。需要与产品形态（自主 agent vs 交互式助手）一起权衡。

**6.7 可观测性/回滚在哪里？**
动态包 注册→调用→spawn 全链路缺少审计事件与回滚手段。建议：seam 打点、拒绝无 policy spawn、把"哪个包拉起了哪个进程"写进会话日志，使 V4b 行为可被事后发现。

**6.8 最小运行账户作为纵深兜底。**
即便 DSH 全部缝都修好，仍应让 harness 进程以**受限 uid** 运行（非用户主账户），叠加文件沙箱，使"任意宿主进程"的爆炸半径被 OS 层进一步压缩。

**6.9 测试断言的口径。**
`sandbox-context.spec.ts` 只覆盖 apply facade，漏掉 execute/exec 面（README 已指出）。且按 AGENTS.md 的 invariant 规则，断言应落在"关系"（沙箱代码永远拿不到宿主 Context）而非"方法是否存在"——用可复现的关系不变量锁定这条缝。

---

## 7. 修复建议对照（README P0/P1/P2）

- **P0**：`execute` 传剥离 `agent.ctx` 的 facade exec（guard.ts）；让 `SubprocessRuntime` 自我约束——约束属于 seam 的执行点，而非"只有 bash-sandbox 会调它"的约定。
- **P1**：动态包 inject 白名单；define/run 接入审批；只读模式排除机密目录。
- **P2**：boot 期检查"已加载配置目录 ∉ 可写根"，重叠即响亮失败（封住 V1 持久化腿）。

---

## 8. 附：本会话的实测验证矩阵

本环境在 DSH 之外还有一层**外层工具沙箱**（文件策略 workspace-write / danger-full-access），它与 DSH 无关，但正好用于区分"DSH 边界"与"宿主写盘边界"：

| 载荷路径 | workspace-write（默认） | danger-full-access |
|---|---|---|
| vm 域内读（`fs/process` 盘点） | 空手：`fs`/`process` undefined，`require` 是陷阱 | 同左（与权限无关） |
| 宿主 shell 读（`/etc/hostname`） | ✓（外层只限写不限读） | ✓ |
| POC 宿主 shell 写家目录 | ✗ EROFS（shell 起来了，写盘被外层拦） | ✓ 文件写入成功 |
| 普通插件 / 直接写家目录 | ✗ EROFS | ✓ |

结论：**V4b 每次都成功逃出 DSH 自己的沙箱拿到宿主进程；家目录写盘被拦是被"外层工具沙箱"挡的，不是 DSH。** 真实部署（无这层外层）里，POC 原样即可写盘——这是本漏洞的爆炸半径所在。

---

## 9. 复现脚本（本仓库内，均已中文化注释）

| 脚本 | 作用 |
|---|---|
| `poc/poc-v4b-exec-escape-to-rce.ts` | 标准复现（vm → subprocess → 宿主写标记） |
| `poc/poc-v4-exec-escape.ts` | 前置（`execute` 拿到宿主 ctx，读宿主服务） |
| `poc/run-user-plugin-test.ts` | 用户提供的工具注册写法逐字跑通 |
| `scripts/poc-home-write.ts` | V4b 链写 `~/test3.txt` 的证据 |
| `scripts/plugin-home-write.ts` | 对照组（普通插件 vs 临时区） |
| `scripts/vm-vs-poc-probe.ts` | vm 域能力盘点 vs 宿主 shell 读取对照 |
