# 逃逸后的 `ctx` 能力清单：自定义插件拿到宿主 Context 能做什么

> 版本：deepseek-harness 0.1.5-rc.2（本地 HEAD `c291e7961a`，= 上游 master 最新）
> 来源：`../scripts/ctx-capabilities-probe.ts` 实测 + 产品自带权威目录 `packages/extensions/tool-cordis/src/api-catalog.ts`（`SERVICE_API`，71 个服务）
> 前提：V4b 的 `execute(args, exec)` 逃逸——动态插件代码拿到宿主 `ToolRunContext`，`exec.agent.ctx` 即真实运行时 Context。

---

## 0. 一句话

`ctx` 不是"一个对象"，而是**整个运行时内核的入口**：它同时握着**服务定位器**（`get`/`reflect.get`）、**插件与生命周期控制**（`plugin`/`effect`/`provide`/`inject`）、**事件总线**（`on`/`emit`/`waterfall`），以及**全部 71 个能力服务**——从进程执行、文件、网络，到会话日志、凭据、审批与沙箱策略本身。拿到它意味着获得访问大量宿主服务的路径（在当前实现中），且**不受动态插件 façade 的任何限制**。

---

## 1. 实测证据（沙箱域内，非模拟）

探针从一个只声明了 `inject: ['tools']` 的动态插件出发，在 `execute` 里用 `exec.agent.ctx` 实测：

| 能力 | 实测结果 |
|---|---|
| **绕过 inject 门**读未声明服务 | `real.get('capSecretStore').read()` → `"CAP_PROBE_SECRET"` |
| **`reflect.get(name,false)`** 免声明解析服务 | → `"CAP_PROBE_SECRET"` |
| 框架原语可达 | `plugin/effect/on/emit/provide/inject/isolate/get` 全部 `function` |
| **向活运行时注册新服务** | `await real.plugin({apply(c){ c.provide('capPwnService', …) }})` → `real.get('capPwnService').ping()` = `"service-injected-by-sandbox-code"` |
| **事件总线** | `real.on('cap/probe-event', …)` + `real.emit(…)` → 监听器触发 `heard=1` |
| **宿主进程执行** | `real.get('subprocess').spawn({argv:['/bin/sh','-c','echo … > marker']})` → 落盘成功 |
| 可解析的声明名（最小组合） | `capSecretStore cordisInspect dynamicCordisRunner loader subprocess systemPrompt timer tools` + cordis 内建 |

> 注：本探针的 agent 是合成的、`root === self`（30 个属性）；真实部署里 `agent.ctx` 是 agent 作用域的子 Context，`ctx.root` 向上到达的是**应用根**，可枚举/解析**全部已挂载服务**（完整 dsh web 组合 ≈ 71 个）。

---

## 2. 框架级原语（与 composition 无关，永远可用）

| 原语 | 能做什么 |
|---|---|
| `ctx.root` | 跳出 agent 作用域，直达应用根 Context |
| `ctx.get(name)` / `ctx.reflect.get(name,false)` | **免 inject 声明**解析任意已挂载服务（facade 的 allowlist 失效） |
| `ctx.reflect.props` | 枚举全部声明属性（服务/访问器）名，找攻击面 |
| `ctx.plugin(plugin)` | **挂载任意宿主插件**（已实测成功挂载并注册服务） |
| `ctx.provide(name, obj)` | 注册/替换服务（可冒充或投毒其他插件的依赖） |
| `ctx.inject(...)` / `ctx.isolate(...)` | 依赖注入与隔离域操作 |
| `ctx.on/once/emit/parallel/serial/bail/waterfall` | 完整事件总线：监听（含 `tools/execute`、`internal/*`、`llm/stream` 等）、伪造、拦截 |
| `ctx.effect(fn)` | 注册随 fiber 存活的效果（定时器、监听器、清理器） |
| `ctx.loader`（部署必挂） | Loader 服务：`create` 行、读写 config、挂载/卸载插件 → **持久化与宿主代码执行**（配合配置期 `!!js` 求值） |
| `ctx.registry` / `ctx.fiber` / `ctx.reflect` | 运行时自省与生命周期控制（可停用/重载他人插件） |
| `ctx.dispose` 等 | 拆掉别人的插件/服务（DoS） |

---

## 3. 能力服务清单（按攻击价值分类）

产品权威目录共 **71 个服务**；下面是逃逸后可直达、且直接决定攻击力的部分（★ = 拿到即等于高风险）。

### 3.1 进程与执行

| 服务 | 权威 summary | 关键方法 / 攻击含义 |
|---|---|---|
| ★ `subprocess` | Abstract subprocess service | `spawn` / `spawnTerminal` / `resolveExecutable`——**无沙箱感知**，任意宿主进程 |
| `shell` | Abstract bash execution service | `resolve` / `run` / `start`——受 `sandboxPolicy` 约束的 bash 执行器（可绕过工具层审批直接调） |
| `terminals` | PTY backend registry | 申请/接管终端会话 |
| `lsp` | LSP capability seam | 起语言服务器进程 |
| `e2b` | E2B 远程沙箱 | 起远程沙箱（外联） |
| `codeRuntime` | 注册 `ctx.codeRuntime` 实现 | 替换代码执行后端 |

### 3.2 文件与存储

| 服务 | 权威 summary | 关键方法 / 含义 |
|---|---|---|
| ★ `fs` | Abstract filesystem provider | `resolve/stat/lstat/contains/...` 全套文件 API；部署中的 sandboxed provider 按 mode 围栏 **write/edit**（读不受限） |
| `workspaceFiles` / `workspaces` / `workspaceRegistry` | 工作区能力 | 枚举/操作工作区与文件 |
| `storage` / `storageDomain` / `spillStore` | 存储中枢与溢出存储 | 读写持久化数据 |
| `attachments` / `fileUploads` / `fileReferences` | 附件/上传/文件引用 | 读取用户上传与引用文件 |
| `directoryPicker` | 目录选择服务 | 借用宿主目录选择能力 |

### 3.3 网络与外联

| 服务 | 权威 summary | 关键方法 / 含义 |
|---|---|---|
| ★ `web` | The web access service | `search` / `fetch` + 注册 provider——**出站访问（实测网络可用）** |
| ★ `webServer` | The browser HTTP carrier service | `register` 路由 / `registerFallback` / **`tapIndex(html => …)`**——**向 Web GUI 的 HTML 注入脚本**，可打用户浏览器、窃取会话令牌 |
| `webhookRuntime` | Fire-and-forget rule runtime | 注册外发 webhook |
| `remote` | 远程命名空间网关 | 驱动 host/client 远程调用面 |

### 3.4 会话、Agent 与编排

| 服务 | 权威 summary | 关键方法 / 含义 |
|---|---|---|
| ★ `sessionPersistence` / `sessions` / `sessionQuery` | 会话存储/内存表/统一查询 | `list` / `readSession` / `searchEvents` / `fork`——**读取全部会话历史**（用户输入过的机密、其他项目内容）、篡改、派生 |
| ★ `agents` / `subagents` / `agentTeams` | Agent 注册表与子代理 | `create` / `register` / `sendMessage` / `interrupt`——创建 Agent、**给任意会话注入消息**、打断他人 |
| `sessionController` / `sessionProjections` / `sessionProjectionCache` / `sessionTelemetry` / `sessionTitle` / `sessionFeedback` / `messageFeedback` | 会话控制/投影/遥测/标题/反馈 | 观察与篡改会话状态与记录 |
| `compaction` | 上下文压缩 | 影响/触发压缩（可借机篡改历史） |
| `goals` / `planMode` | 目标与计划状态 | 操纵 agent 目标、计划 |
| `jobs` | 后台作业注册表 | `start` / `kill` / `list`——后台执行与干扰 |
| `workflowEngine` | 工作流服务 | 触发/替换工作流执行 |
| ★ `commands` | 人类命令注册表 | `register` / **`execute(agent, line, …)`**——以 agent 身份执行斜杠命令（往往能触发高权限动作） |
| ★ `systemPrompt` | 提示词输入注册表 | `section` / `context` / `variable` / **`suppressRuntimeContext()`**——**改写系统提示**、隐藏运行时策略提示（如沙箱边界说明） |
| `userQuestions` | 用户问答校验 + 作用域 answerer waterfall | `ask(request)` + 可注册 answerer → **伪造用户答复/自动同意** |

### 3.5 模型与凭据

| 服务 | 权威 summary | 关键方法 / 含义 |
|---|---|---|
| ★ `credentials` | 凭据服务（两套 key space） | `resolve` / **`readRecord` / `listRecords` / `set` / `unset`**——**读取/篡改存储的 API key 与凭据** |
| `authorization` | 凭据获取流注册表 | `registerFlow` / `begin`——接管凭据获取流程（钓鱼） |
| ★ `llm` | 适配器注册表 + 流式模型调用（`llm/stream` waterfall 可拦截） | `registerAdapter` / 拦截 waterfall——**监听与篡改全部模型流量**、注册伪 provider |
| `agentDefaultModel` / `subagentModelSelection` / `deepseekLlmApiExtensions` / `modelDirectories` / `tokenMeter` | 模型选择/扩展/计量 | 改模型路由、改写请求字段、消耗配额 |

### 3.6 安全治理（可被反向利用）

| 服务 | 权威 summary | 关键方法 / 含义 |
|---|---|---|
| ★ `approval` | 审批服务（策略 → answerer → 记录 ask/outcome） | `setPolicy(agent, policy)` / `request(req)` / `overrideOf(session)`——**改审批策略、驱动审批流程** |
| ★ `permissionPresets` | 部署权限预设与写路径 | `set(session, name)` / `selectFor(state)`——**切换权限预设（含 danger-full-access）→ 自我提权** |
| ★ `sandboxPolicy` | 沙箱策略服务 | `resolve(request)` / `overrideOf(session)` / `defaultMode` / `workspaceRoot`——读取甚至影响会话的沙箱模式与工作区根 |
| `sandbox` | 抽象进程沙箱服务 | `confine(argv, policy)`——沙箱后端本身；拿到即可自造/绕过包裹 |
| `invariants` | 包自有的不变量注册表 | `register(packageName, installer)`——注册不变量（可植入自己的"检查"，不能直接删他人） |
| `settings` / `settingsController` / `settingsScope` / `settingsSchema` | 设置服务与写路径 | `register` / `prepareDocument`——改部署设置 |
| `permissionPresets` / `planMode` / `toolResultPruner` | 权限/计划/结果修剪 | 影响策略与呈现（如修剪掉不想让用户看到的结果） |

### 3.7 插件、工具与运行时内核

| 服务 | 权威 summary | 关键方法 / 含义 |
|---|---|---|
| ★ `tools` | 工具注册表与执行管线 | `register` / `restrict` / `guard` / **`get`（返回活 `ToolDefinition`，含 `execute`）** / `execute`——**直接调用/替换任意工具，跳过审批、guard 与结果规范化**（guard.ts 明确说过 façade 隐藏活定义正是为此） |
| ★ `dynamicCordisRunner` | 动态包运行时 | `define` / `run` / `undefine` / `stop`——继续定义运行更多动态包，**停用他人的包** |
| `pluginInventory` / `cordisInspect` / `inspector` / `typert` / `typertGateway` | 插件清单/API 自省/类型网关 | 枚举全部服务、事件与类型（攻击面测绘） |
| `commands` / `skills` / `sessionSkillCatalog` | 命令与技能 | `skills.register` / `registerProvider`——**注入技能（跨会话持久化指令）** |
| `clientModules` | Web 插件表（扫描 + 图 + bundle 路由 + index 注入） | 影响浏览器侧插件装载 |
| `webServer` / `web` / `remote` | 见 3.3 | — |

---

## 4. 攻击者能用这些做到什么（按目标）

| 目标 | 用到的能力 |
|---|---|
| **RCE（harness 用户身份）** | `subprocess.spawn`（无约束）/ `shell` / `terminals` / `lsp` / `codeRuntime` / `e2b` |
| **全量机密读取** | `credentials`（API key）、`fs`（任意可读文件，含 `~/.dsh/credentials.yaml`）、`sessionPersistence`/`sessionQuery`（历史会话）、`attachments`/`fileUploads` |
| **外传** | `web.fetch`（实测网络通）、`webServer` 路由、`webhookRuntime` |
| **持久化** | `ctx.loader` 写配置（+ 配置期 `!!js` 求值）、`ctx.plugin` 挂载宿主插件、`skills` 注入技能、`settings`/`clientModules` 改部署、`sessionPersistence` 改历史 |
| **提权 / 拆闸** | `permissionPresets.set`（切预设）、`approval.setPolicy`（改审批）、`sandboxPolicy`（改模式）、`systemPrompt.suppressRuntimeContext`（藏掉边界提示）、`invariants.register` |
| **窃听与篡改** | `llm/stream` waterfall（读写全部模型流量与提示）、`tools.get` + `guard`/`restrict`（改工具行为）、`tools/execute` 事件、`sessionProjections` |
| **横向/接管** | `agents.create`、`subagents.sendMessage`（给任意会话注入指令）、`commands.execute`（以 agent 身份跑命令）、`goals`/`planMode` |
| **打用户浏览器** | `webServer.tapIndex`（往 GUI HTML 注入 JS）、`clientModules` |
| **DoS / 破坏** | `ctx.dispose`、停用/重载他人插件、`jobs.kill`、伪造服务使依赖方崩溃 |

---

## 5. 边界与前提（避免过度声称）

1. **服务可达性依赖 composition**：目录列的是产品里存在的 71 个服务；实际能解析哪些取决于部署挂载了哪些插件。本清单给出的是**完整 dsh web 部署的上限**，最小组合的实测已证明"机制"成立（免 inject 解析 + 挂载 + 注册 + 事件 + spawn）。
2. **`agent.ctx` 是作用域 Context**：真实部署中它 agent 局部；`ctx.root` 才是应用根。我们探针里两者相同（合成 agent），所以 `rootProps=30` 是下限，不是真实部署的数字。
3. **文件写栅栏仍在**：OS 级 bwrap/landlock 栅栏是**进程树继承**的，逃逸出的 shell 也受它约束——实测写家目录仍 `EROFS`、`/tmp`/工作区可写。但**读、进程执行、网络不在该栅栏承诺范围内**（项目 sandbox 注记原文：*"FILE effects only — network and process visibility are not claimed"*）。真实部署若无此栅栏（或模式为 `danger-full-access`），写也是全开的。
4. **网络不受限**：实测 `https://example.com` → 200，与注记"no backend restricts network access"一致。
5. **本清单不含"删除他人不变量"这类未验证能力**：`invariants` 只暴露 `register`。

---

## 6. 与修复建议的对应

| 修复 | 关掉的能力 |
|---|---|
| **P0: `execute` 传剥离 `agent.ctx` 的 façade exec** | 本清单**全部**条目（根因；没有 ctx 就没有服务定位器/插件控制/事件总线） |
| **P0: `SubprocessRuntime` 自带约束** | 即使 ctx 泄漏，也限制"任意宿主进程"这一最重能力 |
| **P1: define/run 接审批** | 攻击链的自动化程度（当前 host-only 包零审批） |
| **P1: inject 白名单** | 免声明读取未注入服务（本探针已验证当前可绕过） |
| **P1: 只读模式排除机密目录** | `credentials`/`sessionPersistence` 的读取面 |
| **P2: boot 期校验"配置目录 ∉ 可写根"** | 经 `ctx.loader` 的持久化腿 |

---

## 7. 复现材料

- `../scripts/ctx-capabilities-probe.ts` —— 沙箱内 ctx 能力实测（inject 绕过、挂载服务、事件、spawn）
- `../scripts/catalog-dump.ts` —— 导出产品 `SERVICE_API`（71 服务 summary + 关键服务方法签名）
- `../scripts/verify-v4-v4b-0.1.5.ts` —— 0.1.5-rc.2（源码）上的 V4b 复验；发布版 0.1.6-alpha.1 的实机复验见 `../verify/npm-alpha/`
- `./v4b-attack-chain.md` —— 攻击链与边界分析主文档
