/** OIDC discovery, token exchange, and JWT validation for the enterprise account provider. */
import { createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { z } from 'zod'
import type { EnterpriseAccountProfile } from '@deepseek-ai/dsh-enterprise-account/types'

const discoveryDocument = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  userinfo_endpoint: z.url().optional(),
  revocation_endpoint: z.url().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
})

const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  scope: z.string().optional(),
})

const jwtHeader = z.object({ alg: z.literal('RS256'), kid: z.string().min(1) })
const jwtClaims = z.object({
  iss: z.url(),
  sub: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  azp: z.string().min(1).optional(),
  exp: z.number().int(),
  iat: z.number().int(),
  nonce: z.string().min(1).optional(),
  sid: z.string().min(1).optional(),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
  email: z.string().optional(),
  picture: z.url().optional(),
  org_id: z.string().optional(),
  org_code: z.string().optional(),
})
const userInfo = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
  email: z.string().optional(),
  picture: z.url().optional(),
  org_id: z.string().optional(),
  org_code: z.string().optional(),
})
const jwks = z.object({ keys: z.array(z.object({
  kty: z.literal('RSA'),
  kid: z.string().min(1),
  n: z.string().min(1),
  e: z.string().min(1),
  alg: z.string().optional(),
  use: z.string().optional(),
})) })

/** Discovery metadata used by authorization, verification, refresh, and revocation. */
export type OidcDiscovery = z.infer<typeof discoveryDocument>
/** Successful OAuth token response. */
export type OidcTokenResponse = z.infer<typeof tokenResponse>

/** Token-endpoint authentication methods supported by Harness Admin. */
export type ClientAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post'

/** Public or confidential OIDC client authentication. */
export type ClientAuth = {
  /** Public clients authenticate with PKCE and send no client secret. */
  method: 'none'
  /** Registered OIDC client identifier. */
  clientId: string
} | {
  /** Confidential-client token-endpoint authentication method. */
  method: 'client_secret_basic' | 'client_secret_post'
  /** Registered OIDC client identifier. */
  clientId: string
  /** Registered OIDC client secret. */
  clientSecret: string
}

/** Stable provider failure with a UI-safe category. */
export class EnterpriseOidcError extends Error {
  /** @param code - UI-safe category. @param message - diagnostic without credentials. @param options - causal error. */
  constructor(readonly code: 'network' | 'protocol' | 'expired' | 'storage', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EnterpriseOidcError'
  }
}

/**
 * Compare two authorization-state values without content-dependent early return.
 * @param actual - value received from the callback.
 * @param expected - value created for the attempt.
 * @returns whether the values match exactly.
 */
export function stateMatches(actual: string, expected: string): boolean {
  return Buffer.byteLength(actual) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

/**
 * Load and validate the configured issuer's discovery document.
 * @param issuer - normalized issuer URL.
 * @param signal - request lifetime.
 * @returns validated discovery metadata.
 */
export async function discover(issuer: string, signal: AbortSignal): Promise<OidcDiscovery> {
  const url = new URL('.well-known/openid-configuration', issuer.endsWith('/') ? issuer : `${issuer}/`).href
  const value = await requestJson(url, { signal })
  const parsed = discoveryDocument.safeParse(value)
  if (!parsed.success || normalizeIssuer(parsed.data.issuer) !== issuer) {
    throw new EnterpriseOidcError('protocol', 'OIDC discovery document is invalid')
  }
  if (parsed.data.code_challenge_methods_supported !== undefined
    && !parsed.data.code_challenge_methods_supported.includes('S256')) {
    throw new EnterpriseOidcError('protocol', 'OIDC issuer does not support PKCE S256')
  }
  if (parsed.data.id_token_signing_alg_values_supported !== undefined
    && !parsed.data.id_token_signing_alg_values_supported.includes('RS256')) {
    throw new EnterpriseOidcError('protocol', 'OIDC issuer does not support RS256 ID tokens')
  }
  return parsed.data
}

/**
 * Exchange an authorization code or refresh token through a public or confidential client.
 * @param endpoint - discovered token endpoint.
 * @param parameters - URL-encoded OAuth parameters.
 * @param auth - client authentication kept on the Host.
 * @param signal - request lifetime.
 * @returns validated token response.
 */
export async function exchangeToken(
  endpoint: string,
  parameters: URLSearchParams,
  auth: ClientAuth,
  signal: AbortSignal,
): Promise<OidcTokenResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (auth.method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${formEncode(auth.clientId)}:${formEncode(auth.clientSecret)}`).toString('base64')}`
  } else if (auth.method === 'client_secret_post') {
    parameters.set('client_id', auth.clientId)
    parameters.set('client_secret', auth.clientSecret)
  } else {
    parameters.set('client_id', auth.clientId)
  }
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST', signal,
      headers,
      body: parameters,
    })
  } catch (error) {
    throw new EnterpriseOidcError('network', 'OIDC token request failed', { cause: error })
  }
  if (!response.ok) {
    let oauthError: unknown
    try { oauthError = await response.json() } catch (_error) {
      // A non-JSON error response still reports the HTTP failure without reflecting its body.
    }
    const parsedError = z.object({ error: z.string() }).safeParse(oauthError)
    if (parsedError.success && parsedError.data.error === 'invalid_grant') {
      throw new EnterpriseOidcError('expired', 'OIDC grant is no longer valid')
    }
    throw new EnterpriseOidcError('network', `OIDC token request returned HTTP ${response.status}`)
  }
  let value: unknown
  try { value = await response.json() }
  catch (error) { throw new EnterpriseOidcError('protocol', 'OIDC token response is not JSON', { cause: error }) }
  const parsed = tokenResponse.safeParse(value)
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer') {
    throw new EnterpriseOidcError('protocol', 'OIDC token response is invalid')
  }
  return parsed.data
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length)
}

/**
 * Validate an RS256 ID token against the discovered JWKS.
 * @param token - compact ID token.
 * @param options - expected issuer, client, nonce, and clock policy.
 * @returns validated claims.
 */
export async function verifyIdToken(token: string, options: {
  issuer: string
  clientId: string
  nonce?: string
  subject?: string
  jwksUri: string
  clockSkewSeconds: number
  signal: AbortSignal
}): Promise<z.infer<typeof jwtClaims>> {
  const parts = token.split('.')
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (parts.length !== 3 || encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
    throw new EnterpriseOidcError('protocol', 'OIDC ID token is not compact JWT')
  }
  let headerValue: unknown
  let claimValue: unknown
  try {
    headerValue = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
    claimValue = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch (error) {
    throw new EnterpriseOidcError('protocol', 'OIDC ID token JSON is invalid', { cause: error })
  }
  const header = jwtHeader.safeParse(headerValue)
  const claims = jwtClaims.safeParse(claimValue)
  if (!header.success || !claims.success) throw new EnterpriseOidcError('protocol', 'OIDC ID token claims are invalid')
  const keysValue = await requestJson(options.jwksUri, { signal: options.signal })
  const keys = jwks.safeParse(keysValue)
  const key = keys.success ? keys.data.keys.find(candidate => candidate.kid === header.data.kid
    && (candidate.alg === undefined || candidate.alg === 'RS256') && (candidate.use === undefined || candidate.use === 'sig')) : undefined
  if (key === undefined) throw new EnterpriseOidcError('protocol', 'OIDC signing key is unavailable')
  const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', use: 'sig', kid: key.kid }, format: 'jwk' })
  const valid = verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(encodedSignature, 'base64url'))
  if (!valid) throw new EnterpriseOidcError('protocol', 'OIDC ID token signature is invalid')
  const now = Math.floor(Date.now() / 1000)
  const audiences = typeof claims.data.aud === 'string' ? [claims.data.aud] : claims.data.aud
  if (normalizeIssuer(claims.data.iss) !== options.issuer || !audiences.includes(options.clientId)
    || (audiences.length > 1 && claims.data.azp !== options.clientId)
    || claims.data.exp <= now - options.clockSkewSeconds || claims.data.iat > now + options.clockSkewSeconds
    || (options.nonce !== undefined && claims.data.nonce !== options.nonce)
    || (options.subject !== undefined && claims.data.sub !== options.subject)) {
    throw new EnterpriseOidcError('protocol', 'OIDC ID token verification failed')
  }
  return claims.data
}

/**
 * Read display identity from UserInfo while binding it to the ID-token subject.
 * @param endpoint - discovered UserInfo endpoint.
 * @param accessToken - bearer access token.
 * @param subject - verified ID-token subject.
 * @param signal - request lifetime.
 * @returns sanitized profile claims.
 */
export async function readUserInfo(endpoint: string, accessToken: string, subject: string,
  signal: AbortSignal): Promise<EnterpriseAccountProfile> {
  const parsed = userInfo.safeParse(await requestJson(endpoint, {
    signal, headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  }))
  if (!parsed.success || parsed.data.sub !== subject) throw new EnterpriseOidcError('protocol', 'OIDC UserInfo response is invalid')
  return profileFromClaims(parsed.data)
}

/**
 * Project verified identity claims into browser-safe profile data.
 * @param claims - verified ID-token or UserInfo claims.
 * @returns display-safe profile.
 */
export function profileFromClaims(claims: {
  sub: string
  name?: string | undefined
  preferred_username?: string | undefined
  email?: string | undefined
  picture?: string | undefined
  org_id?: string | undefined
  org_code?: string | undefined
}): EnterpriseAccountProfile {
  return {
    subject: claims.sub,
    name: claims.name ?? null,
    preferredUsername: claims.preferred_username ?? null,
    email: claims.email ?? null,
    picture: claims.picture ?? null,
    organizationId: claims.org_id ?? null,
    organizationCode: claims.org_code ?? null,
  }
}

/**
 * Normalize one configured or discovered issuer for exact comparison.
 * @param value - issuer URL.
 * @returns issuer without a trailing slash.
 */
export function normalizeIssuer(value: string): string {
  const url = new URL(value)
  url.hash = ''
  url.search = ''
  if (url.pathname.endsWith('/') && url.pathname !== '/') url.pathname = url.pathname.slice(0, -1)
  if (url.pathname === '/') url.pathname = ''
  return url.href.replace(/\/$/, '')
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try { response = await fetch(url, init) }
  catch (error) { throw new EnterpriseOidcError('network', 'OIDC request failed', { cause: error }) }
  if (!response.ok) throw new EnterpriseOidcError('network', `OIDC request returned HTTP ${response.status}`)
  try { return await response.json() }
  catch (error) { throw new EnterpriseOidcError('protocol', 'OIDC response is not JSON', { cause: error }) }
}
