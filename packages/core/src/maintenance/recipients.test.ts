import { describe, expect, it } from 'vitest';

import { maintenanceEmailRecipients, type MaintenanceEmailRecipients } from './recipients';

/**
 * The maintenance recipients factory — the only constructor for the branded
 * type the email builder requires. Mirrors the delivery factory's guarantees
 * (validate-then-brand, freeze), pinned independently because the two brands
 * are deliberately separate types.
 */
describe('maintenanceEmailRecipients', () => {
  it('validates, brands and freezes a full input', () => {
    const r = maintenanceEmailRecipients({
      to: 'intake@example-tenant.invalid',
      cc: 'copy@example-tenant.invalid',
      toName: 'Intake Desk',
      ccName: 'Ops Manager',
    });
    expect(r.to).toBe('intake@example-tenant.invalid');
    expect(r.cc).toBe('copy@example-tenant.invalid');
    expect(r.toName).toBe('Intake Desk');
    expect(r.ccName).toBe('Ops Manager');
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as unknown as Record<string, string>).cc = 'attacker@evil.test';
    }).toThrow();
  });

  it('omits absent display names rather than storing undefined keys', () => {
    const r = maintenanceEmailRecipients({
      to: 'intake@example-tenant.invalid',
      cc: 'copy@example-tenant.invalid',
    });
    expect(Object.keys(r as unknown as Record<string, string>).sort()).toEqual(['cc', 'to']);
  });

  it('refuses a malformed to address (the injection grammar)', () => {
    expect(() =>
      maintenanceEmailRecipients({ to: 'a?cc=attacker@evil.test', cc: 'copy@ok.invalid' }),
    ).toThrow(/recipient "to" must be exactly one plain email address/);
  });

  it('refuses an empty or missing-shaped cc — "no cc" is not expressible', () => {
    expect(() => maintenanceEmailRecipients({ to: 'intake@ok.invalid', cc: '' })).toThrow(
      /recipient "cc"/,
    );
    expect(() =>
      maintenanceEmailRecipients({ to: 'intake@ok.invalid', cc: 'two@a.invalid,three@b.invalid' }),
    ).toThrow(/recipient "cc"/);
  });

  it('refuses display names carrying RFC 5322 specials', () => {
    expect(() =>
      maintenanceEmailRecipients({
        to: 'intake@ok.invalid',
        cc: 'copy@ok.invalid',
        ccName: 'Ops, Manager',
      }),
    ).toThrow(/RFC 5322 specials/);
  });

  it('the brand refuses a delivery-style spread — a modified copy does not typecheck', () => {
    const base = maintenanceEmailRecipients({ to: 'intake@ok.invalid', cc: 'copy@ok.invalid' });
    // @ts-expect-error — the private-member brand does not survive an object
    // spread, so "start from a valid value, change the cc" fails to compile.
    const forged: MaintenanceEmailRecipients = { ...base, cc: 'attacker@evil.test' };
    // Runtime keeps the forged value from being silently equal to the base.
    expect(forged.cc).not.toBe(base.cc);
  });
});
