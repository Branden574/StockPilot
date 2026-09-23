// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Print labels for up to 500 items. byIds batches the ids (one `.in()` of
 * them failed past ~215 locally and ~395 in production) and throws
 * internal_error on a failed batch. The page used to swallow every
 * ServiceError into "No items selected", sending the user back to pick items
 * they had already picked; a failed read now reaches the error boundary. A
 * malformed id is dropped before the read, so it cannot fail a batch.
 */

const { byIds, forCurrentUser } = vi.hoisted(() => {
  const byIds = vi.fn();
  return { byIds, forCurrentUser: vi.fn(async () => ({ byIds })) };
});

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/components/inventory/label-sheet', () => ({ LabelSheet: () => null }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser },
}));
vi.mock('@/components/inventory/labels-from-selection', () => ({
  LabelsFromSelection: ({ selectionKey }: { selectionKey: string }) => (
    <div data-testid="from-selection">{selectionKey}</div>
  ),
}));

import { ServiceError } from '@/server/services/context';

import LabelsPage from './page';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = Array.from({ length: 250 }, (_, i) => uuid(i));

beforeEach(() => vi.clearAllMocks());

describe('labels page', () => {
  it('asks byIds for every well-formed id and drops a malformed one', async () => {
    byIds.mockResolvedValue(ids.map((id) => ({ id, name: id, sku: id, barcode: null })));
    render(
      await LabelsPage({ searchParams: Promise.resolve({ items: [...ids, 'not-a-uuid'].join(',') }) }),
    );
    expect(byIds).toHaveBeenCalledWith(ids);
    expect(screen.getByText(/250 items selected/)).toBeTruthy();
  });

  it('?selection= renders the storage handoff and reads nothing on the server', async () => {
    const key = uuid(7);
    render(await LabelsPage({ searchParams: Promise.resolve({ selection: key }) }));
    expect(screen.getByTestId('from-selection').textContent).toBe(key);
    expect(forCurrentUser).not.toHaveBeenCalled();
    expect(byIds).not.toHaveBeenCalled();
  });

  it('says so when more ids were passed than one sheet prints, instead of dropping them quietly', async () => {
    const many = Array.from({ length: 520 }, (_, i) => uuid(i));
    byIds.mockResolvedValue(
      many.slice(0, 500).map((id) => ({ id, name: id, sku: id, barcode: null })),
    );
    render(await LabelsPage({ searchParams: Promise.resolve({ items: many.join(',') }) }));
    expect(byIds).toHaveBeenCalledWith(many.slice(0, 500));
    expect(screen.getByText(/500 items selected/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('520 items were selected');
  });

  it('a failed read reaches the error boundary, never "No items selected"', async () => {
    byIds.mockRejectedValue(new ServiceError('internal_error', 'fetch failed'));
    await expect(
      LabelsPage({ searchParams: Promise.resolve({ items: ids.join(',') }) }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
