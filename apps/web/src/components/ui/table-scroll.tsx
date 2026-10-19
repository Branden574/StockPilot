'use client';

import * as React from 'react';

/**
 * What the keyboard can already reach inside the table. While any of these is
 * in a row, Tab moves through them and the browser scrolls each one into view,
 * so the wrapper itself stays out of the Tab order (Chrome's own rule for
 * keyboard-focusable scrollers).
 */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable=true]';

/**
 * The Table's scroll wrapper, the one client part of components/ui/table.tsx
 * (the rows and cells stay server-renderable, so a long server table hydrates
 * one component, not one per cell).
 *
 * Keyboard and name (WCAG 2.1.1; axe scrollable-region-focusable): while the
 * table is wider than the wrapper and holds nothing the keyboard can reach (no
 * link, enabled button or field, or other tab stop), the wrapper joins the Tab
 * order (tabIndex 0) so the arrow keys scroll it. A table with controls is
 * scrolled by tabbing to them, so it adds no extra, unnamed stop. The wrapper
 * shows the global focus ring (the same 2 px in --ring) drawn as an inset
 * outline rather than the usual box-shadow, so a card's clipped edge cannot
 * hide it and the rows cannot cover it (a row's hover, selected or footer
 * background and its 1 px separators paint above an inset shadow, but below
 * an outline; an outline also stays under forced colors, which drop every
 * box-shadow). While the table overflows the wrapper carries data-overflow="true"
 * for an edge treatment. Overflow and the controls are measured after mount,
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
      setOverflows(el.scrollWidth > el.clientWidth);
      setHasTabbable(el.querySelector(TABBABLE) !== null);
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
    const table = el.firstElementChild;
    if (table && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(check);
      mo.observe(table, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'href', 'tabindex', 'type', 'contenteditable'],
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
      className="focus-visible:outline-ring focus-visible:outline-solid relative w-full overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:ring-0 focus-visible:ring-offset-0"
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
