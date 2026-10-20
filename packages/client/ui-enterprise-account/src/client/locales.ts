/** English enterprise account dictionary. */
export const en = {
  nav: 'Enterprise account',
  gateTitle: 'Sign in to continue',
  gateDescription: 'Use your organization account to access the models and tools assigned to you.',
  loading: 'Checking your account…',
  start: 'Sign in with SSO',
  open: 'Open sign-in page',
  cancel: 'Cancel',
  retry: 'Try again',
  initializing: 'Preparing secure sign-in…',
  waiting: 'Continue in your browser, then return here.',
  completing: 'Verifying your organization account…',
  expired: 'The sign-in request expired. Start again.',
  failed: 'Sign-in could not be completed. Check the management service and try again.',
  signedIn: 'Signed in',
  organization: 'Organization',
  identity: 'Account',
  signOut: 'Sign out',
  streamFailed: 'Account status is unavailable. Reconnect and try again.',
} as const

/** Enterprise account locale keys. */
export type EnterpriseAccountKey = keyof typeof en

/** Chinese enterprise account dictionary. */
export const zh: Record<EnterpriseAccountKey, string> = {
  nav: '企业账号',
  gateTitle: '登录后继续',
  gateDescription: '使用企业账号访问组织分配给你的模型和工具。',
  loading: '正在检查账号状态…',
  start: '使用统一登录',
  open: '打开登录页面',
  cancel: '取消',
  retry: '重试',
  initializing: '正在准备安全登录…',
  waiting: '请在浏览器中完成登录，然后返回此页面。',
  completing: '正在验证企业账号…',
  expired: '登录请求已过期，请重新发起。',
  failed: '登录未完成，请检查后台管理服务后重试。',
  signedIn: '已登录',
  organization: '所属组织',
  identity: '账号',
  signOut: '退出登录',
  streamFailed: '暂时无法获取账号状态，请重新连接后重试。',
}
