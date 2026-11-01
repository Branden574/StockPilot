// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import type { PublicLinkCandidateRow, PublicLinkRow } from '@/server/services/public-links';
import { offline, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the public request link pages. Every save, regenerate, delete, bulk
// add or remove, quantity limit, item search and count set a busy flag,
// awaited its Server Action with no catch and cleared the flag only when it
// answered. A call that got no answer (offline, a server error, a deploy)
// left its button spinning and its confirm unclosable, with no message. Now
// each says what did not happen in its own error line (inside the confirm
// for Regenerate URL and Delete link), and a redirect to sign-in says nothing.
// ---------------------------------------------------------------------------

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises the redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/public-links', () => ({
  addPublicLinkEntriesAction: vi.fn(),
  createPublicLinkAction: vi.fn(),
  deletePublicLinkAction: vi.fn(),
  duplicatePublicLinkAction: vi.fn(),
  getPublicLinkEffectiveCountAction: vi.fn(),
  removePublicLinkEntriesAction: vi.fn(),
  rotatePublicLinkTokenAction: vi.fn(),
  searchPublicLinkCandidatesAction: vi.fn(),
  setPublicLinkActiveAction: vi.fn(),
  setPublicLinkEntryMaxQtyAction: vi.fn(),
  updatePublicLinkAction: vi.fn(),
}));

import {
  addPublicLinkEntriesAction,
  createPublicLinkAction,
  deletePublicLinkAction,
  duplicatePublicLinkAction,
  getPublicLinkEffectiveCountAction,
  removePublicLinkEntriesAction,
  rotatePublicLinkTokenAction,
  searchPublicLinkCandidatesAction,
  setPublicLinkActiveAction,
  setPublicLinkEntryMaxQtyAction,
  updatePublicLinkAction,
} from '@/server/actions/public-links';

import { PublicLinkEditor } from './public-link-editor';
import { PublicLinksManager } from './public-links-manager';

const LINK: PublicLinkRow = {
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
const ROWS: PublicLinkCandidateRow[] = ['Tent', 'Chair'].map((name, i) => ({
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
      appUrl="https://app.example.com"
      link={LINK}
      categories={[]}
      warehouses={[]}
      initialEffective={{ total: 2, byWarehouse: [] }}
      initialRows={ROWS}
      initialTotal={ROWS.length}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchPublicLinkCandidatesAction).mockResolvedValue({
    ok: true,
    data: { rows: ROWS, total: ROWS.length },
  } as never);
  vi.mocked(getPublicLinkEffectiveCountAction).mockResolvedValue({
    ok: true,
    data: { total: 2, byWarehouse: [] },
  } as never);
});

async function confirmIn(user: UserEvent, opener: string, confirm: string) {
  await user.click(screen.getByRole('button', { name: opener }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: confirm }));
  return dialog;
}

describe('the public link editor when a request gets no answer', () => {
  it('Regenerate URL says why inside the confirm, which can be closed', async () => {
    vi.mocked(rotatePublicLinkTokenAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderEditor();
    const dialog = await confirmIn(user, 'Regenerate URL', 'Regenerate URL');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'regenerate the URL'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("the other confirm opens without the last one's error in it", async () => {
    vi.mocked(rotatePublicLinkTokenAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderEditor();
    const first = await confirmIn(user, 'Regenerate URL', 'Regenerate URL');
    await within(first).findByRole('alert');
    await user.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Delete link' }));
    const second = await screen.findByRole('dialog');
    expect(within(second).queryByRole('alert')).toBeNull();
  });

  it('Delete link says why inside the confirm and stays on the page', async () => {
    vi.mocked(deletePublicLinkAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderEditor();
    const dialog = await confirmIn(user, 'Delete link', 'Delete link');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'delete the link'),
    );
    expect(within(dialog).getByRole('button', { name: 'Delete link' })).toBeEnabled();
    expect(push).not.toHaveBeenCalled();
  });

  it('Save settings says so under the settings and works again', async () => {
    vi.mocked(updatePublicLinkAction).mockRejectedValueOnce(offline());
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'save the link settings'),
    );
    expect(screen.getByRole('button', { name: /Save settings/ })).toBeEnabled();
  });

  it('Refresh of the public count says so and works again', async () => {
    vi.mocked(getPublicLinkEffectiveCountAction).mockRejectedValueOnce(offline());
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'count the items on the link'),
    );
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeEnabled();
  });

  it('a search that gets no answer says the items were not loaded', async () => {
    vi.mocked(searchPublicLinkCandidatesAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Search items by name or SKU'), 'tent');
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      requestFailedMessage(offline(), 'load the items'),
    );
  });

  it('a quantity limit says it was not saved, and the box works again', async () => {
    vi.mocked(setPublicLinkEntryMaxQtyAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderEditor();
    const box = screen.getByLabelText('Max quantity per request for Tent');
    await user.type(box, '3');
    fireEvent.blur(box);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'save the quantity limit'),
    );
    expect(screen.getByLabelText('Max quantity per request for Tent')).toBeEnabled();
  });

  // Sent again, an item already on the link is written once (an upsert on
  // the link and the item, server/services/public-links.ts).
  it('Add to link says why inside its dialog and works again', async () => {
    vi.mocked(addPublicLinkEntriesAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('checkbox', { name: 'Select all items on this page' }));
    const dialog = await confirmIn(user, 'Add to link', 'Add 2 items');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'add the items'),
    );
    expect(within(dialog).getByRole('button', { name: 'Add 2 items' })).toBeEnabled();
  });

  it('Remove from link says why inside its dialog and works again', async () => {
    vi.mocked(removePublicLinkEntriesAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('checkbox', { name: 'Select all items on this page' }));
    const dialog = await confirmIn(user, 'Remove from link', 'Remove 2 items');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'remove the items'),
    );
    expect(within(dialog).getByRole('button', { name: 'Remove 2 items' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(updatePublicLinkAction).mockRejectedValueOnce(signInRedirect());
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }));
    await waitFor(() => expect(updatePublicLinkAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the public links list when a request gets no answer', () => {
  it('Disable says why inside its confirm, which can be closed', async () => {
    vi.mocked(setPublicLinkActiveAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<PublicLinksManager appUrl="https://app.example.com" links={[LINK]} />);
    const dialog = await confirmIn(user, 'Disable', 'Disable link');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'turn the link off'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the Disable confirm opens without an older error in it', async () => {
    vi.mocked(duplicatePublicLinkAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<PublicLinksManager appUrl="https://app.example.com" links={[LINK]} />);
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  // A copy has no key: one made before the answer was lost is a second copy.
  it('Duplicate says to look before trying again and works again', async () => {
    vi.mocked(duplicatePublicLinkAction).mockRejectedValueOnce(offline());
    render(<PublicLinksManager appUrl="https://app.example.com" links={[LINK]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestUnconfirmedMessage(offline(), 'the link was copied', 'the links list'),
    );
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeEnabled();
  });

  it('Create link keeps the name, says to look before trying again and works again', async () => {
    vi.mocked(createPublicLinkAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<PublicLinksManager appUrl="https://app.example.com" links={[]} />);
    await user.click(screen.getAllByRole('button', { name: /New link/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Link name'), 'Book fair');
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestUnconfirmedMessage(offline(), 'the link was created', 'the links list'),
    );
    expect(within(dialog).getByLabelText('Link name')).toHaveValue('Book fair');
    expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeEnabled();
  });
});
