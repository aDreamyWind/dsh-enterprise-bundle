/** Enterprise OIDC provider with loopback PKCE login and serialized token refresh. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as streamPromises } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { EnterpriseAccount, type EnterpriseAccountProfile, type EnterpriseAccountView,
  type EnterpriseSignInAttemptId, type EnterpriseSignInAttemptView } from '@deepseek-ai/dsh-enterprise-account'
import { discover, EnterpriseOidcError, exchangeToken, normalizeIssuer, profileFromClaims,
  readUserInfo, stateMatches, verifyIdToken, type ClientAuth, type ClientAuthMethod,
  type OidcDiscovery, type OidcTokenResponse } from './protocol.ts'

const KEY = credentialKey('enterprise-account-oidc', 'default')
const profile = z.object({ subject: z.string().min(1), name: z.string().nullable(),
  preferredUsername: z.string().nullable(), email: z.string().nullable(), picture: z.string().nullable(),
  organizationId: z.string().nullable(), organizationCode: z.string().nullable() })
const activeGrant = z.object({
  version: z.literal(2), status: z.literal('active'), issuer: z.url(), clientId: z.string().min(1),
  subject: z.string().min(1), sid: z.string().min(1).optional(),
  profile,
  accessToken: z.string().min(1), accessExpiresAt: z.number().int().positive(), refreshToken: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)),
})
const expiredGrant = z.object({
  version: z.literal(2), status: z.literal('expired'), issuer: z.url(), clientId: z.string().min(1),
  subject: z.string().min(1), profile: activeGrant.shape.profile,
})
const storedGrant = z.discriminatedUnion('status', [activeGrant, expiredGrant])
const legacyGrant = z.object({
  version: z.literal(1), status: z.union([z.literal('active'), z.literal('expired')]),
  issuer: z.url(), clientId: z.string().min(1), subject: z.string().min(1), sid: z.string().min(1).optional(),
  profile: z.object({ subject: z.string().min(1), name: z.string().nullable(), email: z.string().nullable(),
    picture: z.string().nullable(), tenantId: z.string().nullable() }),
  accessToken: z.string().min(1).optional(), accessExpiresAt: z.number().int().positive().optional(),
  refreshToken: z.string().min(1).optional(), scopes: z.array(z.string().min(1)).optional(),
})
type ActiveGrant = z.infer<typeof activeGrant>
type StoredGrant = z.infer<typeof storedGrant>

/** Deployment-specific enterprise OIDC choices. */
export interface Config {
  /** Exact OpenID issuer configured by the enterprise management service. */
  issuer: string
  /** OIDC client identifier registered for this Harness surface. */
  clientId: string
  /** Confidential-client secret supplied only for a secret-based authentication method. */
  clientSecret?: string
  /** Token-endpoint client authentication; Desktop public clients use `none`. */
  clientAuthMethod?: ClientAuthMethod
  /** Registered redirect URI or the portless loopback template for a native client. */
  redirectUri: string
  /** Whether each login uses the configured URI or allocates a random loopback port. */
  redirectMode?: 'fixed' | 'loopback-random-port'
  /** Exact HTTP(S) origin allowed to receive the access token. */
  gatewayOrigin: string
  /** OIDC scopes requested during login. */
  scopes?: string[]
  /** Upper bound for one browser login attempt. */
  attemptTimeoutMs?: number
  /** Deadline for each discovery, token, UserInfo, JWKS, or revocation request. */
  requestTimeoutMs?: number
  /** Refresh an access token this long before its expiry. */
  refreshBeforeExpiryMs?: number
  /** Allowed ID-token clock skew. */
  clockSkewSeconds?: number
  /** Permit an HTTP issuer only when it uses a loopback hostname. */
  allowLoopbackHttp?: boolean
}

/** Validated enterprise OIDC deployment configuration. */
export const Config = Schema.object({
  issuer: Schema.string().required(),
  clientId: Schema.string().required(),
  clientSecret: Schema.string().role('secret'),
  clientAuthMethod: Schema.union(['none', 'client_secret_basic', 'client_secret_post'] as const).default('client_secret_basic'),
  redirectUri: Schema.string().required(),
  redirectMode: Schema.union(['fixed', 'loopback-random-port'] as const).default('fixed'),
  gatewayOrigin: Schema.string().required(),
  scopes: Schema.array(Schema.string()).default(['openid', 'profile', 'model.invoke', 'offline_access']),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  refreshBeforeExpiryMs: Schema.number().min(0).max(600_000).default(60_000),
  clockSkewSeconds: Schema.number().min(0).max(300).step(1).default(60),
  allowLoopbackHttp: Schema.boolean().default(false),
})

interface Attempt {
  view: EnterpriseSignInAttemptView
  controller: AbortController
  done: Promise<void>
  running: Promise<void>
  callback?: ServerResponse
  disposeCallback?: () => Promise<void>
}

interface CallbackRegistration {
  redirectUri: string
  dispose: () => Promise<void>
}

/** OIDC implementation owning enterprise login state and persisted rotating grants. */
export class EnterpriseOidcAccount extends EnterpriseAccount {
  static inject = ['credentials', 'authorization']
  static Config = Config
  private readonly issuer: string
  private readonly clientId: string
  private readonly clientAuth: ClientAuth
  private readonly redirectUri: string
  private readonly redirectMode: 'fixed' | 'loopback-random-port'
  private readonly gatewayOrigin: string
  private readonly scopes: readonly string[]
  private readonly callbackPath: string
  private readonly attemptTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly refreshBeforeExpiryMs: number
  private readonly clockSkewSeconds: number
  private readonly listeners = new Set<() => void>()
  private readonly background = new Set<Promise<void>>()
  private readonly backgroundLifetime = new AbortController()
  private discovery: Promise<OidcDiscovery> | undefined
  private attempt: Attempt | undefined
  private closed = false

  /** @param ctx - Host with credentials and authorization services. @param config - enterprise OIDC deployment. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = Config(config)
    this.issuer = validateIssuer(resolved.issuer, resolved.allowLoopbackHttp)
    this.clientId = resolved.clientId
    this.clientAuth = resolveClientAuth(resolved.clientAuthMethod, resolved.clientId, resolved.clientSecret)
    this.redirectMode = resolved.redirectMode
    this.redirectUri = validateRedirectUri(resolved.redirectUri, this.redirectMode)
    this.gatewayOrigin = validateOrigin(resolved.gatewayOrigin, 'gatewayOrigin')
    if (!resolved.scopes.includes('openid')) throw new Error('enterprise-account: scopes must include openid')
    if (!resolved.scopes.includes('model.invoke')) throw new Error('enterprise-account: scopes must include model.invoke')
    this.scopes = [...new Set(resolved.scopes)]
    this.callbackPath = new URL(this.redirectUri).pathname
    this.attemptTimeoutMs = resolved.attemptTimeoutMs
    this.requestTimeoutMs = resolved.requestTimeoutMs
    this.refreshBeforeExpiryMs = resolved.refreshBeforeExpiryMs
    this.clockSkewSeconds = resolved.clockSkewSeconds
    ctx.effect(() => ctx.authorization.registerFlow({
      key: KEY,
      label: 'Enterprise account',
      methods: [{ id: 'browser', label: 'Enterprise SSO' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) return Promise.reject(new EnterpriseOidcError('protocol', 'missing sign-in attempt'))
        attempt.running = this.run(session, attempt)
        return attempt.running
      },
    }), 'enterprise account: authorization flow')
    ctx.on('credentials/record-updated', (key) => { if (key === KEY) this.changed() })
    ctx.effect(() => async () => {
      this.closed = true
      this.backgroundLifetime.abort()
      const attempt = this.attempt
      if (attempt !== undefined) {
        if (attempt.view.phase !== 'committing') attempt.controller.abort()
        await attempt.done
      }
      await Promise.all(this.background)
      this.changed()
    }, 'enterprise account: provider lifetime')
  }

  async [Service.init](): Promise<void> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return
    const parsed = readGrant(record)
    if (parsed.issuer === this.issuer && parsed.clientId === this.clientId) return
    await this.ctx.credentials.deleteRecord(KEY)
    console.info('[enterprise-account] stored grant discarded', { reason: 'deployment-mismatch' })
  }

  override async getState(): Promise<EnterpriseAccountView> {
    const record = await this.ctx.credentials.readRecord(KEY)
    const grant = record === undefined ? undefined : readGrant(record)
    const active = grant?.status === 'active' ? grant : undefined
    const attempt = this.attempt?.view ?? null
    return {
      status: active === undefined ? 'signed-out' : 'signed-in',
      profile: active?.profile ?? null,
      attempt: active === undefined && attempt?.phase === 'succeeded' ? null : attempt,
    }
  }

  override async startSignIn(): Promise<EnterpriseAccountView> {
    this.assertOpen()
    if (this.attempt !== undefined && isRunning(this.attempt.view.phase)) return this.getState()
    if (this.attempt !== undefined) await this.attempt.done
    this.assertOpen()
    const attempt: Attempt = {
      view: { id: randomUUID() as EnterpriseSignInAttemptId, phase: 'initializing' },
      controller: new AbortController(),
      done: Promise.resolve(),
      running: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: KEY,
      signal: attempt.controller.signal,
      interaction: {
        notify: () => undefined,
        prompt: () => Promise.reject(new EnterpriseOidcError('protocol', 'unexpected authorization prompt')),
      },
    }).then((outcome) => {
      this.update(attempt, { phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled' })
      this.finishCallback(attempt, outcome.status === 'authorized')
    }).catch((error: unknown) => {
      const code = error instanceof EnterpriseOidcError ? error.code : 'protocol'
      console.info('[enterprise-account] sign-in failed', { errorCode: code })
      this.update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
      this.finishCallback(attempt, false)
    }).then(async () => {
      await attempt.running.catch(() => undefined)
      if (attempt.callback !== undefined) await streamPromises.finished(attempt.callback, { cleanup: true }).catch(() => undefined)
      await attempt.disposeCallback?.()
    })
    this.changed()
    return this.getState()
  }

  override async cancelSignIn(id: EnterpriseSignInAttemptId): Promise<EnterpriseAccountView> {
    const attempt = this.attempt
    if (attempt?.view.id === id) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  override async signOut(): Promise<EnterpriseAccountView> {
    if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
    const record = await this.ctx.credentials.readRecord(KEY)
    const grant = record === undefined ? undefined : readGrant(record)
    await this.ctx.credentials.deleteRecord(KEY)
    this.attempt = undefined
    this.changed()
    if (grant?.status === 'active' && grant.refreshToken !== undefined) this.revoke(grant.refreshToken)
    return this.getState()
  }

  override async *watch(signal: AbortSignal): AsyncIterable<EnterpriseAccountView> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  override async resolveAccessToken(url: string, requiredScopes: readonly string[]): Promise<string | undefined> {
    if (this.closed || new URL(url).origin !== this.gatewayOrigin) return undefined
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return undefined
    const current = readGrant(record)
    if (current.status !== 'active' || !hasScopes(current.scopes, requiredScopes)) return undefined
    if (current.accessExpiresAt > Date.now() + this.refreshBeforeExpiryMs) return current.accessToken
    const updated = await this.ctx.credentials.modifyRecord(KEY, async (stored) => {
      if (stored === undefined) return undefined
      const grant = readGrant(stored)
      if (grant.status !== 'active' || grant.accessToken !== current.accessToken) return undefined
      if (grant.accessExpiresAt > Date.now() + this.refreshBeforeExpiryMs) return undefined
      if (grant.refreshToken === undefined) return { kind: 'grant', payload: expireGrant(grant) }
      return { kind: 'grant', payload: await this.refresh(grant) }
    })
    if (updated === undefined) return undefined
    const refreshed = readGrant(updated)
    if (refreshed.status !== 'active' || !hasScopes(refreshed.scopes, requiredScopes)) {
      this.ctx.emit('enterprise-account/session-expired')
      return undefined
    }
    return refreshed.accessToken
  }

  override async refreshAccessToken(
    url: string,
    rejectedToken: string,
    requiredScopes: readonly string[],
  ): Promise<string | undefined> {
    if (this.closed || new URL(url).origin !== this.gatewayOrigin) return undefined
    const updated = await this.ctx.credentials.modifyRecord(KEY, async (record) => {
      if (record === undefined) return undefined
      const grant = readGrant(record)
      if (grant.status !== 'active' || !hasScopes(grant.scopes, requiredScopes)) return undefined
      if (grant.accessToken !== rejectedToken) return undefined
      if (grant.refreshToken === undefined) return { kind: 'grant', payload: expireGrant(grant) }
      return { kind: 'grant', payload: await this.refresh(grant) }
    })
    if (updated === undefined) {
      return this.resolveAccessToken(url, requiredScopes)
    }
    const refreshed = readGrant(updated)
    if (refreshed.status !== 'active' || !hasScopes(refreshed.scopes, requiredScopes)) {
      this.ctx.emit('enterprise-account/session-expired')
      return undefined
    }
    return refreshed.accessToken
  }

  override async rejectAccessToken(token: string): Promise<void> {
    const outcome = { expired: false }
    await this.ctx.credentials.modifyRecord(KEY, (record) => {
      if (record === undefined) return Promise.resolve(undefined)
      const grant = readGrant(record)
      if (grant.status !== 'active' || grant.accessToken !== token) return Promise.resolve(undefined)
      outcome.expired = true
      return Promise.resolve({ kind: 'grant', payload: expireGrant(grant) })
    })
    if (outcome.expired) this.ctx.emit('enterprise-account/session-expired')
  }

  private async run(session: AuthorizationSession, attempt: Attempt): Promise<void> {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const authorizationCode = Promise.withResolvers<string>()
    void authorizationCode.promise.catch(() => undefined)
    const deadline = new AbortController()
    const signal = AbortSignal.any([session.signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort() }, this.attemptTimeoutMs)
    const abort = (): void => { authorizationCode.reject(new EnterpriseOidcError('expired', 'sign-in attempt expired')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const callback = (request: IncomingMessage, response: ServerResponse): void => {
        let url: URL
        try { url = new URL(request.url ?? '/', 'http://127.0.0.1') }
        catch { response.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
        const receivedState = url.searchParams.get('state') ?? ''
        const code = url.searchParams.get('code')
        if (request.method !== 'GET' || url.pathname !== this.callbackPath || !stateMatches(receivedState, state)
          || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1
          || (code === null && url.searchParams.get('error') === null)) {
          response.writeHead(400, { 'cache-control': 'no-store' }).end()
          return
        }
        if (signal.aborted || attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser') {
          response.writeHead(410, { 'cache-control': 'no-store' }).end()
          return
        }
        attempt.callback = response
        if (code === null) authorizationCode.reject(new EnterpriseOidcError('protocol', 'authorization server rejected login'))
        else authorizationCode.resolve(code)
      }
      const registration = await this.registerCallback(callback, this.ctx.get('webServer')?.port)
      attempt.disposeCallback = registration.dispose
      const redirectUri = registration.redirectUri
      const metadata = await this.metadata(signal)
      signal.throwIfAborted()
      const authorize = new URL(metadata.authorization_endpoint)
      authorize.search = new URLSearchParams({
        response_type: 'code', client_id: this.clientId, redirect_uri: redirectUri,
        scope: this.scopes.join(' '), state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString()
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl: authorize.href, expiresAt: Date.now() + this.attemptTimeoutMs })
      const code = await authorizationCode.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const result = await exchangeToken(metadata.token_endpoint, new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
      }), this.clientAuth, this.requestSignal(signal))
      if (result.id_token === undefined) throw new EnterpriseOidcError('protocol', 'OIDC token response omitted id_token')
      const claims = await verifyIdToken(result.id_token, {
        issuer: this.issuer, clientId: this.clientId, nonce, jwksUri: metadata.jwks_uri,
        clockSkewSeconds: this.clockSkewSeconds, signal: this.requestSignal(signal),
      })
      const profile = metadata.userinfo_endpoint === undefined ? profileFromClaims(claims)
        : await readUserInfo(metadata.userinfo_endpoint, result.access_token, claims.sub, this.requestSignal(signal))
      signal.throwIfAborted()
      this.update(attempt, { phase: 'committing' })
      try { await session.commit({ kind: 'grant', payload: this.toGrant(result, claims.sub, claims.sid, profile) }) }
      catch (error) { throw new EnterpriseOidcError('storage', 'enterprise grant commit failed', { cause: error }) }
    } catch (error) {
      if (deadline.signal.aborted) throw new EnterpriseOidcError('expired', 'sign-in attempt expired')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  private async refresh(grant: ActiveGrant): Promise<StoredGrant> {
    const metadata = await this.metadata(this.requestSignal(this.backgroundLifetime.signal))
    let response: OidcTokenResponse
    try {
      response = await exchangeToken(metadata.token_endpoint, new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: grant.refreshToken ?? '',
        scope: grant.scopes.join(' '),
      }), this.clientAuth, this.requestSignal(this.backgroundLifetime.signal))
    } catch (error) {
      if (error instanceof EnterpriseOidcError && error.code === 'expired') return expireGrant(grant)
      throw error
    }
    if (response.id_token !== undefined) {
      await verifyIdToken(response.id_token, {
        issuer: this.issuer, clientId: this.clientId, subject: grant.subject,
        jwksUri: metadata.jwks_uri, clockSkewSeconds: this.clockSkewSeconds,
        signal: this.requestSignal(this.backgroundLifetime.signal),
      })
    }
    return {
      ...grant,
      accessToken: response.access_token,
      accessExpiresAt: Date.now() + response.expires_in * 1000,
      refreshToken: response.refresh_token ?? grant.refreshToken,
      scopes: parseScopes(response.scope, grant.scopes),
    }
  }

  private toGrant(tokens: OidcTokenResponse, subject: string, sid: string | undefined,
    profile: EnterpriseAccountProfile): ActiveGrant {
    return {
      version: 2, status: 'active', issuer: this.issuer, clientId: this.clientId,
      subject, ...(sid === undefined ? {} : { sid }), profile,
      accessToken: tokens.access_token, accessExpiresAt: Date.now() + tokens.expires_in * 1000,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      scopes: parseScopes(tokens.scope, this.scopes),
    }
  }

  private metadata(signal: AbortSignal): Promise<OidcDiscovery> {
    this.discovery ??= discover(this.issuer, this.requestSignal(signal)).catch((error: unknown) => {
      this.discovery = undefined
      throw error
    }).then((metadata) => {
      const supported = metadata.token_endpoint_auth_methods_supported
      if (supported !== undefined && !supported.includes(this.clientAuth.method)) {
        throw new EnterpriseOidcError('protocol', `OIDC issuer does not support ${this.clientAuth.method}`)
      }
      return metadata
    })
    return this.discovery
  }

  private async registerCallback(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    webServerPort: number | undefined,
  ): Promise<CallbackRegistration> {
    const redirect = new URL(this.redirectUri)
    const redirectPort = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
    if (this.redirectMode === 'fixed' && (redirect.protocol === 'https:' || redirectPort === webServerPort)) {
      const webServer = this.ctx.get('webServer')
      if (webServer === undefined) throw new EnterpriseOidcError('protocol', 'web server is unavailable')
      return {
        redirectUri: this.redirectUri,
        dispose: this.ctx.effect(() => webServer.register({ kind: 'exact', path: this.callbackPath, handler }),
          'enterprise account: browser callback'),
      }
    }
    const server = createServer(handler)
    const hostname = redirect.hostname.replace(/^\[|\]$/g, '')
    const listenPort = this.redirectMode === 'loopback-random-port' ? 0 : redirectPort
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(listenPort, hostname, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      server.closeAllConnections()
      throw new EnterpriseOidcError('network', `OIDC callback listener could not bind ${redirect.origin}`, { cause: error })
    }
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      throw new EnterpriseOidcError('network', 'OIDC callback listener did not expose a TCP port')
    }
    redirect.port = String(address.port)
    return {
      redirectUri: redirect.href,
      dispose: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error === undefined) resolve(); else reject(error) })
          server.closeAllConnections()
        })
      },
    }
  }

  private requestSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)])
  }

  private assertOpen(): void {
    if (this.closed) throw new EnterpriseOidcError('protocol', 'provider is closed')
  }

  private update(attempt: Attempt, patch: Partial<EnterpriseSignInAttemptView>): void {
    const { authorizeUrl: _previousUrl, ...current } = attempt.view
    attempt.view = { ...current, ...patch }
    this.changed()
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  private finishCallback(attempt: Attempt, success: boolean): void {
    if (attempt.callback === undefined) return
    const title = success ? 'Sign-in completed' : 'Sign-in failed'
    const message = success ? 'Return to Harness to continue.' : 'Close this tab and retry from Harness.'
    attempt.callback.writeHead(success ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer',
    }).end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><p>${message}</p></body></html>`)
  }

  private revoke(token: string): void {
    const revocation = (async () => {
      try {
        const metadata = await this.metadata(this.backgroundLifetime.signal)
        if (metadata.revocation_endpoint === undefined) return
        await fetch(metadata.revocation_endpoint, {
          method: 'POST', signal: this.requestSignal(this.backgroundLifetime.signal),
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            ...this.clientAuth.method === 'client_secret_basic'
              ? { authorization: `Basic ${basicCredential(this.clientId, this.clientAuth.clientSecret)}` }
              : {},
          },
          body: new URLSearchParams({
            token,
            token_type_hint: 'refresh_token',
            ...this.clientAuth.method === 'client_secret_post'
              ? { client_id: this.clientId, client_secret: this.clientAuth.clientSecret }
              : this.clientAuth.method === 'none' ? { client_id: this.clientId } : {},
          }),
        })
      } catch (_error) {
        // Local sign-out is authoritative; bounded remote revocation failure never restores the grant.
      }
    })().finally(() => { this.background.delete(revocation) })
    this.background.add(revocation)
  }
}

function readGrant(record: CredentialRecord): StoredGrant {
  if (record.kind !== 'grant') throw new EnterpriseOidcError('storage', 'enterprise credential has the wrong kind')
  const parsed = storedGrant.safeParse(record.payload)
  if (parsed.success) return parsed.data
  const legacy = legacyGrant.safeParse(record.payload)
  if (!legacy.success) throw new EnterpriseOidcError('storage', 'enterprise credential is invalid')
  const value = legacy.data
  const normalizedProfile: EnterpriseAccountProfile = {
    subject: value.profile.subject,
    name: value.profile.name,
    preferredUsername: null,
    email: value.profile.email,
    picture: value.profile.picture,
    organizationId: null,
    organizationCode: null,
  }
  if (value.status === 'expired') {
    return { version: 2, status: 'expired', issuer: value.issuer, clientId: value.clientId,
      subject: value.subject, profile: normalizedProfile }
  }
  if (value.accessToken === undefined || value.accessExpiresAt === undefined || value.scopes === undefined) {
    throw new EnterpriseOidcError('storage', 'enterprise credential is invalid')
  }
  return {
    version: 2, status: 'active', issuer: value.issuer, clientId: value.clientId, subject: value.subject,
    ...(value.sid === undefined ? {} : { sid: value.sid }), profile: normalizedProfile,
    accessToken: value.accessToken, accessExpiresAt: value.accessExpiresAt,
    ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken }), scopes: value.scopes,
  }
}

function expireGrant(grant: ActiveGrant): z.infer<typeof expiredGrant> {
  return {
    version: 2, status: 'expired', issuer: grant.issuer, clientId: grant.clientId,
    subject: grant.subject, profile: grant.profile,
  }
}

function parseScopes(scope: string | undefined, fallback: readonly string[]): string[] {
  return scope === undefined ? [...fallback] : [...new Set(scope.split(/\s+/).filter(Boolean))]
}

function hasScopes(granted: readonly string[], required: readonly string[]): boolean {
  const available = new Set(granted)
  return required.every(scope => available.has(scope))
}

function isRunning(phase: EnterpriseSignInAttemptView['phase']): boolean {
  return ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(phase)
}

function validateIssuer(value: string, allowLoopbackHttp: boolean): string {
  const issuer = new URL(normalizeIssuer(value))
  if (issuer.username || issuer.password || issuer.search || issuer.hash
    || (issuer.protocol !== 'https:' && !(allowLoopbackHttp && issuer.protocol === 'http:' && isLoopback(issuer.hostname)))) {
    throw new Error('enterprise-account: issuer must use HTTPS, or loopback HTTP when explicitly enabled')
  }
  return normalizeIssuer(issuer.href)
}

function validateOrigin(value: string, name: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`enterprise-account: ${name} must be an HTTP(S) origin without credentials, path, query or fragment`)
  }
  return url.origin
}

function validateRedirectUri(value: string, mode: 'fixed' | 'loopback-random-port'): string {
  const url = new URL(value)
  const secure = url.protocol === 'https:'
  const loopback = url.protocol === 'http:' && isLoopback(url.hostname)
  if ((!secure && !loopback) || url.username || url.password || url.search || url.hash || url.pathname === '/') {
    throw new Error('enterprise-account: redirectUri must be HTTPS, or loopback HTTP, with a callback path and no credentials, query, or fragment')
  }
  if (mode === 'loopback-random-port' && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '')) {
    throw new Error('enterprise-account: loopback-random-port requires a portless http://127.0.0.1 redirectUri')
  }
  return url.href
}

function resolveClientAuth(method: ClientAuthMethod, clientId: string, clientSecret: string | undefined): ClientAuth {
  if (method === 'none') {
    if (clientSecret !== undefined) throw new Error('enterprise-account: clientSecret must be omitted when clientAuthMethod is none')
    return { method, clientId }
  }
  if (clientSecret === undefined || clientSecret.length === 0) {
    throw new Error(`enterprise-account: clientSecret is required when clientAuthMethod is ${method}`)
  }
  return { method, clientId, clientSecret }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function basicCredential(clientId: string, clientSecret: string): string {
  const encode = (value: string): string => new URLSearchParams({ value }).toString().slice('value='.length)
  return Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')
}

export default EnterpriseOidcAccount
