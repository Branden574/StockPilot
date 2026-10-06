/**
 * THE ORDER SCREEN'S `focus` PARAMETER (phone ordering PO-4): the success
 * screen's "Review and approve" opens /order/<id>?focus=approve, and the
 * order screen scrolls to its actions section (MANAGER ACTIONS or ORDER
 * ACTIONS: the section, never its label, which depends on the role since
 * security slice D) once, when that section first lays out. It only scrolls:
 * approving is unchanged and still a tap. Pure.
 *
 * Returns RX-2 review (counter taps): the RMA workbench's Hand over opens the
 * replacement's order with ?focus=sign. It scrolls to the actions too, and
 * the paper signature (Physical signature) opens once on arrival
 * (stepSignatureOnArrival: only on the screen in front, for who tapped it).
 */

export type OrderScreenFocus = 'actions' | null;

function focusValue(param: unknown): unknown {
  return Array.isArray(param) ? param[0] : param;
}

/** What a `focus` route parameter asks for. Anything else is nothing. */
export function orderScreenFocus(param: unknown): OrderScreenFocus {
  const v = focusValue(param);
  return v === 'approve' || v === 'actions' || v === 'sign' ? 'actions' : null;
}

/**
 * ?focus=sign as a request that belongs to the screen in front and to the
 * person who tapped Hand over (returns RX-2 review fix; simulator fault
 * 2026-10-06, sim-RX2/shots-fix iphone-FAULT-01..03). A bare one-shot ref let
 * an order screen that stayed mounted UNDER another screen (left through a
 * deep link) open the prompt over Home when someone else signed in: QA Staff's
 * Hand over had not opened it (staff may not confirm), and once QA Manager was
 * signed in the hidden screen passed every check. The prompt names no order,
 * so Record would have handed over an order nobody was looking at.
 *   pending  the screen has not yet been in front with the order loaded;
 *   arrived  it has (the arrival): it opens as soon as everything holds, while
 *            the screen is still in front for the same person;
 *   done     spent for good: opened once, or the person left the screen, or
 *            someone else is signed in.
 * Pure: the screen keeps the state in a ref and steps it on every render.
 */
export interface SignArrival {
  phase: 'pending' | 'arrived' | 'done';
  /** Who was signed in when the screen first rendered (who tapped Hand over). */
  requestedBy: string | null;
}

export function initialSignArrival(userId: string | null): SignArrival {
  return { phase: 'pending', requestedBy: userId };
}

export function stepSignatureOnArrival(
  state: SignArrival,
  input: {
    focus: unknown;
    /** This screen is the one in front (useIsFocused). */
    focused: boolean;
    loaded: boolean;
    /** The screen offers Physical signature to this viewer now. */
    offered: boolean;
    online: boolean;
    busy: boolean;
    /** Who is signed in now. */
    userId: string | null;
  },
): { state: SignArrival; open: boolean } {
  if (state.phase === 'done' || focusValue(input.focus) !== 'sign') return { state, open: false };
  if (state.requestedBy === null || input.userId !== state.requestedBy) {
    return { state: { ...state, phase: 'done' }, open: false };
  }
  let phase: SignArrival['phase'] = state.phase;
  if (phase === 'pending') {
    if (!(input.focused && input.loaded)) return { state, open: false };
    phase = 'arrived';
  }
  if (!input.focused) return { state: { ...state, phase: 'done' }, open: false };
  if (input.loaded && input.offered && input.online && !input.busy) return { state: { ...state, phase: 'done' }, open: true };
  return { state: { ...state, phase }, open: false };
}

/** Where to scroll for a section laid out at `y` in the scroll content: a
 *  little above it, never before the top. */
export function focusScrollY(y: number): number | null {
  if (!Number.isFinite(y)) return null;
  return Math.max(0, Math.round(y) - FOCUS_SCROLL_INSET);
}

export const FOCUS_SCROLL_INSET = 12;
