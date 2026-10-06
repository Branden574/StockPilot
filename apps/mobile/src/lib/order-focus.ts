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
 * (shouldOpenSignatureOnArrival).
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
 * ?focus=sign: open the paper signature on arrival, once. Only when the order
 * has loaded (never a remembered offline view), the screen offers Physical
 * signature (the order is ready to hand over and this viewer may confirm it:
 * a manager by role or the assigned driver), the phone is online and nothing
 * else is running; otherwise the screen simply opens at its actions.
 */
export function shouldOpenSignatureOnArrival(input: {
  focus: unknown;
  /** Already opened once on this screen (never again on a reload). */
  opened: boolean;
  loaded: boolean;
  offered: boolean;
  online: boolean;
  busy: boolean;
}): boolean {
  return focusValue(input.focus) === 'sign' && !input.opened && input.loaded && input.offered && input.online && !input.busy;
}

/** Where to scroll for a section laid out at `y` in the scroll content: a
 *  little above it, never before the top. */
export function focusScrollY(y: number): number | null {
  if (!Number.isFinite(y)) return null;
  return Math.max(0, Math.round(y) - FOCUS_SCROLL_INSET);
}

export const FOCUS_SCROLL_INSET = 12;
