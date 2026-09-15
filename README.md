# dsh-security-pocs

> **DeepSeek Harness 动态插件沙箱边界研究（QVD-2026-52646，V4b）与 `exec.agent.ctx` 的设计溯源。**
> A study of a dynamic-plugin sandbox escape in DeepSeek Harness (QVD-2026-52646, V4b), tracing where the
> leaked `exec.agent.ctx` object actually comes from and why the design looks the way it does.

> ⚠️ **免责声明**：本仓库仅用于**授权安全研究与防御目的**。所有 PoC 与脚本针对**已披露**的漏洞，
> 请在**你拥有或已获授权**的系统上运行；请勿用于未授权测试或攻击。

> **来源与致谢**：本仓库基于 [zzszmyf/dsh-security-pocs](https://github.com/zzszmyf/dsh-security-pocs)（MIT）整理——
> 原始 PoC 与 writeup（V1 / V2 / V4 / V4b）由原作者发布，版权归原作者（见 [`LICENSE`](LICENSE) 与
> [`archive/original-disclosure/`](archive/original-disclosure/)）；本仓库在其基础上新增中文文章、
> `exec.agent.ctx` 的设计溯源、证据材料与发布版复现脚本。

---

## 📄 关于文章

文章《一条 exec 如何穿过沙箱：DeepSeek Harness QVD-2026-52646 漏洞与安全模型分析》**受首发平台要求，不在本仓库发布**。
本仓库保留支撑该文章的材料：分析、证据、PoC 与复现/验证脚本。

## 结论速览

1. **漏洞仍在**：在 `0.1.5-rc.2`（源码）与 **最新发布版 `0.1.6-alpha.1`（npm 发布产物）** 上均**实机复现**——动态包沙箱代码经 `execute(args, exec)` 拿到宿主 `ctx`，读机密、拉起宿主 shell；对上游 `master` tip（`0d1f5000`，领先本地 666 提交）的静态核对显示**断点整包逐字节相同**。
2. **这次升级修的是别的洞**：`--unshare-pid` 修的是 bwrap 的 procfs magic-link 旁路（逃出文件栅栏），subprocess 的 native containment 是进程树生命周期；本链未被触及。
3. **`exec.agent.ctx` 是架构设计的一部分**：`exec.agent` 是"这次调用为谁而做"的显式身份；`agent.ctx` 是 agent 的**注册作用域**（**完整的 Cordis Context + 作用域标签**，而非降权视图），面向**宿主侧受信工具**；**超出设计假设的是其传递路径**——未投影的 `exec` 让它跨过了沙箱边界。
4. **断点在沙箱边界**：`apply(ctx)` 有 façade（其自述目标之一正是 *"close the unguarded-context escape"*），而 `execute(args, exec)` 的 `exec` 从未做投影——同一份 exec 里 `parent` 会投影、`agent` 不会；公开/模型可见契约把 `Agent` 限为 `{id}`，运行时却给全量。
5. **修复方向**：投影 `exec`（剥离 `agent.ctx`）> subprocess 缝自约束 > define/run 接审批 > 关系不变量测试；**而不是**拆除 `agent.ctx`。

## 目录结构

```
analysis/    V4b 攻击链复盘、逃逸后 ctx 能力清单（71 个服务分类）
evidence/    证据清单 + 17 段逐字代码摘录（含 file:line）+ 6 份设计注记（中/英原文）
poc/         复现 PoC（V4b 及其前置 seam 演示）
scripts/     验证与能力盘点脚本（从 harness checkout 运行）
verify/      发布版实机复现：npm 装 0.1.6-alpha.1，**不依赖 monorepo 检出**
archive/     早期多漏洞披露原件（历史存档；其中的路径已随重组失效）
```

| 目录 | 入口 |
|---|---|
| 分析 | [`analysis/v4b-attack-chain.md`](analysis/v4b-attack-chain.md)、[`analysis/ctx-capabilities.md`](analysis/ctx-capabilities.md) |
| 证据 | [`evidence/README.md`](evidence/README.md)、[`evidence/code-excerpts.md`](evidence/code-excerpts.md)、[`evidence/notes/`](evidence/notes/) |
| 复现 PoC | [`poc/poc-v4b-exec-escape-to-rce.ts`](poc/poc-v4b-exec-escape-to-rce.ts)、[`poc/poc-v4-exec-escape.ts`](poc/poc-v4-exec-escape.ts)、[`poc/run-user-plugin-test.ts`](poc/run-user-plugin-test.ts) |
| 脚本 | [`scripts/verify-v4-v4b-0.1.5.ts`](scripts/verify-v4-v4b-0.1.5.ts)、[`scripts/ctx-capabilities-probe.ts`](scripts/ctx-capabilities-probe.ts)、[`scripts/catalog-dump.ts`](scripts/catalog-dump.ts) |
| 历史存档 | [`archive/original-disclosure/`](archive/original-disclosure/) |

## 复现

### 方式一：官方发布版（不依赖 monorepo，推荐快速核验）

```bash
cd verify/npm-alpha
npm install     # 安装 7 个 @deepseek-ai/* 发布包（0.1.6-alpha.1）
npm run verify  # 实机跑通 V4b：ctx 泄漏 → 读机密 → 宿主 shell 写出标记
```

### 方式二：从 harness 源码（需要 checkout）

**要求**：Node ≥ 22.3（`process.getBuiltinModule`）、一份 `deepseek-harness` 源码检出（与本仓库同级，或用 `DSH_CHECKOUT` 指定）、`tsx`。

```bash
CO=/path/to/deepseek-harness
cd $CO
node_modules/.bin/tsx ../dsh-security-pocs/scripts/verify-v4-v4b-0.1.5.ts     # 逃逸 + 读机密 + 宿主 spawn
node_modules/.bin/tsx ../dsh-security-pocs/scripts/ctx-capabilities-probe.ts   # 逃逸后 ctx 能力盘点
```

- 脚本通过 harness 的 **tsconfig paths 从源码**导入 `@deepseek-ai/*`，因此**必须从 checkout 根目录**运行。
- 在受限文件策略下（如 `workspace-write`），逃逸出的进程**写工作区之外会被拒绝（EROFS）**——那是外层文件策略的写栅栏（进程树继承），不是 DSH 的 subprocess 缝；在真实部署或无写栅栏的模式下，写与持久化同样成立。
- 读、进程执行、网络**不在**该写栅栏的承诺范围内（沙箱注记原文：*"FILE effects only — network and process visibility are not claimed"*）。

## 已验证状态

| 项 | 值 |
|---|---|
| 实机验证版本 | `0.1.5-rc.2` @ `c291e7961a`（源码，2026-09-14）**与 `0.1.6-alpha.1`（npm 发布产物，2026-09-15）** |
| 复验结果 | 两个版本上逃逸链路均完整成立：`ctxReachable:true`、`secretRead`、`subprocessReachable:true`、`spawned:true`、宿主 shell 写出标记 |
| 上游最新版 | `master` = `0d1f50007f`（版本 `0.1.6-alpha.1`，领先本地 **666** 提交；`dsh-v0.1.6-alpha.1` 标签距 master 5 提交） |
| 最新版核对方式 | **实机**：npm 发布版 `0.1.6-alpha.1`（`verify/npm-alpha/`）；**静态**：`master` tip（`cordis-host-runner/src` 整包逐字节相同、无新增边界断言、seam 仍零约束） |
| 披露时间线 | 2026-08-13 上报项目方（原件见 `archive/original-disclosure/`） |
| 本次升级的相关修复 | `--unshare-pid`（procfs 旁路）、subprocess native containment（生命周期）；**不含**本链 |
| 注意事项 | 本地 `origin/master` remote-tracking ref 可能滞后，`git status` 会误报"已是最新"；核对应以 `git ls-remote` / compare API 为准 |

## 术语

- **vm 沙箱**：`node:vm` 域的 JS 隔离（本链中被绕过的那层）
- **façade**：动态包 `apply(ctx)` 收到的白名单代理上下文
- **能力缝（capability seam）**：服务定义 / 提供者 / 消费者三元组，如 `subprocess`
- **注册作用域（registration scope）**：`agent.ctx`，决定注册可见性与回收，**不是权限系统**
- **投影（projection）**：跨信任边界传递对象时只给必要字段/能力的裁剪过程

## License

见 [`LICENSE`](LICENSE)。
