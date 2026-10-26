/** Employee directory, bearer rotation and MCP tool lifecycle over real HTTP. */
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { EnterpriseAccount, type EnterpriseAccountView, type EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { EnterpriseMcpSupervisor, serverNameFor } from '../src/index.ts'

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
    const mcp = new McpServer({ name: 'employee-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
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
    expect(info).toHaveBeenCalledExactlyOnceWith('[enterprise-mcp-tool]',
      JSON.stringify({ action: 'mounted', code, toolName }))
    await supervisor.refresh()
    expect(info).toHaveBeenCalledTimes(1)
    rejectOldToken = true
    const result = await ctx.tools.execute({ name: toolName, callId: ToolCallId('employee-ping'),
      arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ content: [{ type: 'text', text: 'pong' }] })
    expect(account.refreshes).toBe(1)
    expect(seenTokens).toContain('Bearer employee-b')
    allowed = false
    await supervisor.refresh()
    expect(ctx.tools.get(toolName)).toBeUndefined()
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
