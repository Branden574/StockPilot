/** The filter bar's control and label classes, shared by its parts
 *  (filter-bar.tsx, orders-placed-control.tsx) so every control is the same
 *  height and weight: the redesign's form field (DESIGN-SPEC 6.3 and 6.4), 32
 *  px on the card fill with the stronger hairline, 44 px with 16 px text
 *  below sm (a thumb-sized target, and no iOS zoom on focus), and the app's
 *  visible focus ring (ring-2 plus ring-offset-2: orders-placed-control's
 *  FOCUS_RING_ROOM counts on those 4 px). */
export const FILTER_CONTROL =
  'border-line-strong bg-card text-foreground focus-visible:ring-ring focus-visible:ring-offset-background h-8 w-full rounded-md border px-2.5 text-[13px] transition-colors hover:border-ink-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line-strong max-sm:h-11 max-sm:text-base';
export const FILTER_LABEL = 'text-muted-foreground text-[12px] font-medium leading-[18px]';
