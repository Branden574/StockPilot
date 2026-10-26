import { safeHexColor } from '@stockpilot/core';

import { cn } from '@/lib/utils';

export type CategoryLookup = { name: string; color: string | null };

/**
 * The Category cell: the category's name in ink 2 after a 6 px dot in its own
 * colour, or a dash. The name is never drawn in the colour itself (DESIGN-SPEC
 * 6.9 draws Category in ink 2; CONFLICTS C8 keeps the dot): a colour an org
 * picks is no text colour, and 7 of the 8 the categories manager offers fall
 * under 4.5:1 on white (FX2). The dot stays decorative, hidden from screen
 * readers, as the name is printed. `wrap` (the table): a name may wrap between
 * its words, and the dot stays beside the first line (7 px down is the centre
 * of a 20.25 px line, so a one-line name sits exactly where it did); a Grid
 * card passes nothing.
 *
 * One component for the Items, Books and Rentals table rows and the Grid
 * cards (inventory-table.tsx). The stored colour reaches the dot only in the
 * `#rrggbb` form the app writes (safeHexColor); anything else draws the name
 * with no dot, as a category with no colour does (docket T14).
 */
export function CategoryLabel({
  category,
  wrap = false,
}: {
  category: CategoryLookup | null | undefined;
  wrap?: boolean;
}) {
  const color = safeHexColor(category?.color);
  return category ? (
    <span
      className={cn(
        'text-ink-2',
        wrap ? 'inline-flex items-start gap-1.5' : 'inline-flex items-center gap-1.5',
      )}
    >
      {color && (
        <span
          aria-hidden
          className={
            wrap
              ? 'mt-[7.125px] h-1.5 w-1.5 shrink-0 rounded-full'
              : 'h-1.5 w-1.5 shrink-0 rounded-full'
          }
          style={{ backgroundColor: color }}
        />
      )}
      {category.name}
    </span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}
