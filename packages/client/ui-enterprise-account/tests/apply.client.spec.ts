// @vitest-environment jsdom
/** Enterprise account UI through the production client module graph and Remote carrier. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, vi } from 'vitest'
import { ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import { ClientRoster, createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { EnterpriseAccountView, EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account/types'
import type {} from '@deepseek-ai/dsh-api-enterprise-account-controller/remote'
import type { EnterpriseAccountInjected } from '../src/client/EnterpriseAccount.tsx'
import { EnterpriseLoginGate, EnterpriseAccountSection } from '../src/client/EnterpriseAccount.tsx'
import * as account from '../src/client/account.ts'

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
  name: string
  dsh: { client: { inject: string[] } }
}
const test = createClientTest({ roster: ClientRoster.of([...webApp.rows, {
  name: manifest.name, inject: manifest.dsh.client.inject, immediately: false,
}]), provide: {
  // This tier replaces generated Remote mounts with contract-free transport proxies.
  [manifest.name]: account,
} })

const signedOut: EnterpriseAccountView = { status: 'signed-out', profile: null, attempt: null }
const signedIn: EnterpriseAccountView = {
  status: 'signed-in', attempt: null,
  profile: { subject: 'user-1', name: '测试用户', preferredUsername: 'tester', email: 'user@example.test',
    picture: null, organizationId: 'org-1', organizationCode: 'engineering' },
}

test('registers the mandatory gate and settings section against one reconnect-safe account state', async ({ mock, remote, start }) => {
  mock.stream('enterpriseAccount/watch', openStream([signedOut]))
  mock.unary('enterpriseAccount/startSignIn', ok({
    ...signedOut,
    attempt: { id: 'attempt-1', phase: 'initializing' },
  }))
  mock.unary('enterpriseAccount/signOut', ok(signedOut))
  const client = await start()
  await mock.streams.drained('enterpriseAccount/watch')
  const overlay = client.ctx.slots.entries('shell.overlay').find(entry => entry.component === EnterpriseLoginGate)
  const settings = client.ctx.slots.entries('settings.section').find(entry => entry.component === EnterpriseAccountSection)
  expect(overlay?.options.id).toBe('enterprise-account.login-gate')
  expect(settings?.options.id).toBe('enterprise-account')
  const face = overlay!.inject!() as object as EnterpriseAccountInjected
  expect(face.hooks.account.getSnapshot()).toEqual({ view: signedOut, failed: false })
  const listener = vi.fn()
  const unsubscribe = face.hooks.account.subscribe(listener)
  await face.start()
  expect(remote.enterpriseAccount.startSignIn).toHaveBeenCalledExactlyOnceWith()
  expect(face.hooks.account.getSnapshot().view?.attempt?.phase).toBe('initializing')
  mock.streams.push('enterpriseAccount/watch', signedIn)
  await vi.waitFor(() => { expect(face.hooks.account.getSnapshot().view).toEqual(signedIn) })
  await face.signOut()
  expect(face.hooks.account.getSnapshot().view).toEqual(signedOut)
  expect(listener).toHaveBeenCalled()
  unsubscribe()
})

test('keeps the newer browser authorization state when the start response arrives later', async ({ mock, remote, start }) => {
  const response = Promise.withResolvers<ReturnType<typeof ok<EnterpriseAccountView>>>()
  const attemptId = 'attempt-1' as EnterpriseSignInAttemptId
  const initializing: EnterpriseAccountView = {
    ...signedOut, attempt: { id: attemptId, phase: 'initializing' },
  }
  const waiting: EnterpriseAccountView = {
    ...signedOut, attempt: { id: attemptId, phase: 'waiting-browser', authorizeUrl: 'https://admin.example.test/authorize' },
  }
  mock.stream('enterpriseAccount/watch', openStream([signedOut]))
  mock.unary('enterpriseAccount/startSignIn', () => response.promise)
  const client = await start()
  await mock.streams.drained('enterpriseAccount/watch')
  const overlay = client.ctx.slots.entries('shell.overlay').find(entry => entry.component === EnterpriseLoginGate)
  const face = overlay!.inject!() as object as EnterpriseAccountInjected
  const starting = face.start()
  await vi.waitFor(() => { expect(remote.enterpriseAccount.startSignIn).toHaveBeenCalledExactlyOnceWith() })
  mock.streams.push('enterpriseAccount/watch', waiting)
  await vi.waitFor(() => { expect(face.hooks.account.getSnapshot().view).toEqual(waiting) })
  response.resolve(ok(initializing))
  expect(await starting).toEqual(initializing)
  expect(face.hooks.account.getSnapshot().view).toEqual(waiting)
})
