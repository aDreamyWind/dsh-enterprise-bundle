/** Enterprise fallback remains process-local and preserves the upstream default-model lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import EnterpriseDefaultModel from '../src/index.ts'

it('uses only the published provider catalog and never persists its fallback', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(EnterpriseDefaultModel, { provider: 'enterprise', model: 'configured', reasoningEffort: 'high' })
  const defaults = ctx.enterpriseModelDefaults
  defaults.setAvailableModels('other', ['different'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'enterprise', model: 'configured', reasoningEffort: 'high' })
  const ids = ['allowed', 'another']
  defaults.setAvailableModels('enterprise', ids)
  ids[0] = 'mutated'
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'enterprise', model: 'allowed' })
  defaults.setAvailableModels('enterprise', ['configured', 'allowed'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'enterprise', model: 'configured', reasoningEffort: 'high' })
  defaults.setAvailableModels('enterprise', [])
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('configured')
  defaults.setAvailableModels('enterprise', ['allowed'])
  defaults.clearAvailableModels('enterprise')
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('configured')
  await defaults.saveSelection({ provider: 'enterprise', model: 'not-persisted' })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('configured')
})

it('unregisters both default-model service names with its owning plugin', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const fork = await ctx.plugin(EnterpriseDefaultModel, { provider: 'enterprise', model: 'configured' })
  expect(ctx.get('agentDefaultModel')).toBeDefined()
  expect(ctx.get('enterpriseModelDefaults')).toBeDefined()
  await fork.dispose()
  expect(ctx.get('agentDefaultModel')).toBeUndefined()
  expect(ctx.get('enterpriseModelDefaults')).toBeUndefined()
})
