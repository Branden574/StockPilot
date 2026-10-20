/**
 * Pins a table's Actions column to the right edge of its card below md: the
 * sticky cell sits on the card fill, with a hairline where the scrolled
 * columns pass under it, so a row's actions stay on screen on a phone while
 * the other columns scroll sideways inside the card. Put it on the column's
 * header cell and on every body cell of that column.
 */
export const STICKY_ACTIONS =
  'max-md:sticky max-md:right-0 max-md:z-[1] max-md:bg-card max-md:shadow-[inset_1px_0_0_hsl(var(--border))]';
