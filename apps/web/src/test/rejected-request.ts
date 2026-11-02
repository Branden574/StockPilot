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
 * Use `offline()` for the first group, `outOfDate()` for a page older than the
 * server, and `signInRedirect()` for the last one.
 */

import { afterEach, beforeEach } from 'vitest';

/** What fetch (and so a Server Action call) rejects with when the browser is offline. */
export function offline(): TypeError {
  return new TypeError('Failed to fetch');
}

/**
 * What a Server Action call rejects with when the page was built by an older
 * deploy and the server no longer has the action (Next's
 * UnrecognizedActionError, next/dist/client/components/router-reducer/reducers/
 * server-action-reducer.js). Nothing ran; only a reload helps.
 */
export function outOfDate(): Error {
  return Object.assign(
    new Error(
      'Server Action "7f00aa" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    ),
    { name: 'UnrecognizedActionError' },
  );
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

/**
 * The rejections nothing handled during each test of the file that calls this
 * (call it once, at the top level). Node reports a promise rejection nobody
 * handled on `process` once the microtasks have run, so read the list after
 * the test has waited a timer turn.
 *
 * A redirect to sign-in rejects the call too. A page that handles it
 * (`if (isControlFlow(e)) return;`) says nothing and lets nothing escape. A
 * handler with no catch also says nothing, but the redirect escapes it as an
 * unhandled rejection, so a test of the redirect checks both: no message, and
 * this list empty.
 */
export function recordEscapedRejections(): unknown[] {
  const escaped: unknown[] = [];
  const record = (reason: unknown) => {
    escaped.push(reason);
  };
  beforeEach(() => {
    escaped.length = 0;
    process.on('unhandledRejection', record);
  });
  afterEach(() => {
    process.off('unhandledRejection', record);
  });
  return escaped;
}
