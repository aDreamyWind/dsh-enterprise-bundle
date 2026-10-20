/** Mandatory login gate and enterprise identity settings surface. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnterpriseAccountView, EnterpriseSignInAttemptId } from '@deepseek-ai/dsh-enterprise-account/types'
import type { EnterpriseAccountKey } from './locales.ts'
import css from './EnterpriseAccount.module.css'

/** Browser-owned account state layered over the Host snapshot stream. */
export interface EnterpriseAccountSnapshot {
  readonly view: EnterpriseAccountView | undefined
  readonly failed: boolean
}

/** Credential-free operations shared by the login gate and settings page. */
export interface EnterpriseAccountInjected {
  hooks: { account: HostObservable<EnterpriseAccountSnapshot> }
  start(): Promise<void>
  cancel(id: EnterpriseSignInAttemptId): Promise<void>
  signOut(): Promise<void>
}

type Face = PropsLocale<'enterprise.account'> & InjectFace<EnterpriseAccountInjected>

/**
 * Block the application until the Host reports a valid enterprise identity.
 * @param props - account state, localized copy, and login actions.
 * @returns a mandatory modal while signed out, or nothing after login.
 */
export function EnterpriseLoginGate({ useAccount, start, cancel, t }: PropsRuntime<'shell.overlay'> & Face) {
  const account = useAccount(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [popupBlocked, setPopupBlocked] = useState(false)
  const pendingWindow = useRef<Window | null>(null)
  const openedAttempt = useRef<string | null>(null)
  const attempt = account.view?.attempt
  const authorizeUrl = attempt?.phase === 'waiting-browser' ? attempt.authorizeUrl : undefined
  useEffect(() => {
    if (account.view?.status === 'signed-in') {
      pendingWindow.current?.close()
      pendingWindow.current = null
      return
    }
    if (authorizeUrl === undefined || attempt === null || attempt === undefined
      || openedAttempt.current === attempt.id) return
    openedAttempt.current = attempt.id
    const popup = pendingWindow.current
    pendingWindow.current = null
    if (popup !== null && !popup.closed) {
      popup.opener = null
      popup.location.replace(authorizeUrl)
      return
    }
    if (window.location.protocol === 'dsh:') {
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
      return
    }
    setPopupBlocked(true)
  }, [account.view?.status, attempt, authorizeUrl])
  if (account.view?.status === 'signed-in') return null
  const active = attempt !== null && attempt !== undefined
    && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(attempt.phase)
  const error = failed || account.failed || attempt?.phase === 'failed' || attempt?.phase === 'expired'
  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setFailed(false)
    try { await operation(); return true } catch (_error) { setFailed(true); return false } finally { setBusy(false) }
  }
  const begin = (): void => {
    setPopupBlocked(false)
    openedAttempt.current = null
    const popup = window.location.protocol === 'dsh:' ? null : window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    else if (window.location.protocol !== 'dsh:') setPopupBlocked(true)
    pendingWindow.current = popup
    void run(start).then((started) => {
      if (started) return
      pendingWindow.current?.close()
      pendingWindow.current = null
    })
  }
  const status: EnterpriseAccountKey | null = account.view === undefined ? 'loading'
    : attempt?.phase === 'expired' ? 'expired'
      : error ? account.failed ? 'streamFailed' : 'failed'
        : attempt?.phase === 'initializing' ? 'initializing'
          : attempt?.phase === 'waiting-browser' ? 'waiting'
            : attempt?.phase === 'exchanging' || attempt?.phase === 'committing' ? 'completing'
              : null
  return <Modal open headless title={t('gateTitle')} onClose={() => {}} className={css.dialog as string}>
    <div className={css.gate}>
      <div className={css.header}>
        <h2 className={css.title}>{t('gateTitle')}</h2>
        <p className={css.description}>{t('gateDescription')}</p>
      </div>
      {status !== null && <p className={css.status} role="status">{t(status)}</p>}
      <div className={css.actions}>
        {active && attempt.phase !== 'committing' && <Button variant="outline" className={css.action} disabled={busy}
          onClick={() => { void run(() => cancel(attempt.id)) }}>{t('cancel')}</Button>}
        {popupBlocked && authorizeUrl !== undefined
          ? <Button variant="primary" className={css.action}
            onClick={() => { window.open(authorizeUrl, '_blank', 'noopener,noreferrer') }}>{t('open')}</Button>
          : <Button variant="primary" className={css.action} disabled={busy || active || account.view === undefined}
            onClick={begin}>
            {busy || active ? <IconLoadingOutlineRegular className={css.spinner} /> : t(error ? 'retry' : 'start')}
          </Button>}
      </div>
    </div>
  </Modal>
}

/**
 * Show the current enterprise identity and locally authoritative sign-out action.
 * @param props - account state, localized copy, and sign-out action.
 * @returns the enterprise account settings section.
 */
export function EnterpriseAccountSection({ useAccount, signOut, t }: PropsRuntime<'settings.section'> & Face) {
  const account = useAccount(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const profile = account.view?.profile
  const leave = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try { await signOut() } catch (_error) { setFailed(true) } finally { setBusy(false) }
  }
  return <section className={css.section} aria-label={t('nav')}>
    <div className={css.card}>
      <div className={css.row}><span className={css.label}>{t('identity')}</span>
        <span className={css.value}>{profile?.name ?? profile?.preferredUsername ?? profile?.email
          ?? profile?.subject ?? t('signedIn')}</span></div>
      <div className={css.row}><span className={css.label}>{t('organization')}</span>
        <span className={css.value}>{profile?.organizationCode ?? profile?.organizationId ?? '—'}</span></div>
    </div>
    {failed && <p className={css.status} role="alert">{t('failed')}</p>}
    <div className={css.actions}><Button variant="outline" className={css.action} disabled={busy}
      onClick={() => { void leave() }}>{busy ? <IconLoadingOutlineRegular className={css.spinner} /> : t('signOut')}</Button></div>
  </section>
}
