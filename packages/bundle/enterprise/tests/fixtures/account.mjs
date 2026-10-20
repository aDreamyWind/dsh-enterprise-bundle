/** Credential-free external identity fixture for the enterprise bundle browser smoke. */
export function apply(ctx) {
  const state = { status: 'signed-out', profile: null, attempt: null }
  ctx.provide('enterpriseAccount', {
    getState: () => Promise.resolve(state),
    startSignIn: () => Promise.resolve(state),
    cancelSignIn: () => Promise.resolve(state),
    signOut: () => Promise.resolve(state),
    async *watch(signal) {
      yield state
      if (signal.aborted) return
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    },
    resolveAccessToken: () => Promise.resolve(undefined),
    refreshAccessToken: () => Promise.resolve(undefined),
    rejectAccessToken: () => Promise.resolve(),
  })
}
