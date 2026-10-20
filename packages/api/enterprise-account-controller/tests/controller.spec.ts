/** Enterprise account Remote delegation preserves safe state and stream lifetime. */
import { Context } from '@deepseek-ai/cordis'
import type { EnterpriseAccount, EnterpriseAccountView, EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account'
import { afterEach, expect, it, vi } from 'vitest'
import EnterpriseAccountController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const state: EnterpriseAccountView = { status: 'signed-out', profile: null, attempt: null }

it('requires native destinations only when Desktop compatibility is enabled', () => {
  expect(EnterpriseAccountController.Config({})).toEqual({})
  expect(EnterpriseAccountController.Config['~standard'].validate({ desktop: {} })).toHaveProperty('issues')
  expect(EnterpriseAccountController.Config({ desktop: {
    usageUrl: 'https://admin.example.test/account', topUpUrl: 'https://admin.example.test/account',
  } })).toEqual({ desktop: {
    usageUrl: 'https://admin.example.test/account', topUpUrl: 'https://admin.example.test/account',
  } })
})

function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const provider = {
    getState: vi.fn<EnterpriseAccount['getState']>().mockResolvedValue(state),
    startSignIn: vi.fn<EnterpriseAccount['startSignIn']>().mockResolvedValue(state),
    cancelSignIn: vi.fn<EnterpriseAccount['cancelSignIn']>().mockResolvedValue(state),
    signOut: vi.fn<EnterpriseAccount['signOut']>().mockResolvedValue(state),
    watch: vi.fn<EnterpriseAccount['watch']>(),
  }
  ctx.provide('enterpriseAccount', provider as never)
  return { provider, controller: new EnterpriseAccountController(ctx) }
}

it('delegates commands without exposing Host-only token methods', async () => {
  const { provider, controller } = fixture()
  expect(await controller.getState()).toBe(state)
  expect(await controller.startSignIn()).toBe(state)
  expect(provider.startSignIn).toHaveBeenCalledExactlyOnceWith()
  const id = 'attempt' as EnterpriseSignInAttemptId
  expect(await controller.cancelSignIn(id)).toBe(state)
  expect(provider.cancelSignIn).toHaveBeenCalledExactlyOnceWith(id)
  expect(await controller.signOut()).toBe(state)
  expect(controller).not.toHaveProperty('resolveAccessToken')
})

it('passes subscription lifetime through unchanged', async () => {
  const { provider, controller } = fixture()
  const lifetime = new AbortController()
  const stream: AsyncIterable<EnterpriseAccountView> = { async *[Symbol.asyncIterator]() { yield state } }
  provider.watch.mockReturnValue(stream)
  expect(controller.watch(lifetime.signal)).toBe(stream)
  expect(provider.watch).toHaveBeenCalledExactlyOnceWith(lifetime.signal)
})
