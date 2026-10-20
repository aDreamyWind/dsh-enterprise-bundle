/** Client-safe enterprise identity and login state. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one local enterprise sign-in attempt. */
export type EnterpriseSignInAttemptId = Branded<'EnterpriseSignInAttemptId'>

/** Stable failure categories suitable for localized UI copy. */
export type EnterpriseSignInErrorCode = 'network' | 'protocol' | 'expired' | 'storage'

/** Browser sign-in progress without authorization codes, tokens, or PKCE material. */
export interface EnterpriseSignInAttemptView {
  readonly id: EnterpriseSignInAttemptId
  readonly phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
  readonly authorizeUrl?: string
  readonly expiresAt?: number
  readonly errorCode?: EnterpriseSignInErrorCode
}

/** Display-safe identity claims accepted from the configured issuer. */
export interface EnterpriseAccountProfile {
  readonly subject: string
  readonly name: string | null
  readonly preferredUsername: string | null
  readonly email: string | null
  readonly picture: string | null
  readonly organizationId: string | null
  readonly organizationCode: string | null
}

/** Complete enterprise account state projected to browser clients. */
export interface EnterpriseAccountView {
  readonly status: 'signed-out' | 'signed-in'
  readonly profile: EnterpriseAccountProfile | null
  readonly attempt: EnterpriseSignInAttemptView | null
}
