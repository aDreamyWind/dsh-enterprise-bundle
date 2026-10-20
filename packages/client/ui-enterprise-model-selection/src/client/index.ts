/** Mount the enterprise model Remote contribution before activating its independent selector. */
import type { Context } from '@deepseek-ai/cordis'
import enterpriseModelsRemote from '@deepseek-ai/dsh-api-enterprise-model-controller/remote'
import { apply as applySelector, inject as selectorInject } from './selector.ts'

/** Required transport for installing the enterprise-only namespace. */
export const inject = ['remote']

const remoteProvider = {
  inject: ['remote'],
  apply(ctx: Context): Promise<() => Promise<void>> {
    return ctx.remote.$mount({
      package: enterpriseModelsRemote.package,
      descriptors: enterpriseModelsRemote.descriptors.filter(descriptor => descriptor.namespace === 'enterpriseModels'),
    })
  },
}

/**
 * Mount the Remote provider and selector as separate lifecycle-owned plugins.
 * @param ctx - browser root carrying the shared authenticated Remote transport.
 */
export function apply(ctx: Context): void {
  ctx.plugin(remoteProvider)
  ctx.plugin({ inject: selectorInject, apply: applySelector })
}
