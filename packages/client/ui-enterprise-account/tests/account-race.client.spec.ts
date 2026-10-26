// @vitest-environment jsdom
/** Account stream and sign-in RPC can settle in either order. */
import type { Context } from '@deepseek-ai/cordis'
import type { EnterpriseAccountView, EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account/types'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/account.ts'
import type { EnterpriseAccountInjected } from '../src/client/EnterpriseAccount.tsx'

it('preserves waiting-browser when its stream frame precedes the initializing RPC response', async () => {
  const attemptId = 'attempt-1' as EnterpriseSignInAttemptId
  const signedOut: EnterpriseAccountView = { status: 'signed-out', profile: null, attempt: null }
  const initializing: EnterpriseAccountView = {
    ...signedOut, attempt: { id: attemptId, phase: 'initializing' },
  }
  const waiting: EnterpriseAccountView = {
    ...signedOut, attempt: { id: attemptId, phase: 'waiting-browser', authorizeUrl: 'https://admin.example.test/authorize' },
  }
  const response = Promise.withResolvers<ReturnType<typeof ok<EnterpriseAccountView>>>()
  const nextFrame = Promise.withResolvers<{ value: EnterpriseAccountView; accept(): void }>()
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { value: signedOut, accept() {} }
      yield await nextFrame.promise
    },
    dispose: vi.fn(async () => {}),
  }
  let face: EnterpriseAccountInjected | undefined
  const ctx = {
    effect: (register: () => unknown) => { register() },
    locale: { register: () => () => {}, bind: () => () => '' },
    remote: {
      $stream: () => stream,
      enterpriseAccount: { startSignIn: vi.fn(() => response.promise) },
    },
    slots: {
      inject: (_slot: string, register: () => unknown) => { register() },
      register: (entry: { inject: () => EnterpriseAccountInjected }) => {
        face ??= entry.inject()
        return () => {}
      },
    },
  } as object as Context
  apply(ctx)
  await vi.waitFor(() => { expect(face?.hooks.account.getSnapshot().view).toEqual(signedOut) })
  const starting = face!.start()
  nextFrame.resolve({ value: waiting, accept() {} })
  await vi.waitFor(() => { expect(face?.hooks.account.getSnapshot().view).toEqual(waiting) })
  response.resolve(ok(initializing))
  expect(await starting).toEqual(initializing)
  expect(face?.hooks.account.getSnapshot().view).toEqual(waiting)
})
