/** Employee-scoped Harness Admin MCP directory and Host-only tool connections. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-enterprise-account'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-mcp-resources'
import type {} from '@deepseek-ai/dsh-skill'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { registerEnterpriseSkills } from './skills.ts'
import { registerUpstreamSkills } from './upstream-skills.ts'

const REQUIRED_SCOPES = ['mcp.invoke'] as const
const connectionSchema = z.object({
  code: z.string().min(1), name: z.string().min(1), serviceName: z.string().min(1),
  url: z.url(), transport: z.literal('streamable_http'),
})
const directorySchema = z.object({ data: z.array(connectionSchema) })
type DirectoryConnection = z.infer<typeof connectionSchema>

/** Host-only Admin directory and bounded request policy. */
export interface Config {
  directoryUrl: string
  allowLoopbackHttp?: boolean
  requestTimeoutMs?: number
  maxDirectoryBytes?: number
  toolCallTimeoutMs?: number
}

/** Validated deployment fields for the enterprise MCP bridge. */
export const Config = Schema.object({
  directoryUrl: Schema.string().required(),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).default(15_000),
  maxDirectoryBytes: Schema.number().min(1).default(1_048_576),
  toolCallTimeoutMs: Schema.number().min(1).default(60_000),
})

export const name = 'mcp-enterprise-connections'
export const inject = ['enterpriseAccount', 'tools', 'mcpResources', 'skills']

/** Stable, valid MCP namespace for an opaque Admin connection code. */
export function serverNameFor(code: string): string {
  return `admin_${createHash('sha256').update(code).digest('hex').slice(0, 26)}`
}

/** Mount a Host-owned directory supervisor without changing Harness MCP packages. */
export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  const directoryUrl = validateDirectoryURL(resolved.directoryUrl, resolved.allowLoopbackHttp)
  const supervisor = new EnterpriseMcpSupervisor(ctx, directoryUrl, resolved)
  const skills = registerEnterpriseSkills(ctx, directoryUrl, resolved)
  ctx.on('agent/pre-step', async (_payload, next) => {
    await supervisor.refreshSafely()
    skills.invalidate()
    return next()
  })
  ctx.effect(() => () => { skills.dispose(); return supervisor.close() }, 'enterprise MCP connections')
  supervisor.start()
}

/** Live directory owner; all enterprise MCP tool registrations end with this instance. */
export class EnterpriseMcpSupervisor {
  private readonly lifetime = new AbortController()
  private readonly connections = new Map<string, EmployeeConnection>()
  private refreshing: Promise<void> | undefined
  private watching: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly directoryUrl: URL,
    private readonly config: Required<Config>,
  ) {}

  /** Follow account changes so sign-out removes employee tools immediately. */
  start(): void {
    this.watching = (async () => {
      for await (const view of this.ctx.enterpriseAccount.watch(this.lifetime.signal)) {
        if (this.lifetime.signal.aborted) break
        // A grant change settles the prior read before replacing or removing its tools.
        try { await this.refreshing }
        catch (_error) { /* refreshSafely reports the failed directory read. */ }
        if (view.status !== 'signed-in' || view.reauthorizationRequired) {
          await this.clear()
        } else {
          await this.refreshSafely()
        }
      }
    })().catch(async (error: unknown) => {
      if (!this.lifetime.signal.aborted) {
        await this.clear()
        this.ctx.logger.error(`enterprise MCP account watch failed; tools removed: ${String(error)}`)
      }
    })
  }

  /** Refresh before a model step; a failed directory never leaves stale enterprise tools visible. */
  async refreshSafely(): Promise<void> {
    try { await this.refresh() }
    catch (error) {
      if (!this.lifetime.signal.aborted) {
        await this.clear()
        this.ctx.logger.error(`enterprise MCP directory unavailable; tools removed: ${String(error)}`)
      }
    }
  }

  /** Serialize directory reads and reconcile connected tools with the current employee grant. */
  refresh(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing
    const operation = this.reconcile()
    this.refreshing = operation
    const settled = (): void => { if (this.refreshing === operation) this.refreshing = undefined }
    void operation.then(settled, settled)
    return operation
  }

  /** Stop reads and connections before the owning Cordis effect is released. */
  async close(): Promise<void> {
    this.lifetime.abort()
    await this.watching
    try { await this.refreshing }
    catch (_error) { /* The failed read was already handled by its caller. */ }
    await this.clear()
  }

  private async reconcile(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    const account = await this.ctx.enterpriseAccount.getState()
    if (account.status !== 'signed-in' || account.reauthorizationRequired) {
      await this.clear()
      return
    }
    const entries = await this.readDirectory()
    this.lifetime.signal.throwIfAborted()
    const available = new Map(entries.map(entry => [entry.code, entry]))
    for (const [code, connection] of this.connections) {
      const entry = available.get(code)
      if (entry === undefined || entry.url !== connection.url) {
        this.connections.delete(code)
        await connection.close()
      }
    }
    for (const entry of entries) {
      if (this.lifetime.signal.aborted) return
      let connection = this.connections.get(entry.code)
      try {
        if (connection === undefined) {
          connection = await EmployeeConnection.open(this.ctx, entry, this.config.toolCallTimeoutMs)
          this.connections.set(entry.code, connection)
        }
        await connection.sync()
      } catch (error) {
        this.ctx.logger.error(`enterprise MCP connection ${entry.code} unavailable: ${String(error)}`)
        if (connection !== undefined) {
          this.connections.delete(entry.code)
          await connection.close()
        }
      }
    }
  }

  private async readDirectory(): Promise<DirectoryConnection[]> {
    const url = this.directoryUrl.href
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const current = await this.ctx.enterpriseAccount.resolveAccessToken(url, REQUIRED_SCOPES)
    if (current === undefined) throw new Error('employee grant lacks mcp.invoke; reauthorize the enterprise account')
    let response = await fetch(url, { headers: { Authorization: `Bearer ${current}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'error', signal })
    if (response.status === 401) {
      await response.body?.cancel()
      const replacement = await this.ctx.enterpriseAccount.refreshAccessToken(url, current, REQUIRED_SCOPES)
      if (replacement === undefined) throw new Error('employee MCP login expired; sign in again')
      response = await fetch(url, { headers: { Authorization: `Bearer ${replacement}`, Accept: 'application/json' },
        cache: 'no-store', redirect: 'error', signal })
      if (response.status === 401) await this.ctx.enterpriseAccount.rejectAccessToken(replacement)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`employee MCP directory returned HTTP ${response.status}`)
    }
    const parsed: unknown = JSON.parse(await readBoundedBody(response, this.config.maxDirectoryBytes))
    const result = directorySchema.parse(parsed)
    const seen = new Set<string>()
    const names = new Set<string>()
    for (const entry of result.data) {
      const gateway = new URL(entry.url)
      if (gateway.origin !== this.directoryUrl.origin || gateway.username || gateway.password
        || gateway.search || gateway.hash || gateway.pathname !== `/mcp/${encodeURIComponent(entry.code)}`) {
        throw new Error(`employee MCP directory returned an untrusted URL for ${entry.code}`)
      }
      const namespace = serverNameFor(entry.code)
      if (seen.has(entry.code) || names.has(namespace)) throw new Error('employee MCP directory repeats a connection identity')
      seen.add(entry.code)
      names.add(namespace)
    }
    return result.data
  }

  private async clear(): Promise<void> {
    const prior = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(prior.map(connection => connection.close()))
  }
}

/** One authenticated SDK connection and its registered tool generation. */
class EmployeeConnection {
  private readonly registrations = new Map<string, () => void>()
  private resourceRegistration: (() => void) | undefined
  private readonly promptRegistrations: (() => void)[] = []
  private upstreamSkills: ReturnType<typeof registerUpstreamSkills> | undefined
  private closed = false

  private constructor(
    private readonly ctx: Context,
    readonly url: string,
    private readonly code: string,
    private readonly client: Client,
    private readonly toolCallTimeoutMs: number,
  ) {}

  static async open(ctx: Context, entry: DirectoryConnection, toolCallTimeoutMs: number): Promise<EmployeeConnection> {
    const client = new Client({ name: 'dsh-enterprise-mcp', version: '0.2.1' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    const connection = new EmployeeConnection(ctx, entry.url, entry.code, client, toolCallTimeoutMs)
    const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
      authProvider: { token: async () => {
        const token = await ctx.enterpriseAccount.resolveAccessToken(entry.url, REQUIRED_SCOPES)
        if (token === undefined) throw new Error('employee MCP login is unavailable')
        return token
      } },
      fetch: (input, init) => connection.fetchWithRefresh(input, init),
    })
    try { await client.connect(transport); return connection }
    catch (error) { await client.close(); throw error }
  }

  /** Replace a full tool generation after successful SDK discovery. */
  async sync(): Promise<void> {
    if (this.closed) return
    const listed = this.client.getServerCapabilities()?.tools === undefined
      ? { tools: [] } : await this.client.listTools(undefined, { cacheMode: 'refresh' })
    const next = new Map<string, ReturnType<typeof createMcpToolDefinition>>()
    for (const tool of listed.tools) {
      const name = toolName(serverNameFor(this.code), tool.name)
      if (next.has(name)) throw new Error(`employee MCP server ${this.code} repeats a tool`)
      next.set(name, createMcpToolDefinition(this.ctx, {
        name, rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema, taskRequired: tool.execution?.taskSupport === 'required',
        call: (args, execution) => this.client.callTool({ name: tool.name, arguments: args },
          { signal: execution.signal, timeout: this.toolCallTimeoutMs, toolDefinition: tool }),
      }))
    }
    const previous = new Set(this.registrations.keys())
    for (const dispose of this.registrations.values()) dispose()
    this.registrations.clear()
    try {
      for (const [name, definition] of next) this.registrations.set(name, this.ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of this.registrations.values()) dispose()
      this.registrations.clear()
      for (const name of previous) this.logToolChange('removed', name)
      throw error
    }
    for (const name of previous) if (!next.has(name)) this.logToolChange('removed', name)
    for (const name of next.keys()) if (!previous.has(name)) this.logToolChange('mounted', name)
    this.syncResourcesAndPrompts()
    const capabilities = this.client.getServerCapabilities()
    const extensions = capabilities?.extensions as Record<string, unknown> | undefined
    if (Object.hasOwn(extensions ?? {}, 'io.modelcontextprotocol/skills')) {
      this.upstreamSkills ??= registerUpstreamSkills(this.ctx, this.client, serverNameFor(this.code), this.toolCallTimeoutMs)
      this.upstreamSkills.invalidate()
    } else {
      this.upstreamSkills?.dispose()
      this.upstreamSkills = undefined
    }
  }

  private syncResourcesAndPrompts(): void {
    const capabilities = this.client.getServerCapabilities()
    if (capabilities?.resources !== undefined && this.resourceRegistration === undefined) {
      this.resourceRegistration = this.ctx.mcpResources.register(serverNameFor(this.code), {
        request: async (request, execution) => {
          const options = { signal: execution.signal, timeout: this.toolCallTimeoutMs }
          switch (request.method) {
            case 'resources/list': return toJson(await this.client.listResources(
              request.cursor === undefined ? undefined : { cursor: request.cursor }, options))
            case 'resources/templates/list': return toJson(await this.client.listResourceTemplates(
              request.cursor === undefined ? undefined : { cursor: request.cursor }, options))
            case 'resources/read': return toJson(await this.client.readResource({ uri: request.uri }, options))
          }
        },
      })
    }
    if (capabilities?.prompts !== undefined && this.promptRegistrations.length === 0) {
      const server = serverNameFor(this.code)
      const output = { schema: { type: 'json' } as const,
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
      this.promptRegistrations.push(this.ctx.tools.register(defineTool({
        name: `mcp_prompt__${server}__list`,
        description: 'List prompt templates from this employee-authorized MCP server.',
        parameters: { cursor: { type: 'string', description: 'Continuation cursor.' } }, output,
        execute: async (args, execution) => toJson(await this.client.listPrompts(
          args.cursor === undefined ? undefined : { cursor: args.cursor },
          { signal: execution.signal, timeout: this.toolCallTimeoutMs })),
      })))
      this.promptRegistrations.push(this.ctx.tools.register(defineTool({
        name: `mcp_prompt__${server}__get`,
        description: 'Get a prompt template by name from this employee-authorized MCP server.',
        parameters: { name: { type: 'string', required: true, description: 'Prompt name.' },
          arguments: { type: 'object', additionalProperties: true, description: 'String prompt argument values.' } }, output,
        execute: async (args, execution) => {
          const values = args.arguments
          if (values !== undefined && Object.values(values).some(value => typeof value !== 'string')) {
            throw new Error('MCP prompt arguments must be strings')
          }
          return toJson(await this.client.getPrompt(
            { name: args.name, arguments: values as Record<string, string> | undefined },
            { signal: execution.signal, timeout: this.toolCallTimeoutMs }))
        },
      })))
    }
  }

  /** Withdraw tools before closing the transport. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [name, dispose] of this.registrations) {
      dispose()
      this.logToolChange('removed', name)
    }
    this.registrations.clear()
    this.resourceRegistration?.()
    this.resourceRegistration = undefined
    for (const dispose of this.promptRegistrations) dispose()
    this.promptRegistrations.length = 0
    this.upstreamSkills?.dispose()
    this.upstreamSkills = undefined
    await this.client.close()
  }

  private logToolChange(action: 'mounted' | 'removed', toolName: string): void {
    console.info('[enterprise-mcp-tool]', JSON.stringify({ action, code: this.code, toolName }))
  }

  private async fetchWithRefresh(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
    const request = { ...init, redirect: 'error' as const }
    const response = await fetch(input, request)
    if (response.status !== 401) return response
    const headers = new Headers(init?.headers)
    const sent = headers.get('Authorization')
    if (sent === null || !sent.startsWith('Bearer ')) return response
    const rejected = sent.slice('Bearer '.length)
    const replacement = await this.ctx.enterpriseAccount.refreshAccessToken(this.url, rejected, REQUIRED_SCOPES)
    if (replacement === undefined) {
      await this.ctx.enterpriseAccount.rejectAccessToken(rejected)
      return response
    }
    await response.body?.cancel()
    headers.set('Authorization', `Bearer ${replacement}`)
    const retry = await fetch(input, { ...request, headers })
    if (retry.status === 401) await this.ctx.enterpriseAccount.rejectAccessToken(replacement)
    return retry
  }
}

function validateDirectoryURL(value: string, allowLoopbackHttp: boolean): URL {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/mcp/connections') {
    throw new Error('enterprise MCP directoryUrl must be an HTTPS Admin directory or enabled loopback HTTP')
  }
  return url
}

function toolName(server: string, raw: string): string {
  const joined = `mcp__${server}__${raw}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, '_')
  if (normalized === joined && joined.length <= 64) return joined
  const hash = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new Error('employee MCP directory exceeds maxDirectoryBytes')
      chunks.push(value)
    }
  } finally {
    try { await reader.cancel() }
    catch (_error) { /* A settled body read remains authoritative during cleanup. */ }
    reader.releaseLock()
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(body)
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
