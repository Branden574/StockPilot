import { fireEvent, render, screen } from '@testing-library/react';
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

const BLOCKED = {
  length: 0,
  key: () => null,
  getItem: () => null,
  removeItem: () => {},
  setItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
};
function blockStorage() {
  vi.stubGlobal('sessionStorage', BLOCKED);
  vi.stubGlobal('localStorage', BLOCKED);
}
const labelsLink = () => screen.getByRole('link', { name: /Print labels/i });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe('BulkActions — Print labels', () => {
  it('hands 443 selected ids to the labels page through storage, with a short URL', async () => {
    renderBar(ids(443));
    await userEvent.click(labelsLink());

    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0]![0] as string;
    const match = /^\/dashboard\/inventory\/labels\?selection=([0-9a-f-]{36})$/.exec(href);
    expect(match).not.toBeNull();
    expect(href.length).toBeLessThan(100);
    expect(readLabelsSelection(match![1]!)).toEqual(ids(443));
  });

  it('falls back to ?items= for a small selection when storage is blocked', async () => {
    blockStorage();
    renderBar(ids(3));
    await userEvent.click(labelsLink());
    expect(push).toHaveBeenCalledWith(`/dashboard/inventory/labels?items=${ids(3).join(',')}`);
  });

  it('never builds a long URL: a large selection with storage blocked is refused with a message', async () => {
    blockStorage();
    renderBar(ids(LABELS_URL_FALLBACK_MAX + 1));
    await userEvent.click(labelsLink());
    expect(push).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('100 items or fewer'));
    expect(labelsLink().getAttribute('href')!.length).toBeLessThan(100);
  });

  // Review of this branch: Print labels had become a button, so cmd-click or
  // middle-click no longer opened the sheet in a new tab (on main it was a
  // plain link and both worked).
  it('is a link whose href is ready before a cmd-click, and the new tab can read the selection', () => {
    renderBar(ids(443));
    const link = labelsLink();
    // The pointer going down prepares the selection and the href.
    fireEvent.pointerDown(link, { button: 0 });
    const href = link.getAttribute('href')!;
    const match = /^\/dashboard\/inventory\/labels\?selection=([0-9a-f-]{36})$/.exec(href);
    expect(match).not.toBeNull();

    // A cmd-click is left to the browser (not prevented, no in-tab push).
    const notPrevented = fireEvent.click(link, { button: 0, metaKey: true });
    expect(notPrevented).toBe(true);
    expect(push).not.toHaveBeenCalled();

    // The new tab has its own, empty sessionStorage.
    sessionStorage.clear();
    expect(readLabelsSelection(match![1]!)).toEqual(ids(443));
  });

  it('a middle click and "Open in new tab" use the same prepared href', () => {
    renderBar(ids(20));
    const link = labelsLink();
    fireEvent.pointerDown(link, { button: 1 });
    const middle = link.getAttribute('href');
    expect(middle).toMatch(/\?selection=/);
    // The context menu (right button) sees the same, already prepared, link.
    fireEvent.pointerDown(link, { button: 2 });
    expect(link.getAttribute('href')).toBe(middle);
  });

  it('keyboard focus prepares the link too, and a new selection gets a new key', () => {
    const { rerender } = render(
      <BulkActions
        selectedIds={ids(5)}
        categories={[]}
        suppliers={[]}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    const link = screen.getByRole('link', { name: /Print labels/i });
    fireEvent.focus(link);
    const first = link.getAttribute('href');
    expect(first).toMatch(/\?selection=/);
    rerender(
      <BulkActions
        selectedIds={ids(6)}
        categories={[]}
        suppliers={[]}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    fireEvent.focus(link);
    const second = link.getAttribute('href');
    expect(second).toMatch(/\?selection=/);
    expect(second).not.toBe(first);
    const key = /selection=([0-9a-f-]{36})/.exec(second!)![1]!;
    expect(readLabelsSelection(key)).toEqual(ids(6));
  });
});
