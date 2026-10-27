/** Translate one authorized upstream MCP Skills extension into Host Skills. */
import type { Context } from '@deepseek-ai/cordis'
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { Client } from '@modelcontextprotocol/client'
import { z } from 'zod'

const entrySchema = z.object({ uri: z.string(), frontmatter: z.record(z.string(), z.unknown()),
  resources: z.unknown().optional() })
const listSchema = z.object({ skills: z.array(entrySchema), nextCursor: z.string().optional() })
const getSchema = z.object({ skill: entrySchema })

export function registerUpstreamSkills(ctx: Context, client: Client, server: string, timeout: number):
    { invalidate(): void; dispose(): void } {
  let control: SkillProviderControl | undefined
  const provider = `enterprise-mcp-${server}`
  const dispose = ctx.skills.registerProvider(owner => {
    control = owner
    return {
      name: provider,
      list: async options => {
        try {
          const skills: SkillCandidate[] = []
          const seen = new Set<string>()
          let cursor: string | undefined
          for (let page = 0; page < 20; page += 1) {
            const result = await client.request({ method: 'skills/list',
              params: cursor === undefined ? {} : { cursor } }, listSchema,
            { ...options.signal === undefined ? {} : { signal: options.signal }, timeout })
            for (const entry of result.skills) {
              const name = skillName(entry.uri, entry.frontmatter)
              if (name === undefined || seen.has(name)) continue
              seen.add(name)
              const description = typeof entry.frontmatter.description === 'string'
                ? entry.frontmatter.description : `MCP Skill from ${server}`
              skills.push({ name, description, invocation: { modelInvocable: true, userInvocable: true },
                source: 'enterprise-mcp', provider, rank: 360, locator: { uri: entry.uri },
                metadata: entry.frontmatter,
                resourceBase: { kind: 'opaque', description: `Read related files with read_mcp_resource using server "${server}" and the listed resource URI.` } })
            }
            if (result.nextCursor === undefined) return skills
            if (result.nextCursor === cursor) throw new Error('upstream Skill pagination did not advance')
            cursor = result.nextCursor
          }
          throw new Error('upstream Skill pagination exceeds 20 pages')
        } catch (error) {
          if (!options.signal?.aborted && !owner.signal.aborted) {
            ctx.logger.warn(`upstream MCP Skills unavailable for ${server}: ${String(error)}`)
          }
          return { candidates: [], complete: false }
        }
      },
      get: async (candidate, options): Promise<SkillDefinition | undefined> => {
        try {
          const uri = (candidate.locator as { uri: string }).uri
          const result = await client.request({ method: 'skills/get', params: { uri } }, getSchema,
            { ...options.signal === undefined ? {} : { signal: options.signal }, timeout })
          if (result.skill.uri !== uri || skillName(uri, result.skill.frontmatter) !== candidate.name) return undefined
          const resource = await client.readResource({ uri },
            { ...options.signal === undefined ? {} : { signal: options.signal }, timeout })
          const content = resource.contents.find(item => item.uri === uri && 'text' in item)
          const markdown = content !== undefined && 'text' in content ? content.text : undefined
          if (markdown === undefined) return undefined
          return { name: candidate.name, description: candidate.description, invocation: candidate.invocation,
            source: candidate.source, provider: candidate.provider,
            ...candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase },
            metadata: result.skill.frontmatter, content: stripFrontmatter(markdown) }
        } catch (error) {
          if (!options.signal?.aborted && !owner.signal.aborted) {
            ctx.logger.warn(`upstream MCP Skill ${candidate.name} unavailable: ${String(error)}`)
          }
          return undefined
        }
      },
    }
  })
  return { invalidate: () => control?.invalidate(), dispose }
}

function skillName(uri: string, frontmatter: Record<string, unknown>): string | undefined {
  const claimed = frontmatter.name
  if (typeof claimed === 'string' && isSkillName(claimed)) return claimed
  try {
    const parsed = new URL(uri)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const name = parts.at(-1) === 'SKILL.md' ? parts.at(-2) : parts.at(-1)
    return name !== undefined && isSkillName(name) ? name : undefined
  } catch (_error) { return undefined }
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')
}
