'use client';

import * as React from 'react';

import { useScrollStop } from './use-scroll-stop';

/**
 * The Table's scroll wrapper, the one client part of components/ui/table.tsx
 * (the rows and cells stay server-renderable, so a long server table hydrates
 * one component, not one per cell).
 *
 * Keyboard and name (WCAG 2.1.1; axe scrollable-region-focusable): while the
 * table is wider than the wrapper and holds nothing the keyboard can reach (no
 * link, enabled button or field, or other tab stop that is shown and not
 * inert; a control in a column hidden at this width does not count), the
 * wrapper joins the Tab order (tabIndex 0) so the arrow keys scroll it; the
 * measuring is useScrollStop's. A table with controls is scrolled by tabbing
 * to them, so it adds no extra, unnamed stop. The wrapper
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
  const { overflows, stop } = useScrollStop(ref);

  const named = Boolean(label || labelledBy);
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
