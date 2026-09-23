import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bulk bar's Print labels. It used to be a link carrying every selected
 * id: 443 selected items made a 16,437-byte request line and Node answered 431
 * before the app ran (lab run, 2026-09-23). The ids now go through this tab's
 * sessionStorage and the URL carries only a 36-character key.
 */

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/inventory',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/inventory', () => ({ bulkUpdateInventoryAction: vi.fn() }));
vi.mock('@/server/actions/purchase-orders', () => ({ createDraftPosFromItemsAction: vi.fn() }));

import { LABELS_URL_FALLBACK_MAX, readLabelsSelection } from '@/lib/inventory/labels-selection';

import { BulkActions } from './bulk-actions';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));

function renderBar(selectedIds: string[]) {
  render(
    <BulkActions
      selectedIds={selectedIds}
      categories={[]}
      suppliers={[]}
      locations={[]}
      tags={[]}
      onClear={() => {}}
      onCycleCount={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('BulkActions — Print labels', () => {
  it('hands 443 selected ids to the labels page through storage, with a short URL', async () => {
    renderBar(ids(443));
    await userEvent.click(screen.getByRole('button', { name: /Print labels/i }));

    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0]![0] as string;
    const match = /^\/dashboard\/inventory\/labels\?selection=([0-9a-f-]{36})$/.exec(href);
    expect(match).not.toBeNull();
    expect(href.length).toBeLessThan(100);
    expect(readLabelsSelection(match![1]!)).toEqual(ids(443));
  });

  it('falls back to ?items= for a small selection when storage is blocked', async () => {
    vi.stubGlobal('sessionStorage', {
      length: 0,
      key: () => null,
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    renderBar(ids(3));
    await userEvent.click(screen.getByRole('button', { name: /Print labels/i }));
    expect(push).toHaveBeenCalledWith(`/dashboard/inventory/labels?items=${ids(3).join(',')}`);
  });

  it('never builds a long URL: a large selection with storage blocked is refused with a message', async () => {
    vi.stubGlobal('sessionStorage', {
      length: 0,
      key: () => null,
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    renderBar(ids(LABELS_URL_FALLBACK_MAX + 1));
    await userEvent.click(screen.getByRole('button', { name: /Print labels/i }));
    expect(push).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('100 items or fewer'));
  });
});
