/** Pack the enterprise bundle and its private plugins without shipping an official Harness fork. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Create a fresh release directory containing a self-contained npm bundle.
 * @param {string} root - SDK-shaped workspace with built enterprise packages.
 * @param {string} output - parent directory for the new release; existing releases remain untouched.
 * @returns {string} absolute tarball path.
 */
export function packEnterprise(root, output) {
  const paths = JSON.parse(readFileSync(join(root, 'enterprise/packages.json'), 'utf8'))
  const packages = paths.map(path => ({ path, manifest: JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) }))
  const owned = new Set(packages.map(pkg => pkg.manifest.name))
  const versions = new Map(packages.map(pkg => [pkg.manifest.name, pkg.manifest.version]))
  for (const parent of ['packages', 'vendor']) {
    for (const first of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!first.isDirectory()) continue
      const directories = parent === 'vendor' ? [join(root, parent, first.name)]
        : readdirSync(join(root, parent, first.name), { withFileTypes: true })
          .filter(row => row.isDirectory()).map(row => join(root, parent, first.name, row.name))
      for (const directory of directories) {
        const file = join(directory, 'package.json')
        if (!existsSync(file)) continue
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        versions.set(manifest.name, manifest.version)
      }
    }
  }
  mkdirSync(output, { recursive: true })
  const release = mkdtempSync(join(output, 'enterprise-'))
  const staging = mkdtempSync(join(tmpdir(), 'harness-enterprise-pack-'))
  for (const [index, pkg] of packages.entries()) {
    const target = index === 0 ? staging : join(staging, 'node_modules', pkg.manifest.name)
    mkdirSync(target, { recursive: true })
    const lib = join(root, pkg.path, 'lib')
    if (!existsSync(join(lib, 'index.js'))) throw new Error(`Build ${pkg.path} before packing`)
    cpSync(lib, join(target, 'lib'), { recursive: true, dereference: true })
    for (const file of ['cordis.patch.yml', 'locale', 'README.md', 'README.zh.md', 'LICENSE']) {
      const source = join(root, pkg.path, file)
      if (existsSync(source)) cpSync(source, join(target, file), { recursive: true })
    }
    const manifest = structuredClone(pkg.manifest)
    delete manifest.devDependencies
    delete manifest.scripts
    delete manifest.private
    manifest.repository = { type: 'git', url: 'git+https://github.com/aDreamyWind/deepseek-harness-boos.git' }
    manifest.files = ['lib', 'locale', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE', '.env.example', 'desktop.patch.example.yml']
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (!version.startsWith('workspace:')) continue
        const exact = versions.get(name)
        if (exact === undefined) throw new Error(`No SDK version for ${name}`)
        manifest[section][name] = exact
      }
    }
    // Harness supplies these shared services; installing another copy would split runtime identities.
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!versions.has(name) || owned.has(name)) continue
      manifest.peerDependencies = { ...manifest.peerDependencies, [name]: version }
      delete manifest.dependencies[name]
    }
    if (index === 0) {
      manifest.engines = { ...manifest.engines, dsh: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version }
      const publicExample = join(root, 'enterprise/.env.example')
      if (existsSync(publicExample)) cpSync(publicExample, join(target, '.env.example'))
      const desktopExample = join(root, 'enterprise/desktop.patch.example.yml')
      if (existsSync(desktopExample)) cpSync(desktopExample, join(target, 'desktop.patch.example.yml'))
      manifest.dependencies = { ...manifest.dependencies, ...Object.fromEntries(packages.slice(1).map(child => [child.manifest.name, child.manifest.version])) }
      manifest.bundleDependencies = [...owned].filter(name => name !== manifest.name)
    }
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'pack', '--ignore-scripts', '--json', '--cache', join(staging, '.npm-cache'), '--pack-destination', release,
  ], { cwd: staging, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Enterprise pack failed: ${result.stderr}`)
  const [packed] = JSON.parse(result.stdout)
  if (packed === undefined || typeof packed.filename !== 'string') throw new Error('npm pack did not report a tarball')
  const included = new Set(packed.files.map(file => file.path))
  for (const pkg of packages.slice(1)) {
    if (!included.has(`node_modules/${pkg.manifest.name}/package.json`)) {
      throw new Error(`npm pack omitted bundled plugin ${pkg.manifest.name}`)
    }
  }
  const archive = join(release, packed.filename)
  writeFileSync(join(release, 'compatibility.json'), JSON.stringify({
    harnessVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    bundle: packages[0].manifest.name,
    version: packages[0].manifest.version,
    archive: packed.filename,
    plugins: [...owned],
  }, null, 2) + '\n')
  rmSync(staging, { recursive: true, force: true })
  return archive
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? defaultRoot)
  console.log(packEnterprise(root, resolve(process.argv[3] ?? join(root, 'dist/enterprise'))))
}
