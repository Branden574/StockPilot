import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the New / Edit dialogs of the charters, warehouses, categories,
// locations, suppliers and tags lists submit through react-hook-form, which
// clears isSubmitting and rethrows when the action rejects: a save that got
// no answer (offline, a server error, a deploy) stopped spinning and said
// nothing, as if it had worked. Supplier Archive and Restore and tag Delete
// left their confirm unclosable. Now the dialog stays open with what was
// typed and says what did not happen: a create with no rule that refuses a
// second copy says to look before trying again; a create that such a rule
// refuses (a warehouse code, a tag name) and every edit say it failed. A
// redirect to sign-in says nothing.
// ---------------------------------------------------------------------------

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises the redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh, back: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/charters', () => ({
  createCharterAction: vi.fn(),
  updateCharterAction: vi.fn(),
  archiveCharterAction: vi.fn(),
  restoreCharterAction: vi.fn(),
}));
vi.mock('@/server/actions/warehouses', () => ({
  createWarehouseAction: vi.fn(),
  updateWarehouseAction: vi.fn(),
  archiveWarehouseAction: vi.fn(),
  restoreWarehouseAction: vi.fn(),
}));
vi.mock('@/server/actions/categories', () => ({
  archiveCategoryAction: vi.fn(),
  createCategoryAction: vi.fn(),
  restoreCategoryAction: vi.fn(),
  setupSportsCategoriesAction: vi.fn(),
  updateCategoryAction: vi.fn(),
}));
vi.mock('@/server/actions/item-visibility', () => ({
  setCategoryPublicVisibilityAction: vi.fn(),
}));
vi.mock('@/server/actions/locations', () => ({
  archiveLocationAction: vi.fn(),
  createLocationAction: vi.fn(),
  restoreLocationAction: vi.fn(),
  updateLocationAction: vi.fn(),
}));
vi.mock('@/server/actions/suppliers', () => ({
  archiveSupplierAction: vi.fn(),
  restoreSupplierAction: vi.fn(),
  createSupplierAction: vi.fn(),
  updateSupplierAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({
  createTagAction: vi.fn(),
  deleteTagAction: vi.fn(),
  updateTagAction: vi.fn(),
}));

import { toast } from 'sonner';

import { CategoriesManager } from '@/components/categories/categories-manager';
import { LocationsManager } from '@/components/locations/locations-manager';
import { SuppliersManager } from '@/components/suppliers/suppliers-manager';
import { TagsManager } from '@/components/tags/tags-manager';
import { createCategoryAction } from '@/server/actions/categories';
import { createCharterAction, updateCharterAction } from '@/server/actions/charters';
import { createLocationAction } from '@/server/actions/locations';
import {
  archiveSupplierAction,
  createSupplierAction,
  restoreSupplierAction,
} from '@/server/actions/suppliers';
import { createTagAction, deleteTagAction, updateTagAction } from '@/server/actions/tags';
import { createWarehouseAction } from '@/server/actions/warehouses';

import { ChartersManager } from './charters-manager';
import { WarehousesManager } from './warehouses-manager';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
});

const CHARTER = {
  id: 'c1',
  name: 'Harbor',
  code: null,
  description: null,
  notes: null,
  status: 'active' as const,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  warehouse_count: 2,
  user_count: 5,
  address: null,
};
const SUPPLIER = {
  id: 's1',
  name: 'Example Supplies',
  contact_name: null,
  email: null,
  phone: null,
  website: null,
  notes: null,
};

async function openDialog(user: UserEvent, opener: string | RegExp) {
  await user.click(screen.getAllByRole('button', { name: opener })[0]!);
  return screen.findByRole('dialog');
}

interface CreateCase {
  name: string;
  action: ReturnType<typeof vi.fn>;
  ui: () => React.ReactElement;
  opener: string | RegExp;
  fill: (user: UserEvent, dialog: HTMLElement) => Promise<void>;
  submit: string;
  sentence: (e: unknown) => string;
}

const CREATES: CreateCase[] = [
  {
    // A code is optional, so nothing stops a second charter.
    name: 'New charter',
    action: vi.mocked(createCharterAction),
    ui: () => (
      <ChartersManager
        initial={[CHARTER]}
        termSingular="Region"
        eyebrow="Admin"
        title="Regions"
        subline="Top-level groupings for warehouses."
      />
    ),
    opener: /New region/,
    fill: async (user, dialog) => {
      await user.type(within(dialog).getByLabelText('Name'), 'Coast');
    },
    submit: 'Create region',
    sentence: (e) => requestUnconfirmedMessage(e, 'the region was created', 'the regions list'),
  },
  {
    // A second warehouse with the same code is refused: warehouses are unique
    // on (organization_id, code), a code is required, and the service answers
    // 'A warehouse with code "..." already exists.'.
    name: 'New warehouse',
    action: vi.mocked(createWarehouseAction),
    ui: () => (
      <WarehousesManager
        view="active"
        initial={[]}
        charters={[{ id: 'c1', name: 'Harbor' }]}
        managers={[]}
        termSingular="Depot"
        charterSingular="Region"
        eyebrow="Admin"
        title="Depots"
        subline="Physical locations stock lives in."
      />
    ),
    opener: /New depot/,
    fill: async (user, dialog) => {
      await user.type(within(dialog).getByLabelText('Name'), 'Annex');
      await user.type(within(dialog).getByLabelText('Code'), 'ANX');
    },
    submit: 'Create depot',
    sentence: (e) => requestFailedMessage(e, 'create the depot'),
  },
  {
    name: 'New category',
    action: vi.mocked(createCategoryAction),
    ui: () => (
      <CategoriesManager
        initial={[]}
        canManage
        canManagePublicVisibility={false}
        sportsEnabled={false}
        canManageSports={false}
      />
    ),
    opener: /New category/,
    fill: async (user, dialog) => {
      await user.type(within(dialog).getByLabelText('Name'), 'Electronics');
    },
    submit: 'Create category',
    sentence: (e) =>
      requestUnconfirmedMessage(e, 'the category was created', 'the categories list'),
  },
  {
    name: 'New location',
    action: vi.mocked(createLocationAction),
    ui: () => <LocationsManager initial={[]} canManage />,
    opener: /New location/,
    fill: async (user, dialog) => {
      await user.type(within(dialog).getByLabelText('Name'), 'Back room');
    },
    submit: 'Create location',
    sentence: (e) => requestUnconfirmedMessage(e, 'the location was created', 'the locations list'),
  },
  {
    name: 'New supplier',
    action: vi.mocked(createSupplierAction),
    ui: () => <SuppliersManager initial={[]} view="active" canManage />,
    opener: /New supplier/,
    fill: async (user, dialog) => {
      await user.type(within(dialog).getByLabelText('Name'), 'Example Paper Co');
    },
    submit: 'Create supplier',
    sentence: (e) => requestUnconfirmedMessage(e, 'the supplier was created', 'the suppliers list'),
  },
  {
    // A second tag with the same name is refused: tags are unique on
    // (organization_id, name), and the service answers "A tag with that name
    // already exists".
    name: 'New tag',
    action: vi.mocked(createTagAction),
    ui: () => <TagsManager initial={[]} />,
    opener: /New tag/,
    fill: async (user, dialog) => {
      await user.type(within(dialog).getByLabelText('Name'), 'Fragile');
    },
    submit: 'Create tag',
    sentence: (e) => requestFailedMessage(e, 'create the tag'),
  },
];

describe('New dialogs when the save gets no answer', () => {
  for (const c of CREATES) {
    it(`${c.name}: stays open with what was typed, says what did not happen, and works again`, async () => {
      c.action.mockRejectedValueOnce(offline());
      const user = userEvent.setup();
      render(c.ui());
      const dialog = await openDialog(user, c.opener);
      await c.fill(user, dialog);
      await user.click(within(dialog).getByRole('button', { name: c.submit }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(c.sentence(offline())));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(within(dialog).getByLabelText('Name')).not.toHaveValue('');
      expect(within(dialog).getByRole('button', { name: c.submit })).toBeEnabled();
    });

    it(`${c.name}: says nothing on the way to sign-in`, async () => {
      c.action.mockRejectedValueOnce(signInRedirect());
      const user = userEvent.setup();
      render(c.ui());
      const dialog = await openDialog(user, c.opener);
      await c.fill(user, dialog);
      await user.click(within(dialog).getByRole('button', { name: c.submit }));
      await waitFor(() => expect(c.action).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(toast.error).not.toHaveBeenCalled();
    });
  }
});

describe('Edit dialogs when the save gets no answer', () => {
  it('Edit charter says it was not saved and stays open', async () => {
    vi.mocked(updateCharterAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(
      <ChartersManager
        initial={[CHARTER]}
        termSingular="Region"
        eyebrow="Admin"
        title="Regions"
        subline="Top-level groupings for warehouses."
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Edit/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'save the region')),
    );
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('Edit tag says it was not saved and stays open', async () => {
    vi.mocked(updateTagAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<TagsManager initial={[{ id: 't-1', name: 'Fragile', color: null, usage_count: 1 }]} />);
    await user.click(screen.getAllByRole('button', { name: /Edit/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'save the tag')),
    );
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
});

describe('confirms that could not be closed', () => {
  it('supplier Archive says why inside the confirm, which can be closed', async () => {
    vi.mocked(archiveSupplierAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<SuppliersManager initial={[SUPPLIER]} view="active" canManage />);
    const dialog = await openDialog(user, 'Archive Example Supplies');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    const sentence = requestFailedMessage(offline(), 'archive the supplier');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Opened again, it does not show the last try's reason.
    const again = await openDialog(user, 'Archive Example Supplies');
    expect(within(again).queryByRole('alert')).toBeNull();
  });

  it('supplier Restore says why inside the confirm', async () => {
    vi.mocked(restoreSupplierAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<SuppliersManager initial={[SUPPLIER]} view="archived" canManage />);
    const dialog = await openDialog(user, /Restore/);
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'restore the supplier'),
    );
    expect(within(dialog).getByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  it('tag Delete says why inside the confirm, which can be closed', async () => {
    vi.mocked(deleteTagAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<TagsManager initial={[{ id: 't-1', name: 'Fragile', color: null, usage_count: 1 }]} />);
    const dialog = await openDialog(user, 'Delete Fragile');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'delete the tag'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
