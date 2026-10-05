import { describe, expect, it, vi } from 'vitest';

import { initialCartState, type CartAction, type CartState } from '@stockpilot/core';

import { createNotesDraft, NOTES_COMMIT_DELAY_MS } from './notes-draft';

/**
 * MANAGER NOTES TYPED LOCALLY, COMMITTED TO THE CART LATER (desk check F8.1):
 * every keystroke used to publish the whole storefront snapshot (every
 * mounted screen redrew). The draft keeps what is typed, commits it after a
 * pause, on blur, before Submit and when checkout goes, and only into the
 * cart of the account, organization and warehouse it was typed for.
 */

type Snap = { scope: { userId: string; orgId: string } | null; warehouseId: string | null; cart: CartState | null };

function fakeSession(initial: Snap) {
  let current = initial;
  const dispatched: CartAction[] = [];
  return {
    dispatched,
    set(next: Partial<Snap>) {
      current = { ...current, ...next };
    },
    getSnapshot: () => current,
    dispatch: vi.fn((action: CartAction) => {
      dispatched.push(action);
      if (action.type === 'set-notes' && current.cart) current = { ...current, cart: { ...current.cart, notes: action.value } };
      return null;
    }),
  };
}

function harness() {
  const timers = new Map<number, () => void>();
  let seq = 0;
  const cart = initialCartState({ warehouseId: 'w1', fulfillmentType: 'pickup' });
  const session = fakeSession({ scope: { userId: 'u', orgId: 'o1' }, warehouseId: 'w1', cart });
  const draft = createNotesDraft({
    session,
    setTimer: (fn, ms) => {
      expect(ms).toBe(NOTES_COMMIT_DELAY_MS);
      seq += 1;
      timers.set(seq, fn);
      return seq;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  });
  const fire = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  return { session, draft, timers, fire };
}

describe('the notes draft', () => {
  it('typing dispatches nothing until the pause; then one set-notes with the last text', () => {
    const { session, draft, fire, timers } = harness();
    draft.change('a');
    draft.change('ab');
    draft.change('abc');
    expect(session.dispatched).toEqual([]);
    expect(timers.size).toBe(1);
    expect(draft.pending()).toBe(true);
    fire();
    expect(session.dispatched).toEqual([{ type: 'set-notes', value: 'abc' }]);
    expect(draft.pending()).toBe(false);
  });

  it('blur, Submit and leaving commit at once, and only once', () => {
    const { session, draft, timers } = harness();
    draft.change('urgent');
    draft.flush();
    expect(session.dispatched).toEqual([{ type: 'set-notes', value: 'urgent' }]);
    expect(timers.size).toBe(0);
    draft.flush();
    draft.dispose();
    expect(session.dispatched).toHaveLength(1);
  });

  it('nothing is dispatched when the cart already holds the text', () => {
    const { session, draft } = harness();
    draft.change('');
    draft.flush();
    expect(session.dispatched).toEqual([]);
  });

  it('never into another organization’s, account’s or warehouse’s cart (a switch before the commit)', () => {
    for (const next of [
      { scope: { userId: 'u', orgId: 'o2' } },
      { scope: { userId: 'u2', orgId: 'o1' } },
      { warehouseId: 'w2' },
      { scope: null },
      { cart: null },
    ] as Partial<Snap>[]) {
      const { session, draft, fire } = harness();
      draft.change('for o1 w1');
      session.set(next);
      fire();
      draft.dispose();
      expect(session.dispatched, JSON.stringify(next)).toEqual([]);
    }
  });
});
