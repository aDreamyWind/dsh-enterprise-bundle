/** Build detached enterprise sources against an official SDK snapshot without editing that checkout. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { tmpdir } from 'node:os'
import { packEnterprise } from './pack.mjs'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { harness: { type: 'string' }, ref: { type: 'string' }, out: { type: 'string' } } })
if (values.harness === undefined) throw new Error('Usage: node enterprise/build.mjs --harness /path/to/installed-official-checkout [--ref HEAD] [--out dist]')
const sdk = resolve(values.harness)
if (!existsSync(join(sdk, 'node_modules/typescript/bin/tsc'))) throw new Error('Run pnpm install in the official checkout first')
const revision = spawnSync('git', ['rev-parse', values.ref ?? 'HEAD'], { cwd: sdk, encoding: 'utf8' })
if (revision.error !== undefined) throw revision.error
if (revision.status !== 0 || !/^[0-9a-f]{40}\s*$/u.test(revision.stdout)) throw new Error('Cannot resolve the official SDK Git revision')
const output = resolve(values.out ?? join(source, 'dist'))
mkdirSync(output, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'harness-enterprise-sdk-'))

/** Run one build operation without a shell and stop on any unsuccessful exit. */
function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}; build retained at ${work}`)
}

run('git', ['archive', '--format=tar', '--output', join(work, 'sdk.tar'), values.ref ?? 'HEAD'], sdk)
const assembled = join(work, 'workspace')
mkdirSync(assembled)
run('tar', ['-xf', join(work, 'sdk.tar'), '-C', assembled], sdk)
const sdkVersion = JSON.parse(readFileSync(join(assembled, 'package.json'), 'utf8')).version
const expected = existsSync(join(source, 'compatibility.json'))
  ? JSON.parse(readFileSync(join(source, 'compatibility.json'), 'utf8')).harnessVersion
  : JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version
if (sdkVersion !== expected) throw new Error(`Plugin targets Harness ${expected}, not ${sdkVersion}; port and test the plugin before changing compatibility.json`)
mkdirSync(join(assembled, 'node_modules'))
for (const entry of readdirSync(join(sdk, 'node_modules'), { withFileTypes: true })) {
  if (entry.name.startsWith('.pnpm-task-run-state')) continue
  symlinkSync(join(sdk, 'node_modules', entry.name), join(assembled, 'node_modules', entry.name),
    process.platform === 'win32' && entry.isDirectory() ? 'junction' : entry.isDirectory() ? 'dir' : 'file')
}
const dependencyDirectories = [join(sdk, 'node_modules'), ...globSync([
  'packages/*/*/node_modules', 'vendor/*/node_modules', 'apps/*/node_modules',
  'native/system/node_modules', 'native/system/packages/*/node_modules',
], { cwd: sdk }).map(path => join(sdk, path))]
for (const directory of dependencyDirectories.slice(1)) {
  const target = join(assembled, directory.slice(sdk.length + 1))
  if (!existsSync(dirname(target))) continue
  symlinkSync(directory, target, process.platform === 'win32' ? 'junction' : 'dir')
}
const paths = JSON.parse(readFileSync(join(source, 'enterprise/packages.json'), 'utf8'))
for (const path of paths) cpSync(join(source, path), join(assembled, path), {
  recursive: true,
  filter: file => !['node_modules', 'lib'].includes(file.split(/[\\/]/u).at(-1)),
})
cpSync(join(source, 'enterprise'), join(assembled, 'enterprise'), { recursive: true })
cpSync(join(source, '.env.example'), join(assembled, '.env.example'))
const owned = new Map(paths.map(path => [JSON.parse(readFileSync(join(assembled, path, 'package.json'), 'utf8')).name, path]))
for (const path of paths) {
  const modules = join(assembled, path, 'node_modules')
  if (existsSync(modules)) continue
  mkdirSync(modules)
  const manifest = JSON.parse(readFileSync(join(assembled, path, 'package.json'), 'utf8'))
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }
  for (const name of Object.keys(dependencies)) {
    const local = owned.get(name)
    const installed = local === undefined
      ? dependencyDirectories.map(directory => join(directory, name)).find(directory => existsSync(join(directory, 'package.json')))
      : join(assembled, local)
    if (installed === undefined) throw new Error(`SDK installation lacks ${name}, required by ${manifest.name}`)
    const link = join(modules, name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(installed, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
const base = join(assembled, 'tsconfig.base.json')
// Official base config contains comments. TypeScript owns parsing its accepted JSON syntax.
const ts = await import(pathToFileURL(join(sdk, 'node_modules/typescript/lib/typescript.js')).href)
const parsed = ts.default.readConfigFile(base, file => readFileSync(file, 'utf8'))
if (parsed.error !== undefined) throw new Error('Cannot read SDK tsconfig.base.json')
const config = parsed.config
const host = ts.default.readConfigFile(join(assembled, 'tsconfig.host.json'), file => readFileSync(file, 'utf8')).config
const client = ts.default.readConfigFile(join(assembled, 'tsconfig.client.json'), file => readFileSync(file, 'utf8')).config
for (const path of paths) {
  const manifest = JSON.parse(readFileSync(join(assembled, path, 'package.json'), 'utf8'))
  for (const [suffix, file] of [['', 'src/index.ts'], ['/types', 'src/types.ts'], ['/client', 'src/client/index.ts']]) {
    if (existsSync(join(assembled, path, file))) config.compilerOptions.paths[manifest.name + suffix] = [`./${path}/${file}`]
  }
  const split = existsSync(join(assembled, path, 'tsconfig.host.json'))
  const hostPath = `./${path}${split ? '/tsconfig.host.json' : ''}`
  const clientPath = `./${path}${split ? '/tsconfig.client.json' : ''}`
  if (split || manifest.dsh?.client === undefined) {
    if (!host.references.some(row => row.path === hostPath)) host.references.push({ path: hostPath })
  }
  if (manifest.dsh?.client !== undefined && !client.references.some(row => row.path === clientPath)) client.references.push({ path: clientPath })
}
writeFileSync(base, JSON.stringify(config, null, 2) + '\n')
writeFileSync(join(assembled, 'tsconfig.host.json'), JSON.stringify(host, null, 2) + '\n')
writeFileSync(join(assembled, 'tsconfig.client.json'), JSON.stringify(client, null, 2) + '\n')
run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--config.verifyDepsBeforeRun=false', 'run', 'build:artifacts'], assembled,
  { env: { ...process.env, DSH_CLIENT_COMMIT_HASH: revision.stdout.trim(), DSH_GATE_CONCURRENCY: process.env.DSH_GATE_CONCURRENCY ?? '2' }, shell: process.platform === 'win32' })
console.log(packEnterprise(assembled, join(output, 'releases')))
