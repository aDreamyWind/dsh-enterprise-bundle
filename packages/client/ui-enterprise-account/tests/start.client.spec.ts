/** A stalled Remote sign-in response has a finite browser wait. */
import { afterEach, expect, it, vi } from 'vitest'
import { EnterpriseStartTimeoutError, waitForStart } from '../src/client/start.ts'

afterEach(() => { vi.useRealTimers() })

it('times out a pending response and accepts a later independent retry', async () => {
  vi.useFakeTimers()
  const stale = Promise.withResolvers<string>()
  const first = waitForStart(stale.promise, 100)
  const firstFailure = expect(first).rejects.toBeInstanceOf(EnterpriseStartTimeoutError)
  await vi.advanceTimersByTimeAsync(100)
  await firstFailure
  stale.resolve('old authorization')
  await expect(waitForStart(Promise.resolve('new authorization'), 100)).resolves.toBe('new authorization')
  expect(vi.getTimerCount()).toBe(0)
})
