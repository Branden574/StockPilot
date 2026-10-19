'use client';

import * as React from 'react';

/**
 * The Table's scroll wrapper, the one client part of components/ui/table.tsx
 * (the rows and cells stay server-renderable, so a long server table hydrates
 * one component, not one per cell).
 *
 * Keyboard and name (WCAG 2.1.1; axe scrollable-region-focusable): while the
 * table is wider than the wrapper, the wrapper joins the Tab order
 * (tabIndex 0) so the arrow keys scroll it, shows the global focus ring (the
 * same 2 px in --ring) drawn as an inset outline rather than the usual
 * box-shadow, so a card's clipped edge cannot hide it and the rows cannot
 * cover it (a row's hover, selected or footer background and its 1 px
 * separators paint above an inset shadow, but below an outline), and carries
 * data-overflow="true" for an edge treatment. Overflow is measured after mount
 * and again whenever the wrapper or the table resizes, so the server HTML and
 * the first client render match and nothing moves. With a `label` (or
 * `labelledBy`) the wrapper is a `region` named by it, whether or not it
 * overflows. A table that fits, with no name, renders exactly as before.
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

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth);
    check();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', check);
      return () => window.removeEventListener('resize', check);
    }
    // The wrapper resizes with the page; the table resizes when its rows or
    // columns change. Either can start or stop the sideways scroll.
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  const named = Boolean(label || labelledBy);
  return (
    <div
      ref={ref}
      className="focus-visible:outline-ring focus-visible:outline-solid relative w-full overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:ring-0 focus-visible:ring-offset-0"
      role={named ? 'region' : undefined}
      aria-label={label || undefined}
      aria-labelledby={label ? undefined : labelledBy || undefined}
      tabIndex={overflows ? 0 : undefined}
      data-overflow={overflows ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
