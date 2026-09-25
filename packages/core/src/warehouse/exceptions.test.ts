import { describe, expect, it } from 'vitest';

import {
  atLeastDaysCopy,
  describeOccurrenceEvent,
  EXCEPTION_ACKNOWLEDGE_HELP,
  EXCEPTION_ACT_NOT_PERMITTED_COPY,
  EXCEPTION_ACT_OFFLINE_COPY,
  EXCEPTION_ACT_RESOLVED_COPY,
  EXCEPTION_ACTION_LABELS,
  EXCEPTION_ALL_CLEAR_TITLE,
  EXCEPTION_LIST_UNAVAILABLE_COPY,
  EXCEPTION_NONE_RESOLVED_COPY,
  EXCEPTION_RESOLVED_WINDOW_DAYS,
  exceptionActDisabledReason,
  groupOccurrences,
  occurrenceStateLabel,
  type OccurrenceEventKind,
  conditionAgeDays,
  countExceptions,
  describeOccurrence,
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  EXCEPTION_RULE_IDS,
  EXCEPTION_RULES,
  formatOccurrenceNumber,
  groupExceptions,
  HOLDING_RULES,
  isExceptionRule,
  isHoldingRule,
  occurrenceKey,
  occurrenceState,
  presentWhenTrackingBegan,
  recurrenceBadge,
  sortExceptions,
  type ExceptionRule,
  type OccurrenceStateInput,
  type WarehouseException,
} from './exceptions';

const ex = (o: Partial<WarehouseException> & Pick<WarehouseException, 'rule' | 'key'>): WarehouseException => ({
  title: 'x',
  detail: 'y',
  href: null,
  ...o,
});

describe('sortExceptions', () => {
  it('puts critical above warning regardless of size', () => {
    const out = sortExceptions([
      ex({ rule: 'long_unplaced', key: 'a', units: 5000 }),
      ex({ rule: 'over_reserved', key: 'b', units: 1 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['b', 'a']);
  });

  it('ranks by UNITS before age within a severity', () => {
    // The judgement this encodes: age is the more emotive number and the wrong
    // one to lead with. One unit lost for 90 days must not outrank 200 units
    // lost yesterday, or the reader spends their attention on trivia.
    const out = sortExceptions([
      ex({ rule: 'long_unplaced', key: 'old-tiny', units: 1, ageDays: 90 }),
      ex({ rule: 'long_unplaced', key: 'new-big', units: 200, ageDays: 1 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['new-big', 'old-tiny']);
  });

  it('uses age only to break a tie on units', () => {
    const out = sortExceptions([
      ex({ rule: 'stale_staging', key: 'newer', units: 10, ageDays: 2 }),
      ex({ rule: 'stale_staging', key: 'older', units: 10, ageDays: 40 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['older', 'newer']);
  });

  it('is a TOTAL order, so the list cannot flicker between renders', () => {
    // Two rows identical on every ranked field must still have a stable
    // relative order; without the key tiebreak they can swap on re-sort and the
    // screen appears to shuffle by itself.
    const a = ex({ rule: 'stale_staging', key: 'aaa', units: 5, ageDays: 5 });
    const b = ex({ rule: 'stale_staging', key: 'bbb', units: 5, ageDays: 5 });
    expect(sortExceptions([a, b]).map((e) => e.key)).toEqual(['aaa', 'bbb']);
    expect(sortExceptions([b, a]).map((e) => e.key)).toEqual(['aaa', 'bbb']);
  });

  it('does not mutate its input', () => {
    const input = [ex({ rule: 'long_unplaced', key: 'a' }), ex({ rule: 'over_reserved', key: 'b' })];
    sortExceptions(input);
    expect(input.map((e) => e.key)).toEqual(['a', 'b']);
  });

  it('treats a missing unit count as zero rather than dropping the row', () => {
    const out = sortExceptions([
      ex({ rule: 'label_mismatch', key: 'no-units' }),
      ex({ rule: 'label_mismatch', key: 'has-units', units: 3 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['has-units', 'no-units']);
  });
});

describe('groupExceptions', () => {
  it('groups by rule and omits rules with nothing to show', () => {
    const groups = groupExceptions([
      ex({ rule: 'stale_staging', key: 's1', units: 4 }),
      ex({ rule: 'over_reserved', key: 'o1', units: 9 }),
      ex({ rule: 'stale_staging', key: 's2', units: 7 }),
    ]);
    expect(groups.map((g) => g.meta.rule)).toEqual(['over_reserved', 'stale_staging']);
    expect(groups[1]!.items.map((i) => i.key)).toEqual(['s2', 's1']);
    // An empty screen must say "nothing is wrong", not list five empty headings.
    expect(groups.some((g) => g.items.length === 0)).toBe(false);
  });

  it('returns nothing at all when there are no exceptions', () => {
    expect(groupExceptions([])).toEqual([]);
  });
});

describe('countExceptions', () => {
  it('counts the total and the critical subset', () => {
    expect(
      countExceptions([
        ex({ rule: 'orphaned_stock', key: 'a' }),
        ex({ rule: 'stale_staging', key: 'b' }),
        ex({ rule: 'over_reserved', key: 'c' }),
      ]),
    ).toEqual({ total: 3, critical: 2 });
  });
});

describe('EXCEPTION_RULES', () => {
  it('every rule tells the reader what to DO', () => {
    // The rule this suite enforces: an exception a reader cannot act on is a
    // metric, and metrics belong in reports. A rule whose action is empty is
    // how this screen becomes a wall of noise nobody opens.
    for (const meta of Object.values(EXCEPTION_RULES)) {
      expect(meta.action.trim().length).toBeGreaterThan(20);
      expect(meta.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('is keyed consistently with its own rule field', () => {
    for (const [key, meta] of Object.entries(EXCEPTION_RULES)) expect(meta.rule).toBe(key);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stored occurrences (F1-1)
// ═══════════════════════════════════════════════════════════════════════════

/** Wording that names or implies a person as the cause. Explanations describe
 *  process and record-keeping only. */
const PEOPLE_WORDING = /employee|staff|theft|stole|someone|worker|picker|person|user/i;

describe('EXCEPTION_RULES occurrence metadata', () => {
  it('every rule offers at least two neutral explanations and says what clears it', () => {
    for (const rule of EXCEPTION_RULE_IDS) {
      const meta = EXCEPTION_RULES[rule];
      expect(meta.explanations.length).toBeGreaterThanOrEqual(2);
      for (const e of meta.explanations) expect(e.trim().length).toBeGreaterThan(20);
      expect(meta.clearedBy.startsWith('Clears when')).toBe(true);
      expect(meta.actions.length).toBeGreaterThan(0);
      expect(meta.actions).toContain('open_item');
    }
  });

  // Mutation caught: an explanation such as "a staff member moved it without
  // scanning" — the screen must never point at people.
  it('no explanation or clear condition names or implies a person', () => {
    for (const rule of EXCEPTION_RULE_IDS) {
      const meta = EXCEPTION_RULES[rule];
      for (const text of [...meta.explanations, meta.clearedBy]) {
        expect(text).not.toMatch(PEOPLE_WORDING);
      }
    }
  });

  it('only item-level rules are recountable; holding rules never are', () => {
    // A count records the item total, and a negative difference comes off the
    // counted rack first, so recounting a Staging holding can correct the
    // wrong place.
    for (const rule of HOLDING_RULES) expect(EXCEPTION_RULES[rule].recountable).toBe(false);
    expect(EXCEPTION_RULES.over_reserved.recountable).toBe(true);
    expect(EXCEPTION_RULES.label_mismatch.recountable).toBe(false);
  });

  it('Staging and Unplaced offer put-away; a label mismatch offers a label edit', () => {
    expect(EXCEPTION_RULES.stale_staging.actions[0]).toBe('put_away');
    expect(EXCEPTION_RULES.long_unplaced.actions[0]).toBe('put_away');
    expect(EXCEPTION_RULES.label_mismatch.actions[0]).toBe('edit_label');
  });

  it('EXCEPTION_RULE_IDS lists every rule exactly once', () => {
    expect([...EXCEPTION_RULE_IDS].sort()).toEqual(Object.keys(EXCEPTION_RULES).sort());
  });
});

describe('isExceptionRule / isHoldingRule', () => {
  it('accepts this build\'s rules and refuses anything else, including a newer build\'s rule', () => {
    for (const r of EXCEPTION_RULE_IDS) expect(isExceptionRule(r)).toBe(true);
    expect(isExceptionRule('count_variance')).toBe(false);
    expect(isExceptionRule('')).toBe(false);
    expect(isExceptionRule(null)).toBe(false);
    expect(isExceptionRule(42)).toBe(false);
  });

  it('the three holding rules are exactly the ones the database requires a location for', () => {
    expect([...HOLDING_RULES].sort()).toEqual(['long_unplaced', 'orphaned_stock', 'stale_staging']);
    expect(isHoldingRule('over_reserved')).toBe(false);
    expect(isHoldingRule('label_mismatch')).toBe(false);
  });
});

describe('occurrenceKey', () => {
  it('gives each rule its own prefix, so one holding never collides across rules', () => {
    expect(occurrenceKey({ rule: 'stale_staging', itemId: 'i', locationId: 'l' })).toBe('stale_staging:i:l');
    expect(occurrenceKey({ rule: 'orphaned_stock', itemId: 'i', locationId: 'l' })).toBe('orphaned_stock:i:l');
    expect(occurrenceKey({ rule: 'long_unplaced', itemId: 'i', locationId: 'l' })).toBe('long_unplaced:i:l');
    expect(occurrenceKey({ rule: 'label_mismatch', itemId: 'i', locationId: null })).toBe('label:i');
    expect(occurrenceKey({ rule: 'over_reserved', itemId: 'i', locationId: null })).toBe('over:i');
    const keys = new Set(
      (['stale_staging', 'orphaned_stock', 'long_unplaced'] as ExceptionRule[]).map((rule) =>
        occurrenceKey({ rule, itemId: 'i', locationId: 'l' }),
      ),
    );
    expect(keys.size).toBe(3);
  });
});

describe('formatOccurrenceNumber', () => {
  it('pads to six digits and never truncates', () => {
    expect(formatOccurrenceNumber(42)).toBe('EX-000042');
    expect(formatOccurrenceNumber('7')).toBe('EX-000007');
    expect(formatOccurrenceNumber(1234567)).toBe('EX-1234567');
  });

  it('refuses anything that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, 'x', '']) {
      expect(formatOccurrenceNumber(bad as never)).toBeNull();
    }
  });
});

describe('conditionAgeDays / atLeastDaysCopy', () => {
  it('counts whole days, never negative, null when the start is unknown', () => {
    expect(conditionAgeDays('2026-09-01T00:00:00Z', '2026-09-10T12:00:00Z')).toBe(9);
    expect(conditionAgeDays('2026-09-10T00:00:00Z', '2026-09-01T00:00:00Z')).toBe(0);
    expect(conditionAgeDays(null, '2026-09-10T00:00:00Z')).toBeNull();
    expect(conditionAgeDays('not a date', '2026-09-10T00:00:00Z')).toBeNull();
  });

  it('always says "at least"', () => {
    expect(atLeastDaysCopy(9)).toBe('for at least 9 days');
    expect(atLeastDaysCopy(1)).toBe('for at least 1 day');
  });
});

describe('describeOccurrence', () => {
  const AS_OF = '2026-09-24T12:00:00Z';

  it('orphaned stock names the archived location and the units', () => {
    const d = describeOccurrence('orphaned_stock', {
      itemName: 'Atlas',
      sku: 'A1',
      units: 12,
      locationName: 'Rack 9-Z',
      locationKind: 'rack',
    });
    expect(d).toEqual({ title: '12 × Atlas', detail: 'in Rack 9-Z, which is archived', units: 12 });
  });

  it('Staging reads "for at least N days" from the condition start', () => {
    const d = describeOccurrence(
      'stale_staging',
      { itemName: 'Atlas', sku: null, units: 4, locationName: 'Staging', locationKind: 'staging' },
      { conditionSince: '2026-09-15T12:00:00Z', asOf: AS_OF },
    );
    expect(d.detail).toBe('in Staging for at least 9 days');
    expect(d.title).toBe('4 × Atlas');
    expect(d.units).toBe(4);
  });

  it('Unplaced reads "unplaced for at least N days"', () => {
    const d = describeOccurrence(
      'long_unplaced',
      { itemName: 'Atlas', sku: null, units: 1.5, locationName: 'Unplaced', locationKind: 'unplaced' },
      { conditionSince: '2026-08-01T12:00:00Z', asOf: AS_OF },
    );
    expect(d.detail).toBe('unplaced for at least 54 days');
    expect(d.title).toBe('1.5 × Atlas');
  });

  it('a resolved row ages to its resolution, not to now', () => {
    const d = describeOccurrence(
      'stale_staging',
      { itemName: 'Atlas', units: 4 },
      { conditionSince: '2026-09-01T00:00:00Z', asOf: '2026-09-11T00:00:00Z' },
    );
    expect(d.detail).toBe('in Staging for at least 10 days');
  });

  it('over-reserved states promised against on hand, and the shortfall as units', () => {
    const d = describeOccurrence('over_reserved', { itemName: 'Atlas', sku: 'A1', promised: 14, onHand: 10 });
    expect(d).toEqual({ title: 'Atlas', detail: '14 promised, 10 on hand', units: 4 });
  });

  it('a label mismatch names the label and where the stock is', () => {
    const d = describeOccurrence('label_mismatch', {
      itemName: 'Atlas',
      sku: 'A1',
      label: '40-C',
      stockOn: ['39-C', '41-A'],
    });
    expect(d).toEqual({ title: 'Atlas', detail: 'labelled 40-C, stock is on 39-C, 41-A', units: null });
  });

  it('the live item name wins over the stored one', () => {
    const d = describeOccurrence('over_reserved', { itemName: 'Old name', promised: 2, onHand: 1 }, {
      itemName: 'New name',
    });
    expect(d.title).toBe('New name');
  });

  it('renders a sentence for every rule even from empty or malformed facts', () => {
    for (const rule of EXCEPTION_RULE_IDS) {
      for (const facts of [{}, null, 'x', [1, 2], { units: 'many', stockOn: 'nope' }]) {
        const d = describeOccurrence(rule, facts);
        expect(d.title.length).toBeGreaterThan(0);
        expect(d.detail.length).toBeGreaterThan(0);
        expect(d.detail).not.toMatch(/undefined|NaN|null/);
        expect(d.title).not.toMatch(/undefined|NaN|null/);
      }
    }
  });
});

describe('occurrenceState — precedence', () => {
  const base: OccurrenceStateInput = {
    resolvedAt: null,
    resolvedReason: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    recount: null,
  };
  const recount = (status: string, completedAt: string | null = null) => ({
    cycleCountId: 'cc-1',
    countNumber: 31,
    status,
    completedAt,
  });

  it('open by default', () => {
    expect(occurrenceState(base, null)).toEqual({ kind: 'open' });
  });

  it('acknowledged carries who and when', () => {
    expect(
      occurrenceState({ ...base, acknowledgedAt: '2026-09-20T10:00:00Z', acknowledgedBy: 'u1' }, null),
    ).toEqual({ kind: 'acknowledged', at: '2026-09-20T10:00:00Z', by: 'u1' });
  });

  it('a recount in progress outranks acknowledged', () => {
    const s = occurrenceState(
      { ...base, acknowledgedAt: '2026-09-20T10:00:00Z', recount: recount('in_progress') },
      '2026-09-24T00:00:00Z',
    );
    expect(s).toEqual({ kind: 'recount_in_progress', cycleCountId: 'cc-1', countNumber: 31 });
  });

  it('a completed recount the store has not re-evaluated since reads Re-checking', () => {
    const s = occurrenceState(
      { ...base, acknowledgedAt: '2026-09-20T10:00:00Z', recount: recount('completed', '2026-09-24T10:00:00Z') },
      '2026-09-24T09:59:00Z',
    );
    expect(s).toEqual({ kind: 'rechecking', cycleCountId: 'cc-1', countNumber: 31 });
    // Before any sync at all it is also re-checking, never "open".
    expect(occurrenceState({ ...base, recount: recount('completed', '2026-09-24T10:00:00Z') }, null).kind).toBe(
      'rechecking',
    );
  });

  it('once an evaluation after the completed recount applied, Re-checking ends', () => {
    const s = occurrenceState(
      { ...base, acknowledgedAt: '2026-09-20T10:00:00Z', recount: recount('completed', '2026-09-24T10:00:00Z') },
      '2026-09-24T10:00:01Z',
    );
    expect(s.kind).toBe('acknowledged');
  });

  it('a cancelled recount does not change the state', () => {
    expect(occurrenceState({ ...base, recount: recount('canceled') }, null)).toEqual({ kind: 'open' });
  });

  it('resolved outranks everything', () => {
    const s = occurrenceState(
      {
        resolvedAt: '2026-09-24T11:00:00Z',
        resolvedReason: 'reclassified',
        acknowledgedAt: '2026-09-20T10:00:00Z',
        acknowledgedBy: 'u1',
        recount: recount('in_progress'),
      },
      null,
    );
    expect(s).toEqual({ kind: 'resolved', reason: 'reclassified', at: '2026-09-24T11:00:00Z' });
  });
});

describe('recurrenceBadge', () => {
  it('is empty for a first occurrence and ordinal after that', () => {
    expect(recurrenceBadge(0)).toBeNull();
    expect(recurrenceBadge(1)).toBe('Recurred (2nd time)');
    expect(recurrenceBadge(2)).toBe('Recurred (3rd time)');
    expect(recurrenceBadge(3)).toBe('Recurred (4th time)');
    expect(recurrenceBadge(10)).toBe('Recurred (11th time)');
    expect(recurrenceBadge(11)).toBe('Recurred (12th time)');
    expect(recurrenceBadge(12)).toBe('Recurred (13th time)');
    expect(recurrenceBadge(20)).toBe('Recurred (21st time)');
    expect(recurrenceBadge(21)).toBe('Recurred (22nd time)');
    expect(recurrenceBadge(-1)).toBeNull();
  });
});

describe('presentWhenTrackingBegan', () => {
  it('is true only when first seen by the very first sync', () => {
    expect(presentWhenTrackingBegan('2026-10-02T15:00:00.000Z', '2026-10-02T15:00:00Z')).toBe(true);
    expect(presentWhenTrackingBegan('2026-10-02T15:15:00Z', '2026-10-02T15:00:00Z')).toBe(false);
    expect(presentWhenTrackingBegan('2026-10-02T15:00:00Z', null)).toBe(false);
  });
});

describe('EXCEPTION_FIRST_CHECK_PENDING_COPY', () => {
  it('says the first check has not run, and never reads as all clear', () => {
    expect(EXCEPTION_FIRST_CHECK_PENDING_COPY).toMatch(/within 15 minutes/);
    expect(EXCEPTION_FIRST_CHECK_PENDING_COPY).not.toMatch(/nothing needs attention|all clear/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared display copy (F1-1 stage 3)
// ═══════════════════════════════════════════════════════════════════════════

describe('exceptionActDisabledReason', () => {
  it('is null only when the row is open, the reader may act and the phone is online', () => {
    expect(exceptionActDisabledReason({ resolved: false, canAct: true, online: true })).toBeNull();
  });

  // Mutation caught: dropping the online check leaves Acknowledge live offline.
  it('offline disables the actions with the reason', () => {
    expect(exceptionActDisabledReason({ resolved: false, canAct: true, online: false })).toBe(
      EXCEPTION_ACT_OFFLINE_COPY,
    );
  });

  it('a reader without permission is told so, online or not', () => {
    for (const online of [true, false]) {
      expect(exceptionActDisabledReason({ resolved: false, canAct: false, online })).toBe(
        EXCEPTION_ACT_NOT_PERMITTED_COPY,
      );
    }
  });

  it('a resolved row is told it is resolved first', () => {
    expect(exceptionActDisabledReason({ resolved: true, canAct: true, online: false })).toBe(
      EXCEPTION_ACT_RESOLVED_COPY,
    );
  });
});

describe('occurrenceStateLabel', () => {
  it('words every state, and a resolved one by its reason, never as a person resolving it', () => {
    expect(occurrenceStateLabel({ kind: 'open' })).toBe('Open');
    expect(occurrenceStateLabel({ kind: 'acknowledged', at: 'x', by: 'u' })).toBe('Acknowledged');
    expect(
      occurrenceStateLabel({ kind: 'recount_in_progress', cycleCountId: 'c', countNumber: 12 }),
    ).toBe('Recount in progress (CC-000012)');
    expect(
      occurrenceStateLabel({ kind: 'recount_in_progress', cycleCountId: 'c', countNumber: null }),
    ).toBe('Recount in progress');
    expect(occurrenceStateLabel({ kind: 'rechecking', cycleCountId: 'c', countNumber: 12 })).toBe(
      'Re-checking',
    );
    expect(occurrenceStateLabel({ kind: 'resolved', reason: 'cleared', at: 'x' })).toBe(
      'Resolved: Cleared',
    );
    expect(occurrenceStateLabel({ kind: 'resolved', reason: 'subject_gone', at: 'x' })).toBe(
      'Resolved: Item archived or deleted',
    );
  });
});

describe('describeOccurrenceEvent', () => {
  const KINDS: OccurrenceEventKind[] = [
    'raised',
    'acknowledged',
    'note',
    'recount_linked',
    'recount_closed',
    'resolved',
    'evidence_added',
    'evidence_removed',
    'escalated',
  ];

  it('words every kind', () => {
    for (const kind of KINDS) {
      expect(describeOccurrenceEvent({ kind, actorLabel: 'Dana Lee' }).trim().length).toBeGreaterThan(3);
    }
  });

  it('the system raises and resolves; a person acknowledges and adds notes', () => {
    expect(describeOccurrenceEvent({ kind: 'raised', actorLabel: null })).toBe('Raised by the system check');
    expect(
      describeOccurrenceEvent({ kind: 'resolved', actorLabel: null, resolvedReason: 'reclassified' }),
    ).toBe('Resolved by the system check: Now reported under another rule');
    expect(describeOccurrenceEvent({ kind: 'acknowledged', actorLabel: 'Dana Lee' })).toBe(
      'Acknowledged by Dana Lee',
    );
    expect(describeOccurrenceEvent({ kind: 'note', actorLabel: 'Former member' })).toBe(
      'Note from Former member',
    );
    expect(
      describeOccurrenceEvent({ kind: 'recount_closed', actorLabel: null, cycleCountNumber: 7 }),
    ).toBe('Recount CC-000007 closed');
  });
});

describe('groupOccurrences', () => {
  const occ = (o: Partial<Parameters<typeof groupOccurrences>[0][number]> & { id: string; rule: ExceptionRule }) => ({
    facts: {},
    conditionSince: null,
    resolvedAt: null,
    item: null,
    ...o,
  });

  it('puts critical rules first, then orders by units at stake, and words each row once', () => {
    const groups = groupOccurrences(
      [
        occ({ id: 'a', rule: 'stale_staging', facts: { itemName: 'Atlas', units: 2 }, conditionSince: '2026-09-01T00:00:00Z' }),
        occ({ id: 'b', rule: 'stale_staging', facts: { itemName: 'Globe', units: 40 }, conditionSince: '2026-09-20T00:00:00Z' }),
        occ({ id: 'c', rule: 'over_reserved', facts: { itemName: 'Map', promised: 5, onHand: 3 } }),
      ],
      '2026-09-24T00:00:00Z',
    );
    expect(groups.map((g) => g.meta.rule)).toEqual(['over_reserved', 'stale_staging']);
    expect(groups[1]!.rows.map((r) => r.occurrence.id)).toEqual(['b', 'a']);
    expect(groups[1]!.rows[1]!.description.detail).toBe('in Staging for at least 23 days');
  });

  it('keeps two occurrences of one identity apart (resolved recurrences)', () => {
    const groups = groupOccurrences([
      occ({ id: 'r1', rule: 'label_mismatch', resolvedAt: '2026-09-20T00:00:00Z' }),
      occ({ id: 'r2', rule: 'label_mismatch', resolvedAt: '2026-09-22T00:00:00Z' }),
    ]);
    expect(groups[0]!.rows.map((r) => r.occurrence.id).sort()).toEqual(['r1', 'r2']);
  });

  it('prefers the live item name over the stored one', () => {
    const [g] = groupOccurrences([
      occ({ id: 'x', rule: 'over_reserved', facts: { itemName: 'Old name' }, item: { name: 'New name' } }),
    ]);
    expect(g!.rows[0]!.description.title).toBe('New name');
  });
});

describe('shared list copy', () => {
  it('the unavailable and empty wording never reads as all clear by accident', () => {
    expect(EXCEPTION_LIST_UNAVAILABLE_COPY).not.toMatch(/nothing|clear|no exceptions/i);
    expect(EXCEPTION_ALL_CLEAR_TITLE).toBe('Nothing needs attention');
    expect(EXCEPTION_NONE_RESOLVED_COPY).toContain(`${EXCEPTION_RESOLVED_WINDOW_DAYS} days`);
  });

  it('acknowledging is described as not resolving anything', () => {
    expect(EXCEPTION_ACKNOWLEDGE_HELP).toMatch(/does not resolve/);
  });

  it('no shared copy names or implies a person as a cause', () => {
    for (const text of [
      EXCEPTION_ACKNOWLEDGE_HELP,
      EXCEPTION_ACT_NOT_PERMITTED_COPY,
      EXCEPTION_ACT_RESOLVED_COPY,
      EXCEPTION_ACT_OFFLINE_COPY,
      EXCEPTION_LIST_UNAVAILABLE_COPY,
      EXCEPTION_NONE_RESOLVED_COPY,
      ...Object.values(EXCEPTION_ACTION_LABELS),
    ]) {
      expect(text).not.toMatch(/employee|staff|theft|stole|someone|worker|picker/i);
    }
  });
});
