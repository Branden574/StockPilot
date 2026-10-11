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

const cand = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sku: 'SP-PAIR',
  name: 'Black Mouse Pad',
  itemType: 'product',
  isBundle: false,
  inFamily: false,
  barcode: null,
  binLocation: id === A ? '22-A' : '22-C',
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

  it('a preview refusal is said inside the dialog', async () => {
    vi.mocked(previewUngroupAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: GROUPING_ERROR_WORDS.permission },
    } as never);
    render(<UngroupDialog open itemIds={[B]} onOpenChange={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_ERROR_WORDS.permission);
  });
});
