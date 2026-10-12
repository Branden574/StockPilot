import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  groupingPreviewKey,
  UNGROUP_COPY,
  type UngroupSelectedOutcome,
} from '@stockpilot/core';

import {
  previewUngroupSelectedAction,
  ungroupSelectedAction,
} from '@/server/actions/item-grouping';

import { UngroupSelectedDialog } from './ungroup-selected-dialog';

// Ungroup anything (owner 2026-10-12, verbatim: "im supposed to be able to
// check box whatever item and then group or ungroup it that was the point.").

vi.mock('@/server/actions/item-grouping', () => ({
  previewUngroupSelectedAction: vi.fn(),
  ungroupSelectedAction: vi.fn(),
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const G = '99999999-9999-4999-8999-999999999999';
const FAM = '77777777-7777-4777-8777-777777777777';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

function record(n: number, over: Record<string, unknown> = {}) {
  return {
    id: id(n),
    name: `Record ${n}`,
    sku: `SKU-${n}`,
    barcode: null,
    isbnFields: null,
    itemType: 'product',
    isBundle: false,
    isRental: false,
    productGroupId: null,
    productGroupName: null,
    variantSize: null,
    charterId: null,
    warehouseId: null,
    binLocation: null,
    customFields: null,
    quantityOnHand: n,
    createdAt: '2026-01-01T00:00:00Z',
    displayGroup: null,
    writable: true,
    charterName: null,
    warehouseName: 'DC4',
    placementLabel: `${n}-A`,
    imageUrl: null,
    ...over,
  };
}

function cand(n: number, sku: string, over: Record<string, unknown> = {}) {
  return {
    id: id(n),
    sku,
    name: `Record ${n}`,
    itemType: 'product',
    isBundle: false,
    inFamily: false,
    barcode: null,
    binLocation: null,
    placementLabel: null,
    charterName: null,
    warehouseName: null,
    quantityOnHand: 1,
    status: 'active',
    ...over,
  };
}

function preview(
  ids: string[],
  records: unknown[],
  candidates: unknown[] = [],
  opts: {
    canUnlinkFamilies?: boolean;
    unavailableCount?: number;
    candidateGroups?: unknown[];
  } = {},
) {
  vi.mocked(previewUngroupSelectedAction).mockResolvedValueOnce({
    ok: true,
    data: {
      review: {
        records,
        unavailableCount: opts.unavailableCount ?? 0,
        sameSkuSiblings: [],
        candidateGroups: opts.candidateGroups ?? [],
        targetGroup: null,
        previewKey: groupingPreviewKey(ORG, ids, null),
      },
      candidates,
      canUnlinkFamilies: opts.canUnlinkFamilies ?? true,
      previewKey: groupingPreviewKey(ORG, ids, null),
      organizationId: ORG,
      actorUserId: ME,
    },
  } as never);
}

const applied = (parts: UngroupSelectedOutcome['parts']): never =>
  ({
    ok: true,
    data: { outcome: { complete: parts.every((p) => p.status === 'applied'), parts } },
  }) as never;

const part = (
  kind: 'remove' | 'split' | 'unlink',
  changed: string[],
  over: Record<string, unknown> = {},
) => ({
  kind,
  status: 'applied' as const,
  changedItemIds: changed,
  notChangedItemIds: [],
  message: null,
  reason: null,
  retryable: false,
  ...over,
});

function row(n: number) {
  return screen.getByTestId(`ungroup-selected-row-${id(n)}`);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('UngroupSelectedDialog', () => {
  it("the owner's case: the eight sizes of a T-shirt family each leave the family, with the Returns note", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
    preview(
      ids,
      ids.map((_, i) =>
        record(i + 1, { productGroupId: FAM, productGroupName: 'Limits Tee', variantSize: 'S' }),
      ),
      ids.map((_, i) => cand(i + 1, `SKU-${i + 1}`, { inFamily: true })),
    );
    render(
      <UngroupSelectedDialog
        open
        itemIds={ids}
        view="items"
        shownUnder={new Map(ids.map((x) => [x, 'family' as const]))}
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByText(UNGROUP_COPY.selectedIntro)).toBeInTheDocument();
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    for (let n = 1; n <= 8; n++) {
      expect(within(row(n)).getByText('Leaves the Limits Tee size family')).toBeInTheDocument();
      // The record's own line: SKU, size, charter, rack, warehouse, on hand.
      expect(
        within(row(n)).getByText(
          `SKU SKU-${n} · Size S · No charter · ${n}-A · DC4 · ${n} on hand`,
        ),
      ).toBeInTheDocument();
    }
    expect(screen.getByText(UNGROUP_COPY.familyNote)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: UNGROUP_COPY.confirm(8) })).toBeInTheDocument();
  });

  // Test stage 2026-10-12 (PR #355, MEDIUM): sizes whose names end in a size
  // are still listed together by their name once out of the family, so the
  // list looks unchanged; the review and the result say so.
  it('sizes whose names end in a size: the review and the result say they stay listed together by their name', async () => {
    const sizes = ['S', 'M', 'L'];
    const ids = sizes.map((_, i) => id(i + 1));
    preview(
      ids,
      sizes.map((sz, i) =>
        record(i + 1, {
          name: `L4L - Pink Shirt - ${sz}`,
          productGroupId: FAM,
          productGroupName: 'Pink Shirt',
          variantSize: sz,
        }),
      ),
      sizes.map((_, i) => cand(i + 1, `SKU-${i + 1}`, { inFamily: true })),
    );
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(applied([part('unlink', ids)]));
    render(
      <UngroupSelectedDialog
        open
        itemIds={ids}
        view="items"
        shownUnder={new Map(ids.map((x) => [x, 'family' as const]))}
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    expect(screen.getByText(UNGROUP_COPY.familyNote)).toBeInTheDocument();
    expect(screen.getByText(UNGROUP_COPY.familyNameNote)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(3) }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(UNGROUP_COPY.leftFamilies(3));
    expect(status).toHaveTextContent(UNGROUP_COPY.familyNameNote);
  });

  it('sizes whose names do not end in a size: no name words, before or after', async () => {
    const ids = [id(1), id(2)];
    preview(
      ids,
      [
        record(1, { productGroupId: FAM, productGroupName: 'Polo' }),
        record(2, { productGroupId: FAM, productGroupName: 'Polo' }),
      ],
      [cand(1, 'SKU-1', { inFamily: true }), cand(2, 'SKU-2', { inFamily: true })],
    );
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(applied([part('unlink', ids)]));
    render(
      <UngroupSelectedDialog
        open
        itemIds={ids}
        view="items"
        shownUnder={new Map(ids.map((x) => [x, 'family' as const]))}
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    expect(screen.getByText(UNGROUP_COPY.familyNote)).toBeInTheDocument();
    expect(screen.queryByText(UNGROUP_COPY.familyNameNote)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(UNGROUP_COPY.leftFamilies(2));
    expect(status).not.toHaveTextContent(UNGROUP_COPY.familyNameNote);
  });

  it('on Books (no size runs there): no name words, even for names that end in a size', async () => {
    const ids = [id(1), id(2)];
    preview(
      ids,
      [
        record(1, { name: 'Tee - S', productGroupId: FAM, productGroupName: 'Tee' }),
        record(2, { name: 'Tee - M', productGroupId: FAM, productGroupName: 'Tee' }),
      ],
      [cand(1, 'SKU-1', { inFamily: true }), cand(2, 'SKU-2', { inFamily: true })],
    );
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(applied([part('unlink', ids)]));
    render(
      <UngroupSelectedDialog
        open
        itemIds={ids}
        view="books"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    expect(screen.getByText(UNGROUP_COPY.familyNote)).toBeInTheDocument();
    expect(screen.queryByText(UNGROUP_COPY.familyNameNote)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(UNGROUP_COPY.leftFamilies(2));
    expect(status).not.toHaveTextContent(UNGROUP_COPY.familyNameNote);
  });

  it('a mixed selection: each record says what happens to it, and the left-out ones say why', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7].map(id);
    preview(
      [...ids, id(50)],
      [
        record(1, { sku: 'PAIR' }),
        record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } }),
        record(3, { productGroupId: FAM, productGroupName: 'Polo' }),
        record(4, { isBundle: true }),
        record(5),
        record(6, { displayGroup: { id: G, name: 'Tees', version: 1 }, writable: false }),
        record(7, { productGroupId: FAM, productGroupName: 'Polo' }),
      ],
      [cand(1, 'PAIR'), cand(9, 'PAIR')],
      {
        canUnlinkFamilies: true,
        unavailableCount: 1,
        candidateGroups: [
          {
            id: G,
            name: 'Tees',
            version: 1,
            itemType: 'product',
            memberCount: 4,
            holdsSelected: true,
          },
        ],
      },
    );
    render(
      <UngroupSelectedDialog
        open
        itemIds={[...ids, id(50)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    expect(within(row(1)).getByText(UNGROUP_COPY.getsOwnSku)).toBeInTheDocument();
    expect(within(row(2)).getByText('Leaves group Tees')).toBeInTheDocument();
    expect(within(row(3)).getByText('Leaves the Polo size family')).toBeInTheDocument();
    expect(
      within(row(4)).getByText(`Left out: ${UNGROUP_COPY.selectedLeftOutReason.kit}`),
    ).toBeInTheDocument();
    expect(
      within(row(5)).getByText(`Left out: ${UNGROUP_COPY.selectedLeftOutReason.nothing}`),
    ).toBeInTheDocument();
    expect(
      within(row(6)).getByText(`Left out: ${UNGROUP_COPY.selectedLeftOutReason.not_writable}`),
    ).toBeInTheDocument();
    expect(screen.getByText(GROUP_COPY.unavailable(1))).toBeInTheDocument();
    expect(screen.getByText(UNGROUP_COPY.othersKeep(1, 'PAIR'))).toBeInTheDocument();
    expect(screen.getByText(GROUP_COPY.removeStays(3, 'Tees'))).toBeInTheDocument();
    expect(screen.getByText(UNGROUP_COPY.familyNote)).toBeInTheDocument();
    // 1 SKU + 1 group + 2 family = 4 records change.
    expect(screen.getByRole('button', { name: UNGROUP_COPY.confirm(4) })).toBeInTheDocument();
  });

  it('without permission to manage sports products a family member is left out and says why', async () => {
    preview([id(3)], [record(3, { productGroupId: FAM, productGroupName: 'Polo' })], [], {
      canUnlinkFamilies: false,
    });
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(3)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(3)}`);
    expect(
      within(row(3)).getByText(`Left out: ${UNGROUP_COPY.selectedLeftOutReason.family_permission}`),
    ).toBeInTheDocument();
    expect(screen.getByText(UNGROUP_COPY.selectedNothing)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ungroup \d+ records?$/ })).toBeNull();
  });

  it('a record in a group and a family leaves the one it is shown under on the list', async () => {
    const both = record(1, {
      displayGroup: { id: G, name: 'Tees', version: 1 },
      productGroupId: FAM,
      productGroupName: 'Polo',
    });
    preview([id(1)], [both]);
    const { unmount } = render(
      <UngroupSelectedDialog
        open
        itemIds={[id(1)]}
        view="items"
        shownUnder={new Map([[id(1), 'family' as const]])}
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByText('Leaves the Polo size family')).toBeInTheDocument();
    unmount();
    preview([id(1)], [both]);
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(1)]}
        view="items"
        shownUnder={new Map([[id(1), 'group' as const]])}
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByText('Leaves group Tees')).toBeInTheDocument();
  });

  // Owner 2026-10-12 ("Move them together"): one size on two racks is one
  // SKU; ticking one rack's record takes every rack's record of that SKU out
  // of the family, so the review lists the other racks, counts them and says
  // they still share the SKU.
  it("a size on two racks: the other rack's record is listed under it, counted, and the note says they still share the SKU", async () => {
    preview(
      [id(1)],
      [record(1, { sku: 'TEE-M', productGroupId: FAM, productGroupName: 'Tee', variantSize: 'M' })],
      [
        cand(1, 'TEE-M', { inFamily: true }),
        cand(2, 'TEE-M', {
          inFamily: true,
          name: 'Tee - M',
          placementLabel: '7-A',
          warehouseName: 'DC4',
          quantityOnHand: 3,
        }),
      ],
    );
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(1)]}
        view="items"
        shownUnder={new Map([[id(1), 'sku' as const]])}
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    const row = await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    expect(row).toHaveTextContent('Leaves the Tee size family');
    expect(row).toHaveTextContent(UNGROUP_COPY.familySkuWith);
    const sib = within(row).getByTestId(`ungroup-selected-sibling-${id(2)}`);
    expect(sib).toHaveTextContent('Tee - M');
    expect(sib).toHaveTextContent('7-A · DC4 · 3 on hand');
    expect(screen.getByText(UNGROUP_COPY.familySkuNote)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) })).toBeInTheDocument();
  });

  it('every record of a SKU ticked: a radio chooses the one that keeps it, and Save counts the one that changes', async () => {
    preview(
      [id(1), id(2)],
      [record(1, { sku: 'PAIR' }), record(2, { sku: 'PAIR' })],
      [cand(1, 'PAIR'), cand(2, 'PAIR')],
    );
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(applied([part('split', [id(1)])]));
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(1), id(2)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    expect(screen.getByText(`SKU PAIR: ${UNGROUP_COPY.anchorLegend}`)).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toBeChecked();
    expect(within(row(1)).getByText(UNGROUP_COPY.keepsSku('PAIR'))).toBeInTheDocument();
    expect(within(row(2)).getByText(UNGROUP_COPY.getsOwnSku)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('radio', { name: `${UNGROUP_COPY.keepsSku('PAIR')}: Record 2` }),
    );
    expect(within(row(2)).getByText(UNGROUP_COPY.keepsSku('PAIR'))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    const sent = vi.mocked(ungroupSelectedAction).mock.calls[0]![0] as {
      split: { anchorItemIds: string[] };
    };
    expect(sent.split.anchorItemIds).toEqual([id(2)]);
  });

  it('Save sends one body with a key per keyed step and the identity, then says what changed', async () => {
    preview(
      [id(1), id(2), id(3)],
      [
        record(1, { sku: 'PAIR' }),
        record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } }),
        record(3, { productGroupId: FAM, productGroupName: 'Polo' }),
      ],
      [cand(1, 'PAIR'), cand(9, 'PAIR')],
    );
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(
      applied([
        part('remove', [id(2)]),
        part('split', [id(1)], {
          splitItems: [
            {
              id: id(1),
              beforeSku: 'PAIR',
              afterSku: 'SP-ABCDE-1234567',
              kept: false,
              anchorItemId: null,
            },
          ],
        }),
        part('unlink', [id(3)]),
      ]),
    );
    const onDone = vi.fn();
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(1), id(2), id(3)]}
        view="items"
        onOpenChange={() => {}}
        onDone={onDone}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(3) }));
    const sent = vi.mocked(ungroupSelectedAction).mock.calls[0]![0] as {
      remove: { idempotencyKey: string };
      split: { idempotencyKey: string };
    };
    expect(sent).toMatchObject({
      organizationId: ORG,
      actorUserId: ME,
      remove: { itemIds: [id(2)], expectedGroups: { [id(2)]: G } },
      split: { itemIds: [id(1)], expectedSkus: { [id(1)]: 'PAIR' }, anchorItemIds: [] },
      unlink: { itemIds: [id(3)], expectedFamilies: { [id(3)]: FAM } },
    });
    const keys = [sent.remove.idempotencyKey, sent.split.idempotencyKey];
    for (const k of keys) expect(k).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(UNGROUP_COPY.leftGroups(1));
    expect(status).toHaveTextContent(UNGROUP_COPY.done(1));
    expect(status).toHaveTextContent(UNGROUP_COPY.leftFamilies(1));
    expect(status).toHaveTextContent('SP-ABCDE-1234567');
    expect(onDone).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus());
  });

  it('a step refused after an earlier one applied: says what applied and what was not done, and Review again reads afresh', async () => {
    const ids = [id(1), id(2)];
    preview(
      ids,
      [
        record(1, { sku: 'PAIR' }),
        record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } }),
      ],
      [cand(1, 'PAIR'), cand(9, 'PAIR')],
    );
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(
      applied([
        part('remove', [id(2)]),
        part('split', [], {
          status: 'refused',
          notChangedItemIds: [id(1)],
          message: GROUPING_ERROR_WORDS.itemChanged,
          reason: 'item_changed',
        }),
      ]),
    );
    const onDone = vi.fn();
    render(
      <UngroupSelectedDialog
        open
        itemIds={ids}
        view="items"
        onOpenChange={() => {}}
        onDone={onDone}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    expect(await screen.findByRole('status')).toHaveTextContent(UNGROUP_COPY.leftGroups(1));
    expect(screen.getByRole('alert')).toHaveTextContent(
      UNGROUP_COPY.partNotDone(UNGROUP_COPY.partWhat('split', 1), GROUPING_ERROR_WORDS.itemChanged),
    );
    // Something changed: the list refreshes.
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    preview(ids, [record(1, { sku: 'PAIR' }), record(2)], [cand(1, 'PAIR'), cand(9, 'PAIR')]);
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    expect(await screen.findByText(UNGROUP_COPY.getsOwnSku)).toBeInTheDocument();
    expect(previewUngroupSelectedAction).toHaveBeenCalledTimes(2);
  });

  it('a busy step offers Try again, which sends the SAME body and keys', async () => {
    preview([id(1)], [record(1, { sku: 'PAIR' })], [cand(1, 'PAIR'), cand(9, 'PAIR')]);
    vi.mocked(ungroupSelectedAction)
      .mockResolvedValueOnce(
        applied([
          part('split', [], {
            status: 'refused',
            notChangedItemIds: [id(1)],
            message: GROUPING_ERROR_WORDS.busy,
            reason: 'busy',
            retryable: true,
          }),
        ]),
      )
      .mockResolvedValueOnce(applied([part('split', [id(1)])]));
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(1)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    // PR #358 review (2026-10-12): Review again sits beside Try again, so a
    // refusal that keeps coming back never leaves Try again as the only way on.
    expect(await screen.findByRole('button', { name: 'Review again' })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    const [first, second] = vi.mocked(ungroupSelectedAction).mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
    expect(await screen.findByText(UNGROUP_COPY.done(1))).toBeInTheDocument();
  });

  // G2 security review LOW (2026-10-12): a keyed step whose answer was lost
  // may have committed: it says so (never "Not done"), offers Try again with
  // the same body, and the list re-reads in case it did.
  it('a step whose answer was lost says Not confirmed, offers Try again and refreshes the list', async () => {
    preview([id(1)], [record(1, { sku: 'PAIR' })], [cand(1, 'PAIR'), cand(9, 'PAIR')]);
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(
      applied([
        part('split', [], {
          status: 'refused',
          notChangedItemIds: [id(1)],
          message: UNGROUP_COPY.stepUnknown,
          reason: 'unknown',
          retryable: true,
        }),
      ]),
    );
    const onDone = vi.fn();
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(1)]}
        view="items"
        onOpenChange={() => {}}
        onDone={onDone}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(1)}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      UNGROUP_COPY.partUnknown(UNGROUP_COPY.partWhat('split', 1), UNGROUP_COPY.stepUnknown),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Not done');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review again' })).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // G2 correctness review INFO (2026-10-12): a remove that found the records
  // already out of any group says so, and the list re-reads (it is behind).
  it('records already out of their group are said to be, and the list refreshes', async () => {
    preview([id(2)], [record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } })]);
    vi.mocked(ungroupSelectedAction).mockResolvedValueOnce(
      applied([part('remove', [], { notChangedItemIds: [id(2)] })]),
    );
    const onDone = vi.fn();
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(2)]}
        view="items"
        onOpenChange={() => {}}
        onDone={onDone}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(2)}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    expect(await screen.findByRole('status')).toHaveTextContent(UNGROUP_COPY.alreadyOutOfGroup(1));
    expect(screen.getByRole('status')).not.toHaveTextContent(UNGROUP_COPY.leftGroups(1));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer for another selection than the one it holds (a stale review)', async () => {
    preview([id(3)], [record(3, { productGroupId: FAM, productGroupName: 'Polo' })]);
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(2)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await waitFor(() => expect(previewUngroupSelectedAction).toHaveBeenCalledWith([id(2)]));
    expect(screen.getByRole('status')).toHaveTextContent('Loading the records');
    expect(screen.queryByTestId(`ungroup-selected-row-${id(3)}`)).toBeNull();
  });

  it('a lost answer leaves the review with the SAME body and keys pending for the next Save', async () => {
    preview([id(2)], [record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } })]);
    vi.mocked(ungroupSelectedAction)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(applied([part('remove', [id(2)])]));
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(2)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(2)}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(GROUPING_ERROR_WORDS.internal);
    expect(alert).not.toHaveTextContent(/Failed to fetch/);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    const [first, second] = vi.mocked(ungroupSelectedAction).mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
  });

  it('a family that moved since the review: the refusal is said, and Review again reads afresh with new keys', async () => {
    preview(
      [id(2), id(3)],
      [
        record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } }),
        record(3, { productGroupId: FAM, productGroupName: 'Polo' }),
      ],
    );
    vi.mocked(ungroupSelectedAction)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'conflict',
          message: UNGROUP_COPY.familyChanged,
          details: { reason: 'family_changed' },
        },
      } as never)
      .mockResolvedValueOnce(applied([part('remove', [id(2)]), part('unlink', [id(3)])]));
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(2), id(3)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(2)}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(UNGROUP_COPY.familyChanged);
    expect(screen.queryByRole('button', { name: UNGROUP_COPY.confirm(2) })).toBeNull();
    preview(
      [id(2), id(3)],
      [
        record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } }),
        record(3, { productGroupId: FAM, productGroupName: 'Polo' }),
      ],
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    await userEvent.click(await screen.findByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    const [first, second] = vi
      .mocked(ungroupSelectedAction)
      .mock.calls.map((c) => c[0] as { remove: { idempotencyKey: string } });
    expect(second!.remove.idempotencyKey).not.toBe(first!.remove.idempotencyKey);
  });

  it('a review with no answer says so in core words and offers Try again; offline says the connection words', async () => {
    vi.mocked(previewUngroupSelectedAction).mockRejectedValueOnce(
      new Error('Failed to find Server Action "abc"'),
    );
    const { unmount } = render(
      <UngroupSelectedDialog
        open
        itemIds={[id(2)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.internal);
    expect(screen.queryByText(/Server Action/)).toBeNull();
    preview([id(2)], [record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } })]);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Leaves group Tees')).toBeInTheDocument();
    unmount();
    const spy = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      vi.mocked(previewUngroupSelectedAction).mockRejectedValueOnce(
        new TypeError('Failed to fetch'),
      );
      render(
        <UngroupSelectedDialog
          open
          itemIds={[id(2)]}
          view="items"
          onOpenChange={() => {}}
          onDone={() => {}}
        />,
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(UNGROUP_COPY.selectedOffline);
    } finally {
      spy.mockRestore();
    }
  });

  it('a refused review that the same request cannot change shows only its words (too many records)', async () => {
    vi.mocked(previewUngroupSelectedAction).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: GROUPING_ERROR_WORDS.tooMany,
        details: { reason: 'invalid' },
      },
    } as never);
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(2)]}
        view="items"
        onOpenChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.tooMany);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ungroup \d+ records?$/ })).toBeNull();
  });

  it('Cancel writes nothing', async () => {
    preview([id(2)], [record(2, { displayGroup: { id: G, name: 'Tees', version: 1 } })]);
    const onOpenChange = vi.fn();
    render(
      <UngroupSelectedDialog
        open
        itemIds={[id(2)]}
        view="items"
        onOpenChange={onOpenChange}
        onDone={() => {}}
      />,
    );
    await screen.findByTestId(`ungroup-selected-row-${id(2)}`);
    await userEvent.click(screen.getByRole('button', { name: GROUP_COPY.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(ungroupSelectedAction).not.toHaveBeenCalled();
  });
});
