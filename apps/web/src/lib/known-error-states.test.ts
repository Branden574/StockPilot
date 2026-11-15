import { describe, expect, it } from 'vitest';

import {
  ACCESS_UNCHECKED_DIGEST,
  knownErrorState,
  LINK_UNCHECKED_DIGEST,
} from './known-error-states';

/**
 * The states an error boundary knows by an error's digest, and the plain
 * words for each. Only the digest decides: a Server Component's error reaches
 * the browser without its class and, in a production build, without its
 * message.
 */
describe('knownErrorState', () => {
  it('the access check that could not be made', () => {
    expect(knownErrorState(Object.assign(new Error('x'), { digest: ACCESS_UNCHECKED_DIGEST }))).toEqual({
      key: 'access-unchecked',
      title: "This page couldn't be loaded",
      body: "We couldn't check your access just now. This is usually temporary.",
    });
  });

  it('the public link that could not be checked', () => {
    expect(knownErrorState(Object.assign(new Error('x'), { digest: LINK_UNCHECKED_DIGEST }))).toEqual({
      key: 'link-unchecked',
      title: "This page couldn't be loaded",
      body: "We couldn't check this link just now. This is usually temporary.",
    });
  });

  it('a plain object with the digest counts: the stand-in need not be an Error', () => {
    expect(knownErrorState({ digest: ACCESS_UNCHECKED_DIGEST })?.key).toBe('access-unchecked');
  });

  it.each([
    ['a generated digest', Object.assign(new Error('x'), { digest: '2416532942' })],
    ['no digest', new Error('x')],
    ['a message that only mentions the digest', new Error(ACCESS_UNCHECKED_DIGEST)],
    ['a digest that is not a string', { digest: 7 }],
    ['a string', ACCESS_UNCHECKED_DIGEST],
    ['null', null],
    ['undefined', undefined],
  ])('%s is no known state', (_name, error) => {
    expect(knownErrorState(error)).toBeNull();
  });

  it('the digests are plain tokens that say nothing about the server', () => {
    for (const digest of [ACCESS_UNCHECKED_DIGEST, LINK_UNCHECKED_DIGEST]) {
      expect(digest).toMatch(/^[A-Z_]+$/);
      // Never one of Next's own control-flow digests.
      expect(digest).not.toMatch(/^NEXT_|^DYNAMIC_|^BAILOUT_/);
    }
  });
});
