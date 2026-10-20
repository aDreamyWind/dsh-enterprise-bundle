/** Plain-Node import and source-import rejection over the gateway's published file set. */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const gateway = await import(new URL('lib/index.js', root).href)
assert.equal(gateway.name, 'llm-enterprise-gateway')
assert.ok(gateway.inject.includes('enterpriseModelDefaults'))

const files = [new URL('lib/index.js', root)]
async function declarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) await declarations(path)
    else if (entry.name.endsWith('.d.ts')) files.push(path)
  }
}
await declarations(new URL('lib/types/', root))
for (const path of files) {
  assert.doesNotMatch(await readFile(path, 'utf8'), /(?:from\s*|import\s*\(\s*)['"][^'"]*\/src\//,
    `published artifact imports upstream TypeScript source: ${path.pathname}`)
}
console.log(`gateway artifact smoke passed (${files.length} published modules)`)
