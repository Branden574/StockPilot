import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CartProvider,
  clearCartDraft,
  initialCartState,
  ORDER_DRAFT_PREFIX,
  orderDraftPrefixFor,
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

  // Web walk 2026-09-25: a checkout that came back inside the 250 ms save
  // debounce cleared the draft, then the save still waiting wrote it back.
  describe('a cleared draft stays cleared', () => {
    async function settle() {
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
    }

    it('the New rental cart: a save still waiting never writes the cleared draft back', async () => {
      renderCart(RENTAL_DRAFT_PREFIX);
      await settle();
      act(() => {
        screen.getByRole('button', { name: 'add tent' }).click();
      });
      clearCartDraft(WH, RENTAL_DRAFT_PREFIX); // the checkout came back at once
      await settle();
      expect(localStorage.getItem(`${RENTAL_DRAFT_PREFIX}${WH}`)).toBeNull();
    });

    it('the Orders cart (placing an order): the same', async () => {
      renderCart();
      await settle();
      act(() => {
        screen.getByRole('button', { name: 'add tent' }).click();
      });
      clearCartDraft(WH);
      await settle();
      expect(localStorage.getItem(`${ORDER_DRAFT_PREFIX}${WH}`)).toBeNull();
    });

    it('a change made after the clear is saved as usual', async () => {
      renderCart(RENTAL_DRAFT_PREFIX);
      await settle();
      act(() => {
        screen.getByRole('button', { name: 'add tent' }).click();
      });
      clearCartDraft(WH, RENTAL_DRAFT_PREFIX);
      act(() => {
        screen.getByRole('button', { name: 'add tent' }).click();
      });
      await settle();
      const saved = JSON.parse(localStorage.getItem(`${RENTAL_DRAFT_PREFIX}${WH}`) ?? '{}');
      expect(saved.lines).toEqual([{ itemId: 'tent', quantity: 2 }]);
    });

    it("clearing one page's draft leaves the other page's waiting save alone", async () => {
      render(
        <>
          <CartProvider
            initial={initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' })}
            draftPrefix={RENTAL_DRAFT_PREFIX}
          >
            <Lines />
          </CartProvider>
          <CartProvider initial={initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' })}>
            <Lines />
          </CartProvider>
        </>,
      );
      await settle();
      act(() => {
        for (const b of screen.getAllByRole('button', { name: 'add tent' })) b.click();
      });
      clearCartDraft(WH, RENTAL_DRAFT_PREFIX);
      await settle();
      expect(localStorage.getItem(`${RENTAL_DRAFT_PREFIX}${WH}`)).toBeNull();
      const orders = JSON.parse(localStorage.getItem(`${ORDER_DRAFT_PREFIX}${WH}`) ?? '{}');
      expect(orders.lines).toEqual([{ itemId: 'tent', quantity: 1 }]);
    });
  });
});

// ═══ THE NEW ORDER DRAFT BELONGS TO ONE ACCOUNT (phone ordering PO-2, X-1) ═══
//
// The New order page saves under order-draft:v2:<userId>:<warehouse>. A draft
// left under the old account-less key is adopted once, by the first signed-in
// person who opens that warehouse, WITHOUT its on-behalf name and email, and
// the old key is deleted.
describe('CartProvider — the New order draft is per account', () => {
  const A = orderDraftPrefixFor('user-a');
  const B = orderDraftPrefixFor('user-b');

  function Who() {
    const { state } = useCart();
    return (
      <span data-testid="who">
        {state.onBehalfOf ? `${state.onBehalfOf.name}/${state.onBehalfOf.email}` : 'myself'}
      </span>
    );
  }
  function renderOrders(prefix: string) {
    return render(
      <CartProvider
        initial={initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' })}
        draftPrefix={prefix}
        legacyDraftPrefix={ORDER_DRAFT_PREFIX}
      >
        <Lines />
        <Who />
      </CartProvider>,
    );
  }
  const legacy = () =>
    JSON.stringify({
      ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }),
      onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.org' },
      lines: [{ itemId: 'stapler', quantity: 3 }],
    });

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('the prefix names the account', () => {
    expect(A).toBe('order-draft:v2:user-a:');
  });

  it('one account never opens another account draft on the same browser', () => {
    localStorage.setItem(`${A}${WH}`, draft([{ itemId: 'stapler', quantity: 1 }]));
    renderOrders(B);
    expect(screen.getByTestId('lines').textContent).toBe('');
  });

  it('a legacy draft is adopted once, without its on-behalf name and email, and the old key is deleted', () => {
    localStorage.setItem(`${ORDER_DRAFT_PREFIX}${WH}`, legacy());
    renderOrders(A);
    expect(screen.getByTestId('lines').textContent).toBe('staplerx3');
    expect(screen.getByTestId('who').textContent).toBe('myself');
    expect(localStorage.getItem(`${ORDER_DRAFT_PREFIX}${WH}`)).toBeNull();
  });

  it('the next account finds nothing to adopt', () => {
    localStorage.setItem(`${ORDER_DRAFT_PREFIX}${WH}`, legacy());
    const first = renderOrders(A);
    first.unmount();
    renderOrders(B);
    expect(screen.getByTestId('lines').textContent).toBe('');
  });

  it('an account with its own draft keeps it and leaves the legacy one for nobody else to misread', () => {
    localStorage.setItem(`${A}${WH}`, draft([{ itemId: 'tent', quantity: 1 }]));
    localStorage.setItem(`${ORDER_DRAFT_PREFIX}${WH}`, legacy());
    renderOrders(A);
    expect(screen.getByTestId('lines').textContent).toBe('tentx1');
  });
});

// ═══ A LOCKED CART CANNOT CHANGE (phone ordering PO-2) ═══
describe('CartProvider — a locked cart drops every change but hydrate and reset', () => {
  function Locker() {
    const { state, dispatch, locked, setLocked } = useCart();
    return (
      <div>
        <span data-testid="lines">{state.lines.map((l) => `${l.itemId}x${l.quantity}`).join(',')}</span>
        <span data-testid="locked">{String(locked)}</span>
        <button type="button" onClick={() => dispatch({ type: 'add', itemId: 'tent' })}>
          add tent
        </button>
        <button type="button" onClick={() => setLocked(true)}>
          lock
        </button>
        <button type="button" onClick={() => setLocked(false)}>
          unlock
        </button>
        <button
          type="button"
          onClick={() =>
            dispatch({
              type: 'hydrate',
              state: { ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), lines: [{ itemId: 'sent', quantity: 2 }] },
            })
          }
        >
          hydrate
        </button>
        <button type="button" onClick={() => dispatch({ type: 'reset' })}>
          reset
        </button>
      </div>
    );
  }
  beforeEach(() => localStorage.clear());

  it('add is dropped while locked, hydrate and reset are not, and unlocking lets changes through again', () => {
    render(
      <CartProvider initial={initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' })}>
        <Locker />
      </CartProvider>,
    );
    const click = (name: string) => act(() => screen.getByRole('button', { name }).click());
    click('add tent');
    expect(screen.getByTestId('lines').textContent).toBe('tentx1');
    // Lock and add in the SAME tick: the ref takes effect before any render.
    act(() => {
      screen.getByRole('button', { name: 'lock' }).click();
      screen.getByRole('button', { name: 'add tent' }).click();
    });
    expect(screen.getByTestId('locked').textContent).toBe('true');
    expect(screen.getByTestId('lines').textContent).toBe('tentx1');
    click('hydrate');
    expect(screen.getByTestId('lines').textContent).toBe('sentx2');
    click('add tent');
    expect(screen.getByTestId('lines').textContent).toBe('sentx2');
    click('unlock');
    click('add tent');
    expect(screen.getByTestId('lines').textContent).toBe('sentx2,tentx1');
    click('lock');
    click('reset');
    expect(screen.getByTestId('lines').textContent).toBe('');
  });
});
