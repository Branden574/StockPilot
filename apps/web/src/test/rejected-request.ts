/**
 * What a request rejects with when it gets no usable answer, for the tests of
 * B40 (a busy flag cleared only when the request resolved).
 *
 * A Server Action call is a fetch under the hood, and its promise REJECTS,
 * rather than resolving with an ActionResult, when the browser is offline, when
 * the connection drops, when the server fails before the action can answer
 * (a crash, a timeout, a deploy that no longer has the action), and when the
 * action redirected (the session ended). A component that set `busy` before
 * the call and cleared it only after a resolved call kept its spinner forever
 * and said nothing.
 *
 * Use `offline()` for the first group and `signInRedirect()` for the last one.
 */

/** What fetch (and so a Server Action call) rejects with when the browser is offline. */
export function offline(): TypeError {
  return new TypeError('Failed to fetch');
}

/**
 * The error a Server Action call rejects with when the action redirected to
 * sign-in. It is Next's own redirect error (the digest its isRedirectError
 * reads), built here because component tests mock next/navigation. A test
 * that asserts on it must keep the real unstable_rethrow in that mock
 * (spread `importOriginal()`), or isControlFlow cannot recognise it.
 */
export function signInRedirect(): Error {
  return Object.assign(new Error('NEXT_REDIRECT'), {
    digest: 'NEXT_REDIRECT;replace;/signin;307;',
  });
}
