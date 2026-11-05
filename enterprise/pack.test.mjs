import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { packEnterprise } from './pack.mjs'

test('the npm archive preserves Harness compatibility and licenses without build-machine metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'enterprise-pack-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bundle = 'packages/bundle/enterprise'
  const child = 'packages/client/ui-enterprise-model-selection'
  const childName = '@fixture/model-selection'
  const childEntry = `package/node_modules/${childName}`
  const localPath = 'C:/Users/builder/project'
  const write = (file, text) => {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const json = (file, value) => write(file, JSON.stringify(value))
  json('enterprise/packages.json', [bundle, child])
  json('package.json', { version: '0.8.0-beta.1' })
  json(`${bundle}/package.json`, { name: '@fixture/enterprise', version: '1.0.0' })
  json(`${child}/package.json`, { name: childName, version: '1.0.0' })
  write('LICENSE', 'Harness SDK license\n')
  write('plugin-license', 'Enterprise plugin license\n')
  write('vendor/cosmokit/LICENSE', 'Original Cosmokit license\n')
  write('vendor/schemastery/LICENSE', 'Original Schemastery license\n')
  write(`${child}/node_modules/clsx/license`, 'Original clsx license\n')
  write(`${bundle}/lib/index.js`, 'export const active = true\n')
  write(`${child}/lib/index.js`, `  //#region ${localPath}/plugin.ts\nexport const model = 'enterprise'\n  //#endregion\n//# sourceMappingURL=index.js.map\n`)
  write(`${child}/lib/index.d.ts`, 'export declare const model: string\n//# sourceMappingURL=index.d.ts.map\n')
  write(`${child}/lib/style.css`, 'main{display:grid}/*# sourceMappingURL=style.css.map */\n')
  write(`${child}/lib/index.js.map`, localPath)
  write(`${child}/lib/tsconfig.tsbuildinfo`, localPath)

  const archive = packEnterprise(root, join(root, 'dist'), join(root, 'plugin-license'))
  const tar = (...args) => execFileSync('tar', args, { encoding: 'utf8' })
  const contents = tar('-tzf', archive).trimEnd().split('\n')
  const read = entry => tar('-xOzf', archive, entry)
  const manifest = JSON.parse(read('package/package.json'))
  const childManifest = JSON.parse(read(`${childEntry}/package.json`))
  const compatibility = JSON.parse(readFileSync(join(dirname(archive), 'compatibility.json'), 'utf8'))
  assert.equal(manifest.version, '1.0.0')
  assert.equal(manifest.engines.dsh, '0.8.0-beta.1')
  assert.equal(childManifest.version, manifest.version)
  assert.equal(childManifest.engines.dsh, manifest.engines.dsh)
  assert.equal(compatibility.version, manifest.version)
  assert.equal(compatibility.harnessVersion, manifest.engines.dsh)
  assert.equal(read('package/LICENSE'), 'Enterprise plugin license\n')
  assert.equal(read(`${childEntry}/LICENSE`), 'Enterprise plugin license\n')
  const notices = read('package/THIRD_PARTY_LICENSES')
  for (const notice of ['Harness SDK license', 'Original Cosmokit license', 'Original Schemastery license', 'Original clsx license']) {
    assert.ok(notices.includes(notice), `Missing ${notice}`)
  }
  assert.equal(read(`${childEntry}/lib/index.js`), "export const model = 'enterprise'\n")
  assert.equal(read(`${childEntry}/lib/index.d.ts`), 'export declare const model: string\n')
  assert.equal(read(`${childEntry}/lib/style.css`).trimEnd(), 'main{display:grid}')
  assert.ok(contents.every(file => !/\.(?:map|tsbuildinfo)$/u.test(file)))
})
