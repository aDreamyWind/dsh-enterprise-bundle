/** Enterprise account descriptors mounted independently of the official Remote assembly. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import enterpriseAccountRemote from '@deepseek-ai/dsh-api-enterprise-account-controller/remote'

/** Required service: the shared authenticated Remote transport. */
export const inject = ['remote']

/**
 * Mount enterprise account methods independently of the official Remote assembly.
 * @param ctx - browser context carrying the authenticated Remote transport.
 * @returns disposer withdrawing the account namespace after its consumers stop.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.remote.$mount({
    package: enterpriseAccountRemote.package,
    descriptors: enterpriseAccountRemote.descriptors.filter(descriptor => descriptor.namespace === 'enterpriseAccount'),
  })
}
