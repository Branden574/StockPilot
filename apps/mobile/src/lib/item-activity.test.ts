import { describe, expect, it } from 'vitest';

import {
  AUDIT_DIFF_ROW_CAP,
  LIFECYCLE_REASON_MOVEMENTS,
  MOVEMENT_SHADOWED_AUDIT_EVENTS,
  auditCapFor,
  buildAuditCardModel,
  diffMetadataFields,
  formatAuditEventLabel,
  formatRelativeTime,
  humanizeFieldName,
  isPlainObject,
  mergeItemActivity,
  stringifyMetadataValue,
  type ActivityAuditInput,
  type ActivityMovementInput,
} from './item-activity';

// ─── fixtures ───────────────────────────────────────────────────────────────

function movement(overrides: Partial<ActivityMovementInput> & { id: string }): ActivityMovementInput {
  return {
    movement_type: 'adjust',
    quantity_change: 1,
    previous_quantity: 0,
    new_quantity: 1,
    moved_quantity: null,
    reason: null,
    notes: null,
    note_editable: true,
    created_at: '2026-07-10T00:00:00.000Z',
    actor: { full_name: 'Ada Lovelace', email: 'ada@example.com' },
    reference_type: null,
    reference_id: null,
    reference_label: null,
    from_location_id: null,
    to_location_id: null,
    from_location_name: null,
    to_location_name: null,
    ...overrides,
  };
}

function auditRow(overrides: Partial<ActivityAuditInput> & { id: string }): ActivityAuditInput {
  return {
    event: 'inventory.item.updated',
    metadata: null,
    created_at: '2026-07-10T00:00:00.000Z',
    actor: { full_name: 'Ada Lovelace', email: 'ada@example.com' },
    ...overrides,
  };
}

// ─── mergeItemActivity: per-kind caps, never a combined slice (P1 bug) ─────

describe('mergeItemActivity — per-kind caps', () => {
  it('caps movements and audits SEPARATELY — a flood of audits never starves the movements slot', () => {
    // 5 movements, all newer than 5 audits. A combined-then-sliced approach
    // with limit=3 would keep the 3 newest overall (all movements here,
    // since they're newer) OR could go the other way if audits were newer —
    // the point of separate caps is that the OUTCOME never depends on which
    // kind happens to be more recent/more numerous.
    const movements = Array.from({ length: 5 }, (_, i) =>
      movement({ id: `m${i}`, created_at: `2026-07-15T00:00:0${i}.000Z` }),
    );
    const audits = Array.from({ length: 5 }, (_, i) =>
      auditRow({
        id: `a${i}`,
        event: 'item.serials.added',
        created_at: `2026-07-01T00:00:0${i}.000Z`,
      }),
    );
    const result = mergeItemActivity({ movements, audits, movementLimit: 3, auditLimit: 2 });
    const movementCount = result.filter((e) => e.kind === 'movement').length;
    const auditCount = result.filter((e) => e.kind === 'audit').length;
    expect(movementCount).toBe(3);
    expect(auditCount).toBe(2);
    expect(result).toHaveLength(5);
  });

  it('audits newer than movements still cannot crowd movements out of their own cap', () => {
    // Reverse the recency: audits are the newest rows now. A combined slice
    // to N=3 would return 3 audits and 0 movements. Separate caps must still
    // return exactly movementLimit movements regardless.
    const movements = Array.from({ length: 4 }, (_, i) =>
      movement({ id: `m${i}`, created_at: `2026-01-01T00:00:0${i}.000Z` }),
    );
    const audits = Array.from({ length: 4 }, (_, i) =>
      auditRow({
        id: `a${i}`,
        event: 'tag.applied',
        created_at: `2026-07-15T00:00:0${i}.000Z`,
      }),
    );
    const result = mergeItemActivity({ movements, audits, movementLimit: 2, auditLimit: 2 });
    expect(result.filter((e) => e.kind === 'movement')).toHaveLength(2);
    expect(result.filter((e) => e.kind === 'audit')).toHaveLength(2);
  });

  it('auditCapFor mirrors forItem: ceil(limit/2), floored at 1', () => {
    expect(auditCapFor(30)).toBe(15);
    expect(auditCapFor(1)).toBe(1);
    expect(auditCapFor(0)).toBe(1);
    expect(auditCapFor(3)).toBe(2);
  });
});

// ─── shadowed-event suppression ────────────────────────────────────────────

describe('mergeItemActivity — MOVEMENT_SHADOWED_AUDIT_EVENTS suppression', () => {
  it('drops every shadowed stock.* audit event from the merged feed', () => {
    const audits = MOVEMENT_SHADOWED_AUDIT_EVENTS.map((event, i) =>
      auditRow({ id: `shadow-${i}`, event }),
    );
    const result = mergeItemActivity({ movements: [], audits, movementLimit: 30, auditLimit: 15 });
    expect(result).toHaveLength(0);
  });

  it('filters shadowed events BEFORE slicing to auditLimit — a shadowed row never occupies a real slot', () => {
    // 1 shadowed + 2 real audit events, auditLimit=2. If filtering happened
    // AFTER slicing (or not at all), the shadowed row could occupy one of
    // the 2 slots and crowd out a real event.
    const audits = [
      auditRow({ id: 'shadow', event: 'stock.adjusted', created_at: '2026-07-15T00:00:03.000Z' }),
      auditRow({ id: 'real-1', event: 'tag.applied', created_at: '2026-07-15T00:00:02.000Z' }),
      auditRow({ id: 'real-2', event: 'tag.removed', created_at: '2026-07-15T00:00:01.000Z' }),
    ];
    const result = mergeItemActivity({ movements: [], audits, movementLimit: 30, auditLimit: 2 });
    expect(result.map((e) => e.id)).toEqual(['real-1', 'real-2']);
  });

  it('non-shadowed events pass through untouched', () => {
    const audits = [auditRow({ id: 'a1', event: 'inventory.item.archived' })];
    const result = mergeItemActivity({ movements: [], audits, movementLimit: 30, auditLimit: 15 });
    expect(result).toHaveLength(1);
  });
});

// ─── lifecycle-reason movement filtering — null reasons MUST be retained ──

describe('mergeItemActivity — LIFECYCLE_REASON_MOVEMENTS filtering (JS-only, null-safe)', () => {
  it('drops legacy item_archived/item_deleted reason rows', () => {
    const movements = LIFECYCLE_REASON_MOVEMENTS.map((reason, i) =>
      movement({ id: `legacy-${i}`, reason }),
    );
    const result = mergeItemActivity({ movements, audits: [], movementLimit: 30, auditLimit: 15 });
    expect(result).toHaveLength(0);
  });

  it('retains movements with a NULL reason — the bug this rule exists to prevent', () => {
    // In prod, 61% of stock_movements rows have reason=null. A query-layer
    // `.not('reason','in',(...))` silently drops all of them (NULL comparison
    // semantics); this JS filter must not repeat that mistake.
    const movements = [
      movement({ id: 'null-reason', reason: null }),
      movement({ id: 'real-reason', reason: 'Cycle count variance' }),
    ];
    const result = mergeItemActivity({ movements, audits: [], movementLimit: 30, auditLimit: 15 });
    expect(result.map((e) => e.id).sort()).toEqual(['null-reason', 'real-reason']);
  });

  it('retains ordinary non-lifecycle reasons (e.g. a receipt reason that happens to differ)', () => {
    const movements = [movement({ id: 'po', reason: 'PO 1029' })];
    const result = mergeItemActivity({ movements, audits: [], movementLimit: 30, auditLimit: 15 });
    expect(result).toHaveLength(1);
  });
});

// ─── sort order across kinds ───────────────────────────────────────────────

describe('mergeItemActivity — sort order', () => {
  it('sorts the merged feed by createdAt descending, interleaving both kinds', () => {
    const movements = [movement({ id: 'm-mid', created_at: '2026-07-10T12:00:00.000Z' })];
    const audits = [
      auditRow({ id: 'a-newest', event: 'tag.applied', created_at: '2026-07-15T12:00:00.000Z' }),
      auditRow({ id: 'a-oldest', event: 'tag.removed', created_at: '2026-07-01T12:00:00.000Z' }),
    ];
    const result = mergeItemActivity({ movements, audits, movementLimit: 30, auditLimit: 15 });
    expect(result.map((e) => e.id)).toEqual(['a-newest', 'm-mid', 'a-oldest']);
  });
});

// ─── crash-safe metadata rendering ──────────────────────────────────────────

describe('isPlainObject', () => {
  it('distinguishes plain objects from arrays, null, and primitives', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});

describe('stringifyMetadataValue — crash-safe on arbitrary jsonb', () => {
  it('never throws on any input shape, including circular-ish nested arrays/objects', () => {
    const values: unknown[] = [
      null,
      undefined,
      '',
      'hello',
      0,
      42,
      true,
      false,
      [],
      [1, 'a', null, true],
      [{ nested: true }],
      {},
      { a: 1, b: [1, 2] },
      Symbol('weird'),
      () => undefined,
    ];
    for (const v of values) {
      expect(() => stringifyMetadataValue(v)).not.toThrow();
    }
  });

  it('renders known shapes as documented', () => {
    expect(stringifyMetadataValue(null)).toBe('—');
    expect(stringifyMetadataValue(undefined)).toBe('—');
    expect(stringifyMetadataValue('')).toBe('—');
    expect(stringifyMetadataValue('hi')).toBe('hi');
    expect(stringifyMetadataValue(3)).toBe('3');
    expect(stringifyMetadataValue(true)).toBe('true');
    expect(stringifyMetadataValue([])).toBe('(none)');
    expect(stringifyMetadataValue([1, 2, 3])).toBe('1, 2, 3');
    expect(stringifyMetadataValue({})).toBe('(empty)');
    expect(stringifyMetadataValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('diffMetadataFields', () => {
  it('diffs two plain objects to only the changed keys', () => {
    const rows = diffMetadataFields({ name: 'Old', sku: 'A1' }, { name: 'New', sku: 'A1' });
    expect(rows).toEqual([{ field: 'name', before: 'Old', after: 'New' }]);
  });

  it('creation-only events (before=null) diff every key on the after side against "—"', () => {
    const rows = diffMetadataFields(null, { name: 'New' });
    expect(rows).toEqual([{ field: 'name', before: '—', after: 'New' }]);
  });

  it('non-object before/after that stringify identically produces no rows', () => {
    expect(diffMetadataFields(undefined, undefined)).toEqual([]);
    expect(diffMetadataFields('same', 'same')).toEqual([]);
  });

  it('non-object before/after that differ produce a single "value" row, never a crash', () => {
    expect(diffMetadataFields('old', 'new')).toEqual([{ field: 'value', before: 'old', after: 'new' }]);
  });

  it('never throws on adversarial metadata shapes', () => {
    expect(() => diffMetadataFields([1, 2], { a: 1 })).not.toThrow();
    expect(() => diffMetadataFields(42, Symbol('x'))).not.toThrow();
  });
});

describe('humanizeFieldName', () => {
  it('title-cases snake_case and uppercases known acronyms', () => {
    expect(humanizeFieldName('public_display_name')).toBe('Public display name');
    expect(humanizeFieldName('po_number')).toBe('PO number');
    expect(humanizeFieldName('sku')).toBe('SKU');
  });
});

// ─── event label formatting ─────────────────────────────────────────────────

describe('formatAuditEventLabel', () => {
  it('formats known item-scoped events exactly like the web port', () => {
    expect(formatAuditEventLabel('inventory.item.updated')).toBe('Inventory Item · Updated');
    expect(formatAuditEventLabel('inventory.item.archived')).toBe('Inventory Item · Archived');
    expect(formatAuditEventLabel('inventory.item.restored')).toBe('Inventory Item · Restored');
    expect(formatAuditEventLabel('inventory.item.deleted')).toBe('Inventory Item · Deleted');
    expect(formatAuditEventLabel('inventory.item.duplicated')).toBe('Inventory Item · Duplicated');
    expect(formatAuditEventLabel('item.serials.added')).toBe('Item Serials · Added');
    expect(formatAuditEventLabel('item.serial.updated')).toBe('Item Serial · Updated');
    expect(formatAuditEventLabel('item.serial.deleted')).toBe('Item Serial · Deleted');
  });

  it('falls back to plain title-casing for events with no subject override (e.g. tag.*)', () => {
    expect(formatAuditEventLabel('tag.applied')).toBe('Tag · Applied');
    expect(formatAuditEventLabel('tag.removed')).toBe('Tag · Removed');
  });

  it('falls back gracefully for a totally unrecognized/future event shape', () => {
    // No override exists for "some_future_domain" — title-cases each
    // underscore-separated word, same fallback as web's formatAuditEvent.
    expect(formatAuditEventLabel('some_future_domain.did_a_thing')).toBe(
      'Some Future Domain · Did A Thing',
    );
    expect(formatAuditEventLabel('singleword')).toBe('Singleword');
    expect(formatAuditEventLabel('')).toBe('—');
  });
});

// ─── relative time ───────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');

  it('renders each bucket boundary deterministically against an injected `now`', () => {
    expect(formatRelativeTime('2026-07-15T11:59:58.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-15T11:59:30.000Z', now)).toBe('30s ago');
    expect(formatRelativeTime('2026-07-15T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelativeTime('2026-07-15T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-07-13T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatRelativeTime('2026-06-01T12:00:00.000Z', now)).toBe('1mo ago');
    expect(formatRelativeTime('2024-07-15T12:00:00.000Z', now)).toBe('2y ago');
  });

  it('clamps a future/skewed timestamp to "just now" rather than a negative duration', () => {
    expect(formatRelativeTime('2026-07-15T12:05:00.000Z', now)).toBe('just now');
  });

  it('returns empty string for an unparsable timestamp rather than throwing', () => {
    expect(() => formatRelativeTime('not-a-date', now)).not.toThrow();
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});

// ─── audit card model ───────────────────────────────────────────────────────

describe('buildAuditCardModel', () => {
  it('builds a full model from realistic item.update metadata — diff rows win over the changed_keys chip (web parity)', () => {
    const row = auditRow({
      id: 'a1',
      event: 'inventory.item.updated',
      metadata: {
        reason: null,
        changed_keys: ['name', 'unit_cost'],
        before: { name: 'Old Widget', unit_cost: 4.5 },
        after: { name: 'New Widget', unit_cost: 5.0 },
      },
    });
    const model = buildAuditCardModel(row);
    expect(model.eventLabel).toBe('Inventory Item · Updated');
    expect(model.actorName).toBe('Ada Lovelace');
    // Rows > 0 -> chip is suppressed even though changed_keys is present and
    // non-empty (this is the exact live scenario reported: a card that used
    // to show "Fields changed: <19 fields>" above a 1-row real diff).
    expect(model.changedKeys).toBeNull();
    expect(model.diffRows).toEqual([
      { field: 'name', before: 'Old Widget', after: 'New Widget' },
      { field: 'unit_cost', before: '4.5', after: '5' },
    ]);
    expect(model.diffMoreCount).toBe(0);
  });

  it('changed_keys AND before/after both present -> diffRows populated, chip omitted entirely', () => {
    // Same shape as the live bug report: a legacy-style changed_keys listing
    // every submitted field (19 of them) alongside a real before/after diff
    // that only actually changed one field.
    const submittedKeys = ['name', 'unit_cost', 'reorder_point', 'bin_location'];
    const row = auditRow({
      id: 'a1b',
      event: 'inventory.item.updated',
      metadata: {
        changed_keys: submittedKeys,
        before: { reorder_point: 5 },
        after: { reorder_point: 10 },
      },
    });
    const model = buildAuditCardModel(row);
    expect(model.diffRows).toEqual([{ field: 'reorder_point', before: '5', after: '10' }]);
    expect(model.diffRows.length).toBeGreaterThan(0);
    expect(model.changedKeys).toBeNull();
  });

  it('changed_keys only, no before/after -> chip present with the legacy honest-label copy', () => {
    // No `before`/`after` on this row at all (legacy pre-capture write), so
    // diffMetadataFields(undefined, undefined) yields zero rows and the chip
    // is the only signal available.
    const row = auditRow({
      id: 'a1c',
      event: 'inventory.item.updated',
      metadata: { changed_keys: ['name', 'reorder_point'] },
    });
    const model = buildAuditCardModel(row);
    expect(model.diffRows).toEqual([]);
    expect(model.changedKeys).toEqual(['name', 'reorder_point']);
  });

  it('caps diff rows at AUDIT_DIFF_ROW_CAP and reports the remainder as diffMoreCount', () => {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) {
      before[`field_${i}`] = 'a';
      after[`field_${i}`] = 'b';
    }
    const row = auditRow({ id: 'a2', metadata: { before, after } });
    const model = buildAuditCardModel(row);
    expect(model.diffRows).toHaveLength(AUDIT_DIFF_ROW_CAP);
    expect(model.diffMoreCount).toBe(9 - AUDIT_DIFF_ROW_CAP);
  });

  it('falls back to "system" actor when actor is null (server-initiated event)', () => {
    const row = auditRow({ id: 'a3', actor: null });
    expect(buildAuditCardModel(row).actorName).toBe('system');
  });

  it('falls back to email when full_name is missing', () => {
    const row = auditRow({ id: 'a4', actor: { full_name: null, email: 'ada@example.com' } });
    expect(buildAuditCardModel(row).actorName).toBe('ada@example.com');
  });

  it('never throws on adversarial metadata: array, string, number, missing entirely', () => {
    const adversarial: (Record<string, unknown> | null)[] = [
      null,
      { before: [1, 2, 3], after: 'oops' },
      { reason: 42, changed_keys: 'not-an-array' },
      { changed_keys: [1, 2, 3] },
    ];
    for (const metadata of adversarial) {
      const row = auditRow({ id: 'adv', metadata });
      expect(() => buildAuditCardModel(row)).not.toThrow();
    }
  });

  it('non-string reason and non-string-array changed_keys degrade to null rather than leaking raw types', () => {
    const row = auditRow({ id: 'a5', metadata: { reason: 42, changed_keys: [1, 2, 3] } });
    const model = buildAuditCardModel(row);
    expect(model.reason).toBeNull();
    expect(model.changedKeys).toBeNull();
  });

  it('a bare (non-object) metadata value degrades to no reason/changed_keys/diff rows, never a crash', () => {
    const row = auditRow({ id: 'a6', metadata: 'not-an-object' as unknown as Record<string, unknown> });
    const model = buildAuditCardModel(row);
    expect(model.reason).toBeNull();
    expect(model.changedKeys).toBeNull();
    expect(model.diffRows).toEqual([]);
  });
});
