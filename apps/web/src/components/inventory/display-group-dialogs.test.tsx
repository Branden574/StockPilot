import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUP_COPY, GROUPING_ERROR_WORDS, groupingPreviewKey } from '@stockpilot/core';

// Group selected's review (design 5, migration 0400): the brief's sentence
// verbatim; each selected record with its picture, name, SKU (and ISBN for a
// book), size, charter, rack and on hand; Cancel writes nothing; a record in
// another group needs an explicit per-record move before Save; a product-
// family member needs the confirmation; Save sends one body under a key kept
// for its retries; a repeat is a no-op; an answer for another selection is
// ignored. Remove from group and Rename send their own bodies.

const h = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }));
vi.mock('@/server/actions/item-grouping', () => ({
  previewGroupingAction: h.preview,
  applyGroupingAction: h.apply,
}));

import {
  GroupSelectedDialog,
  RemoveFromGroupDialog,
  RenameGroupDialog,
} from './display-group-dialogs';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const G = '99999999-9999-4999-8999-999999999999';
const H = '88888888-8888-4888-8888-888888888888';

function rec(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Polo XXXL',
    sku: `SKU-${id.slice(0, 1).toUpperCase()}`,
    barcode: null,
    isbnFields: null,
    itemType: 'product',
    isBundle: false,
    isRental: false,
    productGroupId: null,
    productGroupName: null,
    variantSize: null,
    charterId: null,
    warehouseId: 'wh',
    binLocation: '15-A',
    customFields: null,
    quantityOnHand: 2,
    createdAt: '2026-01-01T00:00:00Z',
    displayGroup: null,
    writable: true,
    charterName: 'North',
    warehouseName: 'DC4',
    placementLabel: '15-A',
    imageUrl: null,
    ...over,
  };
}

function review(
  ids: string[],
  records: unknown[],
  over: Record<string, unknown> = {},
  groupId: string | null = null,
) {
  return {
    ok: true,
    data: {
      organizationId: ORG,
      actorUserId: ME,
      review: {
        records,
        unavailableCount: 0,
        sameSkuSiblings: [],
        candidateGroups: [],
        targetGroup: null,
        previewKey: groupingPreviewKey(ORG, ids, groupId),
        ...over,
      },
    },
  };
}

const APPLIED = {
  ok: true,
  data: {
    outcome: {
      action: 'group',
      outcome: 'applied',
      replay: false,
      created: true,
      group: { id: G, name: 'Polo XXXL', version: 1, itemType: 'product', closed: false },
      changes: [],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GroupSelectedDialog', () => {
  it("says the brief's sentence and lists exactly the selected records with their details", async () => {
    h.preview.mockResolvedValueOnce(
      review(
        [A, B],
        [rec(A), rec(B, { charterName: null, placementLabel: null, quantityOnHand: 5 })],
        {
          unavailableCount: 1,
        },
      ),
    );
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText(
        'Grouping organizes these records together. It does not combine stock, change ownership, or move items.',
      ),
    ).toBeInTheDocument();
    const rowA = await screen.findByTestId(`group-row-${A}`);
    expect(
      within(rowA).getByText(/SKU SKU-A · North · 15-A · DC4 · 2 on hand/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId(`group-row-${B}`)).getByText(
        /No charter · No rack · DC4 · 5 on hand/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(GROUP_COPY.unavailable(1))).toBeInTheDocument();
    // The name is a suggestion, editable; the header previews the result.
    expect(screen.getByDisplayValue('Polo XXXL')).toBeInTheDocument();
    expect(screen.getByTestId('group-preview-header')).toHaveTextContent(
      'Polo XXXL · 2 records · 7 on hand',
    );
    expect(screen.getByText(GROUP_COPY.skuNote)).toBeInTheDocument();
    expect(h.preview).toHaveBeenCalledWith([A, B], null);
  });

  it('Cancel writes nothing', async () => {
    const onOpenChange = vi.fn();
    h.preview.mockResolvedValueOnce(review([A, B], [rec(A), rec(B)]));
    render(
      <GroupSelectedDialog
        open
        onOpenChange={onOpenChange}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`group-row-${A}`);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('Save sends one body under a key, and a busy retry sends the SAME body and key', async () => {
    h.preview.mockResolvedValueOnce(review([A, B], [rec(A), rec(B)]));
    h.apply
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'conflict',
          message: GROUPING_ERROR_WORDS.busy,
          details: { reason: 'busy', retryable: true },
        },
      })
      .mockResolvedValueOnce(APPLIED);
    const onDone = vi.fn();
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={onDone}
      />,
    );
    await screen.findByTestId(`group-row-${A}`);
    await userEvent.click(screen.getByRole('button', { name: 'Group 2 records' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.busy);
    await userEvent.click(screen.getByRole('button', { name: 'Group 2 records' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [first, second] = h.apply.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      action: 'group',
      organizationId: ORG,
      actorUserId: ME,
      itemIds: [A, B],
      target: { kind: 'new', name: 'Polo XXXL' },
      expectedGroups: { [A]: null, [B]: null },
      moveItemIds: [],
      acknowledgeProductFamily: false,
    });
    // The result is announced and focus moves to Done.
    expect(screen.getByRole('status')).toHaveTextContent(GROUP_COPY.done('Polo XXXL'));
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it('a record in another group blocks Save until it is explicitly moved, then the move is sent for that record only', async () => {
    h.preview.mockResolvedValueOnce(
      review([A, B], [rec(A, { displayGroup: { id: H, name: 'Old shirts', version: 3 } }), rec(B)]),
    );
    h.apply.mockResolvedValueOnce(APPLIED);
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`group-row-${A}`);
    const save = screen.getByRole('button', { name: 'Group 2 records' });
    expect(save).toBeDisabled();
    expect(screen.getByTestId('group-blocked')).toHaveTextContent(GROUP_COPY.blocked.otherGroup);
    // P11: the disabled Save says why (its description is the blocked reason).
    expect(save).toHaveAccessibleDescription(GROUP_COPY.blocked.otherGroup);
    const choice = within(screen.getByTestId(`group-row-${A}`)).getByRole('group', {
      name: GROUP_COPY.otherGroup('Old shirts'),
    });
    await userEvent.click(within(choice).getByRole('radio', { name: GROUP_COPY.moveOne }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0]![0]).toMatchObject({
      moveItemIds: [A],
      expectedGroups: { [A]: H, [B]: null },
    });
  });

  it('a product-family member needs the confirmation (its family is never changed)', async () => {
    h.preview.mockResolvedValueOnce(
      review(
        [A, B],
        [
          rec(A, { productGroupId: 'fam', productGroupName: 'Limits Tee', variantSize: 'XS' }),
          rec(B),
        ],
      ),
    );
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`group-row-${A}`);
    expect(screen.getByText(GROUP_COPY.family('Limits Tee'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group 2 records' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: GROUP_COPY.acknowledgeFamily }));
    expect(screen.getByRole('button', { name: 'Group 2 records' })).toBeEnabled();
    // XS shows as its own size: it stays a distinct record.
    expect(within(screen.getByTestId(`group-row-${A}`)).getByText(/Size XS/)).toBeInTheDocument();
  });

  it('kits are left out with the reason, and the rest is planned without them', async () => {
    h.preview.mockResolvedValueOnce(
      review([A, B, C], [rec(A), rec(B), rec(C, { isBundle: true, name: 'Starter kit' })]),
    );
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B, C]}
        view="items"
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`group-row-${C}`);
    expect(
      screen.getByText(`Left out: Starter kit ${GROUP_COPY.leftOutReason.kit}.`),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group 2 records' })).toBeEnabled();
  });

  it('a repeat of a completed grouping says so and writes nothing (never a second group)', async () => {
    const inG = { displayGroup: { id: G, name: 'Polo XXXL', version: 1 } };
    h.preview.mockResolvedValueOnce(review([A, B], [rec(A, inG), rec(B, inG)]));
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`group-row-${A}`);
    expect(screen.getAllByText(GROUP_COPY.noop('Polo XXXL')).length).toBeGreaterThan(0);
    // Nothing would be grouped, so the button does not say it groups.
    expect(screen.queryByRole('button', { name: 'Group 2 records' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: GROUP_COPY.noopConfirm }));
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('books show their ISBN and the editions notice; no size is parsed from a title', async () => {
    h.preview.mockResolvedValueOnce(
      review(
        [A, B],
        [
          rec(A, { itemType: 'book', name: 'Earth Science - S', barcode: '9780306406157' }),
          rec(B, { itemType: 'book', name: 'Earth Science - S', barcode: '9781861972712' }),
        ],
      ),
    );
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="books"
        onDone={() => {}}
      />,
    );
    const rowA = await screen.findByTestId(`group-row-${A}`);
    expect(within(rowA).getByText(/ISBN 9780306406157/)).toBeInTheDocument();
    expect(screen.getByText(GROUP_COPY.editions(2))).toBeInTheDocument();
    expect(screen.getByDisplayValue('Earth Science - S')).toBeInTheDocument();
  });

  it('ignores an answer for another selection than the one on screen', async () => {
    h.preview.mockResolvedValueOnce(review([A, C], [rec(A), rec(C)]));
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId(`group-row-${C}`)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the records/);
  });

  // People review P1, P6 and P8: Add to group from a "Same SKU as records in
  // Tees" chip reviews the record with Tees as the target.
  it("Add to group from a Same SKU chip: the group's own records are listed as already in it, never as staying outside, and Save counts only the record that joins", async () => {
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const tees = { id: G, name: 'Tees', version: 2, itemType: 'product' };
    h.preview.mockResolvedValueOnce(
      review(
        [D],
        [rec(D, { name: 'Limits Tee', sku: 'X' })],
        {
          sameSkuSiblings: [
            { id: A, name: 'Limits Tee', sku: 'X', itemType: 'product', displayGroupId: G },
            { id: B, name: 'Limits Tee', sku: 'X', itemType: 'product', displayGroupId: G },
          ],
          candidateGroups: [{ ...tees, memberCount: 2, holdsSelected: false }],
          targetGroup: {
            ...tees,
            members: [
              { id: A, name: 'Limits Tee', sku: 'X', quantityOnHand: 4 },
              { id: B, name: 'Limits Tee', sku: 'X', quantityOnHand: 5 },
            ],
          },
        },
        G,
      ),
    );
    const onAddToSelection = vi.fn();
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[D]}
        initialGroupId={G}
        view="items"
        onAddToSelection={onAddToSelection}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`group-row-${D}`);
    expect(screen.queryByText(/stay outside this group/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: GROUP_COPY.addSiblings })).not.toBeInTheDocument();
    const members = screen.getByRole('list', { name: GROUP_COPY.targetMembers('Tees') });
    expect(within(members).getAllByRole('listitem')).toHaveLength(2);
    expect(within(members).getAllByText(/SKU X/)).toHaveLength(2);
    expect(screen.getByTestId('group-preview-header')).toHaveTextContent(
      'Tees · 3 records · 11 on hand',
    );
    expect(screen.getByRole('button', { name: 'Add 1 record to Tees' })).toBeEnabled();
  });

  it('a selected record already in the target says so, and Save counts only the records that join (P6)', async () => {
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const tees = { id: G, name: 'Tees', version: 3, itemType: 'product' };
    h.preview.mockResolvedValueOnce(
      review(
        [A, D],
        [rec(A, { displayGroup: { id: G, name: 'Tees', version: 3 } }), rec(D)],
        {
          candidateGroups: [{ ...tees, memberCount: 1, holdsSelected: true }],
          targetGroup: {
            ...tees,
            members: [{ id: A, name: 'Polo XXXL', sku: 'SKU-A', quantityOnHand: 2 }],
          },
        },
        G,
      ),
    );
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, D]}
        initialGroupId={G}
        view="items"
        onDone={() => {}}
      />,
    );
    const rowA = await screen.findByTestId(`group-row-${A}`);
    expect(screen.getByRole('button', { name: /^Add \d+ records? to Tees$/ })).toHaveTextContent(
      'Add 1 record to Tees',
    );
    expect(within(rowA).getByText(GROUP_COPY.alreadyInTarget)).toBeInTheDocument();
  });

  it('a record in another group can be left out from the review: it is not sent and its group is untouched (P10)', async () => {
    h.preview.mockResolvedValueOnce(
      review(
        [A, B, C],
        [rec(A, { displayGroup: { id: H, name: 'Old shirts', version: 3 } }), rec(B), rec(C)],
      ),
    );
    h.apply.mockResolvedValueOnce(APPLIED);
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B, C]}
        view="items"
        onDone={() => {}}
      />,
    );
    const rowA = await screen.findByTestId(`group-row-${A}`);
    expect(screen.getByTestId('group-blocked')).toHaveTextContent(GROUP_COPY.blocked.otherGroup);
    await userEvent.click(within(rowA).getByRole('radio', { name: GROUP_COPY.leaveOutOne }));
    const save = screen.getByRole('button', { name: 'Group 2 records' });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0]![0]).toMatchObject({
      itemIds: [B, C],
      moveItemIds: [],
      expectedGroups: { [B]: null, [C]: null },
    });
  });

  // Recheck R2-1: a choice for a record already in another group was made for
  // the group it was in then. Save is refused when a colleague moved the record
  // meanwhile (membership_changed); Review again then finds it in another
  // group, and the choice must not carry over to it.
  const radio = (row: HTMLElement, words: string) =>
    within(row).getByRole('radio', { name: new RegExp(`^${words}`) });
  const membershipChanged = {
    ok: false,
    error: {
      code: 'conflict',
      message: GROUPING_ERROR_WORDS.membershipChanged,
      details: { reason: 'membership_changed' },
    },
  };

  it('a move chosen while a record was in one group does not carry over when Review again finds it in another (R2-1)', async () => {
    h.preview
      .mockResolvedValueOnce(
        review(
          [A, B],
          [rec(A, { displayGroup: { id: H, name: 'Old shirts', version: 3 } }), rec(B)],
        ),
      )
      .mockResolvedValueOnce(
        review([A, B], [rec(A, { displayGroup: { id: G, name: 'Tees', version: 1 } }), rec(B)]),
      );
    h.apply.mockResolvedValueOnce(membershipChanged).mockResolvedValueOnce(APPLIED);
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    const first = await screen.findByTestId(`group-row-${A}`);
    await userEvent.click(radio(first, GROUP_COPY.moveOne));
    await userEvent.click(screen.getByRole('button', { name: 'Group 2 records' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      GROUPING_ERROR_WORDS.membershipChanged,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    // The new review: A is in Tees now. Its radios are empty and Save is off.
    await screen.findByText(GROUP_COPY.otherGroup('Tees'));
    const row = screen.getByTestId(`group-row-${A}`);
    expect(radio(row, GROUP_COPY.moveOne)).not.toBeChecked();
    expect(radio(row, GROUP_COPY.leaveOutOne)).not.toBeChecked();
    const save = screen.getByRole('button', { name: 'Group 2 records' });
    expect(save).toBeDisabled();
    expect(screen.getByTestId('group-blocked')).toHaveTextContent(GROUP_COPY.blocked.otherGroup);
    expect(h.apply).toHaveBeenCalledTimes(1);
    // Deciding again, for Tees, is what moves it.
    await userEvent.click(radio(row, GROUP_COPY.moveOne));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(2));
    expect(h.apply.mock.calls[1]![0]).toMatchObject({
      moveItemIds: [A],
      expectedGroups: { [A]: G, [B]: null },
    });
  });

  it('a Leave it out chosen for one group does not carry over to another either (R2-1)', async () => {
    h.preview
      .mockResolvedValueOnce(
        review(
          [A, B, C],
          [rec(A, { displayGroup: { id: H, name: 'Old shirts', version: 3 } }), rec(B), rec(C)],
        ),
      )
      .mockResolvedValueOnce(
        review(
          [A, B, C],
          [rec(A, { displayGroup: { id: G, name: 'Tees', version: 1 } }), rec(B), rec(C)],
        ),
      );
    h.apply.mockResolvedValueOnce(membershipChanged);
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B, C]}
        view="items"
        onDone={() => {}}
      />,
    );
    const first = await screen.findByTestId(`group-row-${A}`);
    await userEvent.click(radio(first, GROUP_COPY.leaveOutOne));
    await userEvent.click(screen.getByRole('button', { name: 'Group 2 records' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    await screen.findByText(GROUP_COPY.otherGroup('Tees'));
    const row = screen.getByTestId(`group-row-${A}`);
    expect(radio(row, GROUP_COPY.moveOne)).not.toBeChecked();
    expect(radio(row, GROUP_COPY.leaveOutOne)).not.toBeChecked();
    expect(screen.getByTestId('group-blocked')).toHaveTextContent(GROUP_COPY.blocked.otherGroup);
    expect(screen.getByRole('button', { name: 'Group 3 records' })).toBeDisabled();
  });

  it('a dropped choice does not come back when a later review finds the record in its first group again (R2-1)', async () => {
    const K = '77777777-7777-4777-8777-777777777777';
    const caps = { id: K, name: 'Caps', version: 1, itemType: 'product' };
    const inH = { displayGroup: { id: H, name: 'Old shirts', version: 3 } };
    h.preview
      .mockResolvedValueOnce(review([A, B], [rec(A, inH), rec(B)]))
      .mockResolvedValueOnce(
        review([A, B], [rec(A, { displayGroup: { id: G, name: 'Tees', version: 1 } }), rec(B)], {
          candidateGroups: [{ ...caps, memberCount: 1, holdsSelected: false }],
        }),
      )
      .mockResolvedValueOnce(
        review(
          [A, B],
          [rec(A, inH), rec(B)],
          {
            candidateGroups: [{ ...caps, memberCount: 1, holdsSelected: false }],
            targetGroup: { ...caps, members: [] },
          },
          K,
        ),
      );
    h.apply.mockResolvedValueOnce(membershipChanged);
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    const first = await screen.findByTestId(`group-row-${A}`);
    await userEvent.click(radio(first, GROUP_COPY.moveOne));
    await userEvent.click(screen.getByRole('button', { name: 'Group 2 records' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    await screen.findByText(GROUP_COPY.otherGroup('Tees'));
    // Without deciding again, the person picks an existing group: the next
    // review finds A back in its first group. The choice was dropped, not
    // hidden, so it does not come back.
    await userEvent.click(screen.getByRole('radio', { name: GROUP_COPY.targetExisting }));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: GROUP_COPY.existingLabel }),
      K,
    );
    await waitFor(() => expect(h.preview).toHaveBeenLastCalledWith([A, B], K));
    await screen.findByText(GROUP_COPY.otherGroup('Old shirts'));
    const row = screen.getByTestId(`group-row-${A}`);
    expect(radio(row, GROUP_COPY.moveOne)).not.toBeChecked();
    expect(radio(row, GROUP_COPY.leaveOutOne)).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Add 2 records to Caps' })).toBeDisabled();
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('a choice still holds when the next review finds the record in the same group (R2-1)', async () => {
    const inH = { displayGroup: { id: H, name: 'Old shirts', version: 3 } };
    h.preview
      .mockResolvedValueOnce(review([A, B], [rec(A, inH), rec(B)]))
      .mockResolvedValueOnce(review([A, B], [rec(A, inH), rec(B)]));
    h.apply.mockResolvedValueOnce(membershipChanged).mockResolvedValueOnce(APPLIED);
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    const first = await screen.findByTestId(`group-row-${A}`);
    await userEvent.click(radio(first, GROUP_COPY.moveOne));
    await userEvent.click(screen.getByRole('button', { name: 'Group 2 records' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    await waitFor(() => expect(h.preview).toHaveBeenCalledTimes(2));
    const save = await screen.findByRole('button', { name: 'Group 2 records' });
    await waitFor(() => expect(save).toBeEnabled());
    expect(radio(screen.getByTestId(`group-row-${A}`), GROUP_COPY.moveOne)).toBeChecked();
    await userEvent.click(save);
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(2));
    expect(h.apply.mock.calls[1]![0]).toMatchObject({
      moveItemIds: [A],
      expectedGroups: { [A]: H, [B]: null },
    });
  });

  it('adding to an existing group re-reads that group and sends its version', async () => {
    h.preview
      .mockResolvedValueOnce(
        review([A], [rec(A)], {
          candidateGroups: [
            {
              id: G,
              name: 'Polo XXXL',
              version: 4,
              itemType: 'product',
              memberCount: 2,
              holdsSelected: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        review(
          [A],
          [rec(A)],
          {
            candidateGroups: [
              {
                id: G,
                name: 'Polo XXXL',
                version: 4,
                itemType: 'product',
                memberCount: 2,
                holdsSelected: false,
              },
            ],
            targetGroup: {
              id: G,
              name: 'Polo XXXL',
              version: 4,
              itemType: 'product',
              members: [{ id: B, name: 'Polo', sku: 'S', quantityOnHand: 3 }],
            },
          },
          G,
        ),
      );
    h.apply.mockResolvedValueOnce(APPLIED);
    render(
      <GroupSelectedDialog
        open
        onOpenChange={() => {}}
        itemIds={[A]}
        view="items"
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`group-row-${A}`);
    await userEvent.click(screen.getByRole('radio', { name: GROUP_COPY.targetExisting }));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: GROUP_COPY.existingLabel }),
      G,
    );
    await waitFor(() => expect(h.preview).toHaveBeenLastCalledWith([A], G));
    await screen.findByText('Polo XXXL · 2 records · 5 on hand');
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 record to Polo XXXL' }));
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0]![0]).toMatchObject({
      itemIds: [A],
      target: { kind: 'existing', groupId: G, expectedVersion: 4 },
    });
  });
});

describe('RemoveFromGroupDialog and RenameGroupDialog', () => {
  it('Remove sends the group each record is in, as the review read it; it deletes nothing else', async () => {
    h.preview.mockResolvedValueOnce(
      review([A, B], [rec(A, { displayGroup: { id: G, name: 'Pads', version: 2 } }), rec(B)]),
    );
    h.apply.mockResolvedValueOnce({
      ...APPLIED,
      data: {
        outcome: {
          ...APPLIED.data.outcome,
          action: 'remove',
          group: null,
          changes: [{ itemId: A, fromGroupId: G, toGroupId: null }],
        },
      },
    });
    render(
      <RemoveFromGroupDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B]}
        view="items"
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(GROUP_COPY.removeIntro)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove 1 record' }));
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0]![0]).toMatchObject({
      action: 'remove',
      itemIds: [A],
      expectedGroups: { [A]: G },
    });
  });

  // People review P9: nothing is dropped silently, and the dialog says when
  // the group loses its last records the person can see, or what stays.
  it('Remove names what is left out and why, counts what is unavailable, and says the group loses its last records you can see (P9)', async () => {
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    h.preview.mockResolvedValueOnce(
      review(
        [A, B, C, D],
        [
          rec(A, { displayGroup: { id: G, name: 'Pads', version: 2 } }),
          rec(B, { displayGroup: { id: G, name: 'Pads', version: 2 } }),
          rec(C, {
            name: 'Desk',
            displayGroup: { id: H, name: 'Desks', version: 1 },
            writable: false,
          }),
          rec(D, { name: 'Lamp' }),
        ],
        {
          unavailableCount: 1,
          candidateGroups: [
            {
              id: G,
              name: 'Pads',
              version: 2,
              itemType: 'product',
              memberCount: 2,
              holdsSelected: true,
            },
            {
              id: H,
              name: 'Desks',
              version: 1,
              itemType: 'product',
              memberCount: 5,
              holdsSelected: true,
            },
          ],
        },
      ),
    );
    render(
      <RemoveFromGroupDialog
        open
        onOpenChange={() => {}}
        itemIds={[A, B, C, D]}
        view="items"
        onDone={() => {}}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Remove 2 records' })).toBeEnabled();
    expect(
      screen.getByText(`Left out: Desk ${GROUP_COPY.removeLeftOutReason.not_writable}.`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Left out: Lamp ${GROUP_COPY.removeLeftOutReason.not_in_group}.`),
    ).toBeInTheDocument();
    expect(screen.getByText(GROUP_COPY.unavailable(1))).toBeInTheDocument();
    expect(screen.getByText(GROUP_COPY.removeLast('Pads'))).toBeInTheDocument();
  });

  it('Remove says how many records you can see stay in the group, on this page or not (P9)', async () => {
    h.preview.mockResolvedValueOnce(
      review([A], [rec(A, { displayGroup: { id: G, name: 'Pads', version: 2 } })], {
        candidateGroups: [
          {
            id: G,
            name: 'Pads',
            version: 2,
            itemType: 'product',
            memberCount: 3,
            holdsSelected: true,
          },
        ],
      }),
    );
    render(
      <RemoveFromGroupDialog
        open
        onOpenChange={() => {}}
        itemIds={[A]}
        view="items"
        onDone={() => {}}
      />,
    );
    expect(await screen.findByText(GROUP_COPY.removeStays(2, 'Pads'))).toBeInTheDocument();
    expect(screen.queryByText(GROUP_COPY.removeLast('Pads'))).not.toBeInTheDocument();
  });

  // Data review D3: one request takes at most 100 records; a group can hold
  // 200, all on screen in instant mode.
  it('Remove with more than 100 records on screen reviews the first 100 and says so (D3)', async () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const first = many.slice(0, 100);
    h.preview.mockResolvedValueOnce(
      review(
        first,
        first.map((id) => rec(id, { displayGroup: { id: G, name: 'Pads', version: 2 } })),
        {
          candidateGroups: [
            {
              id: G,
              name: 'Pads',
              version: 2,
              itemType: 'product',
              memberCount: 101,
              holdsSelected: true,
            },
          ],
        },
      ),
    );
    render(
      <RemoveFromGroupDialog
        open
        onOpenChange={() => {}}
        itemIds={many}
        view="items"
        onDone={() => {}}
      />,
    );
    expect(await screen.findByText(GROUP_COPY.removeCapped(101))).toBeInTheDocument();
    expect(h.preview).toHaveBeenCalledWith(first, null);
    expect(screen.getByRole('button', { name: 'Remove 100 records' })).toBeEnabled();
    expect(screen.getByText(GROUP_COPY.removeStays(1, 'Pads'))).toBeInTheDocument();
  });

  it('Rename reads the group through ONE of its records, so a group of more than 100 on screen can be renamed (D3)', async () => {
    const many = Array.from(
      { length: 150 },
      (_, i) => `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    h.preview.mockResolvedValueOnce(
      review(
        [many[0]!],
        [rec(many[0]!)],
        { targetGroup: { id: G, name: 'Pads', version: 7, itemType: 'product', members: [] } },
        G,
      ),
    );
    render(
      <RenameGroupDialog
        open
        onOpenChange={() => {}}
        groupId={G}
        memberIds={many}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByDisplayValue('Pads')).toBeInTheDocument();
    expect(h.preview).toHaveBeenCalledWith([many[0]], G);
  });

  it('Rename sends the group, its version and the trimmed name', async () => {
    h.preview.mockResolvedValueOnce(
      review(
        [A],
        [rec(A)],
        { targetGroup: { id: G, name: 'Pads', version: 7, itemType: 'product', members: [] } },
        G,
      ),
    );
    h.apply.mockResolvedValueOnce(APPLIED);
    render(
      <RenameGroupDialog
        open
        onOpenChange={() => {}}
        groupId={G}
        memberIds={[A, B]}
        onDone={() => {}}
      />,
    );
    const input = await screen.findByDisplayValue('Pads');
    await userEvent.clear(input);
    await userEvent.type(input, '  Mouse pads ');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0]![0]).toMatchObject({
      action: 'rename',
      groupId: G,
      expectedVersion: 7,
      name: 'Mouse pads',
    });
  });
});

// Recheck R2-2: a review whose server action rejects (offline, a platform
// error, a tab left open across a deploy) or answers an error never spins
// forever. It says what happened in core's words, never the raw error, and
// offers Try again whenever a second look may answer differently; a refusal
// the same request cannot change shows only its own words.
describe('a failed review (recheck R2-2)', () => {
  const groupDialog = (ids: string[] = [A, B]) => (
    <GroupSelectedDialog
      open
      onOpenChange={() => {}}
      itemIds={ids}
      view="items"
      onDone={() => {}}
    />
  );

  it('a rejected preview says so in plain words and offers Try again, which reviews again', async () => {
    h.preview
      .mockRejectedValueOnce(new Error('Failed to find Server Action "7f3a"'))
      .mockResolvedValueOnce(review([A, B], [rec(A), rec(B)]));
    render(groupDialog());
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.internal);
    expect(screen.queryByText(/Server Action/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading the records/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId(`group-row-${A}`);
    expect(h.preview).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group 2 records' })).toBeEnabled();
  });

  it('offline, a rejected preview says grouping needs a connection', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      h.preview.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      render(groupDialog());
      expect(await screen.findByRole('alert')).toHaveTextContent(GROUP_COPY.offline);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    } finally {
      online.mockRestore();
    }
  });

  it('a server error answer offers Try again; a refusal a retry cannot change does not', async () => {
    h.preview.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal_error', message: GROUPING_ERROR_WORDS.internal },
    });
    const first = render(groupDialog());
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.internal);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    first.unmount();
    h.preview.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: GROUPING_ERROR_WORDS.groupTooMany,
        details: { reason: 'invalid', field: 'item_ids' },
      },
    });
    render(groupDialog());
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.groupTooMany);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('Remove from group and Rename recover from a rejected preview the same way', async () => {
    h.preview
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(
        review([A], [rec(A, { displayGroup: { id: G, name: 'Pads', version: 2 } })]),
      );
    const remove = render(
      <RemoveFromGroupDialog
        open
        onOpenChange={() => {}}
        itemIds={[A]}
        view="items"
        onDone={() => {}}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.internal);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Remove 1 record' })).toBeEnabled();
    remove.unmount();
    h.preview
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(
        review(
          [A],
          [rec(A)],
          { targetGroup: { id: G, name: 'Pads', version: 7, itemType: 'product', members: [] } },
          G,
        ),
      );
    render(
      <RenameGroupDialog
        open
        onOpenChange={() => {}}
        groupId={G}
        memberIds={[A]}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.internal);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByDisplayValue('Pads')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled();
  });

  it('Rename says the group is not available when the review finds no such group', async () => {
    h.preview.mockResolvedValueOnce(review([A], [rec(A)], { targetGroup: null }, G));
    render(
      <RenameGroupDialog
        open
        onOpenChange={() => {}}
        groupId={G}
        memberIds={[A]}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.groupNotFound);
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  });
});
