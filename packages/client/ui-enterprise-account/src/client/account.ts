/** Enterprise account UI registrations consuming the mounted account namespace. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-enterprise-account-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { EnterpriseAccountView } from '@deepseek-ai/dsh-enterprise-account/types'
import { EnterpriseAccountSection, EnterpriseLoginGate, type EnterpriseAccountInjected,
  type EnterpriseAccountSnapshot } from './EnterpriseAccount.tsx'
import { en, zh, type EnterpriseAccountKey } from './locales.ts'
import { waitForStart } from './start.ts'

export type { EnterpriseAccountInjected, EnterpriseAccountSnapshot } from './EnterpriseAccount.tsx'
export type { EnterpriseAccountKey } from './locales.ts'

/** Browser wait limit for starting enterprise sign-in. */
export interface Config {
  /** Maximum time to wait for the Host's start-sign-in response. */
  startTimeoutMs?: number
}

/** Validated browser sign-in configuration. */
export const Config: Schema<Config> = Schema.object({
  startTimeoutMs: Schema.number().min(1_000).max(120_000).default(15_000),
})

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'enterprise.account': EnterpriseAccountKey }
}

/** Services required by the enterprise account browser plugin. */
export const inject = ['slots', 'locale', 'remote', 'remote.enterpriseAccount']

/**
 * Register the mandatory login gate and enterprise identity settings section.
 * @param ctx - browser plugin context.
 * @param config - validated wait limit for the Host sign-in response.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.effect(() => ctx.locale.register('enterprise.account', { en, zh }), 'enterprise account: dictionaries')
  const t = ctx.locale.bind('enterprise.account')
  let snapshot: EnterpriseAccountSnapshot = { view: undefined, failed: false }
  const listeners = new Set<() => void>()
  const publish = (value: EnterpriseAccountSnapshot): void => {
    snapshot = value
    for (const listener of listeners) listener()
  }
  const stream = ctx.remote.$stream<EnterpriseAccountView>({
    name: 'enterprise-account',
    open: signal => ctx.remote.enterpriseAccount.watch(signal),
    ended: () => new Error('enterprise account stream ended'),
  })
  let disposed = false
  ctx.effect(() => () => { disposed = true; return stream.dispose() }, 'enterprise account: state stream')
  void (async () => {
    for await (const frame of stream) {
      publish({ view: frame.value, failed: false })
      frame.accept()
    }
  })().catch(() => { if (!disposed) publish({ ...snapshot, failed: true }) })
  const update = (view: EnterpriseAccountView): void => { publish({ view, failed: false }) }
  const face: EnterpriseAccountInjected = {
    hooks: { account: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } },
    async start() {
      const result = await waitForStart(ctx.remote.enterpriseAccount.startSignIn(), config.startTimeoutMs as number)
      if (!result.ok) throw result.error
      update(result.value)
      return result.value
    },
    async cancel(id) {
      const result = await ctx.remote.enterpriseAccount.cancelSignIn(id)
      if (!result.ok) throw result.error
      update(result.value)
    },
    async signOut() {
      const result = await ctx.remote.enterpriseAccount.signOut()
      if (!result.ok) throw result.error
      update(result.value)
    },
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'enterprise-account.login-gate', locale: 'enterprise.account', inject: () => face,
  }, EnterpriseLoginGate))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'enterprise-account', order: -20, label: () => t('nav'),
    locale: 'enterprise.account', inject: () => face,
  }, EnterpriseAccountSection))
}
