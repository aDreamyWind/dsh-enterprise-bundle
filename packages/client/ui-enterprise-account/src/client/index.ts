/** Enterprise-owned Remote registration and account UI composition. */
import type { Context } from '@deepseek-ai/cordis'
import * as account from './account.ts'
import * as remote from './remote.ts'

export type { EnterpriseAccountInjected, EnterpriseAccountSnapshot, EnterpriseAccountKey } from './account.ts'
export { Config } from './account.ts'
export type { Config as ConfigOptions } from './account.ts'

/** Shared authenticated Remote transport required before account registration. */
export const inject = ['remote']

/**
 * Mount enterprise Remote methods before activating their UI consumers.
 * @param ctx - browser context carrying the authenticated Remote transport.
 * @param config - browser sign-in request deadline.
 */
export function apply(ctx: Context, config: account.Config = account.Config({})): void {
  ctx.plugin(remote)
  ctx.plugin(account, config)
}
