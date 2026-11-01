import { ChevronRight } from 'lucide-react';
import * as React from 'react';

import { CardGrid, CardGridItem, GridCard } from '@/components/patterns/grid-card';
import { textActionTouchGapY } from '@/components/patterns/touch-target';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The Items, Books and Rentals items photo Grid (redesign P3.2, DESIGN-SPEC
 * 6.15 with CONFLICTS I9 and the PLAN's "Grid card content, per list").
 *
 * A SECOND LOOK AT THE SAME PAGE, NEVER A SECOND LIST. InventoryTable renders
 * this in place of its <table>, from the SAME page entries it would draw as
 * rows, with the SAME selection Set and row keys: switching views changes no
 * selection, scope, sort, filter, total or page membership. Nothing here reads
 * data or keeps state. The table computes every word, figure and control a
 * card shows with the very helpers its cells use and hands them over as
 * finished nodes, so a card can never show a figure its row does not have.
 *
 * Group cards (a size run, a SKU family, a named group) carry their header
 * row's labels and roll-ups, have no checkbox (headers are not selectable, as
 * in the table) and drill down INLINE: their records open as cards in a panel
 * right after the group card, inside the same page, so drilling down cannot
 * change what is on the page.
 *
 * The card body is inert, as a table row is: only the checkbox toggles and
 * only the name navigates (CONFLICTS I8).
 *
 * This module carries no 'use client' directive and no hooks, so the list
 * pages (server components) can import the view preference helpers below to
 * read the cookie for the first paint. The grid itself is only ever rendered
 * by InventoryTable, a client component.
 */

// ── The Table / Grid preference ────────────────────────────────────────────
// A cookie per list, read by the list's server page so the first paint is
// already the viewer's view (no table-then-grid swap, no second image wave)
// and no database read. Values: 'table' | 'grid'. Absent or unknown: Table.

export type InventoryView = 'table' | 'grid';

export const INVENTORY_VIEW_COOKIES = {
  items: 'sp_view_items',
  books: 'sp_view_books',
  rentalItems: 'sp_view_rental_items',
} as const;

/** One year, like the shell's other per-viewer preference cookies. */
const ONE_YEAR = 31536000;

/** The stored choice. Grid only for exactly "grid"; anything else is Table. */
export function parseInventoryView(value: string | null | undefined): InventoryView {
  return value === 'grid' ? 'grid' : 'table';
}

/** The cookie that holds the choice for the list at `basePath`. */
export function inventoryViewCookieFor(basePath: string): string {
  if (basePath === '/dashboard/books' || basePath.startsWith('/dashboard/books/')) {
    return INVENTORY_VIEW_COOKIES.books;
  }
  if (basePath === '/dashboard/rentals' || basePath.startsWith('/dashboard/rentals/')) {
    return INVENTORY_VIEW_COOKIES.rentalItems;
  }
  return INVENTORY_VIEW_COOKIES.items;
}

/** `document.cookie` string that keeps the choice for a year. */
export function inventoryViewCookieString(name: string, view: InventoryView): string {
  return `${name}=${view}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

// ── Card models ────────────────────────────────────────────────────────────

/** One record's card: the row's own checkbox, link, figures and lines. */
export interface GridRecordCard {
  kind: 'record';
  /** The row key (`rowKey ?? id`): the same identity the table's checkbox uses. */
  key: string;
  selected: boolean;
  /** The record's own Checkbox, the same row key as its table row's. */
  checkbox: React.ReactNode;
  /** The photo (or null for the missing-photo hatch). */
  media: React.ReactNode;
  /** The name link: the card's only link. */
  name: React.ReactNode;
  sku?: React.ReactNode;
  /** One line: the category (or the size of a size-run member) and the charter. */
  meta?: React.ReactNode;
  /** A group chip ("In group X", "Same SKU as records in X" with its action). */
  chip?: React.ReactNode;
  status?: React.ReactNode;
  /** The on-hand figure, as the On hand cell prints it. */
  quantity: React.ReactNode;
  /** The On hand cell's sub-lines (placed / awaiting put-away, avail / out). */
  quantityNotes?: React.ReactNode;
  /** The Location cell, opposite the quantity. */
  location?: React.ReactNode;
  /** Labelled facts under the figures: the Rack column (Books: Grade, Rack, Crate). */
  facts?: ReadonlyArray<{ label: string; value: React.ReactNode }>;
  /** The coverage bar. */
  coverage?: React.ReactNode;
  /** A size-run badge on the media corner. */
  badge?: React.ReactNode;
}

/** A header row's card: its labels and roll-ups, and an inline drill-down. */
export interface GridGroupCard {
  kind: 'group';
  key: string;
  media: React.ReactNode;
  name: React.ReactNode;
  sku?: React.ReactNode;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  status?: React.ReactNode;
  quantity: React.ReactNode;
  location?: React.ReactNode;
  facts?: ReadonlyArray<{ label: string; value: React.ReactNode }>;
  /** Rename and Remove on a named group, with the header's own gates. */
  actions?: React.ReactNode;
  coverage?: React.ReactNode;
  expanded: boolean;
  /** The header chevron's own accessible name ("Expand X (8 sizes)"). */
  toggleLabel: string;
  /** Names the drill-down's panel of records ("X (8 sizes)"). */
  panelLabel: string;
  /** The words the drill-down shows: the count in that name ("8 sizes"). */
  toggleText: string;
  onToggle: () => void;
  /** The records it opens to (only while expanded). */
  members: GridRecordCard[];
}

export type GridEntry = GridRecordCard | GridGroupCard;

export interface InventoryGridProps {
  entries: readonly GridEntry[];
  /** The page select-all box (the table's header box is not on screen here). */
  selectAll: React.ReactNode;
  /** Any record is ticked: every card shows its checkbox. */
  selectionActive: boolean;
  /** What shows when the page has no records. */
  empty: React.ReactNode;
  /** For the drill-down panels' ids (one grid per table). */
  idPrefix: string;
}

export function InventoryGrid({
  entries,
  selectAll,
  selectionActive,
  empty,
  idPrefix,
}: InventoryGridProps) {
  return (
    <div data-slot="inventory-grid">
      {/* Above the grid, where the table has its header row: the page
          select-all, with the same page-scoped rule as the header box. */}
      <div className="border-border flex min-h-[37px] items-center border-b px-4 py-1.5">
        {selectAll}
      </div>
      {entries.length === 0 ? (
        empty
      ) : (
        <CardGrid className="p-4 max-sm:p-3">
          {entries.map((entry) =>
            entry.kind === 'record' ? (
              <CardGridItem key={entry.key}>
                <RecordCard card={entry} selectionActive={selectionActive} />
              </CardGridItem>
            ) : (
              <GroupCardItems
                key={entry.key}
                card={entry}
                selectionActive={selectionActive}
                panelId={`${idPrefix}-${entry.key}`}
              />
            ),
          )}
        </CardGrid>
      )}
    </div>
  );
}

/** Labelled facts under a card's figures, one per line ("Rack  1-C"). */
function FactList({ facts }: { facts?: ReadonlyArray<{ label: string; value: React.ReactNode }> }) {
  if (!facts || facts.length === 0) return null;
  return (
    <dl className="flex flex-col gap-0.5 text-[12px] leading-[18px]">
      {facts.map((f) => (
        <div key={f.label} className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="text-muted-foreground shrink-0">{f.label}</dt>
          <dd className="min-w-0 text-right text-[var(--ed-ink-2)] [overflow-wrap:anywhere]">
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RecordCard({ card, selectionActive }: { card: GridRecordCard; selectionActive: boolean }) {
  const footer =
    card.chip || card.facts?.length || card.coverage ? (
      <div className="flex flex-col gap-2">
        {card.chip ? <div className="min-w-0 text-[11px]">{card.chip}</div> : null}
        <FactList facts={card.facts} />
        {card.coverage ? <div className="flex items-center">{card.coverage}</div> : null}
      </div>
    ) : undefined;
  return (
    <GridCard
      data-row-key={card.key}
      data-card-kind="record"
      name={card.name}
      sku={card.sku}
      meta={card.meta}
      media={card.media}
      checkbox={card.checkbox}
      status={card.status}
      badge={card.badge}
      quantity={{ value: card.quantity }}
      quantityNote={card.quantityNotes}
      placement={card.location}
      footer={footer}
      selected={card.selected}
      selectionActive={selectionActive}
      stretchLink={false}
    />
  );
}

function GroupCardItems({
  card,
  selectionActive,
  panelId,
}: {
  card: GridGroupCard;
  selectionActive: boolean;
  panelId: string;
}) {
  return (
    <>
      <CardGridItem>
        <GridCard
          data-card-kind="group"
          data-group-key={card.key}
          name={card.name}
          sku={card.sku}
          meta={card.meta}
          media={card.media}
          status={card.status}
          badge={card.badge}
          quantity={{ value: card.quantity }}
          placement={card.location}
          stretchLink={false}
          className="bg-sunk"
          footer={
            <div className="flex flex-col gap-2">
              {/* Rename and Remove, 18 px text actions with the shared 44 px
                  touch target: where it is on (below sm, a coarse pointer)
                  wrapped actions keep 14 px between them, so neither target
                  lies over the other action (W8: at 390 px a tap on Rename
                  landed on Remove). A fine pointer keeps the 4 px. */}
              {card.actions ? (
                <div
                  data-slot="grid-card-actions"
                  className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', textActionTouchGapY)}
                >
                  {card.actions}
                </div>
              ) : null}
              <FactList facts={card.facts} />
              {card.coverage ? <div className="flex items-center">{card.coverage}</div> : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={card.onToggle}
                aria-expanded={card.expanded}
                aria-controls={card.expanded ? panelId : undefined}
                aria-label={card.toggleLabel}
                className="w-full justify-start gap-1.5"
              >
                <ChevronRight
                  aria-hidden
                  className={cn('transition-transform', card.expanded && 'rotate-90')}
                />
                <span className="min-w-0 truncate">{card.toggleText}</span>
              </Button>
            </div>
          }
        />
      </CardGridItem>
      {card.expanded ? (
        <CardGridItem className="col-span-full">
          <div
            id={panelId}
            role="group"
            aria-label={card.panelLabel}
            data-slot="inventory-grid-members"
            className="border-border bg-sunk rounded-lg border p-3"
          >
            {card.members.length > 0 ? (
              <CardGrid>
                {card.members.map((m) => (
                  <CardGridItem key={m.key}>
                    <RecordCard card={m} selectionActive={selectionActive} />
                  </CardGridItem>
                ))}
              </CardGrid>
            ) : null}
          </div>
        </CardGridItem>
      ) : null}
    </>
  );
}
