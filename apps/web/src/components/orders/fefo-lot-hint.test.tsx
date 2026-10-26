import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { requestUnconfirmedMessage } from '@/lib/request-failure';
import type { FefoSuggestion } from '@/server/services/lots';
import { offline } from '@/test/rejected-request';

// Redesign P4.B1: the earliest-expiry hint inside a pick row keeps its words
// (lot, expiry date or "no date", "avail N"), its empty sentence and its one
// commit, and each lot's quantity field now has a name of its own.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/lots', () => ({
  recordLotPicksAction: vi.fn(async () => ({ ok: true, data: null })),
}));

import { toast } from 'sonner';

import { recordLotPicksAction } from '@/server/actions/lots';

import { FefoLotHint } from './fefo-lot-hint';

function lot(lotNumber: string, over: Partial<FefoSuggestion> = {}): FefoSuggestion {
  return {
    lotNumber,
    expirationDate: '2026-11-01',
    effectiveExpiry: '2026-11-01T00:00:00Z',
    bucket: 'le30',
    remaining: 8,
    expired: false,
    nearExpiry: true,
    ...over,
  };
}

function renderHint(suggestions: FefoSuggestion[]) {
  return render(
    <FefoLotHint
      orderId="order-1"
      orderLineId="line-1"
      itemId="item-1"
      suggestions={suggestions}
    />,
  );
}

describe('FefoLotHint — the redesigned lot sub-panel (P4.B1)', () => {
  it('says so when no lot has stock left', () => {
    renderHint([]);
    expect(
      screen.getByText('No lots with remaining quantity recorded for this item.'),
    ).toBeInTheDocument();
  });

  it('lists each lot with its expiry words, what is left and a named field', () => {
    renderHint([
      lot('L-OLD', { bucket: 'expired', effectiveExpiry: '2026-09-01T00:00:00Z', remaining: 2 }),
      lot('L-NONE', { bucket: 'unknown', effectiveExpiry: null, expirationDate: null }),
    ]);
    expect(screen.getByText('Pick earliest-expiry first (FEFO)')).toBeInTheDocument();
    expect(screen.getByText('L-OLD')).toBeInTheDocument();
    // The words carry the state; the tone is the bucket's.
    const expired = screen.getByText('2026-09-01');
    expect(expired).toHaveAttribute('data-bucket', 'expired');
    expect(screen.getByText('no date')).toHaveAttribute('data-bucket', 'unknown');
    expect(screen.getByText('avail 2')).toBeInTheDocument();
    expect(
      screen.getByRole('spinbutton', { name: 'Picked quantity from lot L-OLD' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('spinbutton', { name: 'Picked quantity from lot L-NONE' }),
    ).toBeInTheDocument();
  });

  it('records nothing until a lot has a quantity, then records the entered lots', async () => {
    const user = userEvent.setup();
    renderHint([lot('L-A'), lot('L-B')]);
    await user.click(screen.getByRole('button', { name: 'Record picked lots' }));
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Enter a quantity for at least one lot.');
    expect(vi.mocked(recordLotPicksAction)).not.toHaveBeenCalled();

    await user.type(screen.getByRole('spinbutton', { name: 'Picked quantity from lot L-B' }), '3');
    await user.click(screen.getByRole('button', { name: 'Record picked lots' }));
    expect(vi.mocked(recordLotPicksAction)).toHaveBeenCalledWith({
      orderRequestId: 'order-1',
      orderRequestLineId: 'line-1',
      itemId: 'item-1',
      picks: [{ lotNumber: 'L-B', qty: 3, expirationDate: '2026-11-01' }],
    });
  });
});

// B40: Record picked lots set `saving`, awaited the action with no catch and
// cleared it only when it answered. A record that got no answer (offline, a
// server error, a deploy) left the button spinning with no message. Each
// record adds lot pick events, so the same record sent again could count the
// picks twice: the message says to check first, and the lots are read again.
describe('FefoLotHint when the record gets no answer', () => {
  it("says to check each lot's remaining quantity first, and Record works again", async () => {
    vi.mocked(recordLotPicksAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderHint([lot('L-A')]);
    await user.type(screen.getByRole('spinbutton', { name: 'Picked quantity from lot L-A' }), '2');
    await user.click(screen.getByRole('button', { name: 'Record picked lots' }));
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      requestUnconfirmedMessage('the lot picks were recorded', "each lot's remaining quantity"),
    );
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Record picked lots' })).toBeEnabled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });
});
