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
});
