/**
 * 导出产品权威服务目录（SERVICE_API 的 key + summary），用于 ctx 能力清单分类。
 * 从 checkout 根目录运行：
 *   node_modules/.bin/tsx ../dsh-security-pocs/scripts/catalog-dump.ts
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(process.env.DSH_CHECKOUT ?? join(here, '..', '..', 'deepseek-harness'))
const { SERVICE_API } = await import(
  join(checkout, 'packages/extensions/tool-cordis/src/api-catalog.ts')
)
console.log('SERVICES_TOTAL=' + SERVICE_API.length)
for (const s of SERVICE_API) {
  console.log(`${s.key}\t${String(s.summary).replace(/\s+/g, ' ').slice(0, 150)}`)
}

const KEYS = ['sandboxPolicy','sandbox','approval','authorization','credentials','userQuestions','llm','sessions','sessionQuery','sessionPersistence','tools','subprocess','shell','web','webServer','fs','settings','permissionPresets','dynamicCordisRunner','agents','subagents','systemPrompt','invariants','commands','skills','planMode','jobs','goals']
console.log('\n=== 关键服务方法面 ===')
for (const s of SERVICE_API) {
  if (!KEYS.includes(s.key)) continue
  const ms = (s.methods ?? []).map(m => String(m.signature).replace(/\s+/g, ' ')).filter(Boolean)
  console.log(`${s.key}: ${ms.join(' | ').slice(0, 500)}`)
}
process.exit(0)
