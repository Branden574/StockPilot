/**
 * THE ORDER SCREEN'S `focus` PARAMETER (phone ordering PO-4): the success
 * screen's "Review and approve" opens /order/<id>?focus=approve, and the
 * order screen scrolls to its actions section (MANAGER ACTIONS or ORDER
 * ACTIONS: the section, never its label, which depends on the role since
 * security slice D) once, when that section first lays out. It only scrolls:
 * approving is unchanged and still a tap. Pure.
 */

export type OrderScreenFocus = 'actions' | null;

/** What a `focus` route parameter asks for. Anything else is nothing. */
export function orderScreenFocus(param: unknown): OrderScreenFocus {
  const v = Array.isArray(param) ? param[0] : param;
  return v === 'approve' || v === 'actions' ? 'actions' : null;
}

/** Where to scroll for a section laid out at `y` in the scroll content: a
 *  little above it, never before the top. */
export function focusScrollY(y: number): number | null {
  if (!Number.isFinite(y)) return null;
  return Math.max(0, Math.round(y) - FOCUS_SCROLL_INSET);
}

export const FOCUS_SCROLL_INSET = 12;
