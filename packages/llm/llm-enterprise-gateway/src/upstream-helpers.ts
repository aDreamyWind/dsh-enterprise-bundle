/** Build-time reuse of upstream helpers; the enterprise artifact inlines these source entries. */
import type { Context } from '@deepseek-ai/cordis'
import type { PiAiAdapterOptions, PiAiProviderProfile, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { authContextFrom as upstreamAuthContext, credentialStoreFrom as upstreamCredentialStore } from '@deepseek-ai/dsh-llm-pi-ai/src/auth.ts'
import { resolveProfiles as upstreamResolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'

/**
 * Resolve gateway model profiles with the matching upstream implementation.
 * @param providers - explicit gateway routes; omission resolves to an empty directory.
 * @returns validated provider profiles including upstream compatibility defaults.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, PiAiProviderProfile>> | undefined,
): Map<string, ResolvedPiAiProviderProfile> {
  return upstreamResolveProfiles(providers)
}

/**
 * Adapt the Host credential service without copying its upstream implementation.
 * @param ctx - Host carrying the optional credential service.
 * @returns the upstream credential adapter owned by this enterprise instance.
 */
export function credentialStoreFrom(ctx: Context): PiAiAdapterOptions['auth']['credentials'] {
  return upstreamCredentialStore(ctx)
}

/**
 * Supply upstream auth lookups for the matching PiAi adapter.
 * @param ctx - Host carrying credential and launch-environment services.
 * @returns the upstream ambient authentication adapter.
 */
export function authContextFrom(ctx: Context): PiAiAdapterOptions['auth']['authContext'] {
  return upstreamAuthContext(ctx)
}
