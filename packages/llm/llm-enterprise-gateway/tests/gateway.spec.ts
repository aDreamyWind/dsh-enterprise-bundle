/** Harness Admin gateway integration over atomically allocated loopback listeners. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import DefaultModel from '@deepseek-ai/dsh-agent-enterprise-default-model'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as EnterpriseGateway from '@deepseek-ai/dsh-llm-enterprise-gateway'
import { expect, it, onTestFinished, vi } from 'vitest'

interface GatewayFixture {
  baseURL: string
  server: Server
  headers: IncomingMessage['headers'][]
  requests: Array<Record<string, unknown>>
  catalogHeaders: IncomingMessage['headers'][]
}

it('exposes the Cordis apply module without a competing default export', () => {
  expect(EnterpriseGateway.apply).toBeTypeOf('function')
  expect(EnterpriseGateway).not.toHaveProperty('default')
})

async function gatewayFixture(
  statuses: number[],
  catalogModels: readonly Record<string, unknown>[] = [{ id: 'catalog-code', object: 'model' }],
  catalogStatus: number | number[] = 200,
  beforeCatalogResponse?: () => Promise<void>,
): Promise<GatewayFixture> {
  const headers: IncomingMessage['headers'][] = []
  const requests: Array<Record<string, unknown>> = []
  const catalogHeaders: IncomingMessage['headers'][] = []
  const server = createServer((request, response) => { void handle(request, response) })
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/v1/models') {
      catalogHeaders.push(request.headers)
      await beforeCatalogResponse?.()
      const status = typeof catalogStatus === 'number' ? catalogStatus : catalogStatus.shift() ?? 500
      response.writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(status === 200
          ? { object: 'list', data: catalogModels }
          : { error: { message: `admin-${String(status)}` } }))
      return
    }
    headers.push(request.headers)
    requests.push(JSON.parse(await readBody(request)) as Record<string, unknown>)
    const status = statuses.shift() ?? 500
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: `admin-${String(status)}` } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}\n\n')
    response.write('data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n')
    response.end('data: [DONE]\n\n')
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('gateway listener did not bind')
  return { baseURL: `http://127.0.0.1:${String(address.port)}/v1`, server, headers, requests, catalogHeaders }
}

function enterpriseAccount(tokens: string[]) {
  return {
    resolveAccessToken: vi.fn(async () => tokens[0]),
    refreshAccessToken: vi.fn(async () => tokens[1]),
    rejectAccessToken: vi.fn(async () => undefined),
  }
}

async function mountGateway(
  gateway: GatewayFixture,
  models: EnterpriseGateway.Config['models'] = [{ id: 'catalog-code' }],
  tokens: string[] = ['initial-token', 'refreshed-token'],
  options: Partial<Pick<EnterpriseGateway.Config, 'catalogMaxBytes' | 'catalogTimeoutMs'>> = {},
) {
  const account = enterpriseAccount(tokens)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('enterpriseAccount', account as never)
  const defaults = { setAvailableModels: vi.fn(), clearAvailableModels: vi.fn() }
  ctx.provide('enterpriseModelDefaults', defaults as never)
  await ctx.plugin(LlmRuntime)
  const mounted = ctx.plugin(EnterpriseGateway, {
    gatewayBaseURL: gateway.baseURL, models, allowLoopbackHttp: true, ...options,
  })
  await mounted
  return { account, defaults, ctx, mounted }
}

async function run(
  statuses: number[],
  catalogModels?: readonly Record<string, unknown>[],
  catalogStatus?: number,
) {
  const gateway = await gatewayFixture(statuses, catalogModels, catalogStatus)
  const { account, defaults, ctx } = await mountGateway(gateway)
  const prepared = await ctx.llm.prepareCall({ provider: 'harness-admin', model: 'catalog-code' })
  const chunks = []
  for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
  return { account, chunks, gateway, defaults, ctx }
}

it('lists only OIDC-authorized models and uses Admin names and vision metadata', async () => {
  const gateway = await gatewayFixture([200], [
    { id: 'allowed', object: 'model', name: 'Allowed Model', capabilities: ['text', 'vision'] },
  ])
  const { defaults, ctx } = await mountGateway(gateway, [{ id: 'not-authorized' }])
  await expect(ctx.llm.listModels('harness-admin')).resolves.toEqual([
    { provider: 'harness-admin', id: 'allowed', name: 'Allowed Model', inputModalities: ['text', 'image'] },
  ])
  expect(gateway.catalogHeaders[0]?.authorization).toBe('Bearer initial-token')
  expect(defaults.setAvailableModels).toHaveBeenCalledWith('harness-admin', ['allowed'])
  await expect(ctx.llm.resolveModelInfo('harness-admin', 'not-authorized'))
    .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  const denied = []
  for await (const chunk of ctx.llm.stream({ provider: 'harness-admin', model: 'not-authorized', messages: [] })) denied.push(chunk)
  expect(denied.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN_MODEL' } } })
  expect(gateway.requests).toEqual([])
  const model = await ctx.llm.resolveModelInfo('harness-admin', 'allowed')
  expect(model.name).toBe('Allowed Model')
  expect(model.context).toBeUndefined()
  const prepared = await ctx.llm.prepareCall({ provider: 'harness-admin', model: 'allowed' })
  for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* drain the successful request */ }
  expect(gateway.requests[0]?.model).toBe('allowed')
})

it('does not fall back to static models when Admin catalog is unavailable', async () => {
  const gateway = await gatewayFixture([], undefined, 503)
  const { defaults, ctx } = await mountGateway(gateway, [{ id: 'static-model' }])
  await expect(ctx.llm.listModels('harness-admin')).rejects.toMatchObject({
    code: 'MODEL_CATALOG_UNAVAILABLE', failure: { status: 503 },
  })
  expect(defaults.setAvailableModels).toHaveBeenCalledWith('harness-admin', [])
})

it('offers no static models while signed out and refuses direct invocation', async () => {
  const gateway = await gatewayFixture([])
  const { ctx } = await mountGateway(gateway, undefined, [])
  await expect(ctx.llm.listModels('harness-admin')).resolves.toEqual([])
  await expect(ctx.llm.prepareCall({ provider: 'harness-admin', model: 'catalog-code' }))
    .rejects.toMatchObject({ code: 'AUTH' })
  expect(gateway.catalogHeaders).toEqual([])
  expect(gateway.requests).toEqual([])
})

it('keeps an empty authorized directory empty even when static model hints exist', async () => {
  const gateway = await gatewayFixture([], [])
  const { ctx } = await mountGateway(gateway)
  await expect(ctx.llm.listModels('harness-admin')).resolves.toEqual([])
  await expect(ctx.llm.prepareCall({ provider: 'harness-admin', model: 'catalog-code' }))
    .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  expect(gateway.requests).toEqual([])
})

it('refreshes a directory-rejected token once using the models endpoint', async () => {
  const gateway = await gatewayFixture([], undefined, [401, 200])
  const { ctx, account } = await mountGateway(gateway)
  await expect(ctx.llm.listModels('harness-admin')).resolves.toEqual([
    { provider: 'harness-admin', id: 'catalog-code', name: 'catalog-code', inputModalities: ['text'] },
  ])
  expect(gateway.catalogHeaders.map(headers => headers.authorization)).toEqual([
    'Bearer initial-token', 'Bearer refreshed-token',
  ])
  expect(account.refreshAccessToken).toHaveBeenCalledExactlyOnceWith(`${gateway.baseURL}/models`, 'initial-token', ['model.invoke'])
  expect(account.rejectAccessToken).not.toHaveBeenCalled()
})

it('retires a refresh token replacement rejected by the directory', async () => {
  const gateway = await gatewayFixture([], undefined, [401, 401])
  const { ctx, account } = await mountGateway(gateway)
  await expect(ctx.llm.listModels('harness-admin')).rejects.toMatchObject({ code: 'AUTH', failure: { status: 401 } })
  expect(account.rejectAccessToken).toHaveBeenCalledExactlyOnceWith('refreshed-token')
})

it.each([
  [{ id: '', object: 'model' }],
  [{ id: 'duplicate' }, { id: 'duplicate' }],
  [{ id: 'invalid', name: 42 }],
  [{ id: 'invalid', capabilities: ['vision', 42] }],
])('rejects malformed model entries instead of advertising a partial catalog: %j', async (...entries) => {
  const gateway = await gatewayFixture([], entries)
  const { ctx } = await mountGateway(gateway)
  await expect(ctx.llm.listModels('harness-admin')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

it.each([0, -1])('checks the complete UTF-8 directory response at its byte limit plus %s', async (delta) => {
  const models = [{ id: 'catalog-code', name: '企业模型' }]
  const bytes = Buffer.byteLength(JSON.stringify({ object: 'list', data: models }))
  const gateway = await gatewayFixture([], models)
  const { ctx } = await mountGateway(gateway, undefined, undefined, { catalogMaxBytes: bytes + delta })
  const listing = ctx.llm.listModels('harness-admin')
  if (delta === 0) await expect(listing).resolves.toHaveLength(1)
  else await expect(listing).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

it('cancels an in-flight directory read and removes its default-model publication on disposal', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const gateway = await gatewayFixture([], undefined, 200, async () => {
    entered.resolve(undefined)
    await release.promise
  })
  const { ctx, mounted, defaults } = await mountGateway(gateway)
  const reading = ctx.llm.listModels('harness-admin')
  const rejected = expect(reading).rejects.toThrow()
  await entered.promise
  await mounted.dispose()
  await rejected
  expect(defaults.setAvailableModels).not.toHaveBeenCalled()
  expect(defaults.clearAvailableModels).toHaveBeenCalledExactlyOnceWith('harness-admin')
  expect(ctx.llm.listProviders()).toEqual([])
  release.resolve(undefined)
})

it('boots the shared enterprise adapter through cordis.yml and applies an authorized default', async () => {
  const gateway = await gatewayFixture([200], [{ id: 'allowed', name: 'Enterprise Chat', capabilities: ['text'] }])
  const root = await mkdtemp(join(tmpdir(), 'dsh-enterprise-directory-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'cordis.yml')
  const template = await readFile(new URL('./fixtures/directory.cordis.yml', import.meta.url), 'utf8')
  await writeFile(configPath, template.replace('{{gateway}}', JSON.stringify(gateway.baseURL)))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['fixture-account'] = {
    apply(owner: Context) { owner.provide('enterpriseAccount', enterpriseAccount(['user-access-token']) as never) },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-agent-enterprise-default-model', DefaultModel],
    ['@deepseek-ai/dsh-llm-enterprise-gateway', EnterpriseGateway],
  ])
  const importer: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: async (specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = importer
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const models = await ctx.llm.listModels('harness-admin')
  const selection = ctx.agentDefaultModel.currentSelection()
  const prepared = await ctx.llm.prepareCall(selection)
  const text: string[] = []
  for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) {
    if (chunk.type === 'text-delta') text.push(chunk.text)
  }
  expect({
    models: models.map(model => ({ id: model.id, name: model.name })), selection, text: text.join(''),
    requestedModel: gateway.requests[0]?.model,
    usageRequested: gateway.requests[0]?.stream_options,
    authenticatedDirectory: gateway.catalogHeaders.every(headers => headers.authorization === 'Bearer user-access-token'),
  }).toMatchInlineSnapshot(`
    {
      "authenticatedDirectory": true,
      "models": [
        {
          "id": "allowed",
          "name": "Enterprise Chat",
        },
      ],
      "requestedModel": "allowed",
      "selection": {
        "model": "allowed",
        "provider": "harness-admin",
      },
      "text": "hello",
      "usageRequested": {
        "include_usage": true,
      },
    }
  `)
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'enterprise-gateway')
  if (entry?.fiber === undefined) throw new Error('enterprise gateway did not activate')
  await entry.fiber.dispose()
  expect(ctx.llm.listProviders()).toEqual([])
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('stale-model')
})

it('refreshes one rejected access token and retries the exact model code once', async () => {
  const { account, chunks, gateway } = await run([401, 200])
  expect(gateway.headers.map(value => value.authorization)).toEqual([
    'Bearer initial-token',
    'Bearer refreshed-token',
  ])
  expect(gateway.requests).toHaveLength(2)
  expect(gateway.requests[1]).toMatchObject({
    model: 'catalog-code',
    stream: true,
    stream_options: { include_usage: true },
  })
  expect(account.refreshAccessToken).toHaveBeenCalledExactlyOnceWith(
    `${gateway.baseURL}/chat/completions`,
    'initial-token',
    ['model.invoke'],
  )
  expect(account.rejectAccessToken).not.toHaveBeenCalled()
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
})

it.each([
  [403, 'AUTHORIZATION_DENIED'],
  [404, 'UNKNOWN_MODEL'],
  [409, 'MODEL_UNAVAILABLE'],
  [429, 'RATE_LIMIT'],
] as const)('maps Harness Admin HTTP %s without refreshing', async (status, code) => {
  const { account, chunks } = await run([status])
  expect(account.refreshAccessToken).not.toHaveBeenCalled()
  expect(chunks.at(-1)).toMatchObject({
    type: 'finish',
    reason: { kind: 'error', failure: { code, status } },
  })
})

it('does not attribute an ambiguous HTTP 403 to the Harness Admin account', async () => {
  const { chunks } = await run([403])
  expect(chunks.at(-1)).toMatchObject({
    type: 'finish',
    reason: { kind: 'error', failure: {
      code: 'AUTHORIZATION_DENIED',
      message: 'Model request was rejected (HTTP 403); check the Harness Admin gateway call record to identify whether the gateway or upstream provider denied it',
    } },
  })
})

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    const value: unknown = chunk
    if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
    else throw new TypeError('request body chunk is not binary or text')
  }
  return Buffer.concat(chunks).toString('utf8')
}
