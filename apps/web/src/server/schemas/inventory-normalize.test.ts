import { describe, expect, it } from 'vitest';

import { createItemSchema, updateItemSchema } from '@stockpilot/core';

/**
 * Schema-level normalization tests. The form's SKU and barcode fields
 * default to '' (empty string) when the user hasn't typed anything.
 * Empty string + min(1) means validation rejects what should be a
 * benign "use the auto-generator" signal — the symptom we're fixing
 * is items landing in the DB without a SKU and breaking label
 * printing afterwards.
 *
 * Contract: empty / whitespace-only `sku` and `barcode` get coerced
 * to `undefined` before validation runs. The downstream service code
 * already handles undefined → auto-generate.
 */

describe('createItemSchema normalization', () => {
  const baseInput = { name: 'Sample item' };

  it('coerces empty string sku to undefined', () => {
    const result = createItemSchema.safeParse({ ...baseInput, sku: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sku).toBeUndefined();
    }
  });

  it('coerces whitespace-only sku to undefined', () => {
    const result = createItemSchema.safeParse({ ...baseInput, sku: '   ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sku).toBeUndefined();
    }
  });

  it('keeps a real sku intact (trimmed)', () => {
    const result = createItemSchema.safeParse({ ...baseInput, sku: '  ABC-123  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sku).toBe('ABC-123');
    }
  });

  it('coerces empty barcode to undefined', () => {
    const result = createItemSchema.safeParse({ ...baseInput, barcode: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.barcode).toBeUndefined();
    }
  });

  it('keeps a real barcode intact (trimmed)', () => {
    const result = createItemSchema.safeParse({
      ...baseInput,
      barcode: '  9780062315007  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.barcode).toBe('9780062315007');
    }
  });

  it('omits optional sku entirely without erroring', () => {
    const result = createItemSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sku).toBeUndefined();
    }
  });
});

describe('updateItemSchema normalization', () => {
  it('coerces empty string sku to undefined on update', () => {
    const result = updateItemSchema.safeParse({ sku: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sku).toBeUndefined();
    }
  });
});
