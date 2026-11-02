/** Employee directory, bearer rotation and MCP tool lifecycle over real HTTP. */
import { createServer } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { EnterpriseAccount, type EnterpriseAccountView, type EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import McpResourceRuntime from '@deepseek-ai/dsh-mcp-resources'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { EnterpriseMcpSupervisor, serverNameFor } from '../src/index.ts'
import { registerEnterpriseSkills } from '../src/skills.ts'

class Account extends EnterpriseAccount {
  token = 'employee-a'
  refreshes = 0
  signedIn = true
  reauthorizationRequired = false
  origin = ''

  override getState(): Promise<EnterpriseAccountView> {
    return Promise.resolve({ status: this.signedIn ? 'signed-in' : 'signed-out', profile: null, attempt: null,
      reauthorizationRequired: this.reauthorizationRequired })
  }
  override startSignIn(): Promise<EnterpriseAccountView> { return this.getState() }
  override cancelSignIn(_id: EnterpriseSignInAttemptId): Promise<EnterpriseAccountView> { return this.getState() }
  override signOut(): Promise<EnterpriseAccountView> { this.signedIn = false; return this.getState() }
  override async *watch(signal: AbortSignal): AsyncIterable<EnterpriseAccountView> {
    yield await this.getState()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  override resolveAccessToken(url: string, scopes: readonly string[]): Promise<string | undefined> {
    return Promise.resolve(this.signedIn && !this.reauthorizationRequired && new URL(url).origin === this.origin
      && scopes.includes('mcp.invoke') ? this.token : undefined)
  }
  override refreshAccessToken(_url: string, rejected: string): Promise<string | undefined> {
    if (rejected === this.token) { this.refreshes++; this.token = 'employee-b' }
    return Promise.resolve(this.token)
  }
  override rejectAccessToken(token: string): Promise<void> {
    if (token === this.token) this.signedIn = false
    return Promise.resolve()
  }
}

it('loads employee tools, refreshes the exact rejected bearer and removes revoked tools', async () => {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'employee-fixture', version: '1.0.0' },
      { capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/skills': {} } } })
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    mcp.registerResource('employee-memo', 'memo://employee', { mimeType: 'text/plain' }, async uri => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'employee-only memo' }],
    }))
    mcp.registerPrompt('plan', { description: 'Plan a task.', argsSchema: z.object({ topic: z.string() }) },
      ({ topic }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Plan ${topic}` } }] }))
    const skillURI = 'skill://fixture/upstream-skill/SKILL.md'
    mcp.registerResource('upstream-skill', skillURI, { mimeType: 'text/markdown' }, async uri => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '---\nname: upstream-skill\n---\n# Upstream skill\n' }],
    }))
    const skillEntry = { uri: skillURI, frontmatter: { name: 'upstream-skill', description: 'Upstream Skill' }, resources: [] }
    mcp.server.setRequestHandler('skills/list', { params: z.object({ cursor: z.string().optional() }),
      result: z.object({ skills: z.array(z.unknown()) }) }, () => ({ skills: [skillEntry] }))
    mcp.server.setRequestHandler('skills/get', { params: z.object({ uri: z.string() }),
      result: z.object({ skill: z.unknown() }) }, () => ({ skill: skillEntry }))
    return mcp
  })
  const mcpHandler = toNodeHandler(handler)
  let origin = ''
  let allowed = true
  let rejectOldToken = false
  const seenTokens: string[] = []
  const server = createServer((request, response) => { void (async () => {
    const token = request.headers.authorization ?? ''
    if (request.url === '/api/v1/mcp/connections') {
      if (!token.startsWith('Bearer employee-')) { response.writeHead(401).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: allowed
        ? [{ code: 'mcp_c_' + 'a'.repeat(32), name: 'Employee MCP', serviceName: 'Fixture',
          url: `${origin}/mcp/mcp_c_${'a'.repeat(32)}`, transport: 'streamable_http' }] : [] }))
      return
    }
    if (request.url?.startsWith('/mcp/')) {
      seenTokens.push(token)
      if (rejectOldToken && token === 'Bearer employee-a') { response.writeHead(401).end(); return }
      await mcpHandler(request as NodeIncomingMessageLike, response)
      return
    }
    response.writeHead(404).end()
  })().catch(() => response.writeHead(500).end()) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind')
  origin = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  let supervisor: EnterpriseMcpSupervisor | undefined
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(McpResourceRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(Account)
    const account = ctx.enterpriseAccount as Account
    account.origin = origin
    supervisor = new EnterpriseMcpSupervisor(ctx, new URL(`${origin}/api/v1/mcp/connections`), {
      directoryUrl: `${origin}/api/v1/mcp/connections`, allowLoopbackHttp: true,
      requestTimeoutMs: 5_000, maxDirectoryBytes: 65_536, toolCallTimeoutMs: 5_000,
    })
    await supervisor.refresh()
    const code = 'mcp_c_' + 'a'.repeat(32)
    const toolName = `mcp__${serverNameFor(code)}__ping`
    expect(serverNameFor(code)).toHaveLength(32)
    expect(ctx.tools.get(toolName)).toBeDefined()
    expect(ctx.tools.get('read_mcp_resource')).toBeDefined()
    const promptList = `mcp_prompt__${serverNameFor(code)}__list`
    const promptGet = `mcp_prompt__${serverNameFor(code)}__get`
    expect(ctx.tools.get(promptList)).toBeDefined()
    expect(ctx.tools.get(promptGet)).toBeDefined()
    expect(await ctx.skills.list()).toMatchObject([{ name: 'upstream-skill' }])
    expect((await ctx.skills.get('upstream-skill'))?.content).toBe('# Upstream skill\n')
    expect(info).toHaveBeenCalledExactlyOnceWith('[enterprise-mcp-tool]',
      JSON.stringify({ action: 'mounted', code, toolName }))
    const agent = { id: SessionId('enterprise-admission') } as Agent
    await ctx.plugin({ inject: ['tools'], apply(inner: Context) { createScope(inner, agent) } })
    const toolSet = await ctx.tools.resolve({
      agent, modelSelection: { provider: 'enterprise', model: 'fixture' }, signal: new AbortController().signal,
    })
    try {
      await supervisor.refresh()
      expect(ctx.tools.schemas(agent, toolSet).some(tool => tool.name === toolName)).toBe(true)
      const admitted = await executeModelToolFixture(ctx, {
        agent, toolSet, name: toolName, callId: ToolCallId('admitted-ping'), arguments: {},
        signal: new AbortController().signal,
      })
      expect(admitted.isError).toBe(false)
      expect(admitted.value).toMatchObject({ content: [{ type: 'text', text: 'pong' }] })
    } finally { toolSet.dispose() }
    expect(info).toHaveBeenCalledTimes(1)
    rejectOldToken = true
    const result = await executeModelToolFixture(ctx, { name: toolName, callId: ToolCallId('employee-ping'),
      arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ content: [{ type: 'text', text: 'pong' }] })
    expect(account.refreshes).toBe(1)
    expect(seenTokens).toContain('Bearer employee-b')
    const resource = await executeModelToolFixture(ctx, { name: 'read_mcp_resource', callId: ToolCallId('employee-resource'),
      arguments: { server: serverNameFor(code), uri: 'memo://employee' }, signal: new AbortController().signal })
    expect(resource.isError).toBe(false)
    expect(resource.value).toMatchObject({ contents: [{ text: 'employee-only memo' }] })
    const prompts = await executeModelToolFixture(ctx, { name: promptList, callId: ToolCallId('employee-prompts'),
      arguments: {}, signal: new AbortController().signal })
    expect(prompts.isError).toBe(false)
    expect(prompts.value).toMatchObject({ prompts: [{ name: 'plan' }] })
    const prompt = await executeModelToolFixture(ctx, { name: promptGet, callId: ToolCallId('employee-prompt'),
      arguments: { name: 'plan', arguments: { topic: 'lunch' } }, signal: new AbortController().signal })
    expect(prompt.isError).toBe(false)
    expect(prompt.value).toMatchObject({ messages: [{ content: { text: 'Plan lunch' } }] })
    allowed = false
    await supervisor.refresh()
    expect(ctx.tools.get(toolName)).toBeUndefined()
    expect(ctx.tools.get('read_mcp_resource')).toBeUndefined()
    expect(ctx.tools.get(promptList)).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
    expect(info).toHaveBeenLastCalledWith('[enterprise-mcp-tool]',
      JSON.stringify({ action: 'removed', code, toolName }))
    allowed = true
    await supervisor.refresh()
    expect(ctx.tools.get(toolName)).toBeDefined()
    expect(info).toHaveBeenLastCalledWith('[enterprise-mcp-tool]',
      JSON.stringify({ action: 'mounted', code, toolName }))
    expect(info).toHaveBeenCalledTimes(3)
  } finally {
    await supervisor?.close()
    info.mockRestore()
    await ctx.fiber.dispose()
    await handler.close()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
})

it('loads a published employee Skill and withdraws it after publication or grant removal', async () => {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'skills-fixture', version: '1.0.0' })
    mcp.registerResource('guide', 'skill://enterprise/example-skill/guide.md', { mimeType: 'text/markdown' },
      async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Employee guide' }] }))
    return mcp
  })
  const mcpHandler = toNodeHandler(handler)
  let published = true
  let origin = ''
  const server = createServer((request, response) => { void (async () => {
    if (request.headers.authorization !== 'Bearer employee-a') { response.writeHead(401).end(); return }
    if (request.url === '/api/v1/skills/directory') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: published ? [{
        asset: { name: 'example-skill', description: 'Employee example' },
        version: { id: 'version-1', frontmatter: { name: 'example-skill', description: 'Employee example' } },
      }] : [] }))
      return
    }
    if (request.url === '/api/v1/skills/files/example-skill/SKILL.md') {
      response.writeHead(published ? 200 : 404, { 'content-type': 'text/markdown' })
        .end(published ? '---\nname: example-skill\ndescription: Employee example\n---\n# Enterprise skill\n' : '')
      return
    }
    if (request.url === '/enterprise-skills/mcp') { await mcpHandler(request as NodeIncomingMessageLike, response); return }
    response.writeHead(404).end()
  })().catch(() => response.writeHead(500).end()) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind')
  origin = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  let bridge: ReturnType<typeof registerEnterpriseSkills> | undefined
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(McpResourceRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(Account)
    ;(ctx.enterpriseAccount as Account).origin = origin
    bridge = registerEnterpriseSkills(ctx, new URL(`${origin}/api/v1/mcp/connections`),
      { requestTimeoutMs: 5_000, maxDirectoryBytes: 65_536, toolCallTimeoutMs: 5_000 })
    expect(await ctx.skills.list()).toMatchObject([{ name: 'example-skill', provider: 'enterprise-admin' }])
    expect((await ctx.skills.get('example-skill'))?.content).toBe('# Enterprise skill\n')
    const resource = await executeModelToolFixture(ctx, { name: 'read_mcp_resource', callId: ToolCallId('skill-resource'),
      arguments: { server: 'enterprise-skills', uri: 'skill://enterprise/example-skill/guide.md' },
      signal: new AbortController().signal })
    expect(resource.isError).toBe(false)
    expect(resource.value).toMatchObject({ contents: [{ text: '# Employee guide' }] })
    published = false
    bridge.invalidate()
    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.get('example-skill')).toBeUndefined()
  } finally {
    bridge?.dispose()
    await ctx.fiber.dispose()
    await handler.close()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
})
