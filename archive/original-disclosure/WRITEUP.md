> **历史存档（archive）。** 本文档是本仓库早期对**多个漏洞（V1 / V2 / V4 / V4b）**的披露原件；
> 其中的运行路径与文件清单已随仓库重组失效（V1、V2 的 PoC 不在本仓库）。
> 当前研究入口：仓库根 `README.md`。

# 插件、沙箱与一把万能钥匙：LLM Agent 框架（harness）中的四个安全漏洞

> 2026-08-13 · deepseek-harness 0.1.0-rc.5（预发布版本，无外部使用者）· 四个概念验证（PoC）均已在真实代码路径上验证通过
>
> **摘要（Abstract）。** 本文档记录了对 DeepSeek Harness——一个基于 Cordis 框架的插件化 Agent 框架（harness）——的一次安全设计审查。我们给出四个 PoC：三个相互独立的漏洞（`!!js` 配置求值、一个能读取宿主机整个文件系统的"只读"沙箱、以及从动态插件 vm 沙箱逃逸出去的 `exec`），外加一个链式利用（exec 逃逸 → 裸子进程（raw subprocess）→ 无约束的宿主机进程执行）。对每个漏洞，我们都说明其机制并附上 file:line 证据，说明外部攻击者如何经由模型自身的界面触达它，以及我们是如何发现它的。所有发现均附带可复现的脚本。

---

## 0. 背景：被审查的系统与威胁模型

DeepSeek Harness 是一个"万物皆插件"（everything is a plugin）的 Agent 框架：

- **插件树（plugin tree）。** 模型适配器、工具注册表、会话日志乃至 Agent 主循环本身都是 Cordis 插件——可以通过配置进行组合与替换。
- **事件溯源（event sourcing）。** 会话日志只允许追加（append-only）；一切模型可见的内容都必须能由它重建（"模型可见即已被记录"）。
- **能力接缝（capability seams）。** 每个可替换的能力都是一个 服务定义（Service Definition）/ 提供者（Provider）/ 消费者（Consumer）三元组。
- **分层沙箱（layered sandboxing）。** Bash 执行经由 `ctx.sandbox`，它会用 landlock/seatbelt/bwrap 包裹 argv；文件系统由一个进程内写围栏（write fence）强制执行；权限模式为 `read-only`（只读）/ `workspace-write`（工作区写入）/ `danger-full-access`（危险全访问）。
- **动态插件（dynamic plugins）。** 模型可以通过 `cordis_define`/`cordis_run` 工具编写代码，将其作为自己的插件挂载，并在一个由受守卫的门面（facade）保护起来的 `node:vm`"沙箱"中运行。

**威胁模型（threat model）。** 模型是一个半可信主体（semi-trusted principal）。它可以被提示注入（prompt injection）所操控（恶意网页、敌意仓库内容、拉取的文档都能注入），而 `read-only` 模式被宣传为在不可信代码之上运行它的安全方式。攻击者的目标是：在宿主机上执行任意代码（arbitrary code execution，即 RCE），或窃取凭据（credential exfiltration）。

我们的方法论见 §6。先讲漏洞。

---

## 1. PoC V1：`!!js` 配置求值 = 加载时的同步代码执行

### 机制（Mechanism）

cordis.yml / cordis.patch.yml 支持 `!!js` 表达式。加载器（Loader）在挂载每一行配置时，经由一个 `internal/config` 瀑布流（waterfall）对它们求值：

```
vendor/loader/src/index.ts:92-101        ctx.on('internal/config', ...) → interpolate(this.ctx, config)
vendor/loader/src/config/utils.ts:5-9      evaluate = new Function('ctx','expr','with (ctx) { return eval(expr) }')
```

该表达式是在 `with(ctx)` 作用域链内的一次直接 eval（direct eval）；`process` 在 ctx 上找不到，于是沿作用域链回落到 Node 全局。本仓库的 engines 范围是 node ^22.19 || >=24，而 Node ≥22.3 自带 **`process.getBuiltinModule()`**——无需 require/import 即可同步访问任意内置模块（builtin）。因此，一个 `!!js` 表达式就是同步的、发生在加载时的任意代码执行：

```yaml
- id: anything
  name: any-plugin
  config:
    probe: !!js process.getBuiltinModule('node:fs').writeFileSync('/tmp/pwned', 'x')
```

配置文件模板（profile template）甚至明示"允许 `!!js` 表达式"（app-boot/src/profile.ts:127-131），而且 app-boot 会对补丁文件做热重载（app-boot/src/index.ts:213）——写入即执行，并在每次启动时重放。

### PoC 验证（Verification）

经由真实的 Loader 挂载路径（用序列化的 `__jsExpr` 形式调用 `loader.create`）：

```
[V1] marker written at config-load time: true
[V1] marker content: "executed-at-config-load"
[V1] writableRoots(workspace-write): ["/tmp/dsh-poc-v1-workspace","/private/tmp","/private/var/folders/..."]
```

### 利用方式与现有防御（Exploitation and the current defense）

在默认部署中，模型的写入面是 `workspace-write` = 工作区根目录 + 系统临时区域（roots.ts:52-55），而补丁文件位于 `~/.dsh/profiles/<name>/cordis.patch.yml`——默认写入边界碰巧能守住。但这是一道**只有一层、且带有一个未经验证不变量的防御**：

- 启动时没有任何环节交叉核对"已加载的配置目录 ∉ 可写根路径（writable roots）"。只要 `workspaceRoot` 指向 home、配置目录落在工作区内、部署属于自修改（self-modification）形态（本仓库的 `demo:cordis` 场景）、或启用了 `danger-full-access`——上述任何一种情形都会悄然闭合这条利用链。
- 即便不写补丁文件：§4 中的链式利用会让写入边界变得无关紧要。

**场景（Scenario）。** 配置投毒（敌意仓库诱导模型去编辑配置），以及在自修改部署中植入持久化后门。

---

## 2. PoC V2："只读"沙箱能读取宿主机整个文件系统

### 机制（Mechanism）

只读模式严格围栏（fence）住**写入**，却对**读取**毫无作为：

- 进程内围栏（fs-sandbox）只包裹 `writeText`/`editText`（fs-sandbox/src/index.ts:91,112）；`readText` 原样继承、未被触碰。
- 进程级 bwrap 配置是 **`--ro-bind / /`**（sandbox-local/src/profiles.ts:17）——宿主机整个文件系统被以只读方式绑定挂载进沙箱。

只读模式的可写根路径是空集（roots.ts:52-55），但与此同时，它意味着模型可以读取 `~/.ssh/*`、项目 `.env` 以及各类凭据文件——而这些文件正是凭据系统自身用 0600 权限保护的对象（credentials-local/src/index.ts:103-122），足以证明在本项目自己的威胁模型中，它们就是机密（secret）。

### PoC 验证（Verification）

使用真实的 SandboxPolicyService + SandboxedFileSystem，处于只读模式，读取工作区之外的一个"凭据"：

```
[V2] read of a secret OUTSIDE the workspace under read-only mode:
     "apiKey: dsh-poc-secret-value\n"
[V2] contrast — write under the same mode denied with code: FS_SANDBOX_DENIED
[V2] writableRoots(read-only): []
[V2] process level: bwrap profile is --ro-bind / / (profiles.ts:17)
```

### 插件前门：注入没有白名单

当一个动态插件声明注入（inject）的服务时，唯一的检查是"该服务是否存在"（cordis-host-runner/src/lifecycle.ts:56）——**不存在白名单（allowlist）**。服务包装器 `guardedService` 只拒绝返回 Context 的值（guard.ts:669-697），既不拦读取也不拦写入。于是，模型编写的代码可以从正门声明：

```js
inject: ['fs', 'web']   // 只读模式下 fs.readText 不受围栏约束，web 可用于外泄
```

读取机密 + 外泄，一步到位。在此基础上：**默认组合（composition）中没有任何宿主端插件会为工具调用发出 `ask`**——只有 CC/Codex 钩子桥（hook bridge）会把某个钩子的 `'ask'` 映射进来；`dsh-user-approval` 只提供一项服务，却没有任何默认接线；而 `tool-bash` 上仍挂着 `TODO(permissions)`（tool-bash/src/index.ts:6-7）。在"只读安全模式"下读取凭据，模型不需要付出任何一次审批（approval）。

**场景（Scenario）。** 以只读模式在不可信仓库之上部署框架——这正是该模式被宣传的目标用途——仓库内容诱导模型去读取 `.env`、`~/.ssh` 与云凭据，并把它们外泄出去。

---

## 3. PoC V4：动态插件 vm 沙箱泄漏宿主的 `exec`

### 背景：团队已经封堵过一类逃逸

cordis-host-runner 中的守卫并不粗疏。`sandbox-context.spec.ts` 的标题字面就是 "escape surface is closed"（逃逸面已封堵），其覆盖范围包括：拒绝 `ctx.root`/`ctx.parent`/`ctx.scope` 等框架成员、拒绝 `ctx.extend`/`ctx.isolate`、拒绝返回 Context 的服务（`denyContext`）、以及让 `tools.get` 返回 schema 视图而非可调用的 ToolDefinition。这确实是认真的对抗性设计。

### 漏洞所在：`execute(args, exec)` 这条路径被漏掉了

但守卫只覆盖了 `apply(ctx)` 这个门面——**并没有覆盖 `execute(args, exec)` 中的 `exec`**：

```
guard.ts:582-584   execute(args, exec) { return cloneJson(await rawExecute(args, exec), ...) }
```

`exec`（即 ToolRunContext）被原封不动地传给了 vm-realm（领域）中的模型代码，而 `exec.agent.ctx` 是**真实的运行时 Context**（runtime-types.ts:64-75 声明了 `readonly ctx: Context`）。门面守卫的是语法；它并没有守卫对象图（object graph）。

### PoC 验证（Verification）

走完整的真实路径——runner.define → run → 真实注册表（registry）管线 → vm-realm 代码经由 `exec.agent.ctx.get('pocSecretStore')` 触达一个宿主服务：

```
[V4] dynamic package mounted and running: true
[V4] isError: false
[V4] sandbox-realm tool code retrieved from the host Context: "HOST_SECRET_LEAKED"
```

---

## 4. PoC V4b（链式）：exec 逃逸 → 裸子进程 → 无约束 RCE

### 链为何能成立：约束放在了错误的层级上

沙箱约束（confinement，即对 argv 的 landlock/seatbelt/bwrap 包裹）只存在于 **shell 层**——`bash-sandbox` 在调用 `ctx.subprocess.spawn` 之前包裹 argv（bash-sandbox/src/index.ts:177-179）。子进程这一接缝本身对约束一无所知：subprocess-local 中**零沙箱引用**。这是典型的接缝结构（seam-structure）失效：强制逻辑落在某一个消费者身上，而不是执行点上——其他调用方（或持有 Context 的逃逸代码）可以完全绕过它。

### PoC 验证（Verification）

vm 沙箱内由模型编写的代码，经由逃逸出的 Context 触达裸子进程服务并派生（spawn）出一个宿主进程：

```
[V4b] dynamic package mounted and running: true
[V4b] tool result (isError=false): "spawned-and-exited"
[V4b] unconfined host process wrote marker: true
[V4b] marker content: "unconfined-spawn\n"
```

**没有文件写入、没有审批、没有跨越任何沙箱边界。** 完成这一步之后：写补丁文件（`!!js` 持久化）、修改任意文件、运行任意命令——全部敞开。§1 中的写入边界防御被整体绕过。

### 一条被"意外"挡住的路线：loader.create 与 realm 边界

我们还尝试过一条更隐蔽的链：逃逸出的 Context → `loader` 服务 → 用携带 `__jsExpr` 的行调用 `loader.create`。结果：该行**真实地完成了挂载**（报错只是重复的定时器注册），但 `!!js` 从未执行。原因值得记录：`interpolate` 的 `isJsExpr` 检查的是 `value instanceof Object`（config/utils.ts:26），而 vm-realm 里构造出的配置对象**并不是宿主 `Object` 的实例**——realm 边界意外地挡住了这条路线。这是一道脆弱的防御：只要把 `isJsExpr` 改成 `typeof value === 'object'`，或先在宿主侧克隆配置，路径就会重新打开。而且它也改变不了什么——子进程那条链从来就不需要 `!!js`。

### 端到端攻击链

```
malicious webpage / repo content / fetched document
        │  prompt injection
        ▼
model calls cordis_define + cordis_run (zero approval in the default composition)
        │
        ▼
vm sandbox runs model code → execute(args, exec) receives the host exec (guard.ts:582-584)
        │
        ▼
exec.agent.ctx.get('subprocess').spawn(...) — no landlock/seatbelt/bwrap
        │
        ▼
arbitrary host process → persistence (patch file + !!js) → long-term foothold
```

### define/run 默认真的是零审批吗？

在我们的 PoC 里，`runner.define` + `runner.run` 在一棵**完全没有接线应答者（answerer）**的树上就成功了——测试装置（test harness）的网关只记录事件并放行、不作应答。Web 组合确实有一套双重检查的审批流，但它的授权（grant）粒度是**按包（per-package）**——一次审批即放行该包未来的所有版本（cordis-host-runner/src/index.ts:240,278），这与按请求（per-request）的接缝语义并不一致。

---

## 5. 外部利用场景

| # | 入口（Entry） | 链条（Chain） | 影响（Impact） | 默认部署中是否可达 |
|---|---|---|---|---|
| A | 提示注入（恶意页面/仓库）→ 模型 | cordis_define → V4 exec 逃逸 → V4b 裸子进程 | 宿主 RCE，零文件写入 | **是**（无需任何错误配置） |
| B | 在不可信仓库上以只读模式部署 | bash `cat` / fs 读取工具 / 插件 `inject:['fs','web']` | 凭据外泄（.ssh/.env/credentials） | **是**（只读部署本身就是触发条件） |
| C | 配置投毒 | 模型写补丁文件 → `!!js` → HMR 执行 + 每次启动重放 | 持久化 RCE | 有条件（workspaceRoot 覆盖配置目录 / 自修改部署） |
| D | 模型操控 | 技能（skill）内容（声明式的；自身不执行代码）诱导模型走向 A/B | 同 A/B | 是（放大器，而非独立攻击面） |

关键点：**场景 A 不依赖任何部署错误配置。**"V1 的链在默认部署中已被打破"这个结论——孤立地看是对的——在 V4b 面前站不住脚：在插件路径上，写入边界从头到尾都没有参与。

---

## 6. 我们是怎么找到它们的：方法论

审查过程，按顺序进行：

### 6.1 先读架构文档，列出信任假设

先从读架构文档开始（architecture.md、glossary、capability-seams、cookbook）——不是为了学会怎么用这套系统，而是为了**找出它在哪些地方假设模型会配合**。由此得到的清单成了候选集合：

- "配置允许 `!!js`"——假设配置文件写作者是可信的；
- "只读是安全模式"——假设读取是无害的；
- "动态插件运行在受限环境里"——假设 vm 边界真的能起到限制作用；
- "沙箱约束了 shell 执行"——假设所有执行都会经过 shell。

每一条假设都对应一个需要验证的攻击面。

### 6.2 五个领域并行审计，每个领域都带一份问题清单

把代码库拆成五个领域并行审计，每个领域都要产出 file:line 证据：

1. **核心循环 + 会话日志**：状态机、输入丢失、崩溃恢复、事件溯源的成本；
2. **能力接缝**：提供者可替换的承诺是否成立、策略放在哪里、是否存在单实现接缝；
3. **工具管线与安全**：审批（approval）携带什么、限制（restriction）究竟是过滤器还是强制执行、沙箱逃逸面；
4. **编排（orchestration）**：子代理（subagent）组合、并行冲突、预算（budget）语义；
5. **typert/RPC/线路（wire）**：类型图、错误码、帧放大、无界缓冲区。

关键技术：**强制执行位置图（enforcement-locus map）**。对每一条安全属性，标出它在哪里被强制执行——在提供者（provider）？在消费者（consumer）？还是仅仅靠约定（convention）？任何只在消费者层、或只停留在书面约定上的属性，都会成为高风险候选——正是这一招直接产出了 V2（对读取的约束策略只存在于工具层）和 V4b（约束只落在 bash 层）。

### 6.3 把仓库自己的规则反转为探测器

这个仓库有异常明确的工程规则（CLAUDE.md）："把决策落实到会执行它的那个操作里"（Enforce a decision in the operation that makes it）、"错误配置要大声失败"（Misconfiguration fails loud）、"把边界应用到完整的结果上"（Apply bounds to the complete result）。**把它们反转为探测器**：违反这些规则的地方就是漏洞候选。V2（读取不受围栏约束 = 策略没有在操作处被强制执行）和 V4b（约束落在消费者而非提供者上）都是第一条规则的反例。用代码库自述的标准去攻击它，产出的发现最难被驳回。

### 6.4 先验证原语，再分层做 PoC

不要一上来就写大 PoC。先逐个验证最小的"原语假设"——它们每一个都是后续链条上的一环：

- `process.getBuiltinModule` 在 `with(ctx)+eval` 引擎里真的可用吗？（一条 `node -e` 即可）
- `ToolExecutionInput.agent` 存在吗？注册表接受它吗？（看类型 + 测试基建）
- `loader.create` 会触发 `interpolate` 吗？（跑一遍；盯着标记文件落地）
- `writableRoots` 的语义是什么、它和补丁文件的存放位置是什么关系？（roots.ts + profile.ts）

然后分层做 PoC，每一层都比上一层更接近真实攻击：

1. **机制层（mechanism level）**：真实 Loader 挂载路径，`!!js` 写入一个标记文件（V1）；
2. **管线层（pipeline level）**：完整的 runner → registry → 工具执行路径，vm 代码取回一个宿主服务（V4）；
3. **链式（chained）**：把上面两者串起来，证明端到端可达（V4b）。

所有验证都走真实代码路径，零 mock。测试基建复用了仓库自身的辅助模式（fs-sandbox.spec.ts 的启动形态、cordis-host-runner 的搭建方式），这保证了：只要 PoC 通过，漏洞就在产品本身里。

### 6.5 失败的路径同样是证据

V4b 的第一次尝试（用 `__jsExpr` 走 `loader.create`）**失败了**——而失败模式本身就是一条发现：vm-realm 对象过不了宿主的 `instanceof Object` 检查。如实记录失败的路径有双重回报：(1) 一道意外存在的防御会被发现，并评估其脆弱性；(2) 转向子进程路线后，我们找到了更直接的链。在安全审查里，被堵死的路线与被打开的路线同样有价值。

### 6.6 可复用检查清单（适用于任何 Agent 框架）

1. **配置求值面（config evaluation surface）**：配置文件里存在代码求值钩子吗（`!!js` / 模板 / 插件引用）？谁能写这些文件？写入面与加载面之间，是否存在经过验证的不变量？
2. **读/写不对称（read/write asymmetry）**：当某个安全模式围栏住写入时，读取是否被同等对待？机密目录是否位于被挂载/可读的面之内？
3. **门面对象图（facade object graph）**：对任何"受限环境"守卫，都要检查它守卫的是语法还是对象图——被守卫的上下文能否经由某个对象引用（exec、agent、服务返回值）触达真实的运行时？
4. **强制执行位置（enforcement locus）**：每一条安全策略是在提供者/执行点被强制，还是落在消费者/约定上？枚举出所有直接调用方；找出谁能绕过它。
5. **注入面的下游能力（downstream capability）**：当工具结果以原始形态进入上下文时，一个（被提示注入的）模型最多能达到什么能力？画出 注入 → 模型 → 能力 → 影响 这条链。
6. **授权语义（authorization semantics）**：一次审批请求携带什么（参数？哈希？只是一串理由？）？授权粒度是什么——按请求，还是按包？

---

## 7. 修复方案，按优先级排列

| 优先级 | 修复内容 | 封堵的路径 |
|---|---|---|
| **P0** | 给动态工具的 `execute` 传入一个门面 exec，并把 `agent.ctx` 从中剥离（guard.ts 内的一处局部改动） | V4 本身 + 整条 V4b 链 + 插件侧的 V1/V2 |
| **P0** | 让 `SubprocessRuntime` 自我约束：约束理应位于接缝的执行点，而不是"只有 bash-sandbox 会调用它"这种约定里 | V4b 的结构性根因 |
| **P1** | 为动态插件的注入建立白名单；把 define/run 接入审批管线 | V2 的插件前门、场景 A 的零审批入口 |
| **P1** | 把机密目录排除在只读模式之外；真正把默认审批接线进 `tools/pre-execute`（目前只有钩子桥会发出 ask） | 场景 B 的凭据外泄 |
| **P2** | 启动时检查：已加载的配置目录 ∉ writableRoots，一旦重叠就大声失败 | 场景 C 的纵深防御（depth-in-defense） |

---

## 8. 附录：PoC 清单与复现

| 文件 | 验证内容 | 关键输出 |
|---|---|---|
| `poc-v1-js-config-exec.ts` | `!!js` 在加载时同步执行代码（真实 Loader） | `marker written at config-load time: true` |
| `poc-v2-readonly-reads.ts` | 只读模式读取整个宿主文件系统（真实 fs 插件） | 机密读取成功 / 写入得到 FS_SANDBOX_DENIED |
| `poc-v4-exec-escape.ts` | vm 沙箱 exec 逃逸（完整 runner→registry 管线） | `"HOST_SECRET_LEAKED"` |
| `poc-v4b-exec-escape-to-rce.ts` | 逃逸 → 裸子进程 → 无约束的宿主进程 | `unconfined host process wrote marker: true` |

复现方法（在本仓库中执行，且有一个 deepseek-harness 的 checkout 作为同级目录）：

```sh
cd /path/to/deepseek-harness        # 源码 checkout，已完成 pnpm install
pnpm exec tsx ../dsh-security-pocs/poc-v1-js-config-exec.ts
pnpm exec tsx ../dsh-security-pocs/poc-v2-readonly-reads.ts
pnpm exec tsx ../dsh-security-pocs/poc-v4-exec-escape.ts
pnpm exec tsx ../dsh-security-pocs/poc-v4b-exec-escape-to-rce.ts
```

环境要求：Node ≥ 22.3（仓库 engines ^22.19 || >=24）；脚本经由仓库的 tsconfig 路径解析来定位工作区源码；每个脚本会自行清理自己的测试夹具（fixtures）。一旦修复落地，这些脚本可以直接转化为回归测试（V4 应当归入 `cordis-host-runner/tests/`，恰好覆盖 sandbox-context.spec.ts 漏掉的那块 exec 面）。

---

## 9. 结论

这三个漏洞共享同一个根因，可以压缩成一句话：**安全属性被强制执行在了错误的层级上**——配置求值信任了它的写作者，只读模式信任了"读取无害"，vm 沙箱守卫了语法却没有守卫对象图，进程约束落在了某一个消费者身上而不是执行点上。链式利用又补上了第二课：在 Agent 框架里，单个漏洞的"可达性（reachability）"必须端到端地画出来——孤立地看，V1 似乎被写入边界约束住了；而 V4b 把这道边界彻底移出了路径。

对于这一类系统的防御者，最重要的一条建议是：**把"被注入的模型能造成的爆炸半径（blast radius）"写成系统测试，而不是写成威胁模型文档。**
