/** Enterprise account Service Definition shared by OIDC providers and Host consumers. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { EnterpriseAccountView, EnterpriseSignInAttemptId } from './types.ts'

export type {
  EnterpriseAccountProfile,
  EnterpriseAccountView,
  EnterpriseSignInAttemptId,
  EnterpriseSignInAttemptView,
  EnterpriseSignInErrorCode,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    enterpriseAccount: EnterpriseAccount
  }

  interface Events {
    /** A rejected or unrefreshable enterprise credential was removed from use.
     * @mode emit
     */
    'enterprise-account/session-expired'(): void
  }
}

/** Enterprise identity operations; token-bearing methods remain Host-only. */
export abstract class EnterpriseAccount extends Service {
  /** @param ctx - context owning the enterprise account provider. */
  constructor(ctx: Context) { super(ctx, 'enterpriseAccount') }

  /**
   * Read stored identity presence and the latest login attempt.
   * @returns a complete snapshot without credentials or PKCE secrets.
   */
  abstract getState(): Promise<EnterpriseAccountView>

  /**
   * Join an active attempt or begin browser authorization through the configured exact redirect URI.
   * @returns the initial snapshot without waiting for browser approval.
   */
  abstract startSignIn(): Promise<EnterpriseAccountView>

  /**
   * Cancel only the named attempt; an admitted credential commit completes first.
   * @param id - attempt identity returned by {@link startSignIn}.
   * @returns state after cancellation or commit settlement.
   */
  abstract cancelSignIn(id: EnterpriseSignInAttemptId): Promise<EnterpriseAccountView>

  /**
   * Remove the local grant before attempting bounded remote revocation.
   * @returns the signed-out state after local removal.
   */
  abstract signOut(): Promise<EnterpriseAccountView>

  /**
   * Subscribe to complete snapshots, including an initial value.
   * @param signal - subscription lifetime; ending it does not cancel login.
   * @returns account snapshots until the signal aborts or provider stops.
   */
  abstract watch(signal: AbortSignal): AsyncIterable<EnterpriseAccountView>

  /**
   * Resolve a current access token for the configured enterprise gateway.
   * Refresh-token rotation is serialized by the credential provider.
   * @param url - actual request destination.
   * @param requiredScopes - scopes the caller needs for this request.
   * @returns an access token, or undefined for another origin, missing scopes, or signed-out state.
   */
  abstract resolveAccessToken(url: string, requiredScopes: readonly string[]): Promise<string | undefined>

  /**
   * Replace a gateway-rejected token through the serialized refresh-token rotation.
   * A concurrent refresh returns its newer token instead of spending the rejected refresh token again.
   * @param url - actual request destination.
   * @param rejectedToken - access token rejected with HTTP 401.
   * @param requiredScopes - scopes the retry needs.
   * @returns the replacement token, or undefined when the session cannot recover.
   */
  abstract refreshAccessToken(
    url: string,
    rejectedToken: string,
    requiredScopes: readonly string[],
  ): Promise<string | undefined>

  /**
   * Retire a gateway-rejected access token only if it is still current.
   * @param token - token rejected by the gateway request.
   * @returns after a matching grant is made unavailable.
   */
  abstract rejectAccessToken(token: string): Promise<void>
}

export default EnterpriseAccount
