// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Removing items from a public link. The service removes up to 1000 entries
 * 100 at a time and stops at the first failed batch; the batches before it
 * are gone. The editor used to close the dialog and clear the selection on
 * any ok result, so a partial removal looked complete. It now says how many
 * were left and keeps the dialog and the selection, so Remove again finishes.
 */

const { removeEntries, searchCandidates, effectiveCount } = vi.hoisted(() => ({
  removeEntries: vi.fn(),
  searchCandidates: vi.fn(),
  effectiveCount: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/server/actions/public-links', () => ({
  addPublicLinkEntriesAction: vi.fn(),
  deletePublicLinkAction: vi.fn(),
  getPublicLinkEffectiveCountAction: effectiveCount,
  removePublicLinkEntriesAction: removeEntries,
  rotatePublicLinkTokenAction: vi.fn(),
  searchPublicLinkCandidatesAction: searchCandidates,
  setPublicLinkEntryMaxQtyAction: vi.fn(),
  updatePublicLinkAction: vi.fn(),
}));

import type { PublicLinkCandidateRow, PublicLinkRow } from '@/server/services/public-links';

import { PublicLinkEditor } from './public-link-editor';

const link: PublicLinkRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Spring drive',
  purpose: null,
  instructions: null,
  active: true,
  expires_at: null,
  available_from: null,
  available_until: null,
  availability_display: 'exact',
  books_enabled: true,
  items_enabled: true,
  include_public_pool: false,
  default_max_qty: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  entry_count: 2,
};
const rows: PublicLinkCandidateRow[] = ['Tent', 'Chair'].map((name, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  name,
  sku: null,
  item_type: 'product',
  status: 'active',
  category_id: null,
  warehouse_id: null,
  public_visibility: 'public',
  on_link: true,
  max_qty_per_request: null,
}));

function renderEditor() {
  render(
    <PublicLinkEditor
      appUrl="https://app.test"
      link={link}
      categories={[]}
      warehouses={[]}
      initialEffective={{ total: 2, byWarehouse: [] }}
      initialRows={rows}
      initialTotal={rows.length}
    />,
  );
}

async function removeAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('checkbox', { name: 'Select all items on this page' }));
  await user.click(screen.getByRole('button', { name: 'Remove from link' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: /^Remove 2 items$/ }));
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  searchCandidates.mockResolvedValue({ ok: true, data: { rows, total: rows.length } });
  effectiveCount.mockResolvedValue({ ok: true, data: { total: 2, byWarehouse: [] } });
});

describe('PublicLinkEditor bulk remove', () => {
  it('a partial removal says how many were left and keeps the dialog and the selection', async () => {
    const user = userEvent.setup();
    removeEntries.mockResolvedValue({ ok: true, data: { removed: 1, failed: 1 } });
    renderEditor();

    const dialog = await removeAll(user);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Removed 1 item. 1 item was not removed because of an error. Run it again to finish.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    // The rows were re-read so the part that was removed shows.
    expect(searchCandidates).toHaveBeenCalled();
  });

  it('a complete removal closes the dialog and clears the selection', async () => {
    const user = userEvent.setup();
    removeEntries.mockResolvedValue({ ok: true, data: { removed: 2, failed: 0 } });
    renderEditor();

    await removeAll(user);

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });
});
