/** Employee-scoped enterprise Skills provider and authenticated Skill file resources. */
import type { Context } from '@deepseek-ai/cordis'
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const SCOPES = ['mcp.invoke'] as const
const publishedSchema = z.object({
  asset: z.object({ name: z.string(), description: z.string() }),
  version: z.object({ id: z.string(), frontmatter: z.record(z.string(), z.unknown()),
    files: z.array(z.object({ path: z.string(), digest: z.string() })).optional() }),
})
const directorySchema = z.object({ data: z.array(publishedSchema) })
type PublishedSkill = z.infer<typeof publishedSchema>

interface Policy { requestTimeoutMs: number; maxDirectoryBytes: number; toolCallTimeoutMs: number }

export function registerEnterpriseSkills(ctx: Context, directoryUrl: URL, policy: Policy):
    { invalidate(): void; dispose(): void } {
  const skillsURL = new URL('/api/v1/skills/directory', directoryUrl)
  const gatewayURL = new URL('/enterprise-skills/mcp', directoryUrl)
  let control: SkillProviderControl | undefined
  const watch = new AbortController()
  const disposeProvider = ctx.skills.registerProvider(owner => {
    control = owner
    return {
      name: 'enterprise-admin',
      list: async options => {
        try {
          const published = await readDirectory(ctx, skillsURL, policy, options.signal)
          return published.filter(item => isSkillName(item.asset.name)).map(item => candidate(item))
        } catch (error) {
          if (!options.signal?.aborted && !owner.signal.aborted) {
            ctx.logger.warn(`enterprise Skill directory unavailable: ${String(error)}`)
          }
          return { candidates: [], complete: false }
        }
      },
      get: async (entry, options): Promise<SkillDefinition | undefined> => {
        try {
          const locator = entry.locator as { name: string; versionId: string }
          const published = await readDirectory(ctx, skillsURL, policy, options.signal)
          const current = published.find(item => item.asset.name === locator.name && item.version.id === locator.versionId)
          if (current === undefined) {
            return undefined
          }
          const url = new URL(`/api/v1/skills/files/${encodeURIComponent(locator.name)}/SKILL.md`, directoryUrl)
          const response = await employeeFetch(ctx, url, options.signal, policy.requestTimeoutMs)
          if (response.status === 404) { await response.body?.cancel(); return undefined }
          if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
          const digest = current.version.files?.find(file => file.path === 'SKILL.md')?.digest
          if (digest !== undefined && response.headers.get('ETag') !== `"${digest}"`) {
            await response.body?.cancel()
            return undefined
          }
          const markdown = await readBounded(response, policy.maxDirectoryBytes)
          return { name: entry.name, description: entry.description, invocation: entry.invocation,
            source: entry.source, provider: entry.provider,
            ...entry.resourceBase === undefined ? {} : { resourceBase: entry.resourceBase },
            ...entry.metadata === undefined ? {} : { metadata: entry.metadata },
            content: stripFrontmatter(markdown) }
        } catch (error) {
          if (!options.signal?.aborted && !owner.signal.aborted) {
            ctx.logger.warn(`enterprise Skill ${entry.name} unavailable: ${String(error)}`)
          }
          return undefined
        }
      },
    }
  })
  const disposeResources = ctx.mcpResources.register('enterprise-skills', {
    request: async (request, execution) => {
      const client = new Client({ name: 'dsh-enterprise-skills', version: '0.2.1' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } })
      const transport = new StreamableHTTPClientTransport(gatewayURL, {
        authProvider: { token: async () => {
          const token = await ctx.enterpriseAccount.resolveAccessToken(gatewayURL.href, SCOPES)
          if (token === undefined) throw new Error('employee Skill login is unavailable')
          return token
        } },
        fetch: (input, init) => fetchWithRefresh(ctx, gatewayURL, input, init),
      })
      try {
        await client.connect(transport)
        const options = { signal: execution.signal, timeout: policy.toolCallTimeoutMs }
        switch (request.method) {
          case 'resources/list': return toJson(await client.listResources(
            request.cursor === undefined ? undefined : { cursor: request.cursor }, options))
          case 'resources/templates/list': return toJson(await client.listResourceTemplates(
            request.cursor === undefined ? undefined : { cursor: request.cursor }, options))
          case 'resources/read': return toJson(await client.readResource({ uri: request.uri }, options))
        }
      } finally { await client.close() }
    },
  })
  void (async () => {
    for await (const _view of ctx.enterpriseAccount.watch(watch.signal)) {
      if (watch.signal.aborted) break
      control?.invalidate()
    }
  })().catch(error => {
    if (!watch.signal.aborted) ctx.logger.warn(`enterprise Skill account watch failed: ${String(error)}`)
  })
  return { invalidate: () => control?.invalidate(), dispose: () => {
    watch.abort()
    disposeResources()
    disposeProvider()
  } }
}

function candidate(item: PublishedSkill): SkillCandidate {
  const name = item.asset.name
  const metadata = item.version.frontmatter
  const description = typeof metadata.description === 'string' ? metadata.description : item.asset.description
  return { name, description, invocation: { modelInvocable: true, userInvocable: true },
    source: 'enterprise', provider: 'enterprise-admin', rank: 350,
    locator: { name, versionId: item.version.id }, metadata,
    resourceBase: { kind: 'opaque', description: `Use read_mcp_resource with server "enterprise-skills" and URI "skill://enterprise/${name}/<file>" to read referenced files.` } }
}

async function readDirectory(ctx: Context, url: URL, policy: Policy, signal?: AbortSignal): Promise<PublishedSkill[]> {
  const response = await employeeFetch(ctx, url, signal, policy.requestTimeoutMs)
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
  return directorySchema.parse(JSON.parse(await readBounded(response, policy.maxDirectoryBytes))).data
}

async function employeeFetch(ctx: Context, url: URL, signal: AbortSignal | undefined, timeout: number): Promise<Response> {
  const token = await ctx.enterpriseAccount.resolveAccessToken(url.href, SCOPES)
  if (token === undefined) throw new Error('employee Skill login is unavailable')
  const combined = signal === undefined ? AbortSignal.timeout(timeout) : AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  return await fetchWithRefresh(ctx, url, url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store', redirect: 'error', signal: combined })
}

async function fetchWithRefresh(ctx: Context, url: URL, input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  const request = { ...init, redirect: 'error' as const }
  const response = await fetch(input, request)
  if (response.status !== 401) return response
  const headers = new Headers(init?.headers)
  const sent = headers.get('Authorization')
  if (!sent?.startsWith('Bearer ')) return response
  const rejected = sent.slice(7)
  const replacement = await ctx.enterpriseAccount.refreshAccessToken(url.href, rejected, SCOPES)
  if (replacement === undefined) {
    await ctx.enterpriseAccount.rejectAccessToken(rejected)
    return response
  }
  await response.body?.cancel()
  headers.set('Authorization', `Bearer ${replacement}`)
  const retry = await fetch(input, { ...request, headers })
  if (retry.status === 401) await ctx.enterpriseAccount.rejectAccessToken(replacement)
  return retry
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('enterprise Skill response exceeds the configured limit')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(body)
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
