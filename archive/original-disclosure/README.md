> **历史存档（archive）。** 本文档是本仓库早期对**多个漏洞（V1 / V2 / V4 / V4b）**的披露原件；
> 其中的运行路径与文件清单已随仓库重组失效（V1、V2 的 PoC 不在本仓库）。
> 当前研究入口：仓库根 `README.md`。

# dsh-security-pocs

针对 **DeepSeek Harness**（[deepseek-harness](https://github.com/deepseek-harness/deepseek-harness)，版本 0.1.0-rc.5，预发布）中三个安全漏洞（外加一个组合利用）的概念验证（PoC）脚本。

每个 PoC 都跑在**真实的代码路径**上——真实的 vendored Loader、真实的沙箱插件、真实的动态插件 runner → 注册表管线。没有 mock。若 PoC 通过，则漏洞存在于产品之中。

完整分析报告：[WRITEUP.md](WRITEUP.md)。

> **免责声明。** 仅用于授权安全研究与防御目的。这些 PoC 已向项目方披露。请勿在非你所有的系统上运行它们。

## 发现

| # | PoC | 漏洞 | 已验证结果 |
|---|---|---|---|
| V1 | `poc-v1-js-config-exec.ts` | `!!js` 配置表达式 = 加载期同步任意代码执行（经由 `process.getBuiltinModule`）。唯一防线是沙箱写边界，而没有任何环节拿配置目录位置与它核对。 | 标记文件在配置加载期写入 |
| V2 | `poc-v2-readonly-reads.ts` | 「只读」沙箱模式可读取整个宿主文件系统（写围栏只包住 write/edit；bwrap profile 是 `--ro-bind / /`）。插件 inject 没有白名单：`inject: ['fs','web']` = 读机密 + 外传，默认零审批接线。 | 读机密成功 / 写被拒绝 |
| V4 | `poc-v4-exec-escape.ts` | 动态插件 vm 沙箱把原始宿主 `exec`（ToolRunContext）交给模型编写的代码；`exec.agent.ctx` 是真实运行时 Context。`apply(ctx)` facade 已加固，`execute(args, exec)` 这条路没有。 | 沙箱代码掏出了一个宿主服务 |
| V4b | `poc-v4b-exec-escape-to-rce.ts` | **组合利用**：exec 逃逸 → `ctx.get('subprocess')` → 无约束宿主进程拉起。沙箱约束只在 shell 层；subprocess 缝隙本身对沙箱无感知。全程无文件写入、无审批。 | 无约束宿主进程写下了标记文件 |

端到端攻击链（V4b）：

```
恶意网页 / 仓库内容 / 拉取的文档
        │  提示注入（prompt injection）
        ▼
模型调用 cordis_define + cordis_run（默认组合零审批）
        │
        ▼
vm 沙箱运行模型代码 → execute(args, exec) 收到宿主 exec（guard.ts:582-584）
        │
        ▼
exec.agent.ctx.get('subprocess').spawn(...) —— 无 landlock/seatbelt/bwrap
        │
        ▼
任意宿主进程 → 持久化（patch 文件 + !!js）→ 长期立足点
```

## 环境要求

- Node ≥ 22.3（`process.getBuiltinModule`；harness 的 engines 范围 ^22.19 || >=24）
- pnpm
- 一份已完成 `pnpm install` 的 deepseek-harness 源码检出，作为本仓库的**同级目录**（或用 `DSH_CHECKOUT` 指向）

```sh
git clone https://github.com/deepseek-harness/deepseek-harness.git
# 在检出目录内：pnpm install
```

## 运行

PoC 通过 tsconfig paths 从 harness **源码**导入 `@deepseek-ai/*` workspace 包，因此必须**从 harness 检出根目录**运行（v1/v4/v4b 现位于本仓库的 analysis/ 子目录；v2 仍在仓库根目录）：

```sh
cd deepseek-harness
pnpm exec tsx ../dsh-security-pocs/analysis/poc-v1-js-config-exec.ts
pnpm exec tsx ../dsh-security-pocs/poc-v2-readonly-reads.ts
pnpm exec tsx ../dsh-security-pocs/analysis/poc-v4-exec-escape.ts
pnpm exec tsx ../dsh-security-pocs/analysis/poc-v4b-exec-escape-to-rce.ts
```

若检出目录在别处：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness pnpm exec tsx /path/to/dsh-security-pocs/analysis/poc-v4b-exec-escape-to-rce.ts
```

每个脚本退出前会清理自己的临时产物（标记文件、临时目录）。

## 预期输出

`poc-v1-js-config-exec.ts`：

```
[V1] marker written at config-load time: true
[V1] marker content: "executed-at-config-load"
```

`poc-v2-readonly-reads.ts`：

```
[V2] read of a secret OUTSIDE the workspace under read-only mode:
     "apiKey: dsh-poc-secret-value\n"
[V2] contrast — write under the same mode denied with code: FS_SANDBOX_DENIED
```

`poc-v4-exec-escape.ts`：

```
[V4] sandbox-realm tool code retrieved from the host Context: "HOST_SECRET_LEAKED"
```

`poc-v4b-exec-escape-to-rce.ts`：

```
[V4b] unconfined host process wrote marker: true
```

## 修复建议

- **P0** —— 给动态工具 `execute` 传入剥离了 `agent.ctx` 的 facade exec（guard.ts）；让 `SubprocessRuntime` 自我约束——约束应属于缝隙的执行点，而不是"只有 bash-sandbox 会调它"的约定。
- **P1** —— 给动态插件 inject 加白名单；把 define/run 接进审批管线；从只读模式中排除机密目录。
- **P2** —— boot 期检查：加载的配置目录 ∉ 可写根集合，重叠即响亮失败。

修复落地后，这些脚本可直接转成回归测试（V4 属于 `cordis-host-runner/tests/`，正好覆盖 `sandbox-context.spec.ts` 漏掉的那个 exec 面）。

## 时间线

- 2026-08-13 —— 发现已上报项目方；PoC 与分析报告发布。
