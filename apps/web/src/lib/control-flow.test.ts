import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { describe, expect, it } from 'vitest';

import { ServiceError } from '@/server/services/context';

import { isControlFlow, rethrowControlFlow } from './control-flow';

/** What a call that ends the work by throwing actually throws. */
function thrownBy(fn: () => never): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}

/** forbidden() and unauthorized() throw a plain error unless the
 *  authInterrupts flag is on, so their signal is built from its digest. */
function accessFallback(status: 401 | 403): Error {
  return Object.assign(new Error(`NEXT_HTTP_ERROR_FALLBACK;${status}`), {
    digest: `NEXT_HTTP_ERROR_FALLBACK;${status}`,
  });
}

describe('rethrowControlFlow', () => {
  const controlFlow: Array<[string, unknown]> = [
    ['redirect() to sign-in', thrownBy(() => redirect('/signin?redirect=%2Fdashboard'))],
    ['permanentRedirect()', thrownBy(() => permanentRedirect('/dashboard'))],
    ['notFound()', thrownBy(() => notFound())],
    ['forbidden()', accessFallback(403)],
    ['unauthorized()', accessFallback(401)],
  ];

  it.each(controlFlow)('throws %s again, unchanged', (_label, error) => {
    expect(() => rethrowControlFlow(error)).toThrow();
    try {
      rethrowControlFlow(error);
    } catch (thrown) {
      expect(thrown).toBe(error);
    }
    expect(isControlFlow(error)).toBe(true);
  });

  it('throws a redirect that another error carries as its cause', () => {
    const signIn = thrownBy(() => redirect('/signin'));
    const wrapped = new Error('could not load the page', { cause: signIn });
    let thrown: unknown = null;
    try {
      rethrowControlFlow(wrapped);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(signIn);
    expect(isControlFlow(wrapped)).toBe(true);
  });

  const failures: Array<[string, unknown]> = [
    ['a ServiceError', new ServiceError('validation_error', 'Name is required.')],
    ['an internal ServiceError', new ServiceError('internal_error', 'relation "x" does not exist')],
    ['a plain Error', new Error('NEXT_REDIRECT')],
    ['an error with an unrelated digest', Object.assign(new Error('x'), { digest: 'abc123' })],
    ['a half-formed redirect digest', Object.assign(new Error('x'), { digest: 'NEXT_REDIRECT' })],
    ['a string', 'NEXT_REDIRECT;push;/signin;307;'],
    ['null', null],
    ['undefined', undefined],
  ];

  it.each(failures)('lets %s through to the catch', (_label, error) => {
    expect(() => rethrowControlFlow(error)).not.toThrow();
    expect(isControlFlow(error)).toBe(false);
  });
});
