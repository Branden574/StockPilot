import * as React from 'react';

import { cn } from '@/lib/utils';

import { PatternPhoto } from './photo';

/**
 * Photo-first record cards (DESIGN-SPEC 6.15 with the brief's section 8
 * overrides, CONFLICTS I9): the Items / Books Grid view and any other photo
 * grid.
 *
 * The card renders ONE record (or one group header) of the page the table
 * already holds: it reads nothing, so switching views never changes
 * selection, scope, sort, filters, totals or page membership.
 *
 * MEDIA: a fixed square (`aspect-square`) with the photo absolutely
 * positioned and `object-contain` on a white tile, so photos are never cropped
 * and a tall photo can never stretch its card (the reference's defect). No
 * photo, or a photo that fails, shows the hatch. Pass the small rendition the
 * row already carries (`imageSrc`), never a master; or pass `media` to use
 * the caller's own image element.
 *
 * SLOTS on the media: `checkbox` top-left in a 28 px chip (the record's own
 * checkbox with the table's row key; it is a sibling of the name link, never
 * inside it), shown on hover or focus, always while `selected` or
 * `selectionActive`, and always on touch; `badge` top-right (the size
 * badge); `status` bottom-left (the stock status pill).
 *
 * BODY: the name (its detail link) clamped to two lines, the mono SKU, an
 * optional meta line, the labelled quantity ("142 on hand") with the
 * placement (warehouse and rack) opposite, optional quantity notes ("12
 * awaiting put-away"), and a footer (the coverage bar, a group card's
 * drill-down).
 *
 * `stretchLink` (default on) widens the name link's click area to the whole
 * card, as the reference's card opens the record; the checkbox, badge and
 * footer stay separate targets above it. Turn it off when the media carries
 * its own interaction (a hover preview).
 */

export interface GridCardQuantity {
  value: React.ReactNode;
  /** The words after the figure; "on hand" unless the page says otherwise. */
  label?: React.ReactNode;
}

export interface GridCardProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  name: React.ReactNode;
  sku?: React.ReactNode;
  meta?: React.ReactNode;
  media?: React.ReactNode;
  imageSrc?: string | null;
  imageAlt?: string;
  checkbox?: React.ReactNode;
  status?: React.ReactNode;
  badge?: React.ReactNode;
  quantity?: GridCardQuantity;
  quantityNote?: React.ReactNode;
  placement?: React.ReactNode;
  footer?: React.ReactNode;
  selected?: boolean;
  selectionActive?: boolean;
  stretchLink?: boolean;
}

export function GridCard({
  name,
  sku,
  meta,
  media,
  imageSrc,
  imageAlt = '',
  checkbox,
  status,
  badge,
  quantity,
  quantityNote,
  placement,
  footer,
  selected = false,
  selectionActive = false,
  stretchLink = true,
  className,
  ...props
}: GridCardProps) {
  return (
    <div
      data-slot="grid-card"
      data-selected={selected ? '' : undefined}
      className={cn(
        'group/card border-border bg-background relative isolate flex h-full min-w-0 flex-col overflow-hidden rounded-lg border transition-colors focus-within:border-[var(--ed-ink-4)] hover:border-[var(--ed-ink-4)]',
        selected &&
          'border-accent ring-accent focus-within:border-accent hover:border-accent ring-1',
        className,
      )}
      {...props}
    >
      <div
        data-slot="grid-card-media"
        className="border-border relative aspect-square w-full shrink-0 overflow-hidden border-b bg-white"
      >
        {media ?? <PatternPhoto src={imageSrc} alt={imageAlt} fit="contain" />}
        {checkbox != null ? (
          <div
            data-slot="grid-card-checkbox"
            className={cn(
              'border-border bg-card absolute left-2 top-2 z-10 grid size-7 place-items-center rounded-md border transition-opacity',
              selected || selectionActive
                ? 'opacity-100'
                : 'pointer-coarse:opacity-100 opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100',
            )}
          >
            {checkbox}
          </div>
        ) : null}
        {badge != null ? (
          <div
            data-slot="grid-card-badge"
            className="pointer-events-none absolute right-2 top-2 z-10"
          >
            {badge}
          </div>
        ) : null}
        {status != null ? (
          <div
            data-slot="grid-card-status"
            className="pointer-events-none absolute bottom-2 left-2 z-10"
          >
            {status}
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-3">
        <div className="min-w-0">
          <div
            data-slot="grid-card-name"
            className={cn(
              'text-foreground line-clamp-2 min-h-[2.7em] text-[13.5px] font-medium leading-[1.35] [overflow-wrap:anywhere]',
              stretchLink && "[&_a]:after:absolute [&_a]:after:inset-0 [&_a]:after:content-['']",
            )}
          >
            {name}
          </div>
          {sku != null ? (
            <div className="text-muted-foreground mt-0.5 truncate font-mono text-[11.5px] leading-[17.25px]">
              {sku}
            </div>
          ) : null}
          {meta != null ? (
            <div className="text-muted-foreground mt-0.5 truncate text-[12px] leading-[18px]">
              {meta}
            </div>
          ) : null}
        </div>
        {quantity != null || placement != null ? (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            {quantity != null ? (
              <div data-slot="grid-card-quantity" className="flex min-w-0 items-baseline gap-1">
                <span className="text-foreground text-[20px] font-medium tabular-nums leading-[30px] [font-family:var(--font-display)]">
                  {quantity.value}
                </span>
                <span className="text-muted-foreground text-[12px]">
                  {quantity.label ?? 'on hand'}
                </span>
              </div>
            ) : (
              <span />
            )}
            {placement != null ? (
              <div
                data-slot="grid-card-placement"
                className="text-muted-foreground min-w-0 truncate whitespace-nowrap font-mono text-[11.5px]"
              >
                {placement}
              </div>
            ) : null}
          </div>
        ) : null}
        {quantityNote != null ? (
          <div className="text-muted-foreground -mt-1.5 text-[11px] leading-4">{quantityNote}</div>
        ) : null}
        {footer != null ? <div className="relative z-10 mt-auto">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * The grid the cards sit in: auto-fill columns of at least 210 px with a 12 px
 * gap (5 at 1440, 4 at 1280, 3 at 1024, 2 at 768), and two columns on a phone
 * so a photo never fills the whole screen. A list (`ul` with role="list", so
 * Safari keeps announcing it); wrap each card in a `CardGridItem`.
 */
export function CardGrid({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      role="list"
      data-slot="card-grid"
      className={cn(
        'grid grid-cols-[repeat(auto-fill,minmax(min(100%,210px),1fr))] gap-3 max-sm:grid-cols-2 max-sm:gap-2',
        className,
      )}
      {...props}
    />
  );
}

export function CardGridItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="card-grid-item" className={cn('min-w-0', className)} {...props} />;
}
