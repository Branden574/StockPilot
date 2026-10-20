import * as React from 'react';

import { cn } from '@/lib/utils';

import { Thumb } from './thumb';
import { textActionTouchGapY, textActionTouchMarginTop } from './touch-target';

/**
 * The record cell for a table row (DESIGN-SPEC 6.9 "Item" recipe): a 34 px
 * thumbnail, the name with its size badge and chip on the first line, and the
 * mono SKU on its own line under it (plain text: still searchable, selectable
 * and copyable).
 *
 * Slots keep the row's behaviour where it is:
 * - `name` is the page's own link (an IntentLink with `?return=`), so the row
 *   still navigates from the name only and its warm-up and prefetch rules stay.
 * - `thumb` takes the page's own image element (next/image with priority and
 *   the LQIP blur, wrapped in its hover preview); without it `imageSrc`
 *   renders a plain lazy thumbnail, and no photo shows the hatch.
 * - `badge` is the size badge ("8 sizes"); `chip` the row's group chip ("In
 *   group X", "Same SKU as records in X") with its "Add to group" action.
 *   The cell only places what the page hands it and reads no group itself.
 * - `chipAction`: the chip carries that action, a text action with the shared
 *   touch target. Where the target is on (below sm, or a coarse pointer) the
 *   first line's wrapped lines and the SKU line then keep 14 px from it, so
 *   the target never lies over the name link or the SKU text, which stays
 *   selectable (textActionTouchGapY, textActionTouchMarginTop).
 * - `actions` is a header row's own text actions ("Rename group", "Remove
 *   from group"), each with the shared touch target, on a line of their own
 *   under the SKU. The line may wrap between two actions; the caller keeps
 *   each action on one line. Wrapped actions sit 6 px apart, so on a fine
 *   pointer the 24 px circle around one never reaches the other (WCAG 2.2
 *   2.5.8), and where the touch target is on the line keeps 14 px from the SKU
 *   and between its own lines, so no action's target lies over the SKU or
 *   over the other action.
 * - `wrapSku` (a table column that must not widen): the SKU line may wrap,
 *   between its parts or, for a long unbroken run, anywhere inside it, so a
 *   long SKU never widens the column. A soft wrap adds no character, so a
 *   copied SKU is exactly the SKU. Without it the SKU stays on one line.
 * - `nested` indents a member row 24 px so its thumbnail sits under its
 *   header's.
 */
export interface ItemCellProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  name: React.ReactNode;
  sku?: React.ReactNode;
  thumb?: React.ReactNode;
  imageSrc?: string | null;
  imageAlt?: string;
  badge?: React.ReactNode;
  chip?: React.ReactNode;
  chipAction?: boolean;
  actions?: React.ReactNode;
  wrapSku?: boolean;
  nested?: boolean;
}

export function ItemCell({
  name,
  sku,
  thumb,
  imageSrc,
  imageAlt = '',
  badge,
  chip,
  chipAction = false,
  actions,
  wrapSku = false,
  nested = false,
  className,
  ...props
}: ItemCellProps) {
  return (
    <div
      data-slot="item-cell"
      data-nested={nested ? '' : undefined}
      className={cn('flex min-w-0 items-center gap-3', nested && 'pl-6', className)}
      {...props}
    >
      {thumb ?? <Thumb size={34} src={imageSrc} alt={imageAlt} />}
      <div className="min-w-0">
        <div
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5',
            chipAction && textActionTouchGapY,
          )}
        >
          <span
            data-slot="item-cell-name"
            className="text-foreground min-w-0 break-words text-[13.5px] font-medium leading-5"
          >
            {name}
          </span>
          {badge}
          {chip}
        </div>
        {sku != null ? (
          <div
            data-slot="item-cell-sku"
            className={cn(
              'text-muted-foreground font-mono text-[11.5px] leading-[17.25px]',
              wrapSku ? '[overflow-wrap:anywhere]' : 'whitespace-nowrap',
              chipAction && textActionTouchMarginTop,
            )}
          >
            {sku}
          </div>
        ) : null}
        {actions != null ? (
          <div
            data-slot="item-cell-actions"
            className={cn(
              'mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5',
              textActionTouchMarginTop,
              textActionTouchGapY,
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
