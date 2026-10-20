/** Harness Admin OpenAI Chat Completions routing with Host-only OIDC bearer tokens. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-enterprise-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-enterprise-account'
import type {} from '@deepseek-ai/dsh-fs'
import {
  LlmAdapter,
  LlmError,
  resolveImageAttachmentAccess,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  PiAiAdapter,
  type PiAiModelProfile,
  type ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import z from '@deepseek-ai/schemastery'
import { authContextFrom, credentialStoreFrom, resolveProfiles } from './upstream-helpers.ts'

const REQUIRED_SCOPES = ['model.invoke'] as const

const modelProfile = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(['text', 'image'] as const)),
})

/** Harness Admin gateway address and optional metadata for Admin model codes. */
export interface Config {
  /** OpenAI-compatible root ending in `/v1`. */
  gatewayBaseURL: string
  /** Harness provider route shown in model selectors. */
  provider?: string
  /** Provider label shown in model selectors. */
  displayName?: string
  /** Model metadata hints; only authenticated `GET /v1/models` decides availability. */
  models: PiAiModelProfile[]
  /** Deadline for one model-directory read, including a possible 401 retry. */
  catalogTimeoutMs?: number
  /** Maximum complete model-directory response size in bytes. */
  catalogMaxBytes?: number
  /** Permit an HTTP gateway only on a loopback hostname. */
  allowLoopbackHttp?: boolean
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  gatewayBaseURL: z.string().required(),
  provider: z.string().default('harness-admin'),
  displayName: z.string().default('Harness Admin'),
  models: z.array(modelProfile).required(),
  catalogTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(15_000),
  catalogMaxBytes: z.number().step(1).min(1).default(1_048_576),
  allowLoopbackHttp: z.boolean().default(false),
})

export const name = 'llm-enterprise-gateway'
export const inject = ['llm', 'enterpriseAccount', 'enterpriseModelDefaults']

interface ResolvedConfig {
  baseURL: string
  requestURL: string
  catalogURL: string
  provider: string
  displayName: string
  modelHints: ReadonlyMap<string, PiAiModelProfile>
  catalogTimeoutMs: number
  catalogMaxBytes: number
}

interface AvailableModel {
  id: string
  name: string
  input: Array<'text' | 'image'>
  profile: PiAiModelProfile
}

interface AvailableCatalog {
  models: readonly AvailableModel[]
  profiles?: ReadonlyMap<string, ResolvedPiAiProviderProfile>
}

interface EnterpriseFailure {
  chunk: Extract<StreamChunk, { type: 'finish' }>
  status?: number
}

/** Register the Harness Admin model route; listing requires an OIDC access token. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const adapter = new EnterpriseGatewayAdapter(ctx, resolved)
  ctx.llm.registerAdapter([resolved.provider], adapter)
  ctx.effect(() => async () => {
    const closing = adapter.close()
    ctx.enterpriseModelDefaults.clearAvailableModels(resolved.provider)
    await closing
  })
}

/** Harness Admin adapter layered over the maintained OpenAI Completions translator. */
export class EnterpriseGatewayAdapter extends LlmAdapter {
  private readonly auth
  private active = true
  private listingRevision = 0
  private readonly catalogLifetime = new AbortController()
  private readonly pendingCatalogs = new Set<Promise<AvailableCatalog>>()

  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {
    super()
    this.auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  }

  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: this.config.displayName } }
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined { return undefined }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const revision = ++this.listingRevision
    let catalog: AvailableCatalog
    try { catalog = await this.availableCatalog(undefined, true) }
    catch (error) {
      if (this.active && revision === this.listingRevision) this.ctx.enterpriseModelDefaults.setAvailableModels(provider, [])
      throw error
    }
    if (this.active && revision === this.listingRevision) {
      this.ctx.enterpriseModelDefaults.setAvailableModels(provider, catalog.models.map(model => model.id))
    }
    return catalog.models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: [...model.input] }))
  }

  /**
   * Stop directory reads and wait until no read can publish after plugin disposal.
   * @returns completion after cancellation settles.
   */
  async close(): Promise<void> {
    this.active = false
    this.catalogLifetime.abort()
    await Promise.allSettled(this.pendingCatalogs)
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const catalog = await this.availableCatalog(signal)
    return this.resolveAvailableModel(catalog, provider, model, signal)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const catalog = await this.availableCatalog(signal)
    const resolved = await this.resolveAvailableModel(catalog, provider, model, signal)
    return { model: resolved, stream: options => this.generate(options, catalog.profiles) }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.streamCurrent(options) }

  private async * streamCurrent(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const catalog = await this.availableCatalog(options.signal)
    await this.resolveAvailableModel(catalog, options.provider, options.model, options.signal)
    yield* this.generate(options, catalog.profiles)
  }

  private async resolveAvailableModel(
    catalog: AvailableCatalog, provider: string, model: string, signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const available = catalog.models.find(entry => entry.id === model)
    if (available === undefined || catalog.profiles === undefined) {
      throw new LlmError(`Harness Admin does not list model "${model}" for this account`, 'UNKNOWN_MODEL')
    }
    const adapter = this.createAdapter(() => Promise.reject(new LlmError('No gateway access token', 'AUTH')), catalog.profiles)
    const resolved = await adapter.resolveModel(provider, model, signal)
    if (available.profile.contextWindow !== undefined) return resolved
    const { context: _assumedContext, ...withoutAssumedContext } = resolved
    return withoutAssumedContext
  }

  private availableCatalog(signal?: AbortSignal, signedOutAsEmpty = false): Promise<AvailableCatalog> {
    const timeout = AbortSignal.timeout(this.config.catalogTimeoutMs)
    const combined = AbortSignal.any([this.catalogLifetime.signal, timeout, ...signal === undefined ? [] : [signal]])
    const operation = this.readAvailableCatalog(combined, signedOutAsEmpty).catch((cause: unknown) => {
      if (timeout.aborted && !this.catalogLifetime.signal.aborted && !signal?.aborted) {
        throw new LlmError('Harness Admin model directory timed out; retry the model list', 'TIMEOUT', { cause })
      }
      throw cause
    })
    this.pendingCatalogs.add(operation)
    void operation.then(() => this.pendingCatalogs.delete(operation), () => this.pendingCatalogs.delete(operation))
    return operation
  }

  private async readAvailableCatalog(signal: AbortSignal, signedOutAsEmpty: boolean): Promise<AvailableCatalog> {
    signal.throwIfAborted()
    const token = await this.ctx.enterpriseAccount.resolveAccessToken(this.config.catalogURL, REQUIRED_SCOPES)
    signal.throwIfAborted()
    if (token === undefined) {
      if (signedOutAsEmpty) return { models: [] }
      throw new LlmError('Sign in to Harness Admin before invoking an enterprise model', 'AUTH')
    }
    let response = await this.fetchCatalog(token, signal)
    if (response.status === 401) {
      await response.body?.cancel()
      const replacement = await this.ctx.enterpriseAccount.refreshAccessToken(
        this.config.catalogURL, token, REQUIRED_SCOPES,
      )
      if (replacement !== undefined) response = await this.fetchCatalog(replacement, signal)
      if (replacement === undefined || response.status === 401) {
        if (replacement !== undefined) await response.body?.cancel()
        await this.ctx.enterpriseAccount.rejectAccessToken(replacement ?? token)
        throw new LlmError('Harness Admin model directory rejected the login session; sign in again', 'AUTH', { status: 401 })
      }
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new LlmError(`Harness Admin model directory request failed (HTTP ${response.status})`,
        response.status === 403 ? 'AUTHORIZATION_DENIED' : 'MODEL_CATALOG_UNAVAILABLE', { status: response.status })
    }
    let payload: unknown
    try { payload = JSON.parse(await readCatalogBody(response, this.config.catalogMaxBytes)) }
    catch (cause) {
      signal.throwIfAborted()
      if (cause instanceof LlmError) throw cause
      throw new LlmError('Harness Admin model directory returned invalid JSON', 'INVALID_RESPONSE', { cause })
    }
    signal.throwIfAborted()
    const models = parseCatalog(payload, this.config.modelHints)
    if (models.length === 0) return { models }
    return {
      models,
      profiles: resolveProfiles({
        [this.config.provider]: {
          displayName: this.config.displayName,
          api: 'openai-completions',
          baseURL: this.config.baseURL,
          models: models.map(model => model.profile),
          compat: { supportsUsageInStreaming: true },
        },
      }),
    }
  }

  private async fetchCatalog(token: string, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(this.config.catalogURL, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal,
      })
    } catch (cause) {
      signal.throwIfAborted()
      throw new LlmError('Harness Admin model directory is unreachable; check the gateway address',
        'MODEL_CATALOG_UNAVAILABLE', { cause })
    }
  }

  private async * generate(
    options: GenerateOptions, profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined,
  ): AsyncGenerator<StreamChunk> {
    if (profiles === undefined) throw new LlmError('Harness Admin lists no available models for this account', 'UNKNOWN_MODEL')
    let forcedToken: string | undefined
    request: for (let attempt = 0; attempt < 2; attempt++) {
      let requestToken: string | undefined
      const adapter = this.createAdapter(async () => {
        requestToken = forcedToken ?? await this.ctx.enterpriseAccount.resolveAccessToken(
          this.config.requestURL,
          REQUIRED_SCOPES,
        )
        if (requestToken === undefined) {
          throw new LlmError('Sign in to Harness Admin before invoking an enterprise model', 'AUTH')
        }
        return requestToken
      }, profiles)
      let emitted = false
      let pendingUsage: Extract<StreamChunk, { type: 'usage' }> | undefined
      for await (const source of adapter.stream(options)) {
        if (source.type === 'usage') { pendingUsage = source; continue }
        if (source.type !== 'finish') { emitted = true; yield source; continue }
        const failure = mapEnterpriseFailure(source)
        if (failure.status === 401 && !emitted && attempt === 0 && requestToken !== undefined) {
          forcedToken = await this.ctx.enterpriseAccount.refreshAccessToken(
            this.config.requestURL,
            requestToken,
            REQUIRED_SCOPES,
          )
          if (forcedToken !== undefined) continue request
        }
        if (failure.status === 401 && requestToken !== undefined) {
          await this.ctx.enterpriseAccount.rejectAccessToken(requestToken)
        }
        if (pendingUsage !== undefined) yield pendingUsage
        yield failure.chunk
        return
      }
      return
    }
  }

  private createAdapter(
    resolveApiKey: () => Promise<string>, profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  ): PiAiAdapter {
    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey,
      auth: this.auth,
      resolveAttachments: () => this.ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments,
        hostPath => this.ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
      onReplayDegrade: ({ provider, model, reason }) => {
        this.ctx.logger.warn(
          `llm-enterprise-gateway: unusable replay state for route "${provider}/${model}";`
          + ` sending provider-neutral content (${reason})`,
        )
      },
    })
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const value = Config(config)
  const baseURL = validateGatewayBaseURL(value.gatewayBaseURL, value.allowLoopbackHttp)
  if (value.provider.length === 0) throw new Error('llm-enterprise-gateway: provider must be non-empty')
  if (value.models.length === 0) throw new Error('llm-enterprise-gateway: models must contain at least one default model hint')
  resolveProfiles({
    [value.provider]: { displayName: value.displayName, api: 'openai-completions', baseURL, models: value.models },
  })
  return {
    baseURL,
    requestURL: `${baseURL}/chat/completions`,
    catalogURL: `${baseURL}/models`,
    provider: value.provider,
    displayName: value.displayName,
    modelHints: new Map(value.models.map(model => [model.id, model])),
    catalogTimeoutMs: value.catalogTimeoutMs,
    catalogMaxBytes: value.catalogMaxBytes,
  }
}

async function readCatalogBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new LlmError('Harness Admin model directory exceeds catalogMaxBytes', 'INVALID_RESPONSE')
      chunks.push(value)
    }
  } finally {
    try { await reader.cancel() }
    catch (_error) { /* Cleanup cannot replace the settled directory result or its original read failure. */ }
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(body)
}

function parseCatalog(payload: unknown, hints: ReadonlyMap<string, PiAiModelProfile>): AvailableModel[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
    || !('object' in payload) || payload.object !== 'list'
    || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new LlmError('Harness Admin model directory returned an invalid list', 'INVALID_RESPONSE')
  }
  const models: AvailableModel[] = []
  const seen = new Set<string>()
  const entries: readonly unknown[] = payload.data
  for (const item of entries) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)
      || !('id' in item) || typeof item.id !== 'string' || item.id.length === 0) {
      throw new LlmError('Harness Admin model directory contains an invalid model', 'INVALID_RESPONSE')
    }
    let declaredName: string | undefined
    if ('name' in item) {
      if (typeof item.name !== 'string') throw new LlmError('Harness Admin model directory contains an invalid name', 'INVALID_RESPONSE')
      declaredName = item.name
    }
    let capabilities: string[] | undefined
    if ('capabilities' in item) {
      if (!isStringArray(item.capabilities)) {
        throw new LlmError('Harness Admin model directory contains invalid capabilities', 'INVALID_RESPONSE')
      }
      capabilities = item.capabilities
    }
    if (seen.has(item.id)) throw new LlmError(`Harness Admin model directory repeats "${item.id}"`, 'INVALID_RESPONSE')
    seen.add(item.id)
    const hint = hints.get(item.id)
    const hintedInput = hint?.input
    const fallbackInput: Array<'text' | 'image'> = hintedInput !== undefined && hintedInput.length > 0 ? [...hintedInput] : ['text']
    const input: Array<'text' | 'image'> = capabilities === undefined
      ? fallbackInput
      : capabilities.includes('vision') ? ['text', 'image'] : ['text']
    const name = declaredName !== undefined && declaredName.length > 0 ? declaredName : hint?.name ?? item.id
    models.push({
      id: item.id,
      name,
      input,
      profile: { ...hint, id: item.id, name, input },
    })
  }
  return models
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function validateGatewayBaseURL(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback))) {
    throw new Error('llm-enterprise-gateway: gatewayBaseURL must use HTTPS, or loopback HTTP when explicitly enabled')
  }
  if (!url.pathname.replace(/\/$/, '').endsWith('/v1')) {
    throw new Error('llm-enterprise-gateway: gatewayBaseURL must end in /v1')
  }
  return url.href.replace(/\/$/, '')
}

function mapEnterpriseFailure(chunk: Extract<StreamChunk, { type: 'finish' }>): EnterpriseFailure {
  if (chunk.reason.kind !== 'error') return { chunk }
  const status = chunk.reason.failure.status ?? httpStatus(chunk.reason.failure.message)
  if (status === undefined) return { chunk }
  const facts = { ...chunk.reason.failure, status }
  switch (status) {
    case 401:
      return { status, chunk: { ...chunk, reason: { kind: 'error', failure: {
        ...facts, code: 'AUTH', message: 'Harness Admin rejected the login session; sign in again',
      } } } }
    case 403:
      return { status, chunk: { ...chunk, reason: { kind: 'error', failure: {
        ...facts, code: 'AUTHORIZATION_DENIED', message: 'Model request was rejected (HTTP 403); check the Harness Admin gateway call record to identify whether the gateway or upstream provider denied it',
      } } } }
    case 404:
      return { status, chunk: { ...chunk, reason: { kind: 'error', failure: {
        ...facts, code: 'UNKNOWN_MODEL', message: 'Harness Admin does not contain the configured model code',
      } } } }
    case 409:
      return { status, chunk: { ...chunk, reason: { kind: 'error', failure: {
        ...facts, code: 'MODEL_UNAVAILABLE', message: 'The Harness Admin model or provider connection is disabled',
      } } } }
    case 429:
      return { status, chunk: { ...chunk, reason: { kind: 'error', failure: {
        ...facts, code: 'RATE_LIMIT', message: 'Harness Admin rate or token quota is exhausted',
      } } } }
    default:
      return { status, chunk: { ...chunk, reason: { kind: 'error', failure: facts } } }
  }
}

function httpStatus(message: string): number | undefined {
  const match = /(?:status(?:=|\s)|HTTP\s*|\b)([45]\d\d)\b/i.exec(message)
  return match?.[1] === undefined ? undefined : Number(match[1])
}
