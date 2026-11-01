import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  offline,
  outOfDate,
  recordEscapedRejections,
  signInRedirect,
} from '@/test/rejected-request';

// B40: Items > Save view spun forever and said nothing when the request
// failed. save() set `saving`, awaited createSavedViewAction with no catch and
// cleared `saving` only after the call resolved, so a call that rejected
// (offline, a server error the action threw, a deploy that no longer has the
// action) left the spinner on. The saved view chip's share and delete did the
// same with their own flags, and Apply view failed in silence.

const { routerMock, urlState } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  urlState: { params: new URLSearchParams('') },
}));
vi.mock('next/navigation', async (importOriginal) => ({
  // The real unstable_rethrow, so isControlFlow recognises a redirect.
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => routerMock,
  useSearchParams: () => urlState.params,
  usePathname: () => '/dashboard/inventory',
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => {
    const { prefetch: _p, scroll: _s, replace: _r, ...anchor } = rest;
    return (
      <a
        href={typeof href === 'string' ? href : '#'}
        {...(anchor as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  },
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt?: string }) => <img src={props.src} alt={props.alt ?? ''} />,
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
const actions = vi.hoisted(() => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/server/actions/saved-views', () => actions);
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: () => <div data-testid="bulk-actions" />,
}));

import { InventoryTable } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

const ROW = {
  id: 'item-1',
  name: 'Item one',
  sku: 'SKU-1',
  status: 'active' as const,
  quantity_on_hand: 4,
  reorder_point: 0,
  unit_cost: 2,
  retail_price: 5,
  category_id: null,
  charter_id: null,
  primary_location_id: null,
  barcode: null,
  model_number: null,
  custom_fields: null,
  created_at: '2026-01-01T00:00:00+00:00',
  updated_at: '2026-01-02T00:00:00+00:00',
};

const VIEW = {
  id: 'view-1',
  name: 'Restock',
  ownerId: 'user-1',
  isShared: false,
  state: { q: 'pens' },
};

function renderTable() {
  return render(
    <InventoryTable
      items={[ROW] as never}
      lookups={LOOKUPS}
      total={1}
      initialQuery=""
      pageSize={30}
      savedViewScope="inventory"
      savedViews={[VIEW] as never}
      currentUserId="user-1"
    />,
  );
}

async function openSaveView(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Save view' }));
  await user.type(await screen.findByLabelText('Name'), 'Pens');
  return screen.getByRole('button', { name: 'Save' });
}

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();

beforeEach(() => {
  vi.clearAllMocks();
  urlState.params = new URLSearchParams('');
  window.history.replaceState(null, '', '/dashboard/inventory');
});

describe('B40: Save view when the request fails', () => {
  it('stops the spinner and says the view was not saved when the call rejects', async () => {
    actions.createSavedViewAction.mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderTable();

    const save = await openSaveView(user);
    await user.click(save);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "We couldn't save the view. Check your connection and try again.",
      ),
    );
    // The popover is still open with the name kept and the reason inside it
    // (the toast sits outside the popover), and Save works again.
    expect(screen.getByRole('alert')).toHaveTextContent(
      "We couldn't save the view. Check your connection and try again.",
    );
    const again = screen.getByRole('button', { name: 'Save' });
    expect(again).toBeEnabled();
    expect(screen.getByLabelText('Name')).toHaveValue('Pens');
    expect(toastMock.success).not.toHaveBeenCalled();

    actions.createSavedViewAction.mockResolvedValueOnce({ ok: true, data: { id: 'view-2' } });
    await user.click(again);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('View "Pens" saved.'));
    expect(actions.createSavedViewAction).toHaveBeenCalledTimes(2);
  });

  it('shows the refusal it was given when the action answers with an error', async () => {
    actions.createSavedViewAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'A view with that name already exists.' },
    });
    const user = userEvent.setup();
    renderTable();

    await user.click(await openSaveView(user));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('A view with that name already exists.'),
    );
    // In the popover as well, where the person is looking.
    expect(screen.getByRole('alert')).toHaveTextContent('A view with that name already exists.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('a page older than the server says to reload, in the popover too', async () => {
    actions.createSavedViewAction.mockRejectedValueOnce(outOfDate());
    const user = userEvent.setup();
    renderTable();

    await user.click(await openSaveView(user));

    const sentence =
      "StockPilot was updated since this page was opened, so we couldn't save the view. Reload the page, then try again.";
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(toastMock.error).toHaveBeenCalledWith(sentence);
    expect(screen.getByLabelText('Name')).toHaveValue('Pens');
  });

  it('shows nothing when the call redirected to sign-in (the router is already navigating)', async () => {
    actions.createSavedViewAction.mockRejectedValueOnce(signInRedirect());
    const user = userEvent.setup();
    renderTable();

    await user.click(await openSaveView(user));

    await waitFor(() => expect(actions.createSavedViewAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('B40: the saved view chip when the request fails', () => {
  it('Share stops its spinner and says the view was not shared', async () => {
    actions.toggleSavedViewShareAction.mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderTable();

    const share = screen.getByRole('button', { name: 'Share view Restock with team' });
    await user.click(share);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "We couldn't share the view. Check your connection and try again.",
      ),
    );
    expect(screen.getByRole('button', { name: 'Share view Restock with team' })).toBeEnabled();
  });

  it('Delete stops its spinner and keeps the dialog open with the reason', async () => {
    actions.deleteSavedViewAction.mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Delete view Restock' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete view' }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "We couldn't delete the view. Check your connection and try again.",
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Delete view' })).toBeEnabled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(routerMock.refresh).not.toHaveBeenCalled();
    // The reason inside the confirm (the toast sits behind it), and Cancel
    // closes it.
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      "We couldn't delete the view. Check your connection and try again.",
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Apply says the view was not applied, and leaves the page as it was', async () => {
    actions.setActiveWarehouseAction.mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Apply view Restock' }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "We couldn't apply the view. Check your connection and try again.",
      ),
    );
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
