import { describe, expect, it } from 'vitest';

import { createRentalSchema } from '../schemas/rentals';

import { isBorrowerEmailFormat, RENTAL_BORROWER_EMAIL_HELP } from './borrower';

describe('isBorrowerEmailFormat', () => {
  it.each(['sam@school.org', 'first.last+rentals@district.k12.ca.us', 'a@b.co'])(
    'accepts %s',
    (email) => expect(isBorrowerEmailFormat(email)).toBe(true),
  );

  it.each(['sam', 'sam@school', '@school.org', 'sam @school.org', 'sam@school .org', ''])(
    'refuses %j',
    (email) => expect(isBorrowerEmailFormat(email)).toBe(false),
  );

  it('never accepts an address the server schema would refuse, for the common shapes', () => {
    const base = {
      warehouseId: '00000000-0000-4000-8000-000000000001',
      borrowerName: 'Sam',
      expectedReturnAt: '2030-01-01T00:00:00.000Z',
      lines: [{ itemId: '00000000-0000-4000-8000-000000000002', quantity: 1 }],
    };
    for (const email of ['sam@school.org', 'first.last+rentals@district.k12.ca.us']) {
      expect(isBorrowerEmailFormat(email)).toBe(true);
      expect(createRentalSchema.safeParse({ ...base, borrowerEmail: email }).success).toBe(true);
    }
  });
});

describe('RENTAL_BORROWER_EMAIL_HELP', () => {
  it('names the three emails a borrower gets, and only those', () => {
    expect(RENTAL_BORROWER_EMAIL_HELP).toMatch(/checkout receipt/);
    expect(RENTAL_BORROWER_EMAIL_HELP).toMatch(/return confirmation/);
    expect(RENTAL_BORROWER_EMAIL_HELP).toMatch(/overdue/);
    // No promise of a reminder before the due date: none is sent.
    expect(RENTAL_BORROWER_EMAIL_HELP).not.toMatch(/due soon|before it is due|upcoming/i);
  });

  it('promises the overdue reminder only with its condition: the Rentals switch, not the comp', () => {
    // cron/rental-overdue sweeps only organizations whose own Rentals row is
    // on (its tests pin that the comp is ignored). A comped organization can
    // create rentals with the switch off, and then no reminder goes out.
    expect(RENTAL_BORROWER_EMAIL_HELP).toMatch(
      /while Rentals is switched on in Settings > Modules, a reminder if the rental is overdue/,
    );
    expect(RENTAL_BORROWER_EMAIL_HELP).not.toMatch(/and a reminder if the rental is overdue/);
  });
});
