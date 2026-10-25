import * as React from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  movementTypeLabel,
  movementTypeTone,
  type MovementTypeTone,
} from '@/lib/movements/movement-type';
import { cn, formatNumber, formatRelative } from '@/lib/utils';

import { EditableMovementNote } from './editable-movement-note';

/**
 * A type's words and tone live in lib/movements/movement-type.ts, which imports
 * no component, so the Overview reads them there without this table's client
 * island (the note editor). Re-exported for the table's callers and tests.
 */
export {
  movementTypeLabel,
  MOVEMENT_TYPE_TONE,
  movementTypeTone,
  type MovementTypeTone,
} from '@/lib/movements/movement-type';

/** One ledger row as the Movements table prints it, in either page mode. */
export interface MovementDisplayRow {
  id: string;
  movementType: string;
  quantityChange: number;
  newQuantity: number;
  movedQuantity: number | null;
  /** Read-only "why" (stock_movements.reason), shown as the note fallback. */
  reason: string | null;
  /** Where that reason points (an order), or null for "plain text". */
  reasonHref: string | null;
  /** Editable free-text note (stock_movements.notes). null when unset. */
  note: string | null;
  /**
   * Per-row gate: false for pre-0231 'receipt_line' rows whose note is a
   * system-managed machine reference (the RPC rejects editing it). Combined
   * with the table-wide `canEditNotes` permission to decide the affordance.
   */
  noteEditable: boolean;
  createdAt: string;
  /**
   * When it happened, in the ORGANIZATION's time zone ("Oct 4, 2026,
   * 10:30 PM"; L7, owner decision Q1). Formatted ONCE by the server page
   * (core formatMovementWhen, in toDisplayRow) and handed in as text, so the
   * server render and the browser cannot disagree. null when createdAt is not
   * a date: nothing is printed then.
   */
  createdAtLabel: string | null;
  itemName: string | null;
  itemSku: string | null;
  actorLabel: string;
  actorEmail: string | null;
}

/**
 * The id the Movements page puts on its h1: the page title names the ledger
 * table's scroll region in both page modes.
 */
export const MOVEMENTS_TITLE_ID = 'movements-title';

/** Each tone's text colour on this table (--success is the accent). */
const TYPE_TONE: Record<MovementTypeTone, string> = {
  accent: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-ink-2',
};

export function MovementTypeLabel({ type }: { type: string }) {
  return (
    <span
      data-movement-type={type}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap font-medium',
        TYPE_TONE[movementTypeTone(type)],
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      {movementTypeLabel(type)}
    </span>
  );
}

/**
 * The Movements ledger table (DESIGN-SPEC 6.9 and 7.8): When, Item, Type, Δ,
 * After, By, Note, in a hairline card that scrolls sideways inside itself on
 * a narrow screen, with the pager as the card's footer.
 *
 * One table for both page modes. The server-paged ledger (page.tsx) renders it
 * on the server and the instant ledger (MovementsInstantTable) in the browser,
 * so the two can no longer print the same row differently: the server copy had
 * kept the old type-keyed amount rule and printed "—" for every order pick.
 * No hooks here, so it renders in either; the note cell is its own client
 * island (EditableMovementNote).
 */
export function MovementsTable({
  rows,
  canEditNotes = false,
  footer,
}: {
  rows: MovementDisplayRow[];
  /** Managers+/granted users get the add/edit-note affordance on each row. */
  canEditNotes?: boolean;
  /** The bottom pager, drawn as the card's footer. */
  footer?: React.ReactNode;
}) {
  return (
    <div className="border-border bg-card overflow-hidden rounded-lg border">
      <Table scrollLabelledBy={MOVEMENTS_TITLE_ID} className="min-w-[860px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>When</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Δ</TableHead>
            <TableHead className="text-right">After</TableHead>
            <TableHead>By</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => {
            // Amount rule, mirroring packages/core movement-history.ts
            // formatHistoryMovement: show the signed delta whenever there IS
            // one, otherwise the physical moved qty, otherwise nothing.
            // Deliberately NOT keyed off movementType === 'transfer'.
            // adjust_stock writes an order pick (0306 complete_picking) and a
            // manager reopen-reversal (0289) as movement_type='transfer' with
            // a real signed quantity_change and NO moved_quantity; only
            // transfer_stock (0231/0327) stamps moved_quantity. A type-keyed
            // cell rendered '—' for every pick while the After column visibly
            // dropped, hiding units leaving the building on an audit surface.
            const change = m.quantityChange;
            const hasDelta = change !== 0;
            const moved = m.movedQuantity;
            return (
              <TableRow key={m.id}>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  <div suppressHydrationWarning className="text-[12.5px] leading-[18.75px]">
                    {formatRelative(m.createdAt)}
                  </div>
                  {/* The exact date and time in the organization's zone (L7),
                      server-made text: it used to be <LocalDateTime>, the
                      viewer's zone. */}
                  {m.createdAtLabel ? (
                    <span className="block text-[12px] leading-[18px]">{m.createdAtLabel}</span>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-[180px]">
                  <div className="text-foreground font-medium">{m.itemName ?? '—'}</div>
                  {m.itemSku ? (
                    <div className="text-muted-foreground font-mono text-[11.5px] leading-[17.25px]">
                      {m.itemSku}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <MovementTypeLabel type={m.movementType} />
                </TableCell>
                <TableCell
                  className={cn(
                    'whitespace-nowrap text-right font-mono text-[13.5px] font-medium tabular-nums',
                    // Colour follows the DELTA, so a pick reads red and a
                    // reopen reads green; a net-zero location move keeps the
                    // neutral tone it has always had.
                    hasDelta
                      ? change > 0
                        ? 'text-success'
                        : 'text-destructive'
                      : moved != null
                        ? 'text-foreground'
                        : 'text-muted-foreground',
                  )}
                >
                  {hasDelta ? (
                    <>
                      {change > 0 ? '+' : ''}
                      {formatNumber(change)}
                    </>
                  ) : moved != null ? (
                    formatNumber(moved)
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-ink-2 whitespace-nowrap text-right font-mono text-[13px] tabular-nums">
                  {formatNumber(m.newQuantity)}
                </TableCell>
                <TableCell className="min-w-[140px]">
                  <div className="text-foreground">{m.actorLabel}</div>
                  {m.actorEmail ? (
                    <div className="text-muted-foreground text-[12px] leading-[18px]">
                      {m.actorEmail}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-ink-2 min-w-[200px] max-w-[360px] text-[13px] leading-[19.5px]">
                  <EditableMovementNote
                    movementId={m.id}
                    note={m.note}
                    reason={m.reason}
                    reasonHref={m.reasonHref}
                    // receipt_line rows are system-managed (RPC rejects the
                    // edit): read-only regardless of the caller's perm.
                    canEdit={canEditNotes && m.noteEditable}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {/* The pagination footer (DESIGN-SPEC 6.9): the range on the left, the
          pager on the right (kept right when there is no range to print). */}
      {footer ? (
        <div
          data-slot="movements-table-footer"
          className="border-border border-t px-4 py-2.5 [&>*:last-child>:last-child]:ml-auto [&>*]:w-full [&>*]:flex-wrap [&>*]:justify-between"
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
