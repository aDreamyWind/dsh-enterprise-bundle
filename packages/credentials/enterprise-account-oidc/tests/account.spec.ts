/** Enterprise OIDC login and rotating refresh integration over real loopback listeners. */
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it } from 'vitest'
import { EnterpriseOidcAccount } from '../src/index.ts'
import { exchangeToken, stateMatches, verifyIdToken, type ClientAuthMethod } from '../src/protocol.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!() })

interface IssuerFixture {
  origin: string
  server: Server
  setNonce(value: string): void
  refreshes(): number
  tokenRequests(): readonly TokenRequest[]
  jwk: JsonWebKey
  issue(claims: Record<string, unknown>): string
}

interface TokenRequest {
  authorization: string | undefined
  clientId: string | null
  clientSecret: string | null
  redirectUri: string | null
}

async function issuerFixture(
  clientAuthMethod: ClientAuthMethod = 'client_secret_basic',
  clientId = 'harness-client',
): Promise<IssuerFixture> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  let origin = ''
  let nonce = ''
  let refreshes = 0
  const tokenRequests: TokenRequest[] = []
  const issue = (claims: Record<string, unknown>): string => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
    return `${header}.${payload}.${signature}`
  }
  const server = createServer((request, response) => { void (async () => {
    if (request.url === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer: origin, authorization_endpoint: `${origin}/api/v1/oauth2/authorize`, token_endpoint: `${origin}/api/v1/oauth2/token`,
        jwks_uri: `${origin}/api/v1/oauth2/jwks`, userinfo_endpoint: `${origin}/api/v1/oauth2/userinfo`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
        id_token_signing_alg_values_supported: ['RS256'],
      })
      return
    }
    if (request.url === '/api/v1/oauth2/jwks') {
      json(response, 200, { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
      return
    }
    if (request.url === '/api/v1/oauth2/userinfo') {
      expect(request.headers.authorization).toMatch(/^Bearer access-/)
      json(response, 200, { sub: 'user-1', name: '测试用户', preferred_username: 'tester', email: 'user@example.test',
        org_id: 'org-1', org_code: 'engineering' })
      return
    }
    if (request.url === '/api/v1/oauth2/token') {
      const body = new URLSearchParams(await readBody(request))
      tokenRequests.push({
        authorization: request.headers.authorization,
        clientId: body.get('client_id'),
        clientSecret: body.get('client_secret'),
        redirectUri: body.get('redirect_uri'),
      })
      if (clientAuthMethod === 'client_secret_basic') {
        expect(request.headers.authorization).toBe(`Basic ${Buffer.from(`${clientId}:harness-secret`).toString('base64')}`)
        expect(body.has('client_id')).toBe(false)
        expect(body.has('client_secret')).toBe(false)
      } else if (clientAuthMethod === 'none') {
        expect(request.headers.authorization).toBeUndefined()
        expect(body.get('client_id')).toBe(clientId)
        expect(body.has('client_secret')).toBe(false)
      }
      const now = Math.floor(Date.now() / 1000)
      if (body.get('grant_type') === 'refresh_token') {
        refreshes++
        json(response, 200, {
          access_token: `access-refresh-${refreshes}`, token_type: 'Bearer', expires_in: 3600,
          refresh_token: `refresh-${refreshes + 1}`, scope: 'openid profile model.invoke offline_access',
        })
        return
      }
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code_verifier')).toBeTruthy()
      json(response, 200, {
        access_token: 'access-initial', token_type: 'Bearer', expires_in: 1, refresh_token: 'refresh-1',
        scope: 'openid profile model.invoke offline_access',
        id_token: issue({ iss: origin, sub: 'user-1', aud: clientId, exp: now + 300, iat: now, nonce, sid: 'sid-1' }),
      })
      return
    }
    response.writeHead(404).end()
  })().catch(() => { response.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('issuer listener did not bind')
  origin = `http://127.0.0.1:${address.port}`
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }))
  return {
    origin, server, setNonce: (value) => { nonce = value }, refreshes: () => refreshes,
    tokenRequests: () => tokenRequests, jwk, issue,
  }
}

async function accountFixture(options: {
  clientAuthMethod?: ClientAuthMethod
  clientId?: string
  redirectMode?: 'fixed' | 'loopback-random-port'
  redirectUri?: string
} = {}) {
  const clientAuthMethod = options.clientAuthMethod ?? 'client_secret_basic'
  const clientId = options.clientId ?? 'harness-client'
  const issuer = await issuerFixture(clientAuthMethod, clientId)
  const home = await mkdtemp(join(tmpdir(), 'dsh-enterprise-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  const redirectUri = options.redirectUri ?? `http://127.0.0.1:${String(ctx.webServer.port)}/oauth2/callback`
  const provider = ctx.plugin(EnterpriseOidcAccount, {
    issuer: issuer.origin, clientId,
    ...(clientAuthMethod === 'none' ? {} : { clientSecret: 'harness-secret' }),
    clientAuthMethod, redirectUri, redirectMode: options.redirectMode ?? 'fixed',
    gatewayOrigin: 'https://gateway.example.test',
    allowLoopbackHttp: true, refreshBeforeExpiryMs: 60_000,
  })
  await provider
  cleanups.push(async () => { await provider.dispose(); await authorization.dispose(); await credentials.dispose(); await web.dispose() })
  const account = ctx.enterpriseAccount as EnterpriseOidcAccount
  const states = new AbortController()
  cleanups.push(async () => { states.abort() })
  const wait = async (phase: string) => {
    for await (const state of account.watch(states.signal)) if (state.attempt?.phase === phase) return state
    throw new Error(`missing phase ${phase}`)
  }
  return { issuer, account, callbackOrigin: `http://127.0.0.1:${ctx.webServer.port}`, wait }
}

it('completes PKCE login, exposes only profile state, and serializes rotating refresh', async () => {
  const fixture = await accountFixture()
  await fixture.account.startSignIn()
  const waiting = await fixture.wait('waiting-browser')
  const authorize = new URL(waiting.attempt!.authorizeUrl!)
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorize.pathname).toBe('/api/v1/oauth2/authorize')
  expect(authorize.searchParams.get('scope')).toBe('openid profile model.invoke offline_access')
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${fixture.callbackOrigin}/oauth2/callback`)
  fixture.issuer.setNonce(authorize.searchParams.get('nonce')!)
  const bad = await fetch(`${fixture.callbackOrigin}/oauth2/callback?code=test&state=wrong`, { redirect: 'manual' })
  expect(bad.status).toBe(400)
  const callback = await fetch(`${fixture.callbackOrigin}/oauth2/callback?code=test&state=${authorize.searchParams.get('state')}`, { redirect: 'manual' })
  expect(callback.status).toBe(200)
  const signedIn = await fixture.wait('succeeded')
  expect(signedIn).toMatchObject({ status: 'signed-in', profile: {
    subject: 'user-1', name: '测试用户', preferredUsername: 'tester', email: 'user@example.test',
    organizationId: 'org-1', organizationCode: 'engineering',
  } })
  expect(JSON.stringify(signedIn)).not.toContain('access-initial')
  expect(authorize.searchParams.has('audience')).toBe(false)
  expect(await fixture.account.resolveAccessToken('https://other.example.test/v1/chat', ['model.invoke'])).toBeUndefined()
  const tokens = await Promise.all([
    fixture.account.resolveAccessToken('https://gateway.example.test/v1/chat', ['model.invoke']),
    fixture.account.resolveAccessToken('https://gateway.example.test/v1/chat/completions', ['model.invoke']),
  ])
  expect(tokens).toEqual(['access-refresh-1', 'access-refresh-1'])
  expect(fixture.issuer.refreshes()).toBe(1)
  const replacements = await Promise.all([
    fixture.account.refreshAccessToken('https://gateway.example.test/v1/chat/completions', 'access-refresh-1', ['model.invoke']),
    fixture.account.refreshAccessToken('https://gateway.example.test/v1/chat/completions', 'access-refresh-1', ['model.invoke']),
  ])
  expect(replacements).toEqual(['access-refresh-2', 'access-refresh-2'])
  expect(fixture.issuer.refreshes()).toBe(2)
  expect((await fixture.account.signOut()).status).toBe('signed-out')
})

it('uses a random loopback port and no client secret for a Desktop public client', async () => {
  const fixture = await accountFixture({
    clientAuthMethod: 'none',
    clientId: 'harness-desktop',
    redirectMode: 'loopback-random-port',
    redirectUri: 'http://127.0.0.1/oauth/callback',
  })
  await fixture.account.startSignIn()
  const waiting = await fixture.wait('waiting-browser')
  const authorize = new URL(waiting.attempt!.authorizeUrl!)
  const redirectUri = new URL(authorize.searchParams.get('redirect_uri')!)
  expect(redirectUri.hostname).toBe('127.0.0.1')
  expect(Number(redirectUri.port)).toBeGreaterThan(0)
  expect(redirectUri.pathname).toBe('/oauth/callback')
  fixture.issuer.setNonce(authorize.searchParams.get('nonce')!)
  const callback = await fetch(`${redirectUri.href}?code=test&state=${authorize.searchParams.get('state')}`, { redirect: 'manual' })
  expect(callback.status).toBe(200)
  await fixture.wait('succeeded')
  expect(fixture.issuer.tokenRequests()[0]).toEqual({
    authorization: undefined,
    clientId: 'harness-desktop',
    clientSecret: null,
    redirectUri: redirectUri.href,
  })
  await expect(fixture.account.resolveAccessToken(
    'https://gateway.example.test/v1/chat/completions', ['model.invoke'],
  )).resolves.toBe('access-refresh-1')
  expect(fixture.issuer.tokenRequests()[1]).toMatchObject({
    authorization: undefined,
    clientId: 'harness-desktop',
    clientSecret: null,
  })
})

it('validates state in constant-time form and rejects a wrong ID-token nonce', async () => {
  expect(stateMatches('same', 'same')).toBe(true)
  expect(stateMatches('short', 'different')).toBe(false)
  const fixture = await issuerFixture()
  const now = Math.floor(Date.now() / 1000)
  const token = fixture.issue({ iss: fixture.origin, sub: 'user-1', aud: 'harness-client', exp: now + 60, iat: now, nonce: 'actual' })
  await expect(verifyIdToken(token, {
    issuer: fixture.origin, clientId: 'harness-client', nonce: 'expected', jwksUri: `${fixture.origin}/api/v1/oauth2/jwks`,
    clockSkewSeconds: 0, signal: AbortSignal.timeout(5_000),
  })).rejects.toMatchObject({ code: 'protocol' })
})

it('supports client_secret_post without an Authorization header', async () => {
  let authorization: string | undefined
  let clientId: string | null = null
  let clientSecret: string | null = null
  const server = createServer((request, response) => { void (async () => {
    const body = new URLSearchParams(await readBody(request))
    authorization = request.headers.authorization
    clientId = body.get('client_id')
    clientSecret = body.get('client_secret')
    json(response, 200, { access_token: 'access-post', token_type: 'Bearer', expires_in: 60 })
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('token listener did not bind')
  await expect(exchangeToken(
    `http://127.0.0.1:${String(address.port)}/token`,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'refresh' }),
    { method: 'client_secret_post', clientId: 'harness-client', clientSecret: 'harness-secret' },
    AbortSignal.timeout(5_000),
  )).resolves.toMatchObject({ access_token: 'access-post' })
  expect(authorization).toBeUndefined()
  expect(clientId).toBe('harness-client')
  expect(clientSecret).toBe('harness-secret')
})

function json(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    const value: unknown = chunk
    if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
    else throw new TypeError('request body chunk is not binary or text')
  }
  return Buffer.concat(chunks).toString('utf8')
}
