# 在官方发布版上复现（不依赖 monorepo）

本目录用 **npm 发布的 `@deepseek-ai/dsh-*@0.1.6-alpha.1`** 实机复现 V4b，
**不需要 `deepseek-harness` 源码检出**——适合在任意机器上快速核验。

## 运行

```bash
cd verify/npm-alpha
npm install        # 安装 package.json 中列出的 7 个发布包
npm run verify     # 等价于 node verify.mjs
```

预期输出：

```
[alpha] mounted: true
[alpha] isError: false
[alpha] sandbox report: {"typeofAgent":"object","typeofAgentCtx":"object","ctxReachable":true,
  "secretRead":"ALPHA_PROBE_SECRET","subprocessReachable":true,"spawned":true}
[alpha] marker written by spawned host shell: true
[alpha] marker content: "alpha-0.1.6-spawned\n"
```

## 这个脚本做了什么

1. 装配真实运行时：`Context` + `dsh-subprocess-local` + `dsh-system-prompt` + `dsh-tools` + `cordis-plugin-timer` + `dsh-cordis-host-runner`，并额外提供一个"宿主机密"服务；
2. 通过 `dynamicCordisRunner.define/run` 挂载一段**模型风格的动态包代码**（在 `node:vm` 沙箱里执行，只声明 `inject: ['tools']`）；
3. 通过**真实工具注册表**调用它注册的工具；
4. 该工具的 `execute(args, exec)` 拿到宿主 `exec`，经 `exec.agent.ctx` 读出未声明的宿主服务、取得 `subprocess` 并**拉起宿主 shell 写入标记文件**（随后自清理）。

## 换版本验证

改 `package.json` 里的 `0.1.6-alpha.1` 为目标版本，重新 `npm install` 即可。
`dsh-*` 子包与 `cordis` / `cordis-plugin-timer` 是**独立版本号**，升级时两者都要跟着调整。

## 与仓库内其他脚本的关系

| 脚本 | 依赖 | 说明 |
|---|---|---|
| `verify/npm-alpha/verify.mjs`（本目录） | npm 发布包 | **实机**，无需源码检出 |
| `../scripts/verify-v4-v4b-0.1.5.ts` | harness 源码 checkout | 实机，`0.1.5-rc.2` |
| `../poc/poc-v4b-exec-escape-to-rce.ts` | harness 源码 checkout | 原始 PoC（中文注释） |
