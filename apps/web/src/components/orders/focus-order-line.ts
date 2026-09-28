/**
 * Taking someone to a line of the order (F2-2). The completion confirm's
 * "Review short lines" and the departure confirm's "Fix the order" close their
 * dialog and land on the first short line, where its fixes are (Lower, Remove:
 * the confirms carry no buttons of their own, decision D18).
 *
 * The order page gives each row of its lines table `orderLineAnchorId(line)`
 * and makes it focusable from script. Focus goes to the line's first fix when
 * it has one (a control marked `data-short-line-fix`), else to the row itself,
 * so a keyboard or screen-reader user arrives exactly where the fix is. The
 * row is marked `data-review="true"` (the page tints it) until focus leaves
 * it, so a sighted user sees which line they were sent to.
 */

/** The DOM id of a line's row on the order page. */
export function orderLineAnchorId(lineId: string): string {
  return `order-line-${lineId}`;
}

/** Scrolls to a line's row and focuses its first fix (or the row). False when
 *  the line is not on the page (no id, or a line added since it rendered). */
export function focusOrderLine(lineId: string | null | undefined): boolean {
  if (!lineId || typeof document === 'undefined') return false;
  const row = document.getElementById(orderLineAnchorId(lineId));
  if (!row) return false;
  const target = row.querySelector<HTMLElement>('[data-short-line-fix]') ?? row;
  row.setAttribute('data-review', 'true');
  const clear = (e: FocusEvent) => {
    if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return;
    row.removeAttribute('data-review');
    row.removeEventListener('focusout', clear);
  };
  row.addEventListener('focusout', clear);
  row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  target.focus({ preventScroll: true });
  return true;
}
