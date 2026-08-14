import { describe, expect, it } from 'vitest';

import { resolveRequesterIdentity } from './requester-identity';

/**
 * The shared two-source fallback for who asked for an order.
 *
 * Pinned here rather than only through its callers because it now has three:
 * web's `OrderRequestsService.get()` (which feeds the print docs and the pick
 * screen as well as the delivery request) and core's delivery-request mapping,
 * which the phone runs. The operator is the whole point — see the module doc.
 */
describe('resolveRequesterIdentity', () => {
  it('the denormalized column wins when it holds a real value', () => {
    expect(resolveRequesterIdentity('onbehalf@site.org', 'staff@cvwest.org')).toBe(
      'onbehalf@site.org',
    );
    expect(resolveRequesterIdentity('Doua Vang', 'Profile Name')).toBe('Doua Vang');
  });

  it('falls through to the joined profile when the column is NULL — the internal self-submit majority', () => {
    expect(resolveRequesterIdentity(null, 'jane@cvsouth.org')).toBe('jane@cvsouth.org');
    expect(resolveRequesterIdentity(undefined, 'Jane Doe')).toBe('Jane Doe');
  });

  it('THE FIX: an EMPTY column falls through too — `||`, never `??`', () => {
    // `??` treats '' as present, so the profile value is never consulted and
    // the caller receives a blank. That is the one-character difference that
    // made web and mobile name different requesters for the same order.
    expect(resolveRequesterIdentity('', 'jane@cvsouth.org')).toBe('jane@cvsouth.org');
    expect(resolveRequesterIdentity('   ', 'jane@cvsouth.org')).toBe('jane@cvsouth.org');
    // Stated as the property, so the intent survives a refactor of the above.
    expect(resolveRequesterIdentity('', 'x@y.org')).not.toBe('');
  });

  it('returns NULL, never an empty string, when neither source has anything usable', () => {
    for (const column of [null, undefined, '', '   ']) {
      for (const profile of [null, undefined, '', '   ']) {
        expect(resolveRequesterIdentity(column, profile)).toBeNull();
      }
    }
  });

  it('trims BOTH sides, so a padded value is used without its padding rather than discarded', () => {
    expect(resolveRequesterIdentity('  Doua Vang  ', null)).toBe('Doua Vang');
    expect(resolveRequesterIdentity(null, '  jane@cvsouth.org  ')).toBe('jane@cvsouth.org');
  });

  it('ignores non-string junk on either side rather than passing it into an email body', () => {
    // The columns are read off untyped PostgREST rows and cast; a cast is not a
    // guarantee. Nothing here should ever reach a mailbox as "[object Object]".
    const junk = { toString: () => 'nope' } as unknown as string;
    expect(resolveRequesterIdentity(junk, 'jane@cvsouth.org')).toBe('jane@cvsouth.org');
    expect(resolveRequesterIdentity(junk, junk)).toBeNull();
  });
});
