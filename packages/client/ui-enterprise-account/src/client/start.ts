/** Bounded wait for the Host to acknowledge a browser sign-in request. */

/** The Host did not answer before the browser's configured sign-in deadline. */
export class EnterpriseStartTimeoutError extends Error {
  readonly code = 'start-timeout' as const

  constructor() { super('enterprise account sign-in request timed out') }
}

/**
 * Stop waiting for one Remote call without treating a later response as a fresh result.
 * @param request - pending Remote call.
 * @param timeoutMs - configured browser wait limit.
 * @returns the response received before the limit.
 */
export async function waitForStart<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([request, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new EnterpriseStartTimeoutError()) }, timeoutMs)
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
