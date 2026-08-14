import { describe, expect, it } from 'vitest';

import { DELIVERY_REQUEST_CC_NOTICE, DELIVERY_REQUEST_EMAIL, DELIVERY_REQUEST_EMAIL_NAMES } from './site';

/**
 * The recipient pair is an operational constant, not configuration. These
 * assertions exist because getting either address wrong sends warehouse work to
 * the wrong mailbox silently — Outlook opens, the employee sends, and nobody
 * finds out until a delivery is missed.
 */
describe('DELIVERY_REQUEST_EMAIL', () => {
  it('is the exact approved pair', () => {
    expect(DELIVERY_REQUEST_EMAIL.to).toBe('dc4@learn4life.org');
    expect(DELIVERY_REQUEST_EMAIL.cc).toBe('arosas@cvwest.org');
  });

  it('has exactly two recipient keys — no third address sneaks in', () => {
    expect(Object.keys(DELIVERY_REQUEST_EMAIL).sort()).toEqual(['cc', 'to']);
  });

  it('never concatenates the two addresses into one field', () => {
    expect(DELIVERY_REQUEST_EMAIL.to).not.toContain(',');
    expect(DELIVERY_REQUEST_EMAIL.to).not.toContain(';');
    expect(DELIVERY_REQUEST_EMAIL.to).not.toContain(DELIVERY_REQUEST_EMAIL.cc);
    expect(DELIVERY_REQUEST_EMAIL.cc).not.toContain(',');
    expect(DELIVERY_REQUEST_EMAIL.cc).not.toContain(';');
  });

  it('is frozen at runtime, so no caller can mutate the shared object', () => {
    expect(Object.isFrozen(DELIVERY_REQUEST_EMAIL)).toBe(true);
    expect(() => {
      (DELIVERY_REQUEST_EMAIL as unknown as Record<string, string>).cc = 'attacker@evil.test';
    }).toThrow();
    expect(DELIVERY_REQUEST_EMAIL.cc).toBe('arosas@cvwest.org');
  });
});

/**
 * Cosmetic display labels only — never routing truth. These pin the exact
 * tenant-verified (2026-08-01) name strings and confirm the object can't be
 * silently mutated, same posture as `DELIVERY_REQUEST_EMAIL` above.
 */
describe('DELIVERY_REQUEST_EMAIL_NAMES', () => {
  it('is the exact tenant-verified display-name pair', () => {
    expect(DELIVERY_REQUEST_EMAIL_NAMES.to).toBe('Fresno Warehouse DC4');
    expect(DELIVERY_REQUEST_EMAIL_NAMES.cc).toBe('Andrew Rosas');
  });

  it('has exactly two keys — no third name sneaks in', () => {
    expect(Object.keys(DELIVERY_REQUEST_EMAIL_NAMES).sort()).toEqual(['cc', 'to']);
  });

  it('never contains an address — names and addresses stay two separate constants', () => {
    expect(DELIVERY_REQUEST_EMAIL_NAMES.to).not.toContain('@');
    expect(DELIVERY_REQUEST_EMAIL_NAMES.cc).not.toContain('@');
  });

  it('is frozen at runtime, so no caller can mutate the shared object', () => {
    expect(Object.isFrozen(DELIVERY_REQUEST_EMAIL_NAMES)).toBe(true);
    expect(() => {
      (DELIVERY_REQUEST_EMAIL_NAMES as unknown as Record<string, string>).cc = 'Attacker Name';
    }).toThrow();
    expect(DELIVERY_REQUEST_EMAIL_NAMES.cc).toBe('Andrew Rosas');
  });
});

describe('DELIVERY_REQUEST_CC_NOTICE', () => {
  it('states what the CC does WITHOUT claiming Zendesk assignment', () => {
    expect(DELIVERY_REQUEST_CC_NOTICE).toBe(
      'The DC4 address creates the delivery-request ticket. A copy will also be sent to arosas@cvwest.org.',
    );
  });

  it('never claims a ticket was created, routed or assigned', () => {
    const copy = DELIVERY_REQUEST_CC_NOTICE.toLowerCase();
    for (const claim of ['assigned', 'has been created', 'was created', 'ticket #', 'submitted']) {
      expect(copy).not.toContain(claim);
    }
  });

  /**
   * The address was hand-typed into this sentence until 2026-08-13, which made
   * the notice a silent SECOND definition of where the copy goes: changing
   * DELIVERY_REQUEST_EMAIL.cc would have left every screen showing this notice
   * naming the old mailbox while the mail went to the new one — telling the
   * employee in writing that a copy was sent somewhere it was not.
   *
   * This assertion catches that by MUTATION OF THE ADDRESS rather than of the
   * sentence: change the constant and a hand-typed notice fails here, because
   * the address it names is no longer the CC. The literal pin above is the
   * other half — it catches an unintended change to the WORDING.
   *
   * Same defect, same shape, in the maintenance twin
   * (packages/core/src/maintenance/constants.ts), pinned the same way there.
   */
  it('names the CC by INTERPOLATION — exactly one address appears, and it is the constant', () => {
    expect(DELIVERY_REQUEST_CC_NOTICE.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)).toEqual([
      DELIVERY_REQUEST_EMAIL.cc,
    ]);
    // Never the intake address: this sentence is about the copy, and naming
    // both would tell the employee the copy went to the ticket queue.
    expect(DELIVERY_REQUEST_CC_NOTICE).not.toContain(DELIVERY_REQUEST_EMAIL.to);
  });
});
