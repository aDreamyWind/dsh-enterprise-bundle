/** Native onboarding keeps enterprise authorization and credential ownership in the Host. */
import { Context } from '@deepseek-ai/cordis'
import type { EnterpriseAccount, EnterpriseAccountView, EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account'
import type { AccountBonusOrderId, AccountClientMetadata, AccountUserId, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { EnterpriseDesktopAccountController, type DesktopAccountConfig } from '../src/desktop-account.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const config: DesktopAccountConfig = { usageUrl: 'https://admin.example.com/account', topUpUrl: 'https://admin.example.com/account' }
const client: AccountClientMetadata = { version: 'test', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }
const id = 'enterprise-attempt' as EnterpriseSignInAttemptId
const signedOut: EnterpriseAccountView = { status: 'signed-out', profile: null, attempt: null }
const waiting: EnterpriseAccountView = {
  ...signedOut,
  attempt: { id, phase: 'waiting-browser', authorizeUrl: 'https://admin.example.com/authorize?state=random', expiresAt: 1000 },
}
const signedIn: EnterpriseAccountView = {
  status: 'signed-in',
  profile: { subject: 'subject', name: 'Enterprise user', preferredUsername: null, email: null,
    picture: null, organizationId: null, organizationCode: null },
  attempt: { id, phase: 'succeeded' },
}

function fixture(settings: DesktopAccountConfig = config) {
  const ctx = new Context()
  roots.push(ctx)
  const provider = {
    getState: vi.fn<EnterpriseAccount['getState']>().mockResolvedValue(signedOut),
    startSignIn: vi.fn<EnterpriseAccount['startSignIn']>().mockResolvedValue(waiting),
    cancelSignIn: vi.fn<EnterpriseAccount['cancelSignIn']>().mockResolvedValue(signedOut),
    signOut: vi.fn<EnterpriseAccount['signOut']>().mockResolvedValue(signedOut),
    watch: vi.fn<EnterpriseAccount['watch']>(),
  }
  ctx.provide('enterpriseAccount', provider as never)
  const agents = vi.fn<() => Pick<Agent, 'status'>[]>().mockReturnValue([])
  ctx.provide('agents', { list: agents } as never)
  const controller = new EnterpriseDesktopAccountController(ctx, settings)
  return { ctx, provider, controller, agents }
}

it('projects login state without claims, and keeps caller-supplied redirects out of OIDC', async () => {
  const { controller, provider } = fixture()
  expect(await controller.getState()).toEqual({ status: 'signed-out', links: config, attempt: null })
  expect(await controller.startSignIn(client, 'http://attacker.example.com', 'desktop')).toEqual({
    status: 'signed-out', links: config, attempt: waiting.attempt,
  })
  expect(provider.startSignIn).toHaveBeenCalledExactlyOnceWith()
  provider.getState.mockResolvedValue(signedIn)
  expect(await controller.getState()).toMatchInlineSnapshot(`
    {
      "attempt": {
        "id": "enterprise-attempt",
        "phase": "succeeded",
      },
      "links": {
        "topUpUrl": "https://admin.example.com/account",
        "usageUrl": "https://admin.example.com/account",
      },
      "status": "credential-stored",
    }
  `)
  expect(controller).not.toHaveProperty('resolveAccessToken')
  expect(remoteMethods(controller).map(marker => marker.method)).toEqual(expect.arrayContaining([
    'getState', 'startSignIn', 'cancelSignIn', 'signOut', 'watch', 'watchExpiry',
  ]))
})

it('never invokes a Platform provider through inherited account methods', async () => {
  const { controller } = fixture()
  expect(controller.typertRemote.serviceKey).toBe('accountController')
  expect(controller.typertRemote.namespace).toBe('account')
  expect(await controller.getProfile(client)).toBeNull()
  expect(await controller.getBalance(client)).toBeNull()
  expect(await controller.getUnnotifiedBonuses(client)).toBeNull()
  expect(await controller.ackBonusNotified('unused' as AccountUserId, 'unused' as AccountBonusOrderId, client)).toBe(false)
  expect(controller.hasRunningAccountTasks()).toBe(false)
})

it('warns about active work even before a model request is logged', () => {
  const { controller, agents } = fixture()
  agents.mockReturnValue([{ status: 'idle' }])
  expect(controller.hasRunningAccountTasks()).toBe(false)
  agents.mockReturnValue([{ status: 'running' }])
  expect(controller.hasRunningAccountTasks()).toBe(true)
})

it('delegates cancellation and sign-out only to the enterprise provider', async () => {
  const { controller, provider } = fixture()
  expect(await controller.cancelSignIn(String(id) as SignInAttemptId)).toEqual({ status: 'signed-out', links: config, attempt: null })
  expect(provider.cancelSignIn).toHaveBeenCalledExactlyOnceWith(id)
  expect(await controller.signOut(client)).toEqual({ status: 'signed-out', links: config, attempt: null })
  expect(provider.signOut).toHaveBeenCalledExactlyOnceWith()
})

it('preserves the native terminal login failure category', async () => {
  const { controller, provider } = fixture()
  provider.getState.mockResolvedValue({ ...signedOut, attempt: { id, phase: 'failed', errorCode: 'storage' } })
  expect((await controller.getState()).attempt).toEqual({ id, phase: 'failed', errorCode: 'storage' })
  provider.getState.mockRejectedValue(new Error('storage unavailable'))
  await expect(controller.getState()).rejects.toThrow('storage unavailable')
})

it.each([
  'http://admin.example.com/account',
  'http://127.0.0.1/account',
  'https://user:password@admin.example.com/account',
  'https://admin.example.com/account?token=secret',
  'https://admin.example.com/account#secret',
  'javascript:alert(1)',
])('rejects an unsafe native destination: %s', (usageUrl) => {
  expect(() => fixture({ ...config, usageUrl })).toThrow('enterprise desktop account')
})

it('permits explicitly configured loopback development destinations only', () => {
  expect(() => fixture({ usageUrl: 'http://127.0.0.1:8080/account', topUpUrl: 'http://localhost:8080/account', allowLoopbackHttp: true })).not.toThrow()
  expect(() => fixture({ ...config, topUpUrl: 'http://admin.example.com/account', allowLoopbackHttp: true })).toThrow()
})

it.each(['abort', 'dispose'] as const)('terminates expiry listeners on %s and does not replay old expiry', async (stop) => {
  const { ctx, controller } = fixture()
  ctx.emit('enterprise-account/session-expired')
  const lifetime = new AbortController()
  const iterator = controller.watchExpiry(lifetime.signal)[Symbol.asyncIterator]()
  const first = iterator.next()
  ctx.emit('enterprise-account/session-expired')
  expect(await first).toEqual({ value: 'session-expired', done: false })
  const next = iterator.next()
  if (stop === 'abort') lifetime.abort()
  else await ctx.fiber.dispose()
  expect(await next).toEqual({ value: undefined, done: true })
  ctx.emit('enterprise-account/session-expired')
  expect(await iterator.next()).toEqual({ value: undefined, done: true })
})

it('does not subscribe already-aborted expiry or account streams', async () => {
  const { controller, provider } = fixture()
  const signal = AbortSignal.abort()
  expect(await controller.watchExpiry(signal)[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
  expect(await controller.watch(signal)[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
  expect(provider.watch).not.toHaveBeenCalled()
})

it.each(['abort', 'dispose'] as const)('projects live account state and releases the provider stream on %s', async (stop) => {
  const { ctx, controller, provider } = fixture()
  const entered = Promise.withResolvers<undefined>()
  const released = vi.fn()
  provider.watch.mockImplementation(async function* (signal) {
    try {
      yield signedIn
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
        entered.resolve(undefined)
      })
      yield waiting
    } finally { released() }
  })
  const lifetime = new AbortController()
  const iterator = controller.watch(lifetime.signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ status: 'credential-stored', links: config, attempt: signedIn.attempt })
  const next = iterator.next()
  await entered.promise
  if (stop === 'abort') lifetime.abort()
  else await ctx.fiber.dispose()
  expect(await next).toEqual({ value: undefined, done: true })
  expect(released).toHaveBeenCalledExactlyOnceWith()
})
