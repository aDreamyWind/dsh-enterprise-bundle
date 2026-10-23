// @vitest-environment jsdom
/** Enterprise login opens once from the initiating gesture and retains a blocked-popup fallback. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnterpriseAccountView, EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account/types'
import type {} from '../src/client/index.ts'
import { EnterpriseAccountSection, EnterpriseLoginGate, type EnterpriseAccountSnapshot } from '../src/client/EnterpriseAccount.tsx'
import { zh, type EnterpriseAccountKey } from '../src/client/locales.ts'
import { EnterpriseStartTimeoutError } from '../src/client/start.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const id = 'attempt-1' as EnterpriseSignInAttemptId
const signedOut: EnterpriseAccountView = { status: 'signed-out', profile: null, attempt: null }

function gate(view: EnterpriseAccountView, start = vi.fn(async () => signedOut)) {
  const snapshot: EnterpriseAccountSnapshot = { view, failed: false }
  return <EnterpriseLoginGate {...({} as GlobalStandardProps)}
    useAccount={selector => selector(snapshot)} start={start} cancel={vi.fn(async () => {})}
    signOut={vi.fn(async () => {})} t={key => key in zh ? zh[key as EnterpriseAccountKey] : key} />
}

it('keeps the idle gate content within the modal and renders its description once', () => {
  render(gate(signedOut))
  expect(screen.getAllByText(zh.gateDescription)).toHaveLength(1)
  const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/client/EnterpriseAccount.module.css'), 'utf8')
  const gateRule = /^\.gate\s*\{([^}]*)\}/m.exec(stylesheet)?.[1] ?? ''
  expect(gateRule).toMatch(/box-sizing:\s*border-box;/)
  expect(gateRule).toMatch(/width:\s*100%;/)
  expect(gateRule).not.toMatch(/100vw|420px/)
})

it('opens a placeholder on the first click and navigates it as soon as the authorization URL arrives', async () => {
  const replace = vi.fn()
  const popup = { closed: false, opener: window, location: { replace }, close: vi.fn() } as object as Window
  const open = vi.spyOn(window, 'open').mockReturnValue(popup)
  const start = vi.fn(async () => ({ ...signedOut, attempt: { id, phase: 'initializing' as const } }))
  const rendered = render(gate(signedOut, start))
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  expect(open).toHaveBeenCalledExactlyOnceWith('about:blank', '_blank')
  expect(start).toHaveBeenCalledOnce()
  const authorizeUrl = 'https://admin.example.test/api/v1/oauth2/authorize?state=state'
  rendered.rerender(gate({ ...signedOut, attempt: { id, phase: 'waiting-browser', authorizeUrl } }, start))
  await waitFor(() => { expect(replace).toHaveBeenCalledExactlyOnceWith(authorizeUrl) })
  expect(screen.queryByRole('button', { name: zh.open })).toBeNull()
})

it('shows the second button only when the browser blocks the first-click popup', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const start = vi.fn(async () => ({ ...signedOut, attempt: { id, phase: 'initializing' as const } }))
  const rendered = render(gate(signedOut, start))
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  const authorizeUrl = 'https://admin.example.test/api/v1/oauth2/authorize?state=state'
  rendered.rerender(gate({ ...signedOut, attempt: { id, phase: 'waiting-browser', authorizeUrl } }, start))
  const fallback = await screen.findByRole('button', { name: zh.open })
  fireEvent.click(fallback)
  expect(open).toHaveBeenLastCalledWith(authorizeUrl, '_blank', 'noopener,noreferrer')
})

it('shows Harness Admin organization claims in the account section', () => {
  const view: EnterpriseAccountView = { status: 'signed-in', attempt: null, profile: {
    subject: 'user-1', name: null, preferredUsername: 'tester', email: 'user@example.test', picture: null,
    organizationId: 'org-1', organizationCode: 'engineering',
  } }
  const snapshot: EnterpriseAccountSnapshot = { view, failed: false }
  render(<EnterpriseAccountSection {...({} as GlobalStandardProps)}
    close={vi.fn()}
    useAccount={selector => selector(snapshot)} start={vi.fn(async () => view)} cancel={vi.fn(async () => {})}
    signOut={vi.fn(async () => {})} t={key => key in zh ? zh[key as EnterpriseAccountKey] : key} />)
  expect(screen.getByText('tester')).toBeTruthy()
  expect(screen.getByText('engineering')).toBeTruthy()
})

it('offers a new consent attempt while keeping the signed-in settings visible', async () => {
  const replace = vi.fn()
  const popup = { closed: false, opener: window, location: { replace }, close: vi.fn() } as object as Window
  const open = vi.spyOn(window, 'open').mockReturnValue(popup)
  const base: EnterpriseAccountView = { status: 'signed-in', reauthorizationRequired: true, attempt: null,
    profile: { subject: 'user-1', name: null, preferredUsername: 'tester', email: null, picture: null,
      organizationId: 'org-1', organizationCode: 'engineering' } }
  const start = vi.fn(async () => ({ ...base, attempt: { id, phase: 'initializing' as const } }))
  const section = (view: EnterpriseAccountView) => <EnterpriseAccountSection {...({} as GlobalStandardProps)}
    close={vi.fn()} useAccount={selector => selector({ view, failed: false })} start={start}
    cancel={vi.fn(async () => {})} signOut={vi.fn(async () => {})}
    t={key => key in zh ? zh[key as EnterpriseAccountKey] : key} />
  const rendered = render(section(base))
  expect(screen.getByText('engineering')).toBeTruthy()
  expect(screen.getByText(zh.reauthorizeDescription)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.reauthorize }))
  expect(open).toHaveBeenCalledExactlyOnceWith('about:blank', '_blank')
  expect(start).toHaveBeenCalledOnce()
  const authorizeUrl = 'https://admin.example.test/api/v1/oauth2/authorize?state=consent'
  rendered.rerender(section({ ...base, attempt: { id, phase: 'waiting-browser', authorizeUrl } }))
  await waitFor(() => { expect(replace).toHaveBeenCalledExactlyOnceWith(authorizeUrl) })
})

it('closes a stalled consent popup and ignores the old attempt when a retry starts', async () => {
  const stale = Promise.withResolvers<EnterpriseAccountView>()
  const nextId = 'attempt-2' as EnterpriseSignInAttemptId
  const base: EnterpriseAccountView = { status: 'signed-in', reauthorizationRequired: true, attempt: null,
    profile: { subject: 'user-1', name: null, preferredUsername: 'tester', email: null, picture: null,
      organizationId: 'org-1', organizationCode: 'engineering' } }
  const start = vi.fn<() => Promise<EnterpriseAccountView>>()
    .mockImplementationOnce(() => stale.promise)
    .mockImplementationOnce(async () => ({ ...base, attempt: { id: nextId, phase: 'initializing' } }))
  const replace = vi.fn()
  const firstPopup = { closed: false, opener: window, location: { replace }, close: vi.fn() } as object as Window
  const open = vi.spyOn(window, 'open').mockReturnValueOnce(firstPopup).mockReturnValue(null)
  const section = (view: EnterpriseAccountView) => <EnterpriseAccountSection {...({} as GlobalStandardProps)}
    close={vi.fn()} useAccount={selector => selector({ view, failed: false })} start={start}
    cancel={vi.fn(async () => {})} signOut={vi.fn(async () => {})}
    t={key => key in zh ? zh[key as EnterpriseAccountKey] : key} />
  const rendered = render(section(base))
  fireEvent.click(screen.getByRole('button', { name: zh.reauthorize }))
  stale.reject(new EnterpriseStartTimeoutError())
  await waitFor(() => { expect(firstPopup.close).toHaveBeenCalledOnce() })
  expect(screen.getByRole('alert').textContent).toBe(zh.startTimedOut)
  rendered.rerender(section({ ...base, attempt: { id, phase: 'waiting-browser', authorizeUrl: 'https://admin.example.test/old' } }))
  expect(replace).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.reauthorize }))
  await waitFor(() => { expect(start).toHaveBeenCalledTimes(2) })
  rendered.rerender(section({ ...base, attempt: { id, phase: 'waiting-browser', authorizeUrl: 'https://admin.example.test/old' } }))
  expect(replace).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: zh.open })).toBeNull()
  rendered.rerender(section({ ...base, attempt: { id: nextId, phase: 'waiting-browser', authorizeUrl: 'https://admin.example.test/new' } }))
  const fallback = await screen.findByRole('button', { name: zh.open })
  fireEvent.click(fallback)
  expect(open).toHaveBeenLastCalledWith('https://admin.example.test/new', '_blank', 'noopener,noreferrer')
})
