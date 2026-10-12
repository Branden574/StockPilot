import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, UNGROUP_COPY } from '@stockpilot/core';

import { previewUngroupAction, ungroupItemsAction } from '@/server/actions/item-grouping';

import { UngroupDialog } from './ungroup-dialog';

vi.mock('@/server/actions/item-grouping', () => ({
  previewUngroupAction: vi.fn(),
  ungroupItemsAction: vi.fn(),
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const K = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const C = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const cand = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sku: 'SP-PAIR',
  name: 'Black Mouse Pad',
  itemType: 'product',
  isBundle: false,
  inFamily: false,
  barcode: null,
  binLocation: id === A ? '22-A' : '22-C',
  placementLabel: id === A ? '22-A' : '22-C',
  charterName: null,
  warehouseName: 'DC4',
  quantityOnHand: id === A ? 9 : 4,
  status: 'active',
  ...over,
});

function preview(candidates: unknown[]) {
  vi.mocked(previewUngroupAction).mockResolvedValue({
    ok: true,
    data: { candidates, organizationId: ORG, actorUserId: ME },
  } as never);
}

const done = {
  ok: true as const,
  data: {
    replay: false,
    items: [
      {
        id: B,
        beforeSku: 'SP-PAIR',
        afterSku: 'SP-ABCDE-1234567',
        kept: false,
        anchorItemId: null,
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UngroupDialog', () => {
  it('the owner case: shows each record, which gets a new SKU, who keeps it, and what does not change', async () => {
    preview([cand(A), cand(B)]);
    render(<UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(UNGROUP_COPY.intro)).toBeInTheDocument();
    expect(previewUngroupAction).toHaveBeenCalledWith([B]);
    const row = await screen.findByTestId(`ungroup-row-${B}`);
    expect(within(row).getByText(/22-C/)).toBeInTheDocument();
    expect(within(row).getByText(UNGROUP_COPY.getsNewSku)).toBeInTheDocument();
    expect(screen.getByText(UNGROUP_COPY.othersKeep(1, 'SP-PAIR'))).toBeInTheDocument();
    expect(screen.getByText(UNGROUP_COPY.barcodeNote)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  // Fix round 1, P2: the line names where the record IS (the service's
  // placement label, the lists' rule), never a blank bin_location's "No rack".
  it('names the rack from the placement label, not from bin_location', async () => {
    preview([
      cand(A, { binLocation: '', placementLabel: 'Rack 37-B' }),
      cand(B, { binLocation: 'Blue Shelf', placementLabel: null }),
    ]);
    render(<UngroupDialog open itemIds={[A, B]} onOpenChange={() => {}} onDone={() => {}} />);
    const a = await screen.findByTestId(`ungroup-row-${A}`);
    expect(within(a).getByText(/Rack 37-B/)).toBeInTheDocument();
    expect(within(a).queryByText(/No rack/)).toBeNull();
    expect(within(screen.getByTestId(`ungroup-row-${B}`)).getByText(/No rack/)).toBeInTheDocument();
  });

  it('Cancel sends nothing', async () => {
    preview([cand(A), cand(B)]);
    const onOpenChange = vi.fn();
    render(<UngroupDialog open itemIds={[B]} onOpenChange={onOpenChange} onDone={() => {}} />);
    await screen.findByTestId(`ungroup-row-${B}`);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(ungroupItemsAction).not.toHaveBeenCalled();
  });

  it('Save sends the plan with the identity the preview answered for, then shows the new SKU', async () => {
    preview([cand(A), cand(B)]);
    vi.mocked(ungroupItemsAction).mockResolvedValueOnce(done as never);
    const onDone = vi.fn();
    render(<UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={onDone} />);
    await screen.findByTestId(`ungroup-row-${B}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    const sent = vi.mocked(ungroupItemsAction).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      organizationId: ORG,
      actorUserId: ME,
      itemIds: [B],
      expectedSkus: { [B]: 'SP-PAIR' },
      anchorItemIds: [],
    });
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('SP-ABCDE-1234567')).toBeInTheDocument();
    expect(screen.getByText(UNGROUP_COPY.done(1))).toBeInTheDocument();
    // No barcode on the split record: its label prints the SKU, so reprint it.
    expect(screen.getByRole('link', { name: /Print labels/i })).toHaveAttribute(
      'href',
      `/dashboard/inventory/labels?items=${B}`,
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('every record selected: a radio picks the record that keeps the SKU (the oldest by default) and Save sends it', async () => {
    preview([cand(A), cand(B)]);
    vi.mocked(ungroupItemsAction).mockResolvedValueOnce(done as never);
    render(<UngroupDialog open itemIds={[A, B]} onOpenChange={() => {}} onDone={() => {}} />);
    await screen.findByTestId(`ungroup-row-${A}`);
    expect(screen.getByText(UNGROUP_COPY.anchorLegend)).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(
      within(screen.getByTestId(`ungroup-row-${A}`)).getByText(UNGROUP_COPY.keepsSku('SP-PAIR')),
    ).toBeInTheDocument();
    await userEvent.click(radios[1]!);
    expect(
      within(screen.getByTestId(`ungroup-row-${B}`)).getByText(UNGROUP_COPY.keepsSku('SP-PAIR')),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    expect(vi.mocked(ungroupItemsAction).mock.calls[0]![0]).toMatchObject({
      itemIds: [A, B],
      anchorItemIds: [B],
    });
  });

  it('a busy answer keeps the key: Try again sends the SAME body and key', async () => {
    preview([cand(A), cand(B)]);
    vi.mocked(ungroupItemsAction)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'conflict',
          message: GROUPING_ERROR_WORDS.busy,
          details: { reason: 'busy', retryable: true },
        },
      } as never)
      .mockResolvedValueOnce(done as never);
    render(<UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={() => {}} />);
    await screen.findByTestId(`ungroup-row-${B}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.busy);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    await screen.findByText('SP-ABCDE-1234567');
    const [first, second] = vi.mocked(ungroupItemsAction).mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
  });

  it('a stale screen (item_changed) says so in the dialog and Review again re-reads with a new key', async () => {
    preview([cand(A), cand(B)]);
    vi.mocked(ungroupItemsAction)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'conflict',
          message: GROUPING_ERROR_WORDS.itemChanged,
          details: { reason: 'item_changed' },
        },
      } as never)
      .mockResolvedValueOnce(done as never);
    render(<UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={() => {}} />);
    await screen.findByTestId(`ungroup-row-${B}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.itemChanged);
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    await waitFor(() => expect(previewUngroupAction).toHaveBeenCalledTimes(2));
    await screen.findByTestId(`ungroup-row-${B}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    const [first, second] = vi
      .mocked(ungroupItemsAction)
      .mock.calls.map((c) => c[0] as { idempotencyKey: string });
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it('lists what it leaves out and why, and offers nothing to save when nothing is left', async () => {
    preview([
      cand(A, { sku: 'ALONE' }),
      cand(K, { sku: 'KIT', isBundle: true }),
      cand(B, { sku: 'KIT' }),
    ]);
    render(<UngroupDialog open itemIds={[A, K]} onOpenChange={() => {}} onDone={() => {}} />);
    expect(
      await screen.findByText(new RegExp(UNGROUP_COPY.leftOutReason.not_shared)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(UNGROUP_COPY.leftOutReason.kit.replace(/[()]/g, '\\$&'))),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ungroup \d/ })).toBeNull();
  });

  // Fix round 1, D6: a thrown action (the network dropped the answer) must not
  // leave the dialog stuck in "saving" with Cancel disabled. It returns to the
  // review with the SAME body and key pending, so Save replays a split that
  // did arrive instead of splitting again.
  it('a lost answer (the action throws) returns to the review, and Save resends the SAME body and key', async () => {
    preview([cand(A), cand(B)]);
    vi.mocked(ungroupItemsAction)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(done as never);
    const onOpenChange = vi.fn();
    render(<UngroupDialog open itemIds={[B]} onOpenChange={onOpenChange} onDone={() => {}} />);
    await screen.findByTestId(`ungroup-row-${B}`);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(GROUPING_ERROR_WORDS.internal);
    expect(alert).not.toHaveTextContent(/Failed to fetch|TypeError/);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Review again' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(1) }));
    await screen.findByText('SP-ABCDE-1234567');
    const [first, second] = vi.mocked(ungroupItemsAction).mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
  });

  // Fix round 1, P6: loading and the result are announced, focus lands on
  // Done when the footer swaps, and each radio names its outcome.
  it('announces loading and the result, moves focus to Done, and each radio describes what happens to its record', async () => {
    let resolvePreview: (v: unknown) => void = () => {};
    vi.mocked(previewUngroupAction).mockReturnValueOnce(
      new Promise((r) => {
        resolvePreview = r;
      }) as never,
    );
    vi.mocked(ungroupItemsAction).mockResolvedValueOnce(done as never);
    render(<UngroupDialog open itemIds={[A, B]} onOpenChange={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading the records');
    resolvePreview({
      ok: true,
      data: { candidates: [cand(A), cand(B)], organizationId: ORG, actorUserId: ME },
    });
    await screen.findByTestId(`ungroup-row-${A}`);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveAccessibleDescription(UNGROUP_COPY.keepsSku('SP-PAIR'));
    expect(radios[1]).toHaveAccessibleDescription(UNGROUP_COPY.getsNewSku);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(UNGROUP_COPY.done(1));
    expect(status).toHaveTextContent('SP-ABCDE-1234567');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus());
  });

  // Fix round 1, D5: when the other records of a SKU vanish between the review
  // and Save, the database keeps the SKU on the oldest selected record although
  // the review said "Gets a new SKU". The result says so instead of dropping it.
  it('says which record kept its SKU when the review had shown it a new one', async () => {
    preview([cand(A), cand(B), cand(C, { binLocation: '22-D', placementLabel: '22-D' })]);
    vi.mocked(ungroupItemsAction).mockResolvedValueOnce({
      ok: true,
      data: {
        replay: false,
        items: [
          { id: B, beforeSku: 'SP-PAIR', afterSku: 'SP-PAIR', kept: true, anchorItemId: B },
          {
            id: C,
            beforeSku: 'SP-PAIR',
            afterSku: 'SP-FGHIJ-7654321',
            kept: false,
            anchorItemId: B,
          },
        ],
      },
    } as never);
    render(<UngroupDialog open itemIds={[B, C]} onOpenChange={() => {}} onDone={() => {}} />);
    await screen.findByTestId(`ungroup-row-${B}`);
    expect(
      within(screen.getByTestId(`ungroup-row-${B}`)).getByText(UNGROUP_COPY.getsNewSku),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.confirm(2) }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(UNGROUP_COPY.done(1));
    expect(status).toHaveTextContent(UNGROUP_COPY.keptUnplanned('SP-PAIR'));
  });

  // Fix round 1, D2: a record without a barcode has a label that prints its
  // SKU; after the split, scanning that old label finds the records that keep
  // the SKU. Say it BEFORE Save, and only when it applies.
  it('says before Save that old SKU labels will find the records that keep the SKU, only when a changing record has no barcode', async () => {
    preview([cand(A), cand(B)]);
    const { unmount } = render(
      <UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={() => {}} />,
    );
    await screen.findByTestId(`ungroup-row-${B}`);
    expect(screen.getByText(UNGROUP_COPY.labelsBefore)).toBeInTheDocument();
    unmount();
    preview([cand(A), cand(B, { barcode: '0012345678905' })]);
    render(<UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={() => {}} />);
    await screen.findByTestId(`ungroup-row-${B}`);
    expect(screen.queryByText(UNGROUP_COPY.labelsBefore)).toBeNull();
  });

  it('a preview refusal is said inside the dialog', async () => {
    vi.mocked(previewUngroupAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: GROUPING_ERROR_WORDS.permission },
    } as never);
    render(<UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.permission);
  });

  // Test stage (local walk W10, C7d): with 101 records selected the preview is
  // refused (tooMany) and returns no candidate, so the plan listed every
  // selected record as "isn't available any more", 101 lines above the real
  // words. A refused preview says only its own words.
  it('a refused preview lists no record as unavailable: it says only why (too many records)', async () => {
    vi.mocked(previewUngroupAction).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: GROUPING_ERROR_WORDS.tooMany,
        details: { reason: 'invalid' },
      },
    } as never);
    const ids = Array.from(
      { length: 101 },
      (_, i) => `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`,
    );
    render(<UngroupDialog open itemIds={ids} onOpenChange={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.tooMany);
    expect(screen.queryByText('Left out:')).toBeNull();
    expect(screen.queryAllByText(new RegExp(UNGROUP_COPY.leftOutReason.not_found))).toHaveLength(0);
    expect(screen.queryByText(UNGROUP_COPY.barcodeNote)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ungroup \d+ records?$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
