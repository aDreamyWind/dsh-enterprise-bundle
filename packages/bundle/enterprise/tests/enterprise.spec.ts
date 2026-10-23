/** Enterprise bundle manifest and patch contract. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

interface InsertRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

interface PatchEntry {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: InsertRow[]
}

it('declares the enterprise OIDC and gateway rows through a parseable bundle patch', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  expect(Array.isArray(parsed)).toBe(true)
  const entries = parsed as PatchEntry[]
  for (const id of ['deepseek-account', 'llm-deepseek-account', 'llm-deepseek', 'llm-pi-ai']) {
    expect(entries).toContainEqual(expect.objectContaining({ id, disabled: true }))
  }
  const rows = entries.flatMap(entry => entry.insert ?? [])
  for (const id of ['agent-default-model', 'ui-model-selection']) {
    expect(entries).toContainEqual(expect.objectContaining({ id, disabled: true }))
  }
  expect(rows.find(row => row.id === 'enterprise-default-model')).toMatchObject({
    config: {
      provider: 'harness-admin',
      model: { __jsExpr: "JSON.parse(process.env.DSH_ENTERPRISE_MODELS ?? process.env.HARNESS_ADMIN_MODELS ?? '[]')[0]?.id" },
    },
  })
  expect(rows.find(row => row.id === 'enterprise-account')).toMatchObject({
    name: '@deepseek-ai/dsh-enterprise-account-oidc',
    config: {
      clientId: { __jsExpr: "ctx.get('profileContext')?.name === 'desktop' ? process.env.DSH_ENTERPRISE_DESKTOP_OIDC_CLIENT_ID : process.env.HARNESS_ADMIN_WEB_OIDC_CLIENT_ID" },
      clientSecret: { __jsExpr: "ctx.get('profileContext')?.name === 'desktop' ? undefined : process.env.HARNESS_ADMIN_WEB_OIDC_CLIENT_SECRET" },
      clientAuthMethod: { __jsExpr: "ctx.get('profileContext')?.name === 'desktop' ? 'none' : 'client_secret_basic'" },
      redirectUri: { __jsExpr: "ctx.get('profileContext')?.name === 'desktop' ? 'http://127.0.0.1/oauth/callback' : process.env.HARNESS_ADMIN_WEB_OIDC_REDIRECT_URI" },
      redirectMode: { __jsExpr: "ctx.get('profileContext')?.name === 'desktop' ? 'loopback-random-port' : 'fixed'" },
    },
  })
  expect(rows.find(row => row.id === 'enterprise-account')?.config?.scopes).toEqual(
    ['openid', 'profile', 'model.invoke', 'mcp.invoke', 'offline_access'],
  )
  expect(rows.find(row => row.id === 'mcp-enterprise-connections')).toMatchObject({
    name: '@deepseek-ai/dsh-mcp-enterprise-connections',
  })
  expect(rows.find(row => row.id === 'llm-enterprise-gateway')).toMatchObject({
    name: '@deepseek-ai/dsh-llm-enterprise-gateway',
    config: {
      gatewayBaseURL: { __jsExpr: 'process.env.DSH_ENTERPRISE_GATEWAY_BASE_URL ?? process.env.HARNESS_ADMIN_GATEWAY_BASE_URL' },
      models: { __jsExpr: "JSON.parse(process.env.DSH_ENTERPRISE_MODELS ?? process.env.HARNESS_ADMIN_MODELS ?? '[]')" },
    },
  })
  expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-llm-enterprise-gateway')
})
