/** Run an installed enterprise archive through an unmodified, built upstream CLI and Chromium. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'

const { values } = parseArgs({ options: {
  cli: { type: 'string' }, home: { type: 'string' }, profile: { type: 'string' }, fixture: { type: 'string' }, screenshot: { type: 'string' },
} })
for (const key of ['cli', 'home', 'profile']) assert.ok(values[key], `--${key} is required`)
assert.notEqual(process.platform, 'win32', 'this smoke owns a POSIX process group')
const cli = await realpath(resolve(values.cli))
const home = await realpath(resolve(values.home))
const profile = values.profile
assert.match(profile, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const profileDir = join(home, 'profiles', profile)
const { name: bundleName } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const installed = await realpath(join(profileDir, 'node_modules', bundleName))
const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
assert.equal(manifest.name, bundleName)
assert.ok(installed.startsWith(`${profileDir}/node_modules/`), 'the archive must be installed inside the profile, not linked to source')
const fixture = values.fixture === undefined
  ? fileURLToPath(new URL('./fixtures/account.mjs', import.meta.url))
  : resolve(values.fixture)
assert.ok(isAbsolute(fixture))
const workspace = await mkdtemp(join(tmpdir(), 'dsh-installed-enterprise-browser-'))
const overlay = join(workspace, 'smoke.patch.yml')
await writeFile(overlay, `- id: enterprise-account\n  disabled: true\n- insert:\n    - id: enterprise-smoke-account\n      name: ${JSON.stringify(fixture)}\n`, { mode: 0o600 })
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/KEY|SECRET|TOKEN|PASSWORD/.test(name) && !name.startsWith('HARNESS_ADMIN_') && !name.startsWith('DSH_ENTERPRISE_')))
env.DSH_HOME = home
env.HARNESS_ADMIN_OIDC_ISSUER = 'https://admin.example.test'
env.HARNESS_ADMIN_MODELS = JSON.stringify([{ id: 'enterprise-smoke', name: 'Enterprise Smoke' }])
env.HARNESS_ADMIN_GATEWAY_BASE_URL = 'https://admin.example.test/v1'
const child = spawn(process.execPath, [cli, '--profile', profile, '--patch', overlay, '--patch', fileURLToPath(new URL('../../../../apps/web/tests/pin-browse-picker.overlay.yml', import.meta.url)), '--port', '0', '--no-open'], {
  cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
let authenticatedUrl
let browser
let exit
const stopped = new Promise(resolveExit => {
  child.once('exit', (code, signal) => { exit = { code, signal }; resolveExit(exit) })
})
function safeDiagnostic(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/g, '<URL>')
}
try {
  authenticatedUrl = await new Promise((ready, reject) => {
    const deadline = setTimeout(() => reject(new Error(`CLI readiness timed out\n${safeDiagnostic(log)}`)), 120_000)
    const finish = action => { clearTimeout(deadline); action() }
    const capture = chunk => {
      log = `${log}${String(chunk)}`.slice(-131_072)
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(log)
      if (match !== null) finish(() => ready(match[1]))
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', error => finish(() => reject(error)))
    void stopped.then(status => finish(() => reject(new Error(`CLI exited before readiness: ${JSON.stringify(status)}\n${safeDiagnostic(log)}`))))
  })
  browser = await chromium.launch()
  const page = await browser.newPage({ locale: 'en-US' })
  const errors = []
  page.on('pageerror', error => errors.push(safeDiagnostic(error.message)))
  await page.goto(authenticatedUrl, { waitUntil: 'load' })
  await page.locator('h2').filter({ hasText: /^Sign in to continue$/ }).waitFor()
  await page.locator('button').filter({ hasText: /^Sign in with SSO$/ }).waitFor()
  assert.equal(await page.getByText('Failed to load plugins', { exact: true }).count(), 0)
  const modules = await page.evaluate(() => Reflect.get(window, '__DSH_BOOT__').entries.map(entry => entry.id))
  assert.ok(modules.includes('@deepseek-ai/dsh-api-session-controller'))
  assert.ok(modules.includes('@deepseek-ai/dsh-client-ui-enterprise-account'))
  assert.ok(modules.includes('@deepseek-ai/dsh-client-ui-enterprise-model-selection'))
  if (values.screenshot !== undefined) await page.screenshot({ path: resolve(values.screenshot), fullPage: true })
  assert.deepEqual(errors, [])
  assert.doesNotMatch(log, /did not activate|Plugins waiting for services|Failed plugins/)
  console.log(`installed enterprise archive browser smoke passed (${manifest.version}; upstream CLI, original Session module, enterprise SSO gate)`)
} catch (error) {
  console.error(safeDiagnostic(error instanceof Error ? error.stack : error))
  console.error(safeDiagnostic(log))
  process.exitCode = 1
} finally {
  try { await browser?.close() } finally {
    if (exit === undefined && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM')
      let deadline
      const settled = await Promise.race([
        stopped.then(() => true),
        new Promise(resolveDeadline => { deadline = setTimeout(() => resolveDeadline(false), 15_000) }),
      ])
      clearTimeout(deadline)
      if (!settled) { process.kill(-child.pid, 'SIGKILL'); await stopped }
    }
    await rm(workspace, { recursive: true, force: true })
  }
}
