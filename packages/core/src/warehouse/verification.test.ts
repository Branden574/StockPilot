import { describe, expect, it } from 'vitest';

import {
  LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY,
  LOCATION_RECOUNT_LABEL,
  locationRecountProblem,
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
  VERIFICATION_UNAVAILABLE_COPY,
  verificationIssueChipCopy,
  verificationNotCountableReason,
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
        countedLocation: { name: 'A-12', kind: 'rack', archived: false },
      }),
    });
    expect(verificationSummaryCopy(at, { timeZone: TZ }).scope).toBe(
      'Counted while A-12 was its only shelf location',
    );
    const gone = summary({ lastCount: count({ countedLocationId: 'r-3', countedLocation: null }) });
    expect(verificationSummaryCopy(gone, { timeZone: TZ }).scope).toBe(
      'Counted while one shelf location, since removed, was its only shelf location',
    );
  });

  it('scope: a count recorded at Unplaced or Staging never calls the bucket a shelf', () => {
    const unplaced = summary({
      lastCount: count({
        countedLocationId: 'u',
        countedLocation: { name: 'Unplaced', kind: 'unplaced', archived: false },
      }),
    });
    expect(verificationSummaryCopy(unplaced, { timeZone: TZ }).scope).toBe(
      'Counted while all of it was Unplaced, on no rack',
    );
    const staging = summary({
      lastCount: count({
        countedLocationId: 's',
        countedLocation: { name: 'Staging WH1', kind: 'staging', archived: false },
      }),
    });
    expect(verificationSummaryCopy(staging, { timeZone: TZ }).scope).toBe(
      'Counted while all of it was in Staging',
    );
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
        countedLocation: { name: 'A-12', kind: 'rack', archived: true },
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
  it('counted while THIS was the only shelf location', () => {
    const s = summary({
      lastCount: count({
        countedLocationId: HERE,
        countedLocation: { name: 'A-12', kind: 'rack', archived: false },
      }),
    });
    expect(locationRowVerificationCopy(s, HERE, { timeZone: TZ }).count).toBe(
      'Counted Sep 12, 2026, while this was its only shelf location',
    );
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
        countedLocation: { name: 'B-3', kind: 'rack', archived: false },
      }),
    });
    expect(locationRowVerificationCopy(s, HERE, { timeZone: TZ }).count).toBe(
      'Item total counted Sep 12, 2026, while B-3 was its only shelf location',
    );
  });
  it('a location page for Unplaced or Staging: "while all of it was here"; a count at Unplaced seen from a rack page', () => {
    const atUnplaced = summary({
      lastCount: count({
        countedLocationId: HERE,
        countedLocation: { name: 'Unplaced', kind: 'unplaced', archived: false },
      }),
    });
    expect(
      locationRowVerificationCopy(atUnplaced, HERE, { timeZone: TZ, locationKind: 'unplaced' })
        .count,
    ).toBe('Counted Sep 12, 2026, while all of it was here');
    expect(
      locationRowVerificationCopy(atUnplaced, 'rack-page', { timeZone: TZ, locationKind: 'rack' })
        .count,
    ).toBe('Item total counted Sep 12, 2026, while all of it was Unplaced, on no rack');
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
      ),
    ).toBe(
      '5 items, 11.5 units here. 1 counted while this was its only shelf location, 2 item totals counted, 1 not counted, 1 could not be loaded. 1 more item here (6 units) is not listed because you cannot open it.',
    );
    expect(locationVerificationTotalsCopy(locationVerificationTotals([], HERE))).toBe(
      '0 items, 0 units here.',
    );
    // A rack page, named as one explicitly: the same words.
    expect(
      locationVerificationTotalsCopy(
        locationVerificationTotals(rows, HERE, { items: 1, quantity: 6 }),
        { locationKind: 'rack' },
      ),
    ).toMatch(/^5 items, 11\.5 units here\. 1 counted while this was its only shelf location, /);
    expect(
      locationVerificationTotalsCopy(
        locationVerificationTotals([{ quantity: 1, summary: neverCounted() }], HERE),
      ),
    ).toBe('1 item, 1 unit here. 1 not counted.');
  });
});

describe('locationRecountProblem', () => {
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
        countedLocation: { name: 'A-12', kind: 'rack', archived: false },
      }),
    });
    expect(parseItemVerificationSummary(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseItemVerificationSummary(JSON.parse(JSON.stringify(neverCounted())))).toEqual(
      neverCounted(),
    );
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

describe('location totals on Staging and Unplaced pages (not shelves)', () => {
  const countedHere = (): ItemVerificationSummary =>
    summary({
      lastCount: count({
        countedLocationId: HERE,
        countedLocation: { name: 'Staging', kind: 'staging', archived: false },
      }),
    });
  it.each(['staging', 'unplaced'])(
    '%s: "counted while all of it was here", never a shelf',
    (kind) => {
      const one = locationVerificationTotalsCopy(
        locationVerificationTotals([{ quantity: 2, summary: countedHere() }], HERE),
        { locationKind: kind },
      );
      expect(one).toBe('1 item, 2 units here. 1 counted while all of it was here.');
      const many = locationVerificationTotalsCopy(
        locationVerificationTotals(
          [
            { quantity: 2, summary: countedHere() },
            { quantity: 3, summary: countedHere() },
          ],
          HERE,
        ),
        { locationKind: kind },
      );
      expect(many).toBe('2 items, 5 units here. 2 counted while all their stock was here.');
      expect(`${one}\n${many}`).not.toMatch(/shelf/);
    },
  );
});
