import * as React from 'react';

import { cn } from '@/lib/utils';

import { Thumb } from './thumb';

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
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
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
            className="text-muted-foreground whitespace-nowrap font-mono text-[11.5px] leading-[17.25px]"
          >
            {sku}
          </div>
        ) : null}
      </div>
    </div>
  );
}
