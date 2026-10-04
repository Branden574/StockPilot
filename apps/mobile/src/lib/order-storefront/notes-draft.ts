import type { CartAction, CartState } from '@stockpilot/core';

/**
 * MANAGER NOTES, TYPED ON CHECKOUT AND COMMITTED TO THE CART LATER (phone
 * ordering PO-4, desk check F8.1). Committing every keystroke published the
 * whole storefront snapshot, and every mounted storefront screen (home and
 * browse stay mounted under checkout) drew again for each character. The
 * field keeps what is typed itself; this draft commits it to the session:
 *
 *   - NOTES_COMMIT_DELAY_MS after the last keystroke;
 *   - at once on blur, before Submit, and when checkout goes (flush);
 *   - only into the cart of the account, organization and warehouse it was
 *     typed for: after a switch, what was typed is dropped, never put into
 *     another cart (the rule desk check F1 set for every write);
 *   - nothing when the cart already holds the text.
 *
 * A cart that is locked refuses the change (the session's rule), which is why
 * Submit flushes BEFORE it sends. Pure: the timer is injected.
 */

export const NOTES_COMMIT_DELAY_MS = 400;

interface NotesSession {
  getSnapshot(): {
    scope: { userId: string; orgId: string } | null;
    warehouseId: string | null;
    cart: CartState | null;
  };
  dispatch(action: CartAction): string | null;
}

export interface NotesDraft {
  /** A keystroke: keep the text and commit it after the pause. */
  change(value: string): void;
  /** Commit now (blur, Submit, leaving checkout). */
  flush(): void;
  /** Typed text not yet committed. */
  pending(): boolean;
  /** Checkout went: commit what is left (to its own cart only). */
  dispose(): void;
}

export function createNotesDraft(deps: {
  session: NotesSession;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): NotesDraft {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let value: string | null = null;
  let bound: { userId: string; orgId: string; warehouseId: string } | null = null;
  let handle: unknown = null;

  function cancel() {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  function flush() {
    cancel();
    const text = value;
    const to = bound;
    value = null;
    bound = null;
    if (text === null || to === null) return;
    const s = deps.session.getSnapshot();
    if (!s.scope || !s.cart) return;
    if (s.scope.userId !== to.userId || s.scope.orgId !== to.orgId || s.warehouseId !== to.warehouseId) return;
    if (s.cart.notes === text) return;
    deps.session.dispatch({ type: 'set-notes', value: text });
  }

  return {
    change(next) {
      const s = deps.session.getSnapshot();
      if (!s.scope || !s.warehouseId) return;
      const here = { userId: s.scope.userId, orgId: s.scope.orgId, warehouseId: s.warehouseId };
      // Typed somewhere else than what is waiting: that goes first.
      if (
        bound !== null &&
        (bound.userId !== here.userId || bound.orgId !== here.orgId || bound.warehouseId !== here.warehouseId)
      ) {
        flush();
      }
      value = next;
      bound = here;
      cancel();
      handle = setTimer(flush, NOTES_COMMIT_DELAY_MS);
    },
    flush,
    pending: () => value !== null,
    dispose: flush,
  };
}
