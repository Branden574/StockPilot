import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CartProvider,
  clearCartDraft,
  initialCartState,
  ORDER_DRAFT_PREFIX,
  RENTAL_DRAFT_PREFIX,
  useCart,
} from './cart-context';

// ═══ ONE SAVED DRAFT PER PAGE ═══
//
// The New rental page saved its cart under the Orders key, so the two pages
// shared one draft per warehouse. An Orders basket then opened inside the
// rental cart and failed checkout (Demo Co, 2026-09-24). These pin that a
// page reads, writes and clears only its own draft.

const WH = 'wh-1';

function draft(lines: Array<{ itemId: string; quantity: number }>) {
  return JSON.stringify({
    ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }),
    lines,
  });
}

function Lines() {
  const { state, dispatch } = useCart();
  return (
    <div>
      <span data-testid="lines">{state.lines.map((l) => `${l.itemId}x${l.quantity}`).join(',')}</span>
      <button type="button" onClick={() => dispatch({ type: 'add', itemId: 'tent' })}>
        add tent
      </button>
    </div>
  );
}

function renderCart(draftPrefix?: string) {
  return render(
    <CartProvider
      initial={initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' })}
      {...(draftPrefix ? { draftPrefix } : {})}
    >
      <Lines />
    </CartProvider>,
  );
}

describe('CartProvider — drafts are per page', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('a rental cart does NOT open the Orders draft for the same warehouse', () => {
    localStorage.setItem(`${ORDER_DRAFT_PREFIX}${WH}`, draft([{ itemId: 'stapler', quantity: 1 }]));
    renderCart(RENTAL_DRAFT_PREFIX);
    expect(screen.getByTestId('lines').textContent).toBe('');
  });

  it('a rental cart restores its own draft', () => {
    localStorage.setItem(`${RENTAL_DRAFT_PREFIX}${WH}`, draft([{ itemId: 'tent', quantity: 2 }]));
    renderCart(RENTAL_DRAFT_PREFIX);
    expect(screen.getByTestId('lines').textContent).toBe('tentx2');
  });

  it('a rental cart saves under its own key and leaves the Orders draft alone', async () => {
    const orders = draft([{ itemId: 'stapler', quantity: 1 }]);
    localStorage.setItem(`${ORDER_DRAFT_PREFIX}${WH}`, orders);
    renderCart(RENTAL_DRAFT_PREFIX);

    act(() => {
      screen.getByRole('button', { name: 'add tent' }).click();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const saved = JSON.parse(localStorage.getItem(`${RENTAL_DRAFT_PREFIX}${WH}`) ?? '{}');
    expect(saved.lines).toEqual([{ itemId: 'tent', quantity: 1 }]);
    expect(localStorage.getItem(`${ORDER_DRAFT_PREFIX}${WH}`)).toBe(orders);
  });

  it('the Orders cart keeps its original key, so saved Orders drafts still restore', () => {
    expect(ORDER_DRAFT_PREFIX).toBe('order-draft:');
    localStorage.setItem(`order-draft:${WH}`, draft([{ itemId: 'stapler', quantity: 3 }]));
    renderCart();
    expect(screen.getByTestId('lines').textContent).toBe('staplerx3');
  });

  it('clearCartDraft removes only the named page draft', () => {
    localStorage.setItem(`${ORDER_DRAFT_PREFIX}${WH}`, draft([{ itemId: 'stapler', quantity: 1 }]));
    localStorage.setItem(`${RENTAL_DRAFT_PREFIX}${WH}`, draft([{ itemId: 'tent', quantity: 1 }]));

    clearCartDraft(WH, RENTAL_DRAFT_PREFIX);
    expect(localStorage.getItem(`${RENTAL_DRAFT_PREFIX}${WH}`)).toBeNull();
    expect(localStorage.getItem(`${ORDER_DRAFT_PREFIX}${WH}`)).not.toBeNull();

    clearCartDraft(WH);
    expect(localStorage.getItem(`${ORDER_DRAFT_PREFIX}${WH}`)).toBeNull();
  });
});
