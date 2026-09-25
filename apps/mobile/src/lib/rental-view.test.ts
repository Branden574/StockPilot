import { describe, expect, it } from 'vitest';

import {
  RENTAL_NO_EMAIL_NOTE,
  RENTAL_NON_MEMBER_EMAIL_NOTE,
  overdueReminderListMark,
  overdueReminderState,
} from '@stockpilot/core';

import {
  RENTAL_DETAIL_SELECT,
  RENTAL_LIST_REMINDER_COLUMNS,
  loadRentalDetail,
  loadRentalReminderContext,
  rentalBorrowerView,
  rentalDayLabel,
  rentalListReminderMark,
  rentalStatusPill,
  rentalTimeLabel,
  rentalWebActionLabel,
  type RentalViewClient,
} from './rental-view';

type Answer = { data: unknown; error: { message: string } | null; status?: number } | Error;

interface Recorded {
  table: string;
  select: string;
  eq: [string, unknown][];
}

/** A fake of `from(t).select(c).eq(..).eq(..).maybeSingle()`, answered per table. */
function fakeClient(answers: Record<string, Answer>) {
  const calls: Recorded[] = [];
  const client: RentalViewClient = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: Recorded = { table, select: columns, eq: [] };
          calls.push(call);
          const chain = {
            eq(col: string, val: unknown) {
              call.eq.push([col, val]);
              return chain;
            },
            maybeSingle() {
              const answer = answers[table] ?? { data: null, error: null };
              return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
            },
          };
          return chain;
        },
      };
    },
  };
  return { client, calls };
}

// Thu Sep 24 2026, 10:00 AM PDT.
const NOW = Date.parse('2026-09-24T17:00:00.000Z');

const RAW_RENTAL = {
  id: 'r-1',
  status: 'out',
  borrower_user_id: null,
  borrower_name: 'Pat from Site 4',
  borrower_email: 'pat@site4.org',
  checked_out_at: '2026-09-20T17:00:00.000Z',
  expected_return_at: '2026-09-26T00:00:00.000Z',
  returned_at: null,
  cancelled_at: null,
  cancellation_reason: null,
  return_notes: null,
  notes: 'Field day',
  overdue_reminder_sent_at: null,
  warehouse: { name: 'DC4' },
  lines: [
    { id: 'l-1', item_id: 'i-1', quantity: '2', notes: null, item: { name: 'Canopy', sku: 'C-1' } },
    { id: 'l-2', item_id: 'i-2', quantity: 1, notes: 'blue', item: null },
  ],
};

describe('loadRentalReminderContext: the sweep switch and the zone', () => {
  it('reads the explicit rentals row and the organization zone', async () => {
    const { client, calls } = fakeClient({
      organization_modules: { data: { enabled: true }, error: null },
      organizations: { data: { timezone: 'America/Los_Angeles' }, error: null },
    });
    await expect(loadRentalReminderContext(client, 'org-1')).resolves.toEqual({
      remindersOn: true,
      timeZone: 'America/Los_Angeles',
    });
    const modules = calls.find((c) => c.table === 'organization_modules');
    expect(modules?.select).toBe('enabled');
    expect(modules?.eq).toEqual([
      ['organization_id', 'org-1'],
      ['module_id', 'rentals'],
    ]);
    // Never the comp: the organization row is read for its zone only.
    expect(calls.find((c) => c.table === 'organizations')?.select).toBe('timezone');
  });

  it('no row is off (a comped organization); an unreadable row is unknown, never a guess', async () => {
    await expect(
      loadRentalReminderContext(fakeClient({ organization_modules: { data: null, error: null } }).client, 'o'),
    ).resolves.toMatchObject({ remindersOn: false });
    await expect(
      loadRentalReminderContext(
        fakeClient({ organization_modules: { data: null, error: { message: 'denied' } } }).client,
        'o',
      ),
    ).resolves.toMatchObject({ remindersOn: null });
    await expect(
      loadRentalReminderContext(fakeClient({ organization_modules: new Error('offline') }).client, 'o'),
    ).resolves.toMatchObject({ remindersOn: null });
  });

  it('a missing or unreadable zone is the device zone (null)', async () => {
    const { client } = fakeClient({ organizations: new Error('offline') });
    await expect(loadRentalReminderContext(client, 'o')).resolves.toMatchObject({ timeZone: null });
    const blank = fakeClient({ organizations: { data: { timezone: '  ' }, error: null } });
    await expect(loadRentalReminderContext(blank.client, 'o')).resolves.toMatchObject({ timeZone: null });
  });
});

describe('loadRentalDetail', () => {
  it('reads the rental scoped to the organization, with its lines, warehouse and context', async () => {
    const { client, calls } = fakeClient({
      rentals: { data: RAW_RENTAL, error: null },
      organization_modules: { data: { enabled: true }, error: null },
      organizations: { data: { timezone: 'America/Los_Angeles' }, error: null },
    });
    const res = await loadRentalDetail(client, 'org-1', 'r-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rentalRead = calls.find((c) => c.table === 'rentals');
    expect(rentalRead?.select).toBe(RENTAL_DETAIL_SELECT);
    expect(rentalRead?.eq).toEqual([
      ['id', 'r-1'],
      ['organization_id', 'org-1'],
    ]);
    // Everything the emails section decides on is selected.
    for (const col of ['borrower_email', 'borrower_user_id', 'overdue_reminder_sent_at', 'expected_return_at', 'returned_at', 'status']) {
      expect(RENTAL_DETAIL_SELECT).toContain(col);
    }
    expect(res.rental).toMatchObject({
      id: 'r-1',
      borrower_name: 'Pat from Site 4',
      warehouseName: 'DC4',
      overdue_reminder_sent_at: null,
    });
    expect(res.rental.lines).toEqual([
      { id: 'l-1', itemId: 'i-1', name: 'Canopy', sku: 'C-1', quantity: 2, notes: null },
      { id: 'l-2', itemId: 'i-2', name: 'Item', sku: null, quantity: 1, notes: 'blue' },
    ]);
    expect(res.context).toEqual({ remindersOn: true, timeZone: 'America/Los_Angeles' });
  });

  it('a rental the caller cannot see is not found', async () => {
    const { client } = fakeClient({ rentals: { data: null, error: null } });
    await expect(loadRentalDetail(client, 'org-1', 'r-1')).resolves.toEqual({ ok: false, notFound: true });
  });

  it('a failed read says so with a reason, never "not found"', async () => {
    const failed = fakeClient({ rentals: { data: null, error: { message: '' }, status: 502 } });
    await expect(loadRentalDetail(failed.client, 'org-1', 'r-1')).resolves.toEqual({
      ok: false,
      notFound: false,
      message: 'HTTP 502',
    });
    const offline = fakeClient({ rentals: new Error('Network request failed') });
    await expect(loadRentalDetail(offline.client, 'org-1', 'r-1')).resolves.toMatchObject({
      ok: false,
      notFound: false,
      message: 'Network request failed',
    });
  });
});

describe('rentalListReminderMark: overdue rows only, the shared rule', () => {
  const ctx = { remindersOn: true, timeZone: 'America/Los_Angeles' };
  const overdue = {
    status: 'out',
    expected_return_at: '2026-09-22T00:00:00.000Z',
    returned_at: null,
    borrower_email: 'pat@site4.org',
    overdue_reminder_sent_at: null,
  };

  it('matches core for an overdue row', () => {
    for (const row of [
      overdue,
      { ...overdue, overdue_reminder_sent_at: '2026-09-22T15:00:02.000Z' },
      { ...overdue, borrower_email: null },
    ]) {
      expect(rentalListReminderMark(row, ctx, NOW)).toBe(
        overdueReminderListMark(overdueReminderState(row, true, NOW), ctx.timeZone),
      );
    }
    expect(rentalListReminderMark({ ...overdue, overdue_reminder_sent_at: '2026-09-22T15:00:02.000Z' }, ctx, NOW)).toBe(
      'Reminder sent Sep 22',
    );
    expect(rentalListReminderMark({ ...overdue, borrower_email: null }, ctx, NOW)).toBe('No email on file');
    expect(rentalListReminderMark(overdue, { ...ctx, remindersOn: false }, NOW)).toBe('Reminders off');
  });

  it('nothing on rows that are not overdue', () => {
    expect(rentalListReminderMark({ ...overdue, expected_return_at: '2026-09-30T00:00:00.000Z' }, ctx, NOW)).toBeNull();
    expect(rentalListReminderMark({ ...overdue, status: 'returned' }, ctx, NOW)).toBeNull();
  });

  it('the list selects the columns the mark needs', () => {
    expect(RENTAL_LIST_REMINDER_COLUMNS).toContain('overdue_reminder_sent_at');
    expect(RENTAL_LIST_REMINDER_COLUMNS).toContain('borrower_user_id');
  });
});

describe('rentalStatusPill', () => {
  it('returned, cancelled, overdue, out', () => {
    expect(rentalStatusPill({ status: 'returned', expected_return_at: '2026-09-01T00:00:00Z' }, NOW)).toEqual({ label: 'RETURNED', status: 'ok' });
    expect(rentalStatusPill({ status: 'cancelled', expected_return_at: '2026-09-01T00:00:00Z' }, NOW)).toEqual({ label: 'CANCELLED', status: 'crit' });
    expect(rentalStatusPill({ status: 'out', expected_return_at: '2026-09-01T00:00:00Z' }, NOW)).toEqual({ label: 'OVERDUE', status: 'crit' });
    expect(rentalStatusPill({ status: 'out', expected_return_at: '2026-09-30T00:00:00Z' }, NOW)).toEqual({ label: 'OUT', status: 'warn' });
  });
});

describe('rentalBorrowerView', () => {
  it('a borrower not linked to an account, with an email: the email and the no-link note', () => {
    expect(rentalBorrowerView({ borrower_name: 'Pat', borrower_user_id: null, borrower_email: 'pat@site4.org' })).toEqual({
      name: 'Pat',
      kind: 'Not linked to a StockPilot account',
      isMember: false,
      email: 'pat@site4.org',
      note: RENTAL_NON_MEMBER_EMAIL_NOTE,
    });
  });

  it('a team member: labelled, no note', () => {
    expect(rentalBorrowerView({ borrower_name: 'Ana', borrower_user_id: 'u-1', borrower_email: 'ana@school.org' })).toMatchObject({
      kind: 'Team member',
      isMember: true,
      note: null,
    });
  });

  it('no email on file (blank counts): the no-email note', () => {
    for (const borrower_email of [null, ' ']) {
      expect(rentalBorrowerView({ borrower_name: 'Pat', borrower_user_id: null, borrower_email })).toMatchObject({
        email: null,
        note: RENTAL_NO_EMAIL_NOTE,
      });
    }
  });
});

describe('rentalTimeLabel', () => {
  it('in the organization zone when known', () => {
    expect(rentalTimeLabel('2026-09-26T00:00:00.000Z', 'America/Los_Angeles')).toBe('Sep 25, 2026, 5:00 PM');
  });

  it('an em dash for nothing or garbage', () => {
    expect(rentalTimeLabel(null, null)).toBe('—');
    expect(rentalTimeLabel('garbage', null)).toBe('—');
  });
});

describe('rentalDayLabel: the list card dates, in the organization zone', () => {
  // The organization on UTC (the column default) and the phone in California:
  // the card must name the day the detail screen names.
  it('the organization zone when known', () => {
    expect(rentalDayLabel('2026-09-26T00:00:00.000Z', 'UTC')).toBe('Sep 26');
    expect(rentalDayLabel('2026-09-26T00:00:00.000Z', 'America/Los_Angeles')).toBe('Sep 25');
  });

  it('agrees with the detail label on the day', () => {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const day = rentalDayLabel('2026-09-26T00:00:00.000Z', zone);
      expect(rentalTimeLabel('2026-09-26T00:00:00.000Z', zone).startsWith(`${day},`)).toBe(true);
    }
  });

  it('an em dash for nothing or garbage', () => {
    expect(rentalDayLabel(null, 'UTC')).toBe('—');
    expect(rentalDayLabel('garbage', null)).toBe('—');
  });
});

describe('rentalWebActionLabel: the detail button to the web actions', () => {
  // The web page shows Mark returned only with rentals:create, and Cancel only
  // with rentals:manage too. Mutation caught: the button for every viewer of
  // an out rental (the old screen).
  const set = (...p: string[]) => new Set(p) as Set<never>;

  it('none for a viewer the web page gives no action to', () => {
    expect(rentalWebActionLabel('out', set('rentals:read'))).toBeNull();
    expect(rentalWebActionLabel('out', set())).toBeNull();
  });

  it('Mark returned only, without rentals:manage', () => {
    expect(rentalWebActionLabel('out', set('rentals:read', 'rentals:create'))).toBe('Mark returned on the web');
  });

  it('and cancel with rentals:manage', () => {
    expect(rentalWebActionLabel('out', set('rentals:create', 'rentals:manage'))).toBe(
      'Mark returned or cancel on the web',
    );
  });

  it('nothing for a rental that is no longer out', () => {
    for (const status of ['returned', 'cancelled']) {
      expect(rentalWebActionLabel(status, set('rentals:create', 'rentals:manage'))).toBeNull();
    }
  });

  it('while the permissions load, shown like every other write button (the web and server decide)', () => {
    expect(rentalWebActionLabel('out', undefined)).toBe('Mark returned or cancel on the web');
  });
});
