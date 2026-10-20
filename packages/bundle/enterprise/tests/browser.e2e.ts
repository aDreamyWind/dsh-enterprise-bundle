/** Built enterprise plugins boot against the ordinary Web client without replacing its Session module. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from '../../../../apps/web/tests/scaffold.ts'

const BUNDLE = fileURLToPath(new URL('../', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./browser.overlay.yml', import.meta.url))

it('keeps the upstream Session client and displays the enterprise gate through its own Remote registration', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [`${BUNDLE}cordis.patch.yml`, OVERLAY],
    extraInstallAnchors: [`${BUNDLE}package.json`],
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ locale: 'en-US' })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('heading', { name: 'Sign in to continue', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Sign in with SSO', exact: true }).waitFor()
    expect(await page.getByText('Failed to load plugins', { exact: true }).count()).toBe(0)
    expect(await page.getByText('Account status is unavailable. Reconnect and try again.', { exact: true }).count()).toBe(0)
    const modules = await page.evaluate(() => {
      const graph = Reflect.get(window, '__DSH_BOOT__') as { entries: Array<{ id: string }> }
      return graph.entries.map(entry => entry.id)
    })
    expect(modules).toContain('@deepseek-ai/dsh-api-session-controller')
    expect(modules).toContain('@deepseek-ai/dsh-client-ui-enterprise-account')
    expect(modules).toContain('@deepseek-ai/dsh-client-ui-enterprise-model-selection')
    expect(modules).not.toContain('@deepseek-ai/dsh-api-enterprise-session-controller')
    expect(scaffold.ctx.get('sessionController')).toBeDefined()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})
