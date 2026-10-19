'use client';

import * as React from 'react';

/**
 * What the keyboard can already reach inside the table. While any of these is
 * in a row, Tab moves through them and the browser scrolls each one into view,
 * so the wrapper itself stays out of the Tab order (Chrome's own rule for
 * keyboard-focusable scrollers). The selector only finds candidates;
 * `canReach` then drops the ones the keyboard cannot get to.
 */
const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type=hidden])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'details > summary:first-of-type',
  'audio[controls]',
  'video[controls]',
  'iframe',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

/**
 * Whether Tab can land on a candidate: no negative tabindex, nothing inert
 * around it, not inside a closed <details> (only its summary shows), and
 * rendered and visible, so a control in a `hidden sm:table-cell` column on a
 * phone, or under [hidden], does not count. aria-hidden is not checked: Tab
 * still reaches a control under it, and the browser scrolls it into view.
 */
function canReach(el: Element): boolean {
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number.parseInt(tabindex, 10) < 0) return false;
  if (el.closest('[inert]')) return false;
  for (
    let details = el.closest('details:not([open])');
    details;
    details = details.parentElement?.closest('details:not([open])') ?? null
  ) {
    const summary = details.querySelector(':scope > summary');
    if (!summary?.contains(el)) return false;
  }
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ visibilityProperty: true });
  }
  return el.getClientRects().length > 0;
}

/** Whether the table holds a control the keyboard can reach. */
function hasReachableControl(el: HTMLElement): boolean {
  return Array.from(el.querySelectorAll(TABBABLE)).some(canReach);
}

/**
 * The Table's scroll wrapper, the one client part of components/ui/table.tsx
 * (the rows and cells stay server-renderable, so a long server table hydrates
 * one component, not one per cell).
 *
 * Keyboard and name (WCAG 2.1.1; axe scrollable-region-focusable): while the
 * table is wider than the wrapper and holds nothing the keyboard can reach (no
 * link, enabled button or field, or other tab stop that is shown and not
 * inert; a control in a column hidden at this width does not count), the
 * wrapper joins the Tab
 * order (tabIndex 0) so the arrow keys scroll it. A table with controls is
 * scrolled by tabbing to them, so it adds no extra, unnamed stop. The wrapper
 * shows the global focus ring (the same 2 px in --ring) drawn as an inset
 * outline rather than the usual box-shadow, so a card's clipped edge cannot
 * hide it and the rows cannot cover it (a row's hover, selected or footer
 * background and its 1 px separators paint above an inset shadow, but below
 * an outline; an outline also stays under forced colors, which drop every
 * box-shadow). As the first or last child of a rounded card the wrapper takes
 * the card's top or bottom corner radius, so the outline follows the card's
 * corners instead of cutting square across them. While the table overflows
 * the wrapper carries data-overflow="true" for an edge treatment. Overflow
 * and the controls are measured after mount,
 * again whenever the wrapper or the table resizes, and whenever the table's
 * rows, links, disabled states or tab stops change, so the server HTML and
 * the first client render match and nothing moves. With a `label` (or
 * `labelledBy`) the wrapper is a `region` named by it, whether or not it
 * overflows. A table that fits, with no name, renders exactly as before.
 * A positioned cell (a sticky column with its own background) still paints
 * over the outline; no caller has one.
 */
export function TableScroll({
  label,
  labelledBy,
  children,
}: {
  label?: string;
  labelledBy?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = React.useState(false);
  const [hasTabbable, setHasTabbable] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const over = el.scrollWidth > el.clientWidth;
      setOverflows(over);
      // Only an overflowing table can need the stop, so a table that fits
      // skips the walk over its controls.
      setHasTabbable(over && hasReachableControl(el));
    };
    check();
    const cleanups: Array<() => void> = [];
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', check);
      cleanups.push(() => window.removeEventListener('resize', check));
    } else {
      // The wrapper resizes with the page; the table resizes when its rows or
      // columns change. Either can start or stop the sideways scroll.
      const ro = new ResizeObserver(check);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
      cleanups.push(() => ro.disconnect());
    }
    // Rows that arrive later, or a button that turns enabled, can add or
    // remove the last control, and with it the need for the wrapper's stop.
    // A column hidden at a breakpoint changes the wrapper's width, which the
    // resize watch above already measures again.
    const table = el.firstElementChild;
    if (table && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(check);
      mo.observe(table, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'disabled',
          'href',
          'tabindex',
          'type',
          'contenteditable',
          'controls',
          'hidden',
          'inert',
          'open',
        ],
      });
      cleanups.push(() => mo.disconnect());
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  const named = Boolean(label || labelledBy);
  const stop = overflows && !hasTabbable;
  return (
    <div
      ref={ref}
      className="focus-visible:outline-ring focus-visible:outline-solid relative w-full overflow-auto first:rounded-t-[inherit] last:rounded-b-[inherit] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:ring-0 focus-visible:ring-offset-0"
      role={named ? 'region' : undefined}
      aria-label={label || undefined}
      aria-labelledby={label ? undefined : labelledBy || undefined}
      tabIndex={stop ? 0 : undefined}
      data-overflow={overflows ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
