import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  ClipboardCheck,
  Edit3,
  History,
  PackageMinus,
  PackagePlus,
  Plus,
  RefreshCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { reasonWithoutRefLabel } from '@stockpilot/core';

import { MetadataDiff } from '@/components/audit/metadata-diff';
import { EditableMovementNote } from '@/components/movements/editable-movement-note';
import { LocalDateTime } from '@/components/ui/local-datetime';
import { referenceHref, referenceTypeLabel } from '@/lib/activity-references';
import { formatAuditEvent } from '@/lib/audit/format';
import { cn, formatNumber, formatRelative } from '@/lib/utils';

import type { ActivityEvent } from '@/server/services/activity';

interface ActivityFeedProps {
  events: ActivityEvent[];
  /**
   * Optional location id → display name map. When provided, transfer events
   * render their route ("A → B") in the meta line. item-detail already holds
   * the org's full location list for the transfer dialog, so the map is free.
   */
  locationNames?: Record<string, string>;
  /**
   * When true, movement rows expose an add/edit-note affordance (the
   * EditableMovementNote client island). Audit rows are never editable.
   * Gated on `movements:edit_notes`; the server action + RPC re-check.
   */
  canEditNotes?: boolean;
}

interface VisualSpec {
  Icon: LucideIcon;
  label: string;
  tone: 'pos' | 'neg' | 'neutral' | 'warn';
}

function specFor(e: ActivityEvent): VisualSpec {
  if (e.kind === 'movement') {
    const delta = e.delta ?? 0;
    if (e.type === 'transfer') {
      return { Icon: ArrowRightLeft, label: 'Stock transferred', tone: 'neutral' };
    }
    if (e.type === 'cycle_count') {
      return { Icon: ClipboardCheck, label: 'Cycle count posted', tone: 'neutral' };
    }
    // NB: the receipt writer (post_receipt_v2 → adjust_stock) records
    // movement_type='receive_po' — 'receipt' was a dead branch.
    if (e.type === 'receive_po' || delta > 0) {
      return { Icon: PackagePlus, label: 'Stock received', tone: 'pos' };
    }
    if (delta < 0) {
      return { Icon: PackageMinus, label: 'Stock removed', tone: 'neg' };
    }
    return { Icon: RefreshCcw, label: 'Stock adjusted', tone: 'neutral' };
  }

  switch (e.type) {
    case 'inventory.item.created':
      return { Icon: Plus, label: 'Item created', tone: 'pos' };
    case 'inventory.item.updated':
      return { Icon: Edit3, label: 'Item edited', tone: 'neutral' };
    case 'inventory.item.archived':
      return { Icon: Archive, label: 'Item archived', tone: 'warn' };
    case 'inventory.item.restored':
      return { Icon: ArchiveRestore, label: 'Item restored', tone: 'pos' };
    case 'inventory.item.deleted':
      return { Icon: Trash2, label: 'Item deleted', tone: 'neg' };
    case 'item.tracking_type.changed':
      return { Icon: RefreshCcw, label: 'Tracking changed', tone: 'neutral' };
    default:
      // Ported from the (now-removed) item-detail AuditTimeline: every
      // audit event type gets the same "Subject · Action" formatting
      // (e.g. "Category · Updated") instead of a raw dot/underscore string,
      // for every audit event type this feed doesn't have a bespoke
      // icon/label for.
      return { Icon: History, label: formatAuditEvent(e.type), tone: 'neutral' };
  }
}

export function ActivityFeed({ events, locationNames, canEditNotes = false }: ActivityFeedProps) {
  if (events.length === 0) {
    return (
      <div className="text-muted-foreground py-10 text-center text-sm">
        No activity yet. Adjust stock, edit fields, or add an image to start the timeline.
      </div>
    );
  }

  return (
    <ol className="relative space-y-0">
      {events.map((e, i) => {
        const spec = specFor(e);
        const isLast = i === events.length - 1;
        // Transfers are net-zero on hand (delta is ALWAYS 0 — the ledger
        // must sum to quantity_on_hand), so the ±delta slot is meaningless
        // for them. Show the physical qty moved instead (moved_quantity,
        // mig 0231); pre-0231 rows have none → show no number, never "0".
        const isTransfer = e.kind === 'movement' && e.type === 'transfer';
        // From/to location context isn't transfer-only: receive_po only sets
        // to_location_id, a removal only sets from_location_id, and a
        // transfer sets both. Render whichever side(s) resolve to a name
        // rather than requiring both (which used to hide the route entirely
        // for every non-transfer movement type).
        const fromName =
          e.kind === 'movement' && e.fromLocationId
            ? locationNames?.[e.fromLocationId]
            : undefined;
        const toName =
          e.kind === 'movement' && e.toLocationId ? locationNames?.[e.toLocationId] : undefined;
        const route =
          fromName && toName
            ? `${fromName} → ${toName}`
            : toName
              ? `→ ${toName}`
              : fromName
                ? `${fromName} →`
                : null;
        // Clickable source link (order_request, cycle_count, return, bundle —
        // the only reference_types any writer sets). referenceHref returns
        // null for any reference_type it doesn't recognize — that's the
        // graceful-degrade signal to render a plain label instead of a link,
        // never a broken href. referenceLabel is the server-resolved display
        // number (order #, return #, bundle name); falls back to a generic
        // type label when there's no cheap number for the type.
        const referenceLink =
          e.kind === 'movement' ? referenceHref(e.referenceType, e.referenceId) : null;
        const referenceDisplayLabel =
          e.kind === 'movement' && e.referenceType
            ? (e.referenceLabel ?? referenceTypeLabel(e.referenceType))
            : null;
        // The reason and the reference chip are resolved from the SAME record,
        // so a pick row arrives here as reason "Order pick (SO-000060)" beside
        // a chip reading "SO-000060" — the handle printed twice on one line.
        // The chip is the linked one, so the reason gives it up.
        const reasonText = reasonWithoutRefLabel(e.reason, referenceDisplayLabel);
        return (
          <li key={e.id} className="relative flex gap-3 pl-2 pr-1">
            {!isLast && (
              <span
                aria-hidden
                className="bg-border absolute left-[19px] top-9 h-[calc(100%-1.25rem)] w-px"
              />
            )}
            <div
              className={cn(
                'relative z-10 mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full border',
                spec.tone === 'pos' && 'border-success/30 bg-success/10 text-success',
                spec.tone === 'neg' && 'border-destructive/30 bg-destructive/10 text-destructive',
                spec.tone === 'warn' && 'border-warning/30 bg-warning/10 text-warning',
                spec.tone === 'neutral' && 'border-border bg-muted text-foreground',
              )}
            >
              <spec.Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </div>

            <div className="flex-1 border-b border-border/60 pb-3 pt-1.5 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium">{spec.label}</span>
                {isTransfer ? (
                  e.movedQuantity !== null && (
                    <span className="font-mono text-xs tabular-nums">
                      {formatNumber(e.movedQuantity)}
                    </span>
                  )
                ) : (
                  e.delta !== null && (
                    <span
                      className={cn(
                        'font-mono text-xs tabular-nums',
                        e.delta > 0 && 'text-success',
                        e.delta < 0 && 'text-destructive',
                      )}
                    >
                      {e.delta > 0 ? '+' : ''}
                      {formatNumber(e.delta)}
                    </span>
                  )
                )}
                {/* ═══ WHERE IT WENT, NEXT TO HOW MUCH — owner report 2026-08-19 ═══
                    "Stock transferred 12 · 46 → 46 on hand" reads like a bug.
                    It is not: a transfer relocates stock, so on-hand is
                    unchanged BY CONSTRUCTION and the 12 is the physical amount
                    moved. The row was telling the truth while hiding the one
                    fact that explains it — the route used to sit fifth on the
                    metadata line below, behind actor, email, relative time and
                    absolute time, and ran off the side of a normal viewport.

                    The row this was reported from is the 2026-07-23 transfer
                    that put 12 units onto test rack 100-A. The destination was
                    recorded faithfully all along; a reader scanning this feed
                    would have seen books walking onto a rack that does not
                    exist, if the layout had not buried the field saying so.

                    The phone has rendered it as a labelled WHERE field since
                    the overhaul (item-history-sheet.tsx). This is web catching
                    up. Order is deliberate: what happened, how much, WHERE,
                    then what you now own. */}
                {route && (
                  <span className="text-muted-foreground text-[11px]">{route}</span>
                )}
                {e.kind === 'movement' && e.previousQuantity !== null && e.quantityAfter !== null ? (
                  <span className="text-muted-foreground text-[11px] tabular-nums">
                    {formatNumber(e.previousQuantity)} → {formatNumber(e.quantityAfter)} on hand
                  </span>
                ) : (
                  e.quantityAfter !== null && (
                    <span className="text-muted-foreground text-[11px]">
                      → {formatNumber(e.quantityAfter)} on hand
                    </span>
                  )
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 text-xs">
                <span>{e.actor}</span>
                {/* Ported from the (now-removed) item-detail AuditTimeline:
                    show the actor's email alongside their name, but only
                    when it's a real second fact (skip when the "name" IS
                    the email — e.g. a profile with no full_name set — so we
                    never render "jane@x.com (jane@x.com)"). */}
                {e.actorEmail && e.actorEmail !== e.actor && (
                  <span className="ml-1 text-[11px]">({e.actorEmail})</span>
                )}
                <span className="mx-1.5">·</span>
                {/* Relative for scanability + exact viewer-local date/time
                    always visible (owner ask 2026-07-15: every movement must
                    carry its accurate date+time, not just "2 months ago"). */}
                <time dateTime={e.createdAt}>{formatRelative(e.createdAt)}</time>
                <LocalDateTime iso={e.createdAt} prefix=" · " />
                {referenceDisplayLabel && (
                  <>
                    <span className="mx-1.5">·</span>
                    {referenceLink ? (
                      <Link
                        href={referenceLink}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        {referenceDisplayLabel}
                      </Link>
                    ) : (
                      <span>{referenceDisplayLabel}</span>
                    )}
                  </>
                )}
                {reasonText && (
                  <>
                    <span className="mx-1.5">·</span>
                    <span className="italic">{reasonText}</span>
                  </>
                )}
                {e.kind === 'movement' && canEditNotes && e.noteEditable ? (
                  <>
                    <span className="mx-1.5">·</span>
                    {/* Small client island — the ONLY editable surface on a
                        movement row. `e.id` is `m:<uuid>`; the RPC needs the
                        raw uuid. Audit rows AND system-managed 'receipt_line'
                        rows (noteEditable=false) fall through to the static
                        branch below (never editable). */}
                    <EditableMovementNote
                      variant="inline"
                      movementId={e.id.replace(/^m:/, '')}
                      note={e.notes}
                      canEdit
                    />
                  </>
                ) : (
                  e.notes && (
                    <>
                      <span className="mx-1.5">·</span>
                      <span className="italic">&ldquo;{e.notes}&rdquo;</span>
                    </>
                  )
                )}
              </div>
              {/* Before/after diff drawer + changed_keys chip — audit rows
                  only (movements carry no such metadata). Shared with
                  AuditTimeline and the global audit log page. */}
              {e.kind === 'audit' && <MetadataDiff metadata={e.metadata} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
