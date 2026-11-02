/** The enterprise catalog samples availability without replacing ordinary Session operations. */
import { Context } from '@deepseek-ai/cordis'
import EnterpriseDefaultModel from '@deepseek-ai/dsh-agent-enterprise-default-model'
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller/src/catalog.ts'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished } from 'vitest'
import EnterpriseModelController from '../src/index.ts'

it('returns an authorized default on the first directory read and preserves the Session provider', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(EnterpriseDefaultModel, { provider: 'enterprise', model: 'unavailable', reasoningEffort: 'high' })
  await ctx.plugin(LlmRuntime)
  const modelCatalog = () => buildModelCatalog(ctx)
  ctx.provide('sessionController', { modelCatalog } as never)
  ctx.llm.registerAdapter(['enterprise'], new class extends LlmAdapter {
    override async listModels(provider: string) {
      ctx.enterpriseModelDefaults.setAvailableModels(provider, ['allowed'])
      return [{ provider, id: 'allowed', name: 'Enterprise Chat' }]
    }

    override async resolveModel(provider: string, id: string) { return { provider, id, name: 'Enterprise Chat' } }
    override async *stream() {}
  }())
  const controller = new EnterpriseModelController(ctx)
  expect(remoteMethods(controller).map(marker => marker.method)).toEqual(['modelCatalog'])
  expect(controller.typertRemote.namespace).toBe('enterpriseModels')
  expect(await controller.modelCatalog()).toEqual({
    default: { provider: 'enterprise', model: 'allowed' },
    routableProviders: ['enterprise'],
    groups: [{ id: 'enterprise', name: 'enterprise', models: [{ id: 'allowed', name: 'Enterprise Chat' }] }],
    failures: [],
  })
  expect(ctx.sessionController).toHaveProperty('modelCatalog', modelCatalog)
})
