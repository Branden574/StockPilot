import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUS_COLORS,
  ORDER_STATUS_KEYS,
  ORDER_STATUS_LABEL_MAX,
  ORDER_STATUS_META,
  isOrderStatusColor,
  isOrderStatusKey,
  resolveOrderStatusConfig,
  type OrderStatusConfig,
} from './order-status';

describe('canonical constants', () => {
  it('exposes the 14 canonical status keys', () => {
    expect(ORDER_STATUS_KEYS).toHaveLength(14);
    expect(ORDER_STATUS_KEYS).toContain('pending_confirmation');
    expect(ORDER_STATUS_KEYS).toContain('backordered');
    expect(ORDER_STATUS_KEYS).toContain('cancelled');
  });

  it('has meta for every status key, with colors drawn from the allowed set', () => {
    for (const key of ORDER_STATUS_KEYS) {
      const meta = ORDER_STATUS_META[key];
      expect(meta).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(ORDER_STATUS_COLORS).toContain(meta.color);
      expect(typeof meta.sortOrder).toBe('number');
    }
  });

  it('isOrderStatusKey / isOrderStatusColor guard correctly', () => {
    expect(isOrderStatusKey('approved')).toBe(true);
    expect(isOrderStatusKey('not_a_status')).toBe(false);
    expect(isOrderStatusKey(42)).toBe(false);
    expect(isOrderStatusColor('warning')).toBe(true);
    expect(isOrderStatusColor('rainbow')).toBe(false);
    expect(isOrderStatusColor(null)).toBe(false);
  });
});

describe('resolveOrderStatusConfig', () => {
  it('returns the canonical defaults for null / undefined / garbage', () => {
    expect(resolveOrderStatusConfig(null)).toEqual(ORDER_STATUS_META);
    expect(resolveOrderStatusConfig(undefined)).toEqual(ORDER_STATUS_META);
    expect(resolveOrderStatusConfig('nope' as unknown as OrderStatusConfig)).toEqual(
      ORDER_STATUS_META,
    );
    expect(resolveOrderStatusConfig([] as unknown as OrderStatusConfig)).toEqual(
      ORDER_STATUS_META,
    );
  });

  it('returns a fresh copy that does not mutate the shared constant', () => {
    const resolved = resolveOrderStatusConfig({ approved: { label: 'OK' } });
    resolved.approved.label = 'tampered';
    expect(ORDER_STATUS_META.approved.label).toBe('Approved');
    // Default-valued keys are also copies, not references.
    expect(resolved.denied).not.toBe(ORDER_STATUS_META.denied);
  });

  it('overrides label, color, and sortOrder when valid', () => {
    const resolved = resolveOrderStatusConfig({
      pending_approval: { label: 'Awaiting sign-off', color: 'destructive', sortOrder: 99 },
    });
    expect(resolved.pending_approval).toEqual({
      label: 'Awaiting sign-off',
      color: 'destructive',
      sortOrder: 99,
    });
    // Untouched keys keep their defaults.
    expect(resolved.approved).toEqual(ORDER_STATUS_META.approved);
  });

  it('trims labels and rejects empty / over-long labels (keeps default)', () => {
    const resolved = resolveOrderStatusConfig({
      approved: { label: '  Trimmed  ' },
      denied: { label: '   ' },
      completed: { label: 'x'.repeat(ORDER_STATUS_LABEL_MAX + 1) },
    });
    expect(resolved.approved.label).toBe('Trimmed');
    expect(resolved.denied.label).toBe(ORDER_STATUS_META.denied.label);
    expect(resolved.completed.label).toBe(ORDER_STATUS_META.completed.label);
  });

  it('ignores unknown color tokens (keeps default color)', () => {
    const resolved = resolveOrderStatusConfig({
      approved: { color: 'neon' as never },
    });
    expect(resolved.approved.color).toBe(ORDER_STATUS_META.approved.color);
  });

  it('ignores non-finite / non-number sortOrder and truncates floats', () => {
    const resolved = resolveOrderStatusConfig({
      approved: { sortOrder: Number.NaN },
      denied: { sortOrder: '5' as never },
      completed: { sortOrder: 3.9 },
    });
    expect(resolved.approved.sortOrder).toBe(ORDER_STATUS_META.approved.sortOrder);
    expect(resolved.denied.sortOrder).toBe(ORDER_STATUS_META.denied.sortOrder);
    expect(resolved.completed.sortOrder).toBe(3);
  });

  it('ignores unknown status keys entirely', () => {
    const resolved = resolveOrderStatusConfig({
      not_a_status: { label: 'Hax', color: 'destructive' },
    } as unknown as OrderStatusConfig);
    expect(resolved).toEqual(ORDER_STATUS_META);
    expect((resolved as Record<string, unknown>).not_a_status).toBeUndefined();
  });

  it('ignores a non-object per-status entry (keeps default)', () => {
    const resolved = resolveOrderStatusConfig({
      approved: 'red' as never,
    });
    expect(resolved.approved).toEqual(ORDER_STATUS_META.approved);
  });
});
