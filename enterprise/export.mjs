/** Export only enterprise-owned sources and build tools to a detachable plugin workspace. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { positionals, values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true })
const output = resolve(positionals[0] ?? join(root, 'dist/enterprise-source'))
if (values.out === undefined) mkdirSync(output, { recursive: true })
const destination = values.out === undefined ? mkdtempSync(join(output, 'source-')) : resolve(values.out)
if (values.out !== undefined) mkdirSync(destination)
mkdirSync(join(destination, 'enterprise'))
const paths = JSON.parse(readFileSync(join(root, 'enterprise/packages.json'), 'utf8'))
for (const path of paths) {
  const target = join(destination, path)
  mkdirSync(target, { recursive: true })
  for (const file of ['src', 'tests', 'locale', 'package.json', 'cordis.patch.yml', 'tsconfig.json',
    'tsconfig.host.json', 'tsconfig.client.json', 'tsdown.config.ts', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE']) {
    const source = join(root, path, file)
    if (existsSync(source)) cpSync(source, join(target, file), { recursive: true })
  }
}
for (const file of ['packages.json', 'pack.mjs', 'pack.test.mjs', 'build.mjs', 'export.mjs', '.env.example', 'desktop.patch.example.yml', 'README.md', 'README.zh.md', 'README.i18n.yaml']) {
  cpSync(join(root, 'enterprise', file), join(destination, 'enterprise', file), { recursive: true })
}
cpSync(join(root, 'enterprise/.env.example'), join(destination, '.env.example'))
cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'))
const pluginVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
writeFileSync(join(destination, 'package.json'), JSON.stringify({
  name: '@adreamywind/harness-enterprise-source', private: true, type: 'module', version: pluginVersion,
  license: 'MIT', scripts: { build: 'node enterprise/build.mjs', 'test:pack': 'node --test enterprise/pack.test.mjs' },
}, null, 2) + '\n')
cpSync(join(root, 'compatibility.json'), join(destination, 'compatibility.json'))
writeFileSync(join(destination, '.gitignore'), "# Build output and dependencies\ndist/\nlib/\nnode_modules/\n*.tsbuildinfo\n*.tgz\n\n# Local configuration and credentials\n.env\n.env.*\n!.env.example\n\n# Logs, coverage, and caches\n*.log\ncoverage/\n.cache/\n\n# Editor and OS files\n.idea/\n.vscode/\n.DS_Store\nThumbs.db\n")
cpSync(join(root, 'README.md'), join(destination, 'README.md'))
console.log(destination)
