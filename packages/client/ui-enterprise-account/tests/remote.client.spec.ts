/** The enterprise namespace mounts and withdraws without the official Remote assembly. */
import { Context } from '@deepseek-ai/cordis'
import { apply as applyGateway, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-enterprise-account-controller/remote'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { expect, it } from 'vitest'
import { apply, inject } from '../src/client/remote.ts'

it('owns enterprise RPC methods and removes them when the client plugin unloads', async () => {
  const ctx = new Context()
  const mock = RemoteMock.create()
  const state = { status: 'signed-out', profile: null, attempt: null }
  mock.unary('enterpriseAccount/getState', ok(state))
  try {
    await ctx.plugin(TypertRegistry)
    installConnection(ctx, {
      interactions: 'answer', transport: { rpc: mock.rpc }, location: { hostname: 'localhost' },
    })
    await ctx.plugin({ inject: gatewayInject, apply: applyGateway })
    const bridge = ctx.plugin({ inject, apply })
    await bridge
    expect(await ctx.remote.enterpriseAccount.getState()).toEqual({ ok: true, value: state })
    expect(ctx.remote.account).toBeUndefined()
    await bridge.dispose()
    expect(ctx.get('remote.enterpriseAccount')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    mock.assertNoUnmatched()
  }
})
