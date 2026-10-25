import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newRackConfirmationDetail, type NewRackBlocker } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// 2026-09-24 (warehouse DC4): an item meant for rack 17-B was saved as "1-B", and a
// manual create resolves-or-CREATES the rack its opening stock is typed onto.
// A new rack 1-B appeared and all 130 units moved onto it. The phone has asked
// "Create new rack 1-B?" since #249; the web New item form never did.
//
// Now the server refuses such a create before anything is written, with the
// question (NEW_RACK_REQUIRES_CONFIRMATION), and this form asks it in the
// placement dialog, in the server's words, then saves again with the answer:
// yes (confirmNewRack), or a near-match instead. These pin the form's half.
// The server's half is inventory.new-rack-question.test.ts.
// ---------------------------------------------------------------------------

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
  findGroupCandidatesAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));

import { toast } from 'sonner';

import {
  bulkCreateSizedVariantsAction,
  createItemAction,
  updateItemAction,
} from '@/server/actions/inventory';
import { pressWhenEnabled } from '@/test/press-when-enabled';

import { ItemForm, type ItemFormDefaults } from './item-form';

type Category = Parameters<typeof ItemForm>[0]['categories'][number];

const WAREHOUSE_ID = '66666666-6666-4666-8666-666666666666';
const SITE_ID = '77777777-7777-4777-8777-777777777777';
const SHIRTS_ID = '88888888-8888-4888-8888-888888888888';

/** DC4's racks, as the phone guard's own test has them (create-rack-check.test.ts). */
const DC4_RACKS = ['17-B', '18-B', '20-A', '22-A', '35', '35-A', '36-A'];

/** What the action returns when the server asks, built by the server's own builder. */
function askedAbout(label: string, units: number, blockedBy: NewRackBlocker | null = null) {
  const detail = newRackConfirmationDetail({
    label,
    warehouseName: 'DC4',
    quantity: units,
    existingLabels: DC4_RACKS,
    blockedBy,
  });
  if (!detail) throw new Error(`${label} is an existing rack in the fixture`);
  return {
    ok: false,
    error: { code: 'conflict', message: detail.message, details: { ...detail } },
  };
}

const INCIDENT_MESSAGE =
  '1-B does not exist in DC4 yet. Continuing creates it and moves 130 units into it. Did you mean 17-B or 18-B?';

function renderForm(
  opts: {
    defaults?: ItemFormDefaults;
    itemType?: 'product' | 'book';
    categories?: Category[];
  } = {},
) {
  return render(
    <ItemForm
      defaults={{
        name: 'Spiral notebook',
        warehouseId: WAREHOUSE_ID,
        quantityOnHand: 130,
        ...opts.defaults,
      }}
      itemType={opts.itemType ?? 'product'}
      categories={opts.categories ?? []}
      locations={[{ id: SITE_ID, name: 'DC4' }]}
      suppliers={[]}
      warehouses={[{ id: WAREHOUSE_ID, name: 'DC4' }]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

const rackNumberBox = () => screen.getByPlaceholderText('38');
const rackRowBox = () => screen.getByPlaceholderText('A');
const createButton = () => screen.getByRole('button', { name: /create item/i });

function createCall(n: number): Record<string, unknown> {
  return vi.mocked(createItemAction).mock.calls[n]?.[0] as unknown as Record<string, unknown>;
}

function bulkCall(n: number): Record<string, unknown> {
  return vi.mocked(bulkCreateSizedVariantsAction).mock.calls[n]?.[0] as unknown as Record<
    string,
    unknown
  >;
}

async function typeRack(user: ReturnType<typeof userEvent.setup>, number: string, row: string) {
  await user.type(rackNumberBox(), number);
  await user.type(rackRowBox(), row);
}

beforeEach(() => vi.clearAllMocks());

describe('ItemForm, New item: a typed rack that does not exist is asked about first', () => {
  it('asks in the server words, saves nothing until the answer, and creates the rack on yes', async () => {
    vi.mocked(createItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 130) as never)
      .mockResolvedValueOnce({ ok: true, data: { id: 'item-new' } } as never);
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'b');
    await user.click(createButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Create new rack 1-B?')).toBeInTheDocument();
    expect(within(dialog).getByText(INCIDENT_MESSAGE)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Use 17-B instead' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Use 18-B instead' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    // The first save asked nothing in advance and was refused: nothing is
    // saved, nobody is sent anywhere, and the question is not an error.
    expect(createItemAction).toHaveBeenCalledTimes(1);
    expect(createCall(0)).not.toHaveProperty('confirmNewRack');
    expect(createCall(0)).toMatchObject({ binLocation: '1-B' });
    expect(push).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    await pressWhenEnabled(
      user,
      within(dialog).getByRole('button', { name: 'Create rack and save' }),
    );

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(2));
    expect(createCall(1)).toMatchObject({
      name: 'Spiral notebook',
      quantityOnHand: 130,
      binLocation: '1-B',
      confirmNewRack: true,
      customFields: expect.objectContaining({ rack_number: '1', rack_row: 'B' }),
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/item-new'));
    expect(toast.success).toHaveBeenCalledWith('Item created.');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('Go back saves nothing, keeps what was typed, and the next save asks again', async () => {
    vi.mocked(createItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 130) as never)
      .mockResolvedValueOnce(askedAbout('1-B', 130) as never);
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'B');
    await user.click(createButton());
    const dialog = await screen.findByRole('alertdialog');
    await pressWhenEnabled(user, within(dialog).getByRole('button', { name: 'Go back' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(createItemAction).toHaveBeenCalledTimes(1);
    expect(rackNumberBox()).toHaveValue('1');
    expect(rackRowBox()).toHaveValue('B');
    expect(push).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    // The answer belongs to one save. Going back answered nothing, so saving
    // again sends no yes and is asked again.
    await user.click(createButton());
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(createItemAction).toHaveBeenCalledTimes(2);
    expect(createCall(1)).not.toHaveProperty('confirmNewRack');
  });

  it('"Use 17-B instead" saves onto the existing rack, sends no yes, and shows it in the boxes', async () => {
    vi.mocked(createItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 130) as never)
      .mockResolvedValueOnce({ ok: true, data: { id: 'item-new' } } as never);
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'B');
    await user.click(createButton());
    const dialog = await screen.findByRole('alertdialog');
    await pressWhenEnabled(user, within(dialog).getByRole('button', { name: 'Use 17-B instead' }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(2));
    expect(createCall(1)).toMatchObject({
      binLocation: '17-B',
      customFields: expect.objectContaining({ rack_number: '17', rack_row: 'B' }),
    });
    expect(createCall(1)).not.toHaveProperty('confirmNewRack');
    expect(rackNumberBox()).toHaveValue('17');
    expect(rackRowBox()).toHaveValue('B');
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/item-new'));
  });

  it('asks again, in its own words, when the near-match is gone by the time it is saved', async () => {
    vi.mocked(createItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 130) as never)
      .mockResolvedValueOnce(
        // 17-B was deleted meanwhile: the server asks about 17-B now.
        (() => {
          const detail = newRackConfirmationDetail({
            label: '17-B',
            warehouseName: 'DC4',
            quantity: 130,
            existingLabels: ['18-B'],
          })!;
          return {
            ok: false,
            error: { code: 'conflict', message: detail.message, details: detail },
          };
        })() as never,
      );
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'B');
    await user.click(createButton());
    await pressWhenEnabled(
      user,
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Use 17-B instead',
      }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByRole('alertdialog')).getByText('Create new rack 17-B?'),
      ).toBeInTheDocument(),
    );
    expect(push).not.toHaveBeenCalled();
  });

  // 2026-10-25 review: a Staff member cannot create racks (no Manage
  // locations), so their yes never created one. The question says so in the
  // server's words, and its button says what the yes does.
  it('for a member who cannot create racks, says so and offers Save anyway, never Create rack and save', async () => {
    vi.mocked(createItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 130, 'create_rack') as never)
      .mockResolvedValueOnce({
        ok: true,
        data: { id: 'item-new', placementFailed: { rackName: '1-B', count: 1 } },
      } as never);
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'B');
    await user.click(createButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Rack 1-B does not exist')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        '1-B does not exist in DC4 yet, and creating a rack needs the Manage locations permission. Saving does not put the 130 units on a rack. Did you mean 17-B or 18-B?',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Use 17-B instead' })).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Create rack and save' }),
    ).not.toBeInTheDocument();

    await pressWhenEnabled(user, within(dialog).getByRole('button', { name: 'Save anyway' }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(2));
    expect(createCall(1)).toMatchObject({ binLocation: '1-B', confirmNewRack: true });
    // The item is saved, and the stock that is not on the rack is said.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/item-new'));
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('could not be placed on rack 1-B'),
      expect.anything(),
    );
  });

  it('an existing rack is saved straight away: one save, no question, no yes sent', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'item-new' },
    } as never);
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '17', 'B');
    await user.click(createButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/item-new'));
    expect(createItemAction).toHaveBeenCalledTimes(1);
    expect(createCall(0)).toMatchObject({ binLocation: '17-B' });
    expect(createCall(0)).not.toHaveProperty('confirmNewRack');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a Site picked as the primary location, with no rack typed, is saved with no question', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'item-new' },
    } as never);
    renderForm({ defaults: { primaryLocationId: SITE_ID } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(createButton());

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
    expect(createCall(0)).toMatchObject({ primaryLocationId: SITE_ID });
    // No rack label at all: the stock waits in Unplaced and no rack is made.
    expect(createCall(0).binLocation ?? null).toBeNull();
    expect(createCall(0)).not.toHaveProperty('confirmNewRack');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a book put in a crate is saved with no rack question', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'book-new' },
    } as never);
    renderForm({ itemType: 'book', defaults: { name: 'Maus I', quantityOnHand: 12 } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '17', 'B');
    await user.type(screen.getByPlaceholderText('e.g. 12'), '4');
    await user.click(createButton());

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
    expect(createCall(0)).toMatchObject({
      itemType: 'book',
      customFields: expect.objectContaining({
        book_rack_number: '17',
        book_rack_row: 'B',
        book_crate_number: '4',
      }),
    });
    expect(createCall(0)).not.toHaveProperty('confirmNewRack');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it("asks about a book's Bin / shelf rack too, and a near-match replaces the Bin / shelf", async () => {
    vi.mocked(createItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 12) as never)
      .mockResolvedValueOnce({ ok: true, data: { id: 'book-new' } } as never);
    renderForm({ itemType: 'book', defaults: { name: 'Maus I', quantityOnHand: 12 } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const bin = screen.getByPlaceholderText('A-12, Shelf 3…');
    await user.type(bin, '1-B');
    await user.click(createButton());
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Create new rack 1-B?')).toBeInTheDocument();
    await pressWhenEnabled(user, within(dialog).getByRole('button', { name: 'Use 17-B instead' }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(2));
    expect(createCall(1)).toMatchObject({ itemType: 'book', binLocation: '17-B' });
    expect(createCall(1)).not.toHaveProperty('confirmNewRack');
    expect(bin).toHaveValue('17-B');
  });

  it('says any other refusal as before, with no question', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'A warehouse must be selected before creating an item.',
      },
    } as never);
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'B');
    await user.click(createButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'A warehouse must be selected before creating an item.',
      ),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('never opens an empty question for a refusal that only looks like one', async () => {
    const asked = askedAbout('1-B', 130);
    vi.mocked(createItemAction).mockResolvedValueOnce({
      ...asked,
      error: { ...asked.error, details: { ...asked.error.details, title: '' } },
    } as never);
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'B');
    await user.click(createButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(INCIDENT_MESSAGE));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('an edit never asks it (the question belongs to a create)', async () => {
    vi.mocked(updateItemAction).mockResolvedValueOnce(askedAbout('1-B', 130) as never);
    renderForm({ defaults: { id: 'item-1', name: 'Spiral notebook', quantityOnHand: 130 } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await typeRack(user, '1', 'B');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(INCIDENT_MESSAGE));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('ItemForm, New item size run: the run is asked about once', () => {
  const SHIRTS = { id: SHIRTS_ID, name: 'Shirts', supports_sizes: true } as Category;

  it('asks, then saves the whole run again with the yes', async () => {
    vi.mocked(bulkCreateSizedVariantsAction)
      .mockResolvedValueOnce(askedAbout('1-B', 15) as never)
      .mockResolvedValueOnce({ ok: true, data: { created: 2, ids: ['v-s', 'v-m'] } } as never);
    renderForm({ categories: [SHIRTS], defaults: { name: 'Team Shirt', categoryId: SHIRTS_ID } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole('button', { name: 'S' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await typeRack(user, '1', 'B');
    await user.click(createButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Create new rack 1-B?')).toBeInTheDocument();
    expect(bulkCall(0)).not.toHaveProperty('confirmNewRack');
    expect(createItemAction).not.toHaveBeenCalled();

    await pressWhenEnabled(
      user,
      within(dialog).getByRole('button', { name: 'Create rack and save' }),
    );

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(2));
    expect(bulkCall(1)).toMatchObject({
      binLocation: '1-B',
      rackNumber: '1',
      rackRow: 'B',
      confirmNewRack: true,
      variants: [expect.objectContaining({ size: 'S' }), expect.objectContaining({ size: 'M' })],
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory'));
  });

  it('"Use 17-B instead" puts the run on the existing rack and sends no yes', async () => {
    vi.mocked(bulkCreateSizedVariantsAction)
      .mockResolvedValueOnce(askedAbout('1-B', 15) as never)
      .mockResolvedValueOnce({ ok: true, data: { created: 1, ids: ['v-s'] } } as never);
    renderForm({ categories: [SHIRTS], defaults: { name: 'Team Shirt', categoryId: SHIRTS_ID } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.click(screen.getByRole('button', { name: 'S' }));
    await typeRack(user, '1', 'B');
    await user.click(createButton());
    await pressWhenEnabled(
      user,
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Use 17-B instead',
      }),
    );

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(2));
    expect(bulkCall(1)).toMatchObject({ binLocation: '17-B', rackNumber: '17', rackRow: 'B' });
    expect(bulkCall(1)).not.toHaveProperty('confirmNewRack');
  });
});
