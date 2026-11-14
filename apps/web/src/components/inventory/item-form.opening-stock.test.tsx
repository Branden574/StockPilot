import { describe, expect, it, vi } from 'vitest';

// A create whose opening quantity could not be recorded: the item WAS saved
// (with zero on hand), so the form must not stay open for a second press that
// would save a second item. The form shows the sentence and goes to where the
// saved record is: its page for one item, the list for several.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));

import { openingStockSavedHref } from './opening-stock-saved';

const ID = '33333333-3333-4333-8333-333333333333';
const saved = (details: Record<string, unknown>) => ({
  code: 'conflict' as const,
  message: 'This item was saved with zero on hand: its opening quantity could not be recorded.',
  details: { reason: 'opening_stock_not_recorded', ...details },
});

describe('openingStockSavedHref', () => {
  it('one saved item: its own page (items and books)', () => {
    expect(openingStockSavedHref(saved({ itemIds: [ID], total: 1 }), false)).toBe(
      `/dashboard/inventory/${ID}`,
    );
    expect(openingStockSavedHref(saved({ itemIds: [ID], total: 1 }), true)).toBe(
      `/dashboard/books/${ID}`,
    );
  });

  it('several saved items (a size run): the list', () => {
    expect(openingStockSavedHref(saved({ itemIds: [ID], total: 3 }), false)).toBe(
      '/dashboard/inventory',
    );
    expect(openingStockSavedHref(saved({ itemIds: [ID, ID], total: 2 }), true)).toBe(
      '/dashboard/books',
    );
  });

  it('any other refusal keeps the form as it is', () => {
    expect(
      openingStockSavedHref({ code: 'conflict', message: 'x', details: { reason: 'sku_taken' } }, false),
    ).toBeNull();
    expect(openingStockSavedHref({ code: 'conflict', message: 'x' }, false)).toBeNull();
    expect(
      openingStockSavedHref({ code: 'internal_error', message: 'x', details: { reason: 'opening_stock_not_recorded' } }, false),
    ).toBeNull();
  });
});
