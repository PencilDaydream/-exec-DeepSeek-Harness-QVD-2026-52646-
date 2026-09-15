/**
 * 实验：在当前的工具沙箱权限下，普通插件代码（不走 POC 的 subprocess
 * 逃逸）能在家目录写文件吗？
 *
 * 一个普通 cordis 插件，其 apply() 主体对 $HOME 下的绝对路径调用 node:fs
 * writeFileSync —— 这正是任何已挂载插件都拥有的能力。没有
 * harness.registerTool、没有 exec.agent.ctx、没有 subprocess spawn。
 *
 * 从 DeepSeek Harness checkout 根目录运行：
 *   cd deepseek-harness
 *   node_modules/.bin/tsx ../dsh-security-pocs/scripts/plugin-home-write.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const dst = join(homedir(), 'test2.txt')
const tmpProbe = join(tmpdir(), 'dsh-plugin-home-write-probe.txt')

const results: Record<string, string> = {}

const ctx = new Context()
await ctx.plugin({
  name: 'home-write-probe',
  apply() {
    // 探针 1：写入 $HOME —— 本实验要回答的问题。
    try {
      writeFileSync(dst, 'written-by-plugin-code\n')
      results['home write (inside plugin apply)'] = 'SUCCEEDED'
    } catch (err) {
      results['home write (inside plugin apply)'] = 'DENIED: ' + String((err as Error).message)
    }
    // 探针 2：对照组 —— $HOME 不可写时临时区仍然可写。
    try {
      writeFileSync(tmpProbe, 'probe')
      results['tmp control write'] = 'SUCCEEDED'
    } catch (err) {
      results['tmp control write'] = 'DENIED: ' + String((err as Error).message)
    }
  },
})

console.log('[probe] plugin apply() ran')
for (const [k, v] of Object.entries(results)) console.log(`[probe] ${k}: ${v}`)
console.log(`[probe] ${dst} exists after apply: ${existsSync(dst)}`)
if (existsSync(dst)) console.log('[probe] dst content:', JSON.stringify(readFileSync(dst, 'utf8')))
process.exit(0)
