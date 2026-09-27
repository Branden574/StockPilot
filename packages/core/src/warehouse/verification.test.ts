import { describe, expect, it } from 'vitest';

import { EXCEPTION_FIRST_CHECK_PENDING_COPY } from './exceptions';
import {
  LOCATION_HOLDINGS_CAP,
  LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY,
  LOCATION_HOLDINGS_TRUNCATED_COPY,
  LOCATION_NO_OPEN_ISSUES_COPY,
  LOCATION_NO_VISIBLE_OPEN_ISSUES_COPY,
  LOCATION_OPEN_ISSUES_OUT_OF_SCOPE_COPY,
  LOCATION_RECOUNT_LABEL,
  locationOpenIssuesEmptyCopy,
  locationRecountProblem,
  locationRecountProblemOf,
  locationRowVerificationCopy,
  locationVerificationTotals,
  locationVerificationTotalsCopy,
  parseItemVerificationSummary,
  VERIFICATION_AI_ASSISTED_COPY,
  VERIFICATION_COUNT_ACTION_LABEL,
  VERIFICATION_ITEM_TOTAL_SCOPE_COPY,
  VERIFICATION_MOVEMENTS_UNKNOWN_COPY,
  VERIFICATION_NEVER_COUNTED_COPY,
  VERIFICATION_NOT_COUNTABLE_COPY,
  VERIFICATION_SESSION_ENDED_COPY,
  VERIFICATION_UNAVAILABLE_COPY,
  verificationIssueChipCopy,
  verificationNotCountableReason,
  verificationRefusalCopy,
  verificationRefusalOf,
  verificationSummaryCopy,
  type ItemVerificationSummary,
  type VerificationLastCount,
} from './verification';

const TZ = 'America/Chicago';
const HERE = 'loc-here';

function count(o: Partial<VerificationLastCount> = {}): VerificationLastCount {
  return {
    cycleCountId: 'cc-31',
    countNumber: 31,
    completedAt: '2026-09-12T16:00:00Z',
    countedAt: '2026-09-12T15:02:00Z',
    capturedAt: null,
    // 10:02 AM on Sep 12 in Chicago (CDT, UTC-5).
    baselineAt: '2026-09-12T15:02:00Z',
    expectedQuantity: 10,
    expectedAtStart: 10,
    countedQuantity: 10,
    countedLocationId: null,
    countedLocation: null,
    aiAssisted: false,
    countedBy: { id: 'u-a', label: 'Avery' },
    postedBy: { id: 'u-b', label: 'Blake' },
    ...o,
  };
}

function summary(o: Partial<ItemVerificationSummary> = {}): ItemVerificationSummary {
  return {
    itemId: 'item-1',
    item: {
      status: 'active',
      isRental: false,
      isBundle: false,
      deleted: false,
      countable: true,
      quantityOnHand: 12,
    },
    lastCount: count(),
    movementsSince: 0,
    outsideLedgerSince: 0,
    openCount: null,
    ...o,
  };
}

const neverCounted = () =>
  summary({ lastCount: null, movementsSince: null, outsideLedgerSince: null });

describe('verificationSummaryCopy: every state', () => {
  it('unavailable: a failed read says so, never "never counted"', () => {
    for (const s of [null, undefined]) {
      const c = verificationSummaryCopy(s, { timeZone: TZ, canCount: true });
      expect(c.state).toBe('unavailable');
      expect(c.headline).toBe("Couldn't load verification");
      expect(c.headline).toBe(VERIFICATION_UNAVAILABLE_COPY);
      expect(c.lines).toEqual(["Couldn't load verification"]);
      expect(c.lines.join(' ')).not.toContain(VERIFICATION_NEVER_COUNTED_COPY);
      expect(c.countAction).toBeNull();
    }
  });

  it('never counted: the stated answer, with "Count this item" only for a reader who may start a count', () => {
    const staff = verificationSummaryCopy(neverCounted(), { timeZone: TZ, canCount: false });
    expect(staff.state).toBe('never_counted');
    expect(staff.headline).toBe('No physical count on record.');
    expect(staff.countAction).toBeNull();
    expect(staff.lines).toEqual(['No physical count on record.']);

    const manager = verificationSummaryCopy(neverCounted(), { timeZone: TZ, canCount: true });
    expect(manager.countAction).toBe('Count this item');
    expect(manager.countAction).toBe(VERIFICATION_COUNT_ACTION_LABEL);
    expect(manager.lines).toEqual(['No physical count on record.', 'Count this item']);
    // Nothing about "since": there is no count to be since.
    expect(manager.movementsSince).toBeNull();
    expect(manager.bookNow).toBeNull();
  });

  it('header: the date the count is true for and the count reference, linking to the count', () => {
    const c = verificationSummaryCopy(summary(), { timeZone: TZ });
    expect(c.state).toBe('counted');
    expect(c.headline).toBe('Last physical count: Sep 12, 2026 · CC-000031');
    expect(c.countId).toBe('cc-31');
    // A count with no number still has a date, and never a made-up reference.
    expect(
      verificationSummaryCopy(summary({ lastCount: count({ countNumber: null }) }), {
        timeZone: TZ,
      }).headline,
    ).toBe('Last physical count: Sep 12, 2026');
  });

  it('header date is the observation (an offline capture), not when it synced or posted', () => {
    const c = verificationSummaryCopy(
      summary({
        lastCount: count({
          capturedAt: '2026-09-10T20:00:00Z',
          baselineAt: '2026-09-10T20:00:00Z',
          countedAt: '2026-09-12T15:02:00Z',
        }),
      }),
      { timeZone: TZ },
    );
    expect(c.headline).toBe('Last physical count: Sep 10, 2026 · CC-000031');
  });

  it('matched the book', () => {
    expect(verificationSummaryCopy(summary(), { timeZone: TZ }).result).toBe(
      'Matched the book (10)',
    );
  });

  it('book corrected, with the signed difference', () => {
    const up = summary({
      lastCount: count({ expectedQuantity: 8, expectedAtStart: 9, countedQuantity: 10 }),
    });
    expect(verificationSummaryCopy(up, { timeZone: TZ }).result).toBe(
      'Book corrected from 8 to 10 (+2)',
    );
    const down = summary({ lastCount: count({ expectedQuantity: 10, countedQuantity: 7.5 }) });
    expect(verificationSummaryCopy(down, { timeZone: TZ }).result).toBe(
      'Book corrected from 10 to 7.5 (-2.5)',
    );
  });

  it('a line from before 0339 (no book at count time kept) says only what was counted', () => {
    const legacy = summary({
      lastCount: count({ expectedAtStart: null, expectedQuantity: 6, countedQuantity: 10 }),
    });
    const c = verificationSummaryCopy(legacy, { timeZone: TZ });
    expect(c.result).toBe('Counted 10');
    expect(c.lines.join(' ')).not.toMatch(/Matched|corrected/);
  });

  it('scope: the counted location when one was recorded', () => {
    const at = summary({
      lastCount: count({
        countedLocationId: 'r-1',
        countedLocation: { name: 'A-12', kind: 'rack', type: 'shelf', archived: false },
      }),
    });
    expect(verificationSummaryCopy(at, { timeZone: TZ }).scope).toBe(
      'Counted while A-12 was its only shelf location',
    );
    // The location is gone: its kind is unknown, so it is not called a shelf.
    const gone = summary({ lastCount: count({ countedLocationId: 'r-3', countedLocation: null }) });
    expect(verificationSummaryCopy(gone, { timeZone: TZ }).scope).toBe(
      'Counted while a location, since removed, was its only place outside Staging',
    );
  });

  // M1 (review 2026-09-27). The trigger records Unplaced when it is the
  // item's only holding OUTSIDE Staging (Staging is left out of the
  // candidates), so 3 in Unplaced plus 5 in Staging records Unplaced (pgTAP
  // 0374 S28 pins that). "All of it was Unplaced" was false for that item.
  it('scope: a count recorded at Unplaced says it was the only place outside Staging, never "all of it"', () => {
    const unplaced = summary({
      lastCount: count({
        countedLocationId: 'u',
        countedLocation: { name: 'Unplaced', kind: 'unplaced', type: 'other', archived: false },
      }),
    });
    const scope = verificationSummaryCopy(unplaced, { timeZone: TZ }).scope;
    expect(scope).toBe('Counted while Unplaced was its only place outside Staging, on no rack');
    expect(scope).not.toMatch(/all of it/);
  });

  // L2 (review 2026-09-27). A Site holding the item's only stock outside
  // Staging is recorded too (the trigger's candidates include NULL-kind
  // Sites); a Site is not a shelf.
  it('scope: a Site or job site is its only place outside Staging, never a "shelf location"', () => {
    const site = summary({
      lastCount: count({
        countedLocationId: 'site',
        countedLocation: { name: 'Job site', kind: null, type: 'jobsite', archived: false },
      }),
    });
    expect(verificationSummaryCopy(site, { timeZone: TZ }).scope).toBe(
      'Counted while Job site was its only place outside Staging',
    );
    const warehouse = summary({
      lastCount: count({
        countedLocationId: 'wh',
        countedLocation: { name: 'DC4', kind: null, type: 'warehouse', archived: false },
      }),
    });
    expect(verificationSummaryCopy(warehouse, { timeZone: TZ }).scope).toBe(
      'Counted while DC4 was its only place outside Staging',
    );
    // A server that sends no type: a NULL-kind location is a Site (core
    // isSiteLocation's catch-all), so never a shelf.
    const untyped = summary({
      lastCount: count({
        countedLocationId: 'x',
        countedLocation: { name: 'Room 4', kind: null, type: null, archived: false },
      }),
    });
    expect(verificationSummaryCopy(untyped, { timeZone: TZ }).scope).toBe(
      'Counted while Room 4 was its only place outside Staging',
    );
  });

  it('scope: every placement (rack, crate, area, shelf, bin) is a shelf location', () => {
    for (const loc of [
      { kind: 'rack', type: 'shelf' },
      { kind: 'crate', type: 'other' },
      { kind: 'area', type: 'other' },
      { kind: null, type: 'shelf' },
      { kind: null, type: 'bin' },
    ]) {
      const s = summary({
        lastCount: count({
          countedLocationId: 'p',
          countedLocation: { name: 'P-1', ...loc, archived: false },
        }),
      });
      expect(verificationSummaryCopy(s, { timeZone: TZ }).scope, JSON.stringify(loc)).toBe(
        'Counted while P-1 was its only shelf location',
      );
    }
  });

  it('scope: the item total, with the locations not recorded', () => {
    const c = verificationSummaryCopy(summary(), { timeZone: TZ });
    expect(c.scope).toBe('Item total counted. Which locations were checked was not recorded.');
    expect(c.scope).toBe(VERIFICATION_ITEM_TOTAL_SCOPE_COPY);
  });

  it('who counted and who posted', () => {
    expect(verificationSummaryCopy(summary(), { timeZone: TZ }).who).toBe(
      'Counted by Avery, posted by Blake.',
    );
    const same = summary({
      lastCount: count({
        countedBy: { id: 'u-a', label: 'Avery' },
        postedBy: { id: 'u-a', label: 'Avery' },
      }),
    });
    expect(verificationSummaryCopy(same, { timeZone: TZ }).who).toBe(
      'Counted and posted by Avery.',
    );
    const onlyPoster = summary({ lastCount: count({ countedBy: null }) });
    expect(verificationSummaryCopy(onlyPoster, { timeZone: TZ }).who).toBe('Posted by Blake.');
    const onlyCounter = summary({ lastCount: count({ postedBy: { id: 'u-b', label: null } }) });
    expect(verificationSummaryCopy(onlyCounter, { timeZone: TZ }).who).toBe('Counted by Avery.');
    // Names not resolved in this answer: left out, never guessed.
    const unnamed = summary({
      lastCount: count({
        countedBy: { id: 'u-a', label: null },
        postedBy: { id: 'u-b', label: null },
      }),
    });
    expect(verificationSummaryCopy(unnamed, { timeZone: TZ }).who).toBeNull();
  });

  it('offline capture: taken on the device, then synced', () => {
    const sameDay = summary({
      lastCount: count({ capturedAt: '2026-09-12T15:02:00Z', countedAt: '2026-09-12T15:40:00Z' }),
    });
    expect(verificationSummaryCopy(sameDay, { timeZone: TZ }).capture).toBe(
      'Taken 10:02 AM on the device, synced 10:40 AM',
    );
    const overnight = summary({
      lastCount: count({ capturedAt: '2026-09-12T02:30:00Z', countedAt: '2026-09-12T15:40:00Z' }),
    });
    expect(verificationSummaryCopy(overnight, { timeZone: TZ }).capture).toBe(
      'Taken Sep 11, 9:30 PM on the device, synced Sep 12, 10:40 AM',
    );
  });

  it('an online count (captured within two minutes of the record, or no capture) says nothing about the device', () => {
    const online = summary({
      lastCount: count({ capturedAt: '2026-09-12T15:01:30Z', countedAt: '2026-09-12T15:02:00Z' }),
    });
    expect(verificationSummaryCopy(online, { timeZone: TZ }).capture).toBeNull();
    expect(verificationSummaryCopy(summary(), { timeZone: TZ }).capture).toBeNull();
  });

  it('AI-assisted', () => {
    const ai = summary({ lastCount: count({ aiAssisted: true }) });
    expect(verificationSummaryCopy(ai, { timeZone: TZ }).aiAssisted).toBe(
      'Recorded with AI shelf-scan assistance',
    );
    expect(verificationSummaryCopy(ai, { timeZone: TZ }).aiAssisted).toBe(
      VERIFICATION_AI_ASSISTED_COPY,
    );
    expect(verificationSummaryCopy(summary(), { timeZone: TZ }).aiAssisted).toBeNull();
  });

  it('since then: movements (singular and plural), outside the ledger only when any, and the book now', () => {
    const none = verificationSummaryCopy(summary(), { timeZone: TZ });
    expect(none.movementsSince).toBe('0 recorded stock movements since');
    expect(none.outsideLedger).toBeNull();
    expect(none.bookNow).toBe('Book now: 12');
    const one = verificationSummaryCopy(summary({ movementsSince: 1 }), { timeZone: TZ });
    expect(one.movementsSince).toBe('1 recorded stock movement since');
    const some = verificationSummaryCopy(summary({ movementsSince: 3, outsideLedgerSince: 2 }), {
      timeZone: TZ,
    });
    expect(some.movementsSince).toBe('3 recorded stock movements since');
    expect(some.outsideLedger).toBe('2 recorded outside the stock ledger');
  });

  it('a count whose movements are unknown says so, never "0 movements"', () => {
    const c = verificationSummaryCopy(summary({ movementsSince: null }), { timeZone: TZ });
    expect(c.movementsSince).toBe(VERIFICATION_MOVEMENTS_UNKNOWN_COPY);
    expect(c.lines.join(' ')).not.toMatch(/\b0 recorded/);
  });

  it('in an open count', () => {
    const open = summary({ openCount: { cycleCountId: 'cc-45', countNumber: 45 } });
    expect(verificationSummaryCopy(open, { timeZone: TZ }).beingCounted).toEqual({
      text: 'Being counted in CC-000045',
      cycleCountId: 'cc-45',
    });
    const neverButOpen = summary({
      lastCount: null,
      movementsSince: null,
      openCount: { cycleCountId: 'cc-9', countNumber: null },
    });
    const c = verificationSummaryCopy(neverButOpen, { timeZone: TZ });
    expect(c.headline).toBe(VERIFICATION_NEVER_COUNTED_COPY);
    expect(c.beingCounted?.text).toBe('Being counted in an open count');
  });

  it('not countable: rental equipment and kits, archived, discontinued, deleted; never offered a count', () => {
    const cases: Array<[Partial<ItemVerificationSummary['item']>, string]> = [
      [{ isRental: true, countable: false }, 'Rental equipment and kits are not cycle counted'],
      [{ isBundle: true, countable: false }, 'Rental equipment and kits are not cycle counted'],
      [{ status: 'archived', countable: false }, 'Archived'],
      [{ status: 'discontinued', countable: false }, 'Discontinued'],
      [{ deleted: true, countable: false }, 'Deleted'],
    ];
    for (const [item, text] of cases) {
      for (const lastCount of [null, count()]) {
        const s = summary({ lastCount, item: { ...summary().item, ...item } });
        const c = verificationSummaryCopy(s, { timeZone: TZ, canCount: true });
        expect(c.notCountable).toBe(text);
        expect(c.countAction).toBeNull();
      }
    }
    expect(VERIFICATION_NOT_COUNTABLE_COPY.rental_or_kit).toBe(
      'Rental equipment and kits are not cycle counted',
    );
    expect(verificationSummaryCopy(summary(), { timeZone: TZ }).notCountable).toBeNull();
  });

  it('an item the server says is not countable for a reason this build does not know is never offered a count', () => {
    const odd = summary({ item: { ...summary().item, status: 'retired', countable: false } });
    expect(verificationNotCountableReason(odd.item)).toBe('archived');
    expect(verificationSummaryCopy(odd, { timeZone: TZ, canCount: true }).countAction).toBeNull();
  });

  it('lines come in display order', () => {
    const c = verificationSummaryCopy(
      summary({
        movementsSince: 2,
        outsideLedgerSince: 1,
        openCount: { cycleCountId: 'cc-45', countNumber: 45 },
        lastCount: count({ aiAssisted: true, capturedAt: '2026-09-12T14:00:00Z' }),
      }),
      { timeZone: TZ, canCount: true },
    );
    expect(c.lines).toEqual([
      'Last physical count: Sep 12, 2026 · CC-000031',
      'Matched the book (10)',
      'Item total counted. Which locations were checked was not recorded.',
      'Counted by Avery, posted by Blake.',
      'Taken 9:00 AM on the device, synced 10:02 AM',
      'Recorded with AI shelf-scan assistance',
      '2 recorded stock movements since',
      '1 recorded outside the stock ledger',
      'Book now: 12',
      'Being counted in CC-000045',
      'Count this item',
    ]);
  });
});

describe('the words never say "verified" and never show a percentage', () => {
  const variants: Array<ItemVerificationSummary | null> = [
    null,
    neverCounted(),
    summary(),
    summary({ lastCount: count({ expectedQuantity: 8, countedQuantity: 10 }) }),
    summary({ lastCount: count({ expectedAtStart: null }) }),
    summary({
      lastCount: count({
        countedLocationId: 'r',
        countedLocation: { name: 'A-12', kind: 'rack', type: 'shelf', archived: true },
      }),
    }),
    summary({ lastCount: count({ aiAssisted: true, capturedAt: '2026-09-11T01:00:00Z' }) }),
    summary({ movementsSince: null }),
    summary({
      movementsSince: 7,
      outsideLedgerSince: 3,
      openCount: { cycleCountId: 'c', countNumber: 2 },
    }),
    summary({
      item: {
        status: 'archived',
        isRental: true,
        isBundle: true,
        deleted: true,
        countable: false,
        quantityOnHand: 0,
      },
    }),
  ];
  it('item card, every state', () => {
    for (const v of variants) {
      for (const canCount of [true, false]) {
        const text = verificationSummaryCopy(v, { timeZone: TZ, canCount }).lines.join('\n');
        expect(text).not.toMatch(/verif(ied|y)/i);
        expect(text).not.toMatch(/%|percent|accura|confirm|score/i);
      }
    }
  });
  it('location rows, totals and the recount reason', () => {
    const texts: string[] = [];
    for (const v of variants) {
      const r = locationRowVerificationCopy(v, HERE, { timeZone: TZ });
      texts.push(r.count, r.movementsSince ?? '', r.beingCounted?.text ?? '', r.notCountable ?? '');
    }
    texts.push(
      locationVerificationTotalsCopy(
        locationVerificationTotals(
          variants.map((summary) => ({ quantity: 3, summary })),
          HERE,
          { items: 2, quantity: 5 },
        ),
      ),
      LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY,
      LOCATION_OPEN_ISSUES_OUT_OF_SCOPE_COPY,
      LOCATION_NO_VISIBLE_OPEN_ISSUES_COPY,
      LOCATION_NO_OPEN_ISSUES_COPY,
      LOCATION_HOLDINGS_TRUNCATED_COPY,
      locationRecountProblem(0) ?? '',
      locationRecountProblem(500) ?? '',
      LOCATION_RECOUNT_LABEL,
    );
    const all = texts.join('\n');
    expect(all).not.toMatch(/verif(ied|y)/i);
    expect(all).not.toMatch(/%|percent|accura|confirm|score/i);
  });
});

describe('location rows', () => {
  it('counted while THIS was the only shelf location (a rack page)', () => {
    const s = summary({
      lastCount: count({
        countedLocationId: HERE,
        countedLocation: { name: 'A-12', kind: 'rack', type: 'shelf', archived: false },
      }),
    });
    expect(
      locationRowVerificationCopy(s, HERE, {
        timeZone: TZ,
        locationKind: 'rack',
        locationType: 'shelf',
      }).count,
    ).toBe('Counted Sep 12, 2026, while this was its only shelf location');
  });
  it('a Site page (or a page whose kind is not given): its only place outside Staging, never a shelf', () => {
    const s = summary({ lastCount: count({ countedLocationId: HERE }) });
    expect(
      locationRowVerificationCopy(s, HERE, {
        timeZone: TZ,
        locationKind: null,
        locationType: 'jobsite',
      }).count,
    ).toBe('Counted Sep 12, 2026, while this was its only place outside Staging');
    expect(locationRowVerificationCopy(s, HERE, { timeZone: TZ }).count).toBe(
      'Counted Sep 12, 2026, while this was its only place outside Staging',
    );
  });
  // L1 (review 2026-09-27): a link or typed URL may carry an upper-case id;
  // the database answers in lower case.
  it('matches the page to the counted location whatever the case of the id', () => {
    const here = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const s = summary({ lastCount: count({ countedLocationId: here }) });
    expect(
      locationRowVerificationCopy(s, here.toUpperCase(), {
        timeZone: TZ,
        locationKind: 'rack',
        locationType: 'shelf',
      }).count,
    ).toBe('Counted Sep 12, 2026, while this was its only shelf location');
    expect(
      locationVerificationTotals([{ quantity: 1, summary: s }], here.toUpperCase()).countedHere,
    ).toBe(1);
  });
  it('the item total, location not recorded', () => {
    expect(locationRowVerificationCopy(summary(), HERE, { timeZone: TZ }).count).toBe(
      'Item total counted Sep 12, 2026, location not recorded',
    );
  });
  it('counted while ANOTHER location was its only one (moved here since): never "this was"', () => {
    const s = summary({
      lastCount: count({
        countedLocationId: 'elsewhere',
        countedLocation: { name: 'B-3', kind: 'rack', type: 'shelf', archived: false },
      }),
    });
    expect(locationRowVerificationCopy(s, HERE, { timeZone: TZ }).count).toBe(
      'Item total counted Sep 12, 2026, while B-3 was its only shelf location',
    );
  });
  // M1: never "all of it" (Staging may also have held some).
  it('the Unplaced page: "while this was its only place outside Staging"; a count at Unplaced seen from a rack page', () => {
    const atUnplaced = summary({
      lastCount: count({
        countedLocationId: HERE,
        countedLocation: { name: 'Unplaced', kind: 'unplaced', type: 'other', archived: false },
      }),
    });
    const here = locationRowVerificationCopy(atUnplaced, HERE, {
      timeZone: TZ,
      locationKind: 'unplaced',
      locationType: 'other',
    }).count;
    expect(here).toBe('Counted Sep 12, 2026, while this was its only place outside Staging');
    const fromRack = locationRowVerificationCopy(atUnplaced, 'rack-page', {
      timeZone: TZ,
      locationKind: 'rack',
      locationType: 'shelf',
    }).count;
    expect(fromRack).toBe(
      'Item total counted Sep 12, 2026, while Unplaced was its only place outside Staging, on no rack',
    );
    expect(`${here}\n${fromRack}`).not.toMatch(/all of it|shelf/);
  });
  it('not counted, and unavailable (never "Not counted" for a failed read)', () => {
    expect(locationRowVerificationCopy(neverCounted(), HERE, { timeZone: TZ }).count).toBe(
      'Not counted',
    );
    expect(locationRowVerificationCopy(null, HERE, { timeZone: TZ }).count).toBe(
      "Couldn't load verification",
    );
  });
  it('movements since and the open count ride along', () => {
    const r = locationRowVerificationCopy(
      summary({ movementsSince: 1, openCount: { cycleCountId: 'cc-2', countNumber: 2 } }),
      HERE,
      { timeZone: TZ },
    );
    expect(r.movementsSince).toBe('1 recorded stock movement since');
    expect(r.beingCounted?.text).toBe('Being counted in CC-000002');
  });
});

describe('location totals cover every row', () => {
  const rows = [
    { quantity: 4, summary: summary({ lastCount: count({ countedLocationId: HERE }) }) },
    { quantity: 2.5, summary: summary() },
    { quantity: 1, summary: neverCounted() },
    { quantity: 3, summary: null },
    {
      quantity: 1,
      summary: summary({ item: { ...summary().item, isRental: true, countable: false } }),
    },
  ];
  it('counts each kind of row, and the countable ones', () => {
    expect(locationVerificationTotals(rows, HERE, { items: 1, quantity: 6 })).toEqual({
      items: 5,
      quantity: 11.5,
      countedHere: 1,
      countedItemTotal: 2,
      notCounted: 1,
      unavailable: 1,
      hiddenItems: 1,
      hiddenQuantity: 6,
      countable: 3,
    });
  });
  it('reads as one line, naming what is not listed', () => {
    expect(
      locationVerificationTotalsCopy(
        locationVerificationTotals(rows, HERE, { items: 1, quantity: 6 }),
        { locationKind: 'rack', locationType: 'shelf' },
      ),
    ).toBe(
      '5 items, 11.5 units here. 1 counted while this was its only shelf location, 2 item totals counted, 1 not counted, 1 could not be loaded. 1 more item here (6 units) is not listed because you cannot open it.',
    );
    expect(locationVerificationTotalsCopy(locationVerificationTotals([], HERE))).toBe(
      '0 items, 0 units here.',
    );
    // A page whose kind is not given is not assumed to be a shelf.
    expect(
      locationVerificationTotalsCopy(
        locationVerificationTotals(rows, HERE, { items: 1, quantity: 6 }),
      ),
    ).toMatch(
      /^5 items, 11\.5 units here\. 1 counted while this was its only place outside Staging, /,
    );
    expect(
      locationVerificationTotalsCopy(
        locationVerificationTotals([{ quantity: 1, summary: neverCounted() }], HERE),
      ),
    ).toBe('1 item, 1 unit here. 1 not counted.');
  });
});

describe('locationRecountProblem', () => {
  // L5 (review 2026-09-27): a partial holdings read cannot back a recount of
  // "the items here", on the web as on the phone.
  it('a holdings read that reached its cap: the totals are partial, so no recount', () => {
    expect(LOCATION_HOLDINGS_CAP).toBe(20_000);
    expect(LOCATION_HOLDINGS_TRUNCATED_COPY).toBe(
      'Only the first 20,000 holdings here were read, so these totals are partial.',
    );
    for (const n of [0, 1, 200, 201]) {
      expect(locationRecountProblem(n, { truncated: true })).toBe(LOCATION_HOLDINGS_TRUNCATED_COPY);
    }
    expect(locationRecountProblem(5, { truncated: false })).toBeNull();
  });
  it("locationRecountProblemOf: the server's reason, else a partial read, else the item count", () => {
    const totals = { countable: 5 };
    expect(
      locationRecountProblemOf({ recountProblem: 'Server says no.', truncated: true, totals }),
    ).toBe('Server says no.');
    expect(locationRecountProblemOf({ recountProblem: null, truncated: true, totals })).toBe(
      LOCATION_HOLDINGS_TRUNCATED_COPY,
    );
    expect(locationRecountProblemOf({ recountProblem: null, truncated: false, totals })).toBeNull();
    expect(
      locationRecountProblemOf({
        recountProblem: null,
        truncated: false,
        totals: { countable: 0 },
      }),
    ).toBe('Nothing here can be counted.');
  });
  it('nothing countable, within the cap, and above it (the 200-item recount cap)', () => {
    expect(locationRecountProblem(0)).toBe('Nothing here can be counted.');
    expect(locationRecountProblem(1)).toBeNull();
    expect(locationRecountProblem(200)).toBeNull();
    expect(locationRecountProblem(201)).toBe(
      'A recount can include at most 200 items, and 201 items here can be counted. Count this location from Cycle Counts instead.',
    );
  });
});

describe('verificationIssueChipCopy', () => {
  it('reference and rule heading; an unknown rule reads as its reference alone', () => {
    expect(verificationIssueChipCopy({ number: 42, rule: 'count_variance' })).toBe(
      'EX-000042 · Count did not match the book',
    );
    expect(verificationIssueChipCopy({ number: 7, rule: 'stale_staging' })).toBe(
      'EX-000007 · Sitting in Staging',
    );
    expect(verificationIssueChipCopy({ number: 8, rule: 'future_rule' })).toBe('EX-000008');
    expect(verificationIssueChipCopy({ number: null, rule: 'future_rule' })).toBe('Open exception');
  });
});

describe('parseItemVerificationSummary (the phone reads the API)', () => {
  it('round-trips what the server sends', () => {
    const s = summary({
      movementsSince: 2,
      outsideLedgerSince: 1,
      openCount: { cycleCountId: 'cc-45', countNumber: 45 },
      lastCount: count({
        countedLocationId: 'r',
        countedLocation: { name: 'A-12', kind: 'rack', type: 'shelf', archived: false },
      }),
    });
    expect(parseItemVerificationSummary(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseItemVerificationSummary(JSON.parse(JSON.stringify(neverCounted())))).toEqual(
      neverCounted(),
    );
  });
  it('a server that sends no location type: type null (never a shelf by default)', () => {
    const s = summary({
      lastCount: count({
        countedLocationId: 'r',
        countedLocation: { name: 'A-12', kind: 'rack', type: 'shelf', archived: false },
      }),
    });
    const raw = JSON.parse(JSON.stringify(s)) as Record<string, any>;
    delete raw.lastCount.countedLocation.type;
    expect(parseItemVerificationSummary(raw)!.lastCount!.countedLocation).toEqual({
      name: 'A-12',
      kind: 'rack',
      type: null,
      archived: false,
    });
  });
  it('anything it cannot read is null (worded as unavailable), never a never-counted summary', () => {
    for (const bad of [
      null,
      'x',
      [],
      {},
      { itemId: 'i' },
      { itemId: 'i', item: { isRental: 'no' } },
    ]) {
      expect(parseItemVerificationSummary(bad)).toBeNull();
    }
    const noLastCountKey = JSON.parse(JSON.stringify(summary())) as Record<string, unknown>;
    delete noLastCountKey.lastCount;
    expect(parseItemVerificationSummary(noLastCountKey)).toBeNull();
    const garbledCount = JSON.parse(JSON.stringify(summary())) as Record<string, any>;
    garbledCount.lastCount.countedQuantity = 'ten';
    expect(parseItemVerificationSummary(garbledCount)).toBeNull();
    expect(verificationSummaryCopy(parseItemVerificationSummary(garbledCount)).headline).toBe(
      "Couldn't load verification",
    );
  });
  it('a garbled movements number is unknown, not 0', () => {
    const raw = JSON.parse(JSON.stringify(summary({ movementsSince: 4 }))) as Record<
      string,
      unknown
    >;
    raw.movementsSince = 'four';
    const parsed = parseItemVerificationSummary(raw)!;
    expect(parsed.movementsSince).toBeNull();
    expect(verificationSummaryCopy(parsed, { timeZone: TZ }).movementsSince).toBe(
      VERIFICATION_MOVEMENTS_UNKNOWN_COPY,
    );
  });
});

// A count recorded at Staging. The trigger never records Staging (it leaves
// Staging out of the candidates; pgTAP 0374 S29), and counted_location_id is
// not client-writable since 0368, but a line written before then could name
// it. Its words must never contradict themselves: "Staging was its only place
// outside Staging" (verify pass, 2026-09-27). They say only what such a
// record can mean: the item had stock in Staging when it was counted.
describe('a count recorded at Staging (defensive: the trigger never records it)', () => {
  const STAGING = 'loc-staging';
  const atStaging = (): ItemVerificationSummary =>
    summary({
      lastCount: count({
        countedLocationId: STAGING,
        countedLocation: { name: 'Staging', kind: 'staging', type: 'other', archived: false },
      }),
    });

  it('the item card', () => {
    const scope = verificationSummaryCopy(atStaging(), { timeZone: TZ }).scope;
    expect(scope).toBe('Counted while it had stock in Staging');
  });

  it('a row on another page', () => {
    expect(
      locationRowVerificationCopy(atStaging(), HERE, {
        timeZone: TZ,
        locationKind: 'rack',
        locationType: 'shelf',
      }).count,
    ).toBe('Item total counted Sep 12, 2026, while it had stock in Staging');
  });

  it("the Staging page's rows and totals", () => {
    expect(
      locationRowVerificationCopy(atStaging(), STAGING, {
        timeZone: TZ,
        locationKind: 'staging',
        locationType: 'other',
      }).count,
    ).toBe('Counted Sep 12, 2026, while it had stock here');
    const one = locationVerificationTotals([{ quantity: 2, summary: atStaging() }], STAGING);
    expect(
      locationVerificationTotalsCopy(one, { locationKind: 'staging', locationType: 'other' }),
    ).toBe('1 item, 2 units here. 1 counted while it had stock here.');
    const two = locationVerificationTotals(
      [
        { quantity: 2, summary: atStaging() },
        { quantity: 3, summary: atStaging() },
      ],
      STAGING,
    );
    expect(
      locationVerificationTotalsCopy(two, { locationKind: 'staging', locationType: 'other' }),
    ).toBe('2 items, 5 units here. 2 counted while they had stock here.');
  });

  it('never says Staging was its only place outside Staging, anywhere', () => {
    const words = [
      verificationSummaryCopy(atStaging(), { timeZone: TZ }).lines.join('\n'),
      locationRowVerificationCopy(atStaging(), HERE, { timeZone: TZ }).count,
      locationRowVerificationCopy(atStaging(), STAGING, {
        timeZone: TZ,
        locationKind: 'staging',
      }).count,
      locationVerificationTotalsCopy(
        locationVerificationTotals([{ quantity: 2, summary: atStaging() }], STAGING),
        { locationKind: 'staging' },
      ),
    ].join('\n');
    expect(words).not.toMatch(/outside Staging|only shelf location|all of it/);
  });
});

// M1 and L2: the totals on the Unplaced page and on a Site's page. Never "all
// of it" / "all their stock" (Staging may also have held some), never a shelf.
describe('location totals on the Unplaced page and a Site page (not shelves)', () => {
  const countedHere = (): ItemVerificationSummary =>
    summary({ lastCount: count({ countedLocationId: HERE }) });
  it.each([
    ['unplaced', 'other'],
    [null, 'jobsite'],
    [null, 'warehouse'],
  ])('kind %s, type %s: "counted while this was its only place outside Staging"', (kind, type) => {
    const one = locationVerificationTotalsCopy(
      locationVerificationTotals([{ quantity: 2, summary: countedHere() }], HERE),
      { locationKind: kind, locationType: type },
    );
    expect(one).toBe(
      '1 item, 2 units here. 1 counted while this was its only place outside Staging.',
    );
    const many = locationVerificationTotalsCopy(
      locationVerificationTotals(
        [
          { quantity: 2, summary: countedHere() },
          { quantity: 3, summary: countedHere() },
        ],
        HERE,
      ),
      { locationKind: kind, locationType: type },
    );
    expect(many).toBe(
      '2 items, 5 units here. 2 counted while this was their only place outside Staging.',
    );
    expect(`${one}\n${many}`).not.toMatch(/shelf|all of it|all their/);
  });
  it('a rack, crate or bin page: their only shelf location', () => {
    for (const [kind, type] of [
      ['rack', 'shelf'],
      ['crate', 'other'],
      [null, 'bin'],
    ] as const) {
      expect(
        locationVerificationTotalsCopy(
          locationVerificationTotals([{ quantity: 2, summary: countedHere() }], HERE),
          { locationKind: kind, locationType: type },
        ),
      ).toBe('1 item, 2 units here. 1 counted while this was its only shelf location.');
    }
  });
});

// M2 (review 2026-09-27): "Open issues here" is read under the reader's RLS,
// so an empty list is "none recorded" only when nothing here is hidden.
describe('locationOpenIssuesEmptyCopy', () => {
  const checkedAt = '2026-09-24T18:00:02Z';
  it("out of the reader's warehouses: says so, never that none are recorded", () => {
    for (const at of [checkedAt, null]) {
      const c = locationOpenIssuesEmptyCopy({
        holdingsVisible: false,
        hiddenItems: 0,
        checkedAt: at,
      });
      expect(c).toEqual({ kind: 'out_of_scope', text: LOCATION_OPEN_ISSUES_OUT_OF_SCOPE_COPY });
      expect(c.text).toBe(
        'This location is in a warehouse you are not assigned to, so its open exceptions are not listed here.',
      );
      expect(c.text).not.toMatch(/No open exceptions/);
    }
  });
  it('items here the reader cannot open: "none you can see"', () => {
    expect(
      locationOpenIssuesEmptyCopy({ holdingsVisible: true, hiddenItems: 2, checkedAt }),
    ).toEqual({
      kind: 'none',
      text: 'No open exceptions you can see are recorded here.',
    });
    expect(LOCATION_NO_VISIBLE_OPEN_ISSUES_COPY).toBe(
      'No open exceptions you can see are recorded here.',
    );
  });
  it('nothing hidden: none recorded at this location; before the first check: that it has not run', () => {
    expect(
      locationOpenIssuesEmptyCopy({ holdingsVisible: true, hiddenItems: 0, checkedAt }),
    ).toEqual({
      kind: 'none',
      text: LOCATION_NO_OPEN_ISSUES_COPY,
    });
    expect(LOCATION_NO_OPEN_ISSUES_COPY).toBe('No open exceptions are recorded at this location.');
    expect(
      locationOpenIssuesEmptyCopy({ holdingsVisible: true, hiddenItems: 3, checkedAt: null }),
    ).toEqual({ kind: 'first_check_pending', text: EXCEPTION_FIRST_CHECK_PENDING_COPY });
  });
});

// L5 (review 2026-09-27): a refused read reads the same on the web card and
// the phone card.
describe('verificationRefusalOf / verificationRefusalCopy', () => {
  it('maps the service codes and reasons; anything else is a failed read (null)', () => {
    expect(verificationRefusalOf('not_found', undefined)).toBe('not_found');
    expect(verificationRefusalOf('validation_error', 'invalid_item_id')).toBe('invalid_id');
    expect(verificationRefusalOf('forbidden', undefined)).toBe('forbidden');
    expect(verificationRefusalOf('forbidden', 'aal2_required')).toBe('aal2_required');
    expect(verificationRefusalOf('forbidden', 'mfa_required')).toBe('mfa_required');
    expect(verificationRefusalOf('internal_error', undefined)).toBeNull();
    expect(verificationRefusalOf(undefined, undefined)).toBeNull();
  });
  it('the words', () => {
    expect(verificationRefusalCopy('not_found', 'item')).toBe(
      'This item is not available to you, or it no longer exists.',
    );
    expect(verificationRefusalCopy('not_found', 'location')).toBe(
      'This location is not available to you, or it no longer exists.',
    );
    expect(verificationRefusalCopy('forbidden', 'item')).toBe(
      'You do not have permission to see this.',
    );
    expect(verificationRefusalCopy('invalid_id', 'location')).toBe('This link is not valid.');
    expect(verificationRefusalCopy('aal2_required', 'item')).toMatch(/authenticator app/);
    expect(verificationRefusalCopy('mfa_required', 'item')).toMatch(/two-factor/);
    expect(VERIFICATION_SESSION_ENDED_COPY).toBe('Your session has ended. Sign in again.');
  });
});
