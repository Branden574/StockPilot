import { describe, expect, it } from 'vitest';

import {
  activeRecountCopy,
  COUNT_THIS_ITEM_LABEL,
  countStartAllowed,
  describeTimelineEvent,
  isCountableItem,
  parseRecountOutcome,
  RECOUNT_OFFLINE_COPY,
  recountDisabledReason,
  recountResultSummary,
  recountSelectedLabel,
  recountSelectionProblem,
  type RecountResultInput,
  isRecountableRule,
  isRecountSkipReason,
  isRecountUnavailableReason,
  RECOUNT_COUNTS_TOTAL_COPY,
  RECOUNT_REPLAY_UNKNOWN_COPY,
  RECOUNT_UNAVAILABLE_COPY,
  recountUnavailableCopy,
  RECOUNT_MANAGER_ONLY_COPY,
  RECOUNT_MAX_ITEMS,
  RECOUNT_NOTES_MAX,
  RECOUNT_SKIP_REASON_COPY,
  recountNotes,
  recountOutcome,
  recountOutcomeCopy,
  varianceDestination,
  varianceDestinationCopy,
  varianceReviewLine,
  type RecountOutcome,
} from './exception-recount';

const PEOPLE_WORDING = /employee|staff|theft|stole|someone|worker|picker|person|user/i;

describe('isRecountableRule', () => {
  it('is true for the two item-level rules only, and false for anything unknown', () => {
    expect(isRecountableRule('count_variance')).toBe(true);
    expect(isRecountableRule('over_reserved')).toBe(true);
    for (const r of ['stale_staging', 'long_unplaced', 'orphaned_stock', 'label_mismatch', 'x', null, 3]) {
      expect(isRecountableRule(r)).toBe(false);
    }
  });
});

describe('recountNotes', () => {
  it('names one item, counts several, and is null for none', () => {
    expect(recountNotes([])).toBeNull();
    expect(recountNotes([{ name: 'Atlas of the World' }])).toBe('Recount: Atlas of the World');
    expect(recountNotes([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('Recount: 3 items');
    // A name that could not be read still says how many.
    expect(recountNotes([{ name: '  ' }])).toBe('Recount: 1 item');
    expect(recountNotes([{ name: null }])).toBe('Recount: 1 item');
  });

  it('never exceeds 80 characters (it becomes a push title) and flattens line breaks', () => {
    const long = recountNotes([{ name: 'x'.repeat(300) }])!;
    expect(Array.from(long)).toHaveLength(RECOUNT_NOTES_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(recountNotes([{ name: 'Line one\nline two' }])).toBe('Recount: Line one line two');
    // A name that fits exactly is not cut.
    const fits = 'y'.repeat(RECOUNT_NOTES_MAX - 'Recount: '.length);
    expect(recountNotes([{ name: fits }])).toBe(`Recount: ${fits}`);
  });

  it('is neutral: it says which item, never why', () => {
    expect(recountNotes([{ name: 'Atlas' }])).not.toMatch(/variance|missing|wrong|exception/i);
  });
});

describe('recountOutcome', () => {
  const completed = { status: 'completed' };

  it('in progress carries n of m when both are known', () => {
    expect(recountOutcome({ status: 'in_progress', countedLines: 2, totalLines: 5 }, null)).toEqual({
      kind: 'in_progress',
      counted: 2,
      total: 5,
    });
    expect(recountOutcome({ status: 'in_progress', countedLines: -1, totalLines: 1.5 }, null)).toEqual({
      kind: 'in_progress',
      counted: null,
      total: null,
    });
  });

  it('cancelled, whichever spelling the row uses', () => {
    expect(recountOutcome({ status: 'canceled' }, null)).toEqual({ kind: 'cancelled' });
    expect(recountOutcome({ status: 'cancelled' }, null)).toEqual({ kind: 'cancelled' });
  });

  it('posted without counting this item', () => {
    expect(recountOutcome(completed, { countedQuantity: null, expectedQuantity: 10 })).toEqual({
      kind: 'not_counted',
    });
  });

  it('matched the book, and a numeric-string line from PostgREST reads the same', () => {
    expect(recountOutcome(completed, { countedQuantity: 10, expectedQuantity: 10 })).toEqual({
      kind: 'matched',
      quantity: 10,
    });
    expect(recountOutcome(completed, { countedQuantity: '10.0000', expectedQuantity: '10' })).toEqual({
      kind: 'matched',
      quantity: 10,
    });
  });

  it('book corrected from the book at count time to the counted number', () => {
    expect(recountOutcome(completed, { countedQuantity: 11, expectedQuantity: 10 })).toEqual({
      kind: 'corrected',
      from: 10,
      to: 11,
      delta: 1,
    });
    expect(recountOutcome(completed, { countedQuantity: 10, expectedQuantity: 10.1 })).toEqual({
      kind: 'corrected',
      from: 10.1,
      to: 10,
      delta: -0.1,
    });
  });

  // Mutation caught: treating an unreadable line as "matched" (or as "not
  // counted") would tell a manager the recount settled something it did not.
  it('an unreadable count or line is unavailable, never matched', () => {
    expect(recountOutcome(null, { countedQuantity: 1, expectedQuantity: 1 })).toEqual({ kind: 'unavailable' });
    expect(recountOutcome(completed, null)).toEqual({ kind: 'unavailable' });
    expect(recountOutcome(completed, { countedQuantity: 'abc', expectedQuantity: 1 })).toEqual({
      kind: 'unavailable',
    });
    expect(recountOutcome(completed, { countedQuantity: 3, expectedQuantity: null })).toEqual({
      kind: 'unavailable',
    });
    expect(recountOutcome({ status: 'mystery' }, null)).toEqual({ kind: 'unavailable' });
  });

  it('words every outcome', () => {
    const cases: Array<[RecountOutcome, string]> = [
      [{ kind: 'in_progress', counted: 1, total: 3 }, 'In progress: 1 of 3 counted'],
      [{ kind: 'in_progress', counted: null, total: 3 }, 'In progress'],
      [{ kind: 'cancelled' }, 'Cancelled before it was posted'],
      [{ kind: 'not_counted' }, 'Posted without counting this item'],
      [{ kind: 'matched', quantity: 10 }, 'Matched the book (10)'],
      [{ kind: 'corrected', from: 8, to: 10, delta: 2 }, 'Book corrected from 8 to 10 (+2)'],
      [{ kind: 'corrected', from: 10, to: 7, delta: -3 }, 'Book corrected from 10 to 7 (-3)'],
      [{ kind: 'superseded' }, 'Counted before a later count of this item, so it does not re-check it'],
      [{ kind: 'unavailable' }, 'Result not available'],
    ];
    for (const [o, text] of cases) expect(recountOutcomeCopy(o)).toBe(text);
  });

  // Review finding (F1-2): a recount line counted BEFORE the posted variance
  // read "Matched the book" while the exception stayed open. Mutation caught:
  // ignore `rechecks`, and the completed zero line reads "matched".
  it('a line that does not re-check the item is never "matched the book"', () => {
    const stale = { countedQuantity: 20, expectedQuantity: 20, rechecks: false };
    expect(recountOutcome({ status: 'completed' }, stale)).toEqual({ kind: 'superseded' });
    expect(recountOutcome({ status: 'in_progress', countedLines: 1, totalLines: 1 }, stale)).toEqual({
      kind: 'superseded',
    });
    // An open line not counted yet, or one that re-checks, is ordinary.
    expect(
      recountOutcome({ status: 'in_progress', countedLines: 0, totalLines: 1 }, { ...stale, countedQuantity: null }),
    ).toEqual({ kind: 'in_progress', counted: 0, total: 1 });
    expect(recountOutcome({ status: 'completed' }, { ...stale, rechecks: true })).toEqual({
      kind: 'matched',
      quantity: 20,
    });
    // Unknown (a server that does not say) keeps the numbers.
    expect(recountOutcome({ status: 'completed' }, { ...stale, rechecks: null })).toEqual({
      kind: 'matched',
      quantity: 20,
    });
    // A superseded line that still changed the stock says so.
    expect(recountOutcome({ status: 'completed' }, { countedQuantity: 21, expectedQuantity: 20, rechecks: false })).toEqual(
      { kind: 'corrected', from: 20, to: 21, delta: 1 },
    );
    // A cancelled count is cancelled whatever its line.
    expect(recountOutcome({ status: 'canceled' }, stale)).toEqual({ kind: 'cancelled' });
  });
});

describe('varianceDestination (mirrors post_cycle_count routing, 0342/0343)', () => {
  const rack = { name: 'Rack 12-A', kind: 'rack' };

  it('more than the book lands on the counted rack, else in Staging', () => {
    expect(varianceDestination({ countedQuantity: 11, expectedQuantity: 10, countedLocation: rack })).toEqual({
      kind: 'adds_to_location',
      location: 'Rack 12-A',
    });
    expect(varianceDestination({ countedQuantity: 11, expectedQuantity: 10, countedLocation: null })).toEqual({
      kind: 'adds_to_staging',
    });
  });

  it('less than the book comes off the counted rack first, else Staging first', () => {
    expect(varianceDestination({ countedQuantity: 8, expectedQuantity: 10, countedLocation: rack })).toEqual({
      kind: 'off_location_then_staging',
      location: 'Rack 12-A',
    });
    expect(varianceDestination({ countedQuantity: 8, expectedQuantity: 10, countedLocation: null })).toEqual({
      kind: 'off_staging_then_shelves',
    });
  });

  // Mutation caught: honouring an archived or Staging counted location, which
  // the post itself ignores (it routes those the no-location way).
  it('an archived or Staging counted location routes as if none were recorded', () => {
    for (const loc of [
      { ...rack, archived: true },
      { name: 'Staging', kind: 'staging' },
      { name: '  ', kind: 'rack' },
    ]) {
      expect(varianceDestination({ countedQuantity: 11, expectedQuantity: 10, countedLocation: loc })).toEqual({
        kind: 'adds_to_staging',
      });
    }
  });

  it('an Unplaced bucket reads by its kind, not its stored name', () => {
    expect(
      varianceDestination({
        countedQuantity: 3,
        expectedQuantity: 1,
        countedLocation: { name: 'Unplaced (DC4)', kind: 'unplaced' },
      }),
    ).toEqual({ kind: 'adds_to_location', location: 'Unplaced' });
  });

  it('a match changes nothing; an uncounted line has no destination', () => {
    expect(varianceDestination({ countedQuantity: 10, expectedQuantity: 10, countedLocation: rack })).toEqual({
      kind: 'none',
    });
    expect(varianceDestination({ countedQuantity: null, expectedQuantity: 10, countedLocation: rack })).toBeNull();
  });

  it('words each destination and the full review line', () => {
    expect(varianceDestinationCopy({ kind: 'adds_to_location', location: 'Rack 12-A' })).toBe('adds to Rack 12-A');
    expect(varianceDestinationCopy({ kind: 'adds_to_staging' })).toBe('adds to Staging');
    // Review finding (F1-2): the post drains the target, then Staging, then
    // continues into the other shelf locations (apply_level_delta
    // 'staging_first' falls through to the placed draw-down).
    expect(varianceDestinationCopy({ kind: 'off_location_then_staging', location: 'Rack 12-A' })).toBe(
      'comes off Rack 12-A first, then Staging, then other shelf locations',
    );
    expect(varianceDestinationCopy({ kind: 'off_staging_then_shelves' })).toBe(
      'comes off Staging first, then shelf locations',
    );
    expect(varianceDestinationCopy({ kind: 'none' })).toBe('no change to stock');
    expect(varianceReviewLine({ countedQuantity: 11, expectedQuantity: 10, countedLocation: rack })).toBe(
      'Counted 11, book 10 (+1): adds to Rack 12-A',
    );
    expect(varianceReviewLine({ countedQuantity: 10, expectedQuantity: 10, countedLocation: null })).toBe(
      'Counted 10, book 10: no change to stock',
    );
    expect(varianceReviewLine({ countedQuantity: null, expectedQuantity: 10, countedLocation: null })).toBeNull();
    expect(varianceReviewLine({ countedQuantity: 7, expectedQuantity: 10, countedLocation: rack })).toBe(
      'Counted 7, book 10 (-3): comes off Rack 12-A first, then Staging, then other shelf locations',
    );
  });

  // Review finding (F1-2): a stale line's review line must not say where a
  // difference lands (posting applies nothing, or is refused as superseded).
  it('a line that cannot re-check its item says so instead of a destination', () => {
    expect(
      varianceReviewLine({ countedQuantity: 10, expectedQuantity: 10, countedLocation: null, rechecks: false }),
    ).toBe('Counted 10, book 10: counted before a later count of this item, so it does not re-check it');
    expect(
      varianceReviewLine({ countedQuantity: 11, expectedQuantity: 10, countedLocation: rack, rechecks: false }),
    ).toBe('Counted 11, book 10 (+1): counted before a later count of this item, so it does not re-check it');
    expect(
      varianceReviewLine({ countedQuantity: 11, expectedQuantity: 10, countedLocation: rack, rechecks: true }),
    ).toBe('Counted 11, book 10 (+1): adds to Rack 12-A');
  });
});

describe('shared recount copy', () => {
  it('caps and reasons are what the database uses', () => {
    expect(RECOUNT_MAX_ITEMS).toBe(200);
    expect(Object.keys(RECOUNT_SKIP_REASON_COPY).sort()).toEqual(['not_countable', 'not_recountable', 'resolved']);
    for (const r of ['resolved', 'not_recountable', 'not_countable']) expect(isRecountSkipReason(r)).toBe(true);
    expect(isRecountSkipReason('other')).toBe(false);
  });

  it('says a count records the total, and never names or implies a person', () => {
    expect(RECOUNT_COUNTS_TOTAL_COPY).toMatch(/total, wherever it is stored/);
    for (const text of [RECOUNT_COUNTS_TOTAL_COPY, ...Object.values(RECOUNT_SKIP_REASON_COPY)]) {
      expect(text).not.toMatch(PEOPLE_WORDING);
    }
    expect(RECOUNT_MANAGER_ONLY_COPY).toMatch(/manager/);
  });
});

// ── F1-2 stage 3: the words the screens share ───────────────────────────────

describe('parseRecountOutcome', () => {
  it('reads every kind the server sends', () => {
    expect(parseRecountOutcome({ kind: 'in_progress', counted: 1, total: 3 })).toEqual({
      kind: 'in_progress',
      counted: 1,
      total: 3,
    });
    expect(parseRecountOutcome({ kind: 'in_progress', counted: null, total: null })).toEqual({
      kind: 'in_progress',
      counted: null,
      total: null,
    });
    expect(parseRecountOutcome({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' });
    expect(parseRecountOutcome({ kind: 'not_counted' })).toEqual({ kind: 'not_counted' });
    expect(parseRecountOutcome({ kind: 'matched', quantity: 21 })).toEqual({ kind: 'matched', quantity: 21 });
    expect(parseRecountOutcome({ kind: 'corrected', from: 10, to: 11, delta: 1 })).toEqual({
      kind: 'corrected',
      from: 10,
      to: 11,
      delta: 1,
    });
    expect(parseRecountOutcome({ kind: 'superseded' })).toEqual({ kind: 'superseded' });
  });

  // Mutation caught: a matched outcome with no quantity read as matched.
  it('never reads an incomplete or unknown outcome as matched', () => {
    for (const bad of [
      null,
      undefined,
      'matched',
      [],
      { kind: 'matched' },
      { kind: 'matched', quantity: '21' },
      { kind: 'corrected', from: 10, to: 11 },
      { kind: 'a_future_kind' },
    ]) {
      expect(parseRecountOutcome(bad)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('activeRecountCopy / describeTimelineEvent', () => {
  it('names the count and what it came to', () => {
    expect(activeRecountCopy({ countNumber: 31, outcome: { kind: 'in_progress', counted: 1, total: 3 } })).toBe(
      'Recount CC-000031: In progress: 1 of 3 counted',
    );
    expect(activeRecountCopy({ countNumber: null, outcome: { kind: 'unavailable' } })).toBe(
      'Recount: Result not available',
    );
  });

  it('adds the outcome to a closed recount only', () => {
    expect(
      describeTimelineEvent({
        kind: 'recount_closed',
        actorLabel: null,
        cycleCountNumber: 2,
        recountOutcome: { kind: 'matched', quantity: 21 },
      }),
    ).toBe('Recount CC-000002 closed: Matched the book (21)');
    expect(
      describeTimelineEvent({
        kind: 'recount_closed',
        actorLabel: null,
        cycleCountNumber: 2,
        recountOutcome: { kind: 'corrected', from: 10, to: 11, delta: 1 },
      }),
    ).toBe('Recount CC-000002 closed: Book corrected from 10 to 11 (+1)');
    // No outcome known: the plain headline, never a made-up result.
    expect(describeTimelineEvent({ kind: 'recount_closed', actorLabel: null, cycleCountNumber: 2 })).toBe(
      'Recount CC-000002 closed',
    );
    expect(
      describeTimelineEvent({
        kind: 'recount_linked',
        actorLabel: 'Ana',
        cycleCountNumber: 2,
        recountOutcome: { kind: 'matched', quantity: 21 },
      }),
    ).toBe('Recount CC-000002 linked by Ana');
  });
});

describe('countStartAllowed', () => {
  const all = new Set(['cycle_counts:assign', 'stock:adjust'] as const);

  it('needs the module, both permissions and the manager role', () => {
    expect(countStartAllowed({ role: 'manager', permissions: new Set(all), cycleCountsEnabled: true })).toBe(true);
    expect(countStartAllowed({ role: 'owner', permissions: new Set(all), cycleCountsEnabled: true })).toBe(true);
    expect(countStartAllowed({ role: 'manager', permissions: new Set(all), cycleCountsEnabled: false })).toBe(false);
    expect(
      countStartAllowed({ role: 'manager', permissions: new Set(['stock:adjust'] as const), cycleCountsEnabled: true }),
    ).toBe(false);
    expect(
      countStartAllowed({
        role: 'manager',
        permissions: new Set(['cycle_counts:assign'] as const),
        cycleCountsEnabled: true,
      }),
    ).toBe(false);
    // An override that grants a lower role both keys still stops at the role
    // (the cycle_counts INSERT policy is manager-only).
    expect(countStartAllowed({ role: 'staff', permissions: new Set(all), cycleCountsEnabled: true })).toBe(false);
    expect(countStartAllowed({ role: null, permissions: new Set(all), cycleCountsEnabled: true })).toBe(false);
  });

  it('falls back to the role defaults while the effective set is unknown', () => {
    expect(countStartAllowed({ role: 'manager', cycleCountsEnabled: true })).toBe(true);
    expect(countStartAllowed({ role: 'staff', cycleCountsEnabled: true })).toBe(false);
  });
});

describe('recountDisabledReason / selection', () => {
  it('permission first, then the connection', () => {
    expect(recountDisabledReason({ canRecount: false, online: false })).toBe(RECOUNT_MANAGER_ONLY_COPY);
    expect(recountDisabledReason({ canRecount: true, online: false })).toBe(RECOUNT_OFFLINE_COPY);
    expect(recountDisabledReason({ canRecount: true, online: true })).toBeNull();
  });

  // Review finding (F1-2): a manager was told "Only a manager..." when the
  // real reason was the Cycle Counts module being off.
  it('says the real reason Recount is withheld', () => {
    expect(recountUnavailableCopy('module_disabled')).toBe(
      'Cycle Counts is turned off for this organization, so a recount cannot be started.',
    );
    expect(recountUnavailableCopy('not_permitted')).toBe(RECOUNT_MANAGER_ONLY_COPY);
    // Unknown or missing: the permission rule, as before.
    expect(recountUnavailableCopy(undefined)).toBe(RECOUNT_MANAGER_ONLY_COPY);
    expect(recountUnavailableCopy('something_new')).toBe(RECOUNT_MANAGER_ONLY_COPY);
    expect(
      recountDisabledReason({ canRecount: false, online: true, unavailableReason: 'module_disabled' }),
    ).toBe(RECOUNT_UNAVAILABLE_COPY.module_disabled);
    for (const r of ['module_disabled', 'not_permitted']) expect(isRecountUnavailableReason(r)).toBe(true);
    expect(isRecountUnavailableReason('x')).toBe(false);
  });

  it('labels the selection and refuses an empty or oversized one', () => {
    expect(recountSelectedLabel(3)).toBe('Recount selected (3)');
    expect(recountSelectionProblem(0)).not.toBeNull();
    expect(recountSelectionProblem(1)).toBeNull();
    expect(recountSelectionProblem(RECOUNT_MAX_ITEMS)).toBeNull();
    expect(recountSelectionProblem(RECOUNT_MAX_ITEMS + 1)).toMatch(/at most 200/);
  });
});

describe('isCountableItem', () => {
  it('is start_cycle_count’s predicate', () => {
    expect(isCountableItem({ status: 'active' })).toBe(true);
    expect(isCountableItem({ status: 'active', is_rental: false, is_bundle: false, deleted_at: null })).toBe(true);
    expect(isCountableItem({ status: 'archived' })).toBe(false);
    expect(isCountableItem({ status: 'discontinued' })).toBe(false);
    expect(isCountableItem({ status: 'active', is_rental: true })).toBe(false);
    expect(isCountableItem({ status: 'active', is_bundle: true })).toBe(false);
    expect(isCountableItem({ status: 'active', deleted_at: '2026-09-01T00:00:00Z' })).toBe(false);
    expect(isCountableItem(null)).toBe(false);
    expect(COUNT_THIS_ITEM_LABEL).toBe('Count this item');
  });
});

describe('recountResultSummary', () => {
  const base: RecountResultInput = {
    cycleCountId: 'cc-new',
    countNumber: 2,
    lineCount: 3,
    created: true,
    replay: false,
    assignedTo: 'u-staff',
    assignmentFailed: false,
    linkedExisting: [],
    skipped: [],
  };

  it('started, assigned', () => {
    const s = recountResultSummary(base, { assigneeLabel: 'QA Staff' });
    expect(s.started).toEqual({ cycleCountId: 'cc-new', text: 'Started CC-000002 (3 items)' });
    expect(s.assignment).toBe('Assigned to QA Staff, who gets a notification.');
    expect(s.alreadyCounting).toEqual([]);
    expect(s.skipped).toEqual([]);
    expect(s.nothing).toBeNull();
    expect(recountResultSummary({ ...base, lineCount: 1 }).started?.text).toBe('Started CC-000002 (1 item)');
  });

  // Mutation caught: an assignment failure worded as "Assigned".
  it('says when assigning failed and when nobody was chosen', () => {
    expect(recountResultSummary({ ...base, assignedTo: null, assignmentFailed: true }).assignment).toBe(
      'It was started unassigned and nobody was notified. Assign it from the count.',
    );
    expect(recountResultSummary({ ...base, assignedTo: null }).assignment).toBe(
      'Not assigned to anyone yet. Assign it from the count.',
    );
  });

  it('a replay names the first count and says no second one was made', () => {
    const s = recountResultSummary({ ...base, created: false, replay: true, lineCount: null });
    expect(s.started?.text).toBe(
      'Started CC-000002. This request had already been received, so no second count was made.',
    );
  });

  it('already being counted: count, assignee, age, and "linked" only when exceptions were linked', () => {
    const s = recountResultSummary(
      {
        ...base,
        cycleCountId: null,
        countNumber: null,
        lineCount: null,
        created: false,
        assignedTo: null,
        linkedExisting: [
          {
            cycleCountId: 'cc-1',
            countNumber: 1,
            assignedTo: { id: 'u1', label: 'Ana' },
            startedAt: '2026-09-24T18:00:00Z',
            itemIds: ['i1'],
            occurrenceIds: ['o1'],
          },
          {
            cycleCountId: 'cc-3',
            countNumber: 3,
            assignedTo: null,
            startedAt: null,
            itemIds: ['i2', 'i3'],
            occurrenceIds: [],
          },
          {
            cycleCountId: 'cc-4',
            countNumber: 4,
            assignedTo: { id: 'u2', label: null },
            startedAt: null,
            itemIds: ['i4'],
            occurrenceIds: ['o4'],
          },
        ],
      },
      { timeZone: 'America/Los_Angeles' },
    );
    expect(s.started).toBeNull();
    expect(s.assignment).toBeNull();
    expect(s.alreadyCounting.map((a) => a.text)).toEqual([
      'Already being counted in CC-000001 (assigned to Ana, open since Sep 24), linked',
      '2 items already being counted in CC-000003 (unassigned)',
      'Already being counted in CC-000004 (assigned to a team member), linked',
    ]);
    expect(s.nothing).toBeNull();
  });

  it('skipped rows name the item and the reason once, and all-skipped says nothing started', () => {
    const s = recountResultSummary({
      ...base,
      cycleCountId: null,
      countNumber: null,
      created: false,
      assignedTo: null,
      skipped: [
        { itemId: 'i1', itemName: 'Projector', reason: 'not_countable' },
        { itemId: 'i1', itemName: 'Projector', reason: 'not_countable' },
        { itemId: 'i2', itemName: null, reason: 'resolved' },
      ],
    });
    expect(s.skipped).toEqual([
      'Skipped: Projector: Rental equipment, kits and archived items are not counted',
      'Skipped: An item: Already resolved',
    ]);
    expect(s.nothing).toBe('No count was started.');
  });

  // Review finding (F1-2): an exception skipped as resolved read
  // "Skipped: Chromebook: Already resolved" next to "Started CC-000040" for the
  // same item. Mutation caught: word every skip as the item.
  it('an exception left out is worded as the exception, not the item', () => {
    const s = recountResultSummary({
      ...base,
      lineCount: 1,
      skipped: [
        { itemId: 'i1', itemName: 'Chromebook', reason: 'resolved', occurrenceId: 'o1', occurrenceReference: 'EX-000012' },
        { itemId: 'i1', itemName: 'Chromebook', reason: 'resolved', occurrenceId: 'o1', occurrenceReference: 'EX-000012' },
        { itemId: 'i2', itemName: null, reason: 'not_recountable', occurrenceId: 'o2', occurrenceReference: null },
        { itemId: 'i3', itemName: 'Projector', reason: 'not_countable', occurrenceId: 'o3', occurrenceReference: 'EX-000013' },
      ],
    });
    expect(s.started?.text).toBe('Started CC-000002 (1 item)');
    expect(s.skipped).toEqual([
      'Not linked: EX-000012 (Chromebook): Already resolved',
      'Not linked: An exception: A recount cannot settle this kind of exception',
      'Skipped: Projector: Rental equipment, kits and archived items are not counted',
    ]);
  });

  // Review finding (F1-2): a replay of a link-only request answered
  // "No count was started." after the exceptions had been linked. The server
  // now replays the first answer; a replay that names nothing says so.
  it('a replay repeats the first answer, and never says "No count was started" for a replay that names nothing', () => {
    const linkOnly = recountResultSummary({
      ...base,
      cycleCountId: null,
      countNumber: null,
      lineCount: 0,
      created: false,
      replay: true,
      assignedTo: null,
      linkedExisting: [
        {
          cycleCountId: 'cc-5',
          countNumber: 5,
          assignedTo: null,
          startedAt: null,
          itemIds: ['i1'],
          occurrenceIds: ['o1'],
        },
      ],
    });
    expect(linkOnly.alreadyCounting.map((a) => a.text)).toEqual(['Already being counted in CC-000005 (unassigned), linked']);
    expect(linkOnly.nothing).toBeNull();
    const empty = recountResultSummary({ ...base, cycleCountId: null, countNumber: null, created: false, replay: true });
    expect(empty.nothing).toBe(RECOUNT_REPLAY_UNKNOWN_COPY);
    expect(empty.nothing).not.toBe('No count was started.');
  });
});
