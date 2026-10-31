import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

import { BulkActions } from './bulk-actions';

import { bulkUpdateInventoryAction } from '@/server/actions/inventory';
import { bulkSetItemPublicVisibilityAction } from '@/server/actions/item-visibility';
import { createDraftPosFromItemsAction } from '@/server/actions/purchase-orders';

// B40: the Items toolbar's bulk writes set a busy flag, awaited the action
// with no catch and cleared the flag only when it answered. A call that got no
// answer (offline, a server error, a deploy) left the button spinning, said
// nothing, and for Archive left the confirm stuck open (it refuses to close
// while pending).

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/inventory',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/inventory', () => ({ bulkUpdateInventoryAction: vi.fn() }));
vi.mock('@/server/actions/item-visibility', () => ({
  bulkSetItemPublicVisibilityAction: vi.fn(),
}));
vi.mock('@/server/actions/purchase-orders', () => ({ createDraftPosFromItemsAction: vi.fn() }));

function renderBar(onClear = vi.fn()) {
  render(
    <BulkActions
      selectedIds={['a', 'b', 'c']}
      categories={[]}
      suppliers={[]}
      locations={[]}
      tags={[]}
      onClear={onClear}
      onCycleCount={() => {}}
      canSetPublicVisibility
    />,
  );
  return onClear;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkActions when a bulk write gets no answer', () => {
  it('Create draft POs says to check Purchase orders before trying again, and works again', async () => {
    vi.mocked(createDraftPosFromItemsAction).mockRejectedValueOnce(offline());
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Create draft POs/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the draft POs were created', 'Purchase orders'),
      ),
    );
    expect(screen.getByRole('button', { name: /Create draft POs/i })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('Set public visibility says the change was not made, in the dialog, and Apply works again', async () => {
    vi.mocked(bulkSetItemPublicVisibilityAction).mockRejectedValueOnce(offline());
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Set public visibility/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'change the public visibility'),
    );
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('Archive says the items were not updated, stops spinning and keeps the selection', async () => {
    vi.mocked(bulkUpdateInventoryAction).mockRejectedValueOnce(offline());
    const onClear = renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Archive/i }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getAllByRole('button', { name: /Archive/i });
    await user.click(confirm[confirm.length - 1]!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'update the items')),
    );
    const again = within(dialog).getAllByRole('button', { name: /Archive/i });
    expect(again[again.length - 1]).toBeEnabled();
    expect(onClear).not.toHaveBeenCalled();
  });
});
