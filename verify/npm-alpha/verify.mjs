/**
 * 实机验证：官方 npm 发布产物 `0.1.6-alpha.1` 上的 V4b 链路。
 *
 * 与 `../scripts/verify-v4-v4b-0.1.5.ts` 同构，区别是**完全不依赖 monorepo checkout**：
 * 全部通过 npm 安装的 `@deepseek-ai/*` 发布包导入（built lib），因此可以在任意机器上复现。
 *
 * 依赖（见本目录 package.json / 安装命令）：
 *   @deepseek-ai/cordis@^4.0.2
 *   @deepseek-ai/cordis-plugin-timer@^1.1.4
 *   @deepseek-ai/dsh-cordis-host-runner@0.1.6-alpha.1
 *   @deepseek-ai/dsh-tools@0.1.6-alpha.1
 *   @deepseek-ai/dsh-system-prompt@0.1.6-alpha.1
 *   @deepseek-ai/dsh-subprocess-local@0.1.6-alpha.1
 *   @deepseek-ai/dsh-agent@0.1.6-alpha.1
 *
 * 运行：node verify.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'

const marker = join(process.cwd(), 'alpha-marker.txt')
rmSync(marker, { force: true })
const SECRET = 'ALPHA_PROBE_SECRET'

const HOST_CODE = `
  return {
    name: 'verify-alpha',
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'verify_probe',
        description: 'probe exec boundary on published alpha',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: value }] },
        },
        async execute(_args, exec) {
          const report = {
            typeofAgent: typeof exec.agent,
            typeofAgentCtx: exec.agent ? typeof exec.agent.ctx : 'n/a',
          }
          try {
            const real = exec.agent.ctx
            report.ctxReachable = real !== undefined
            report.secretRead = real.get('probeSecretStore').read()
            const subprocess = real.get('subprocess')
            report.subprocessReachable = subprocess !== undefined
            if (subprocess) {
              const handle = subprocess.spawn({
                argv: ['/bin/sh', '-c', 'echo alpha-0.1.6-spawned > ${marker}'],
                cwd: '/',
                stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
                graceMs: 1000,
              })
              await handle.done
              report.spawned = true
            }
          } catch (e) { report.error = String((e && e.message) || e) }
          return JSON.stringify(report)
        },
      }))
    },
  }
`

const ctx = new Context()
await ctx.plugin({ name: 'probe-secret', apply(c) { c.provide('probeSecretStore', { read: () => SECRET }) } })
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(Timer)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(DynamicCordisRunnerService)

const AGENT = { id: 'S-alpha', steer() {}, inject() {}, ctx }
const runner = ctx.dynamicCordisRunner
const { pluginId, packageId } = runner.define({
  sessionId: AGENT.id,
  plugin: { kind: 'new', idPrefix: 'vfy' },
  name: 'verify-alpha',
  purpose: 'verify',
  code: { host: HOST_CODE },
})
const receipt = await runner.run(AGENT, pluginId, packageId, 'run')
console.log('[alpha] mounted:', receipt.ok)
if (!receipt.ok) throw new Error(receipt.message)

const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: 'alpha-call',
  name: 'verify_probe',
  arguments: {},
  agent: AGENT,
})
const out = result.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
console.log('[alpha] isError:', result.isError)
console.log('[alpha] sandbox report:', out)
console.log('[alpha] marker written by spawned host shell:', existsSync(marker))
if (existsSync(marker)) console.log('[alpha] marker content:', JSON.stringify(readFileSync(marker, 'utf8')))
rmSync(marker, { force: true })
