/** Enterprise OIDC projection for the unmodified Electron shell's account RPC. */
import { Context } from '@deepseek-ai/cordis'
import { AccountController } from '@deepseek-ai/dsh-api-account-controller'
import type {} from '@deepseek-ai/dsh-agent'
import type { AccountBonusBatch, AccountBonusOrderId, AccountClientMetadata, AccountDetails,
  AccountUserId, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { EnterpriseAccountView, EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account'

/** Public destinations required by the native account-state decoder. */
export interface DesktopAccountConfig {
  /** Enterprise account or usage page; never an official DeepSeek destination by default. */
  readonly usageUrl: string
  /** Enterprise account-management page; no recharge capability is implied. */
  readonly topUpUrl: string
  /** Permit development HTTP destinations only on loopback hosts; absent means HTTPS only. */
  readonly allowLoopbackHttp?: boolean
}

function destination(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'))) {
    throw new Error('enterprise desktop account: destinations must use HTTPS without credentials, query, or fragment; development HTTP requires explicit loopback permission')
  }
  return url.href
}

/** Native onboarding commands backed only by the enterprise account provider. */
export class EnterpriseDesktopAccountController extends AccountController {
  static override inject = ['enterpriseAccount', 'agents']
  private readonly lifetime = new AbortController()
  private readonly links: AccountView['links']

  /**
   * @param ctx - Host carrying enterprise OIDC and the authenticated Remote transport.
   * @param config - public enterprise destinations; invalid destinations fail plugin activation.
   */
  constructor(ctx: Context, config: DesktopAccountConfig) {
    super(ctx)
    this.links = {
      usageUrl: destination(config.usageUrl, config.allowLoopbackHttp === true),
      topUpUrl: destination(config.topUpUrl, config.allowLoopbackHttp === true),
    }
    ctx.effect(() => () => { this.lifetime.abort() })
  }

  private project(view: EnterpriseAccountView): AccountView {
    const attempt = view.attempt
    return {
      status: view.status === 'signed-in' ? 'credential-stored' : 'signed-out',
      links: this.links,
      attempt: attempt === null ? null : {
        id: String(attempt.id) as SignInAttemptId,
        phase: attempt.phase,
        ...(attempt.authorizeUrl === undefined ? {} : { authorizeUrl: attempt.authorizeUrl }),
        ...(attempt.expiresAt === undefined ? {} : { expiresAt: attempt.expiresAt }),
        ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
      },
    }
  }

  /** @returns native account presence and progress, without identity claims or credentials. */
  override async getState(): Promise<AccountView> { return this.project(await this.ctx.enterpriseAccount.getState()) }

  /**
   * Do not query a DeepSeek Platform profile for an enterprise identity.
   * @param client - native display metadata.
   * @returns null because this compatibility API exposes no Platform profile.
   */
  override getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    void client
    return Promise.resolve(null)
  }

  /**
   * Do not query DeepSeek Platform wallets for enterprise credentials.
   * @param client - native display metadata.
   * @returns null because enterprise quotas are not Platform wallet balances.
   */
  override getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    void client
    return Promise.resolve(null)
  }

  /**
   * Do not query DeepSeek Platform promotions for an enterprise identity.
   * @param client - native display metadata.
   * @returns null because enterprise accounts have no Platform bonus feed.
   */
  override getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null> {
    void client
    return Promise.resolve(null)
  }

  /**
   * Refuse Platform promotion acknowledgement without performing a request.
   * @param accountId - unsupported Platform account identifier.
   * @param orderId - unsupported Platform order identifier.
   * @param client - native display metadata.
   * @returns false; no acknowledgement is recorded.
   */
  override ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean> {
    void accountId
    void orderId
    void client
    return Promise.resolve(false)
  }

  /**
   * Inspect active work before enterprise sign-out without relying on a previously logged provider.
   * @returns whether any agent is running, including tool execution and work before its first request.
   */
  override hasRunningAccountTasks(): boolean {
    return this.ctx.agents.list().some(agent => agent.status === 'running')
  }

  /**
   * Start enterprise authorization; the provider owns the registered redirect URI and browser attempt.
   * @param client - native display metadata, not used for enterprise authentication.
   * @param callbackOrigin - native transport origin, never substituted for the registered OIDC redirect URI.
   * @param loginSource - native caller metadata; it cannot select an authentication provider.
   * @returns enterprise login progress projected for native onboarding.
   */
  override async startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    void client
    void callbackOrigin
    void loginSource
    return this.project(await this.ctx.enterpriseAccount.startSignIn())
  }

  /**
   * Cancel the named enterprise attempt without interrupting an admitted credential commit.
   * @param attemptId - native projection of the enterprise attempt identifier.
   * @returns native progress after cancellation or commit settlement.
   */
  override async cancelSignIn(attemptId: SignInAttemptId): Promise<AccountView> {
    return this.project(await this.ctx.enterpriseAccount.cancelSignIn(String(attemptId) as EnterpriseSignInAttemptId))
  }

  /**
   * Remove the enterprise grant through its provider; no DeepSeek service is called.
   * @param client - native display metadata, not used for enterprise revocation.
   * @returns native signed-out state after local credential removal.
   */
  override async signOut(client: AccountClientMetadata): Promise<AccountView> {
    void client
    return this.project(await this.ctx.enterpriseAccount.signOut())
  }

  /**
   * Project initial and subsequent enterprise states for the native shell.
   * @param signal - native stream lifetime; plugin disposal also stops the provider subscription.
   * @returns native snapshots without enterprise profile claims or credentials.
   */
  override async *watch(signal: AbortSignal): AsyncIterable<AccountView> {
    if (signal.aborted || this.lifetime.signal.aborted) return
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    for await (const view of this.ctx.enterpriseAccount.watch(lifetime)) {
      if (lifetime.aborted) return
      yield this.project(view)
    }
  }

  /**
   * Forward live enterprise credential-expiry notifications without replay.
   * @param signal - native stream lifetime; plugin disposal also terminates the subscription.
   * @returns one native expiry notification per event observed while subscribed.
   */
  override async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    if (lifetime.aborted) return
    let pending = 0
    let wake: (() => void) | undefined
    const stop = this.ctx.on('enterprise-account/session-expired', () => { pending++; wake?.() })
    const abort = (): void => { wake?.() }
    lifetime.addEventListener('abort', abort, { once: true })
    try {
      while (!lifetime.aborted) {
        if (pending > 0) { pending--; yield 'session-expired'; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stop()
      lifetime.removeEventListener('abort', abort)
    }
  }
}
