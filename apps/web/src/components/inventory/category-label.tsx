import { safeHexColor } from '@stockpilot/core';

export type CategoryLookup = { name: string; color: string | null };

/**
 * The Category cell: the category's name in its own colour with its dot, or a
 * dash. `wrap` (the table): a name may wrap between its words, and the dot
 * stays beside the first line (7 px down is the centre of a 20.25 px line, so a
 * one-line name sits exactly where it did); a Grid card passes nothing.
 *
 * One component for the Items, Books and Rentals table rows and the Grid
 * cards (inventory-table.tsx). The stored colour is drawn only in the
 * `#rrggbb` form the app writes (safeHexColor); anything else draws the plain
 * name, as a category with no colour does (docket T14).
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
      className={wrap ? 'inline-flex items-start gap-1.5' : 'inline-flex items-center gap-1.5'}
      style={color ? { color } : undefined}
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
