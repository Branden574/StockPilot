'use client';

import {
  ArrowRightLeft,
  ClipboardCheck,
  History,
  Loader2,
  PackageMinus,
  PackagePlus,
  RefreshCcw,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { LocalDateTime } from '@/components/ui/local-datetime';
import { cn, formatRelative } from '@/lib/utils';

import {
  formatHistoryMovement,
  type ItemHistoryMovement,
  type ItemHistoryPage,
} from '@stockpilot/core';

/**
 * "Where did this come from, on what date and time, and why, and who" for one
 * staging row (owner ask, 2026-07-22).
 *
 * WHY A HISTORY AND NOT A SOURCE LABEL. Two earlier attempts inferred a single
 * winning "source" per holding out of the ledger; both were confidently wrong
 * (one could erase PO attribution, the other renamed cancelled order picks as
 * customer returns and reset the staging row's age, deleting its Stale badge).
 * This dialog renders the ledger rows AS THEY ARE — there is no winner to pick,
 * so there is no rule to get wrong, and nothing here touches stagedWorklist's
 * source column or its ageDays.
 *
 * WHY IT FETCHES THE BEARER ROUTE. /api/v1/items/[id]/history calls the SAME
 * InventoryService.itemMovementHistory() the phone reads, and withApiContext
 * accepts this page's session cookie as well as a Bearer token. Going through
 * the one route is what keeps the browser and the phone telling the same story
 * — two surfaces disagreeing about where stock came from is the original
 * incident. All wording comes from the shared @stockpilot/core formatter for
 * the same reason; this file adds only icons, layout and date rendering.
 *
 * Timestamps: raw ISO from the service, rendered through <LocalDateTime> so the
 * viewer sees THEIR timezone (a server-rendered toLocaleString would print
 * Vercel's UTC). Same treatment as the item activity feed.
 */

/** One request's worth of rows. Not a guess at any server cap: the service
 *  echoes the window it used and returns an explicit `hasMore`, so paging is
 *  driven by that fact rather than by "the page came back full". */
const PAGE_SIZE = 50;

interface ItemHistoryDialogProps {
  itemId: string;
  itemName: string;
  itemSku: string;
  trigger: React.ReactNode;
}

/**
 * One inventory_items ROW sharing this SKU, as /api/v1/items/lookup returns it.
 *
 * WHY THIS EXISTS. A history is per ITEM RECORD, and under Model B one SKU is
 * legitimately several records — in the owner's org SKU SP-0WK2L-LY1 is three
 * ("Science Dimensions Earth & Space Science": 46 on hand at rack 37-B, 144 at
 * 42-B, and an archived 0 with no rack). The header used to say "Every recorded
 * movement for {name} {sku}", which is false: the owner's incident spans two of
 * those records and each dialog showed half of it with no hint the other half
 * existed. So the header now names the ONE record it is showing — by its rack,
 * which is how someone standing in the warehouse tells them apart — and the
 * the count of sibling records is disclosed, without describing them.
 *
 * The records are NOT merged. Aggregating movements across records would change
 * what every on-hand number in the list means, which is precisely the class of
 * confident wrongness that got the two earlier attempts reverted.
 */
interface SkuSibling {
  id: string;
  placementLabel: string | null;
  quantityOnHand: number;
}


/** movement_type → icon. Deliberately keyed off the recorded TYPE, never off
 *  the sign of the delta: an `add` is not a receipt, and a `correction` that
 *  reverses a receipt is not an adjustment. Unknown types fall back to the
 *  neutral clock rather than borrowing another kind's meaning. */
const MOVEMENT_ICONS: Record<string, LucideIcon> = {
  initial: ClipboardCheck,
  add: PackagePlus,
  remove: PackageMinus,
  adjust: RefreshCcw,
  correction: Undo2,
  transfer: ArrowRightLeft,
  receive_po: PackagePlus,
  cycle_count: ClipboardCheck,
  return: Undo2,
};

function iconFor(movementType: string): LucideIcon {
  return MOVEMENT_ICONS[movementType] ?? History;
}

export function ItemHistoryDialog({
  itemId,
  itemName,
  itemSku,
  trigger,
}: ItemHistoryDialogProps) {
  const [open, setOpen] = React.useState(false);
  // The record currently being READ. Starts at the row the caller clicked and
  // changes only when the reader deliberately steps to a sibling record.
  const [activeItemId, setActiveItemId] = React.useState(itemId);
  const [rows, setRows] = React.useState<ItemHistoryMovement[]>([]);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Every record sharing this SKU, or null while unknown / when the lookup
  // failed. null is NOT an empty list: with no answer the dialog says nothing
  // the sibling COUNT rather than implying this is the whole story.
  const [skuRecords, setSkuRecords] = React.useState<SkuSibling[] | null>(null);
  // The name/SKU the SERVICE reports for the record actually being read. The
  // props describe the row the caller clicked, which stops being that record
  // the moment the reader steps to a sibling — and a header naming the wrong
  // record is the defect this dialog was just fixed for.
  const [loadedIdentity, setLoadedIdentity] = React.useState<{
    name: string;
    sku: string;
  } | null>(null);
  // Set when the reader jumps from one half of a reversal pair to the other.
  const [highlightId, setHighlightId] = React.useState<string | null>(null);

  const rowRefs = React.useRef<Record<string, HTMLLIElement | null>>({});

  const load = React.useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/items/${activeItemId}/history?limit=${PAGE_SIZE}&offset=${offset}`,
        );
        if (!res.ok) {
          // Surface WHY, not a generic failure: "forbidden" and "not found"
          // mean different things to someone chasing missing stock.
          const body = (await res.json().catch(() => null)) as
            | { error?: string; message?: string }
            | null;
          setError(
            body?.message ??
              (body?.error === 'forbidden'
                ? 'You do not have access to this item’s warehouse.'
                : body?.error === 'not_found'
                  ? 'This item no longer exists.'
                  : 'Could not load history.'),
          );
          return;
        }
        const page = (await res.json()) as ItemHistoryPage;
        // Append DE-DUPLICATED by movement id, exactly as the native sheet's
        // appendHistoryMovements does. The window is newest-first and live: a
        // movement written between page 1 and page 2 shifts every later row
        // down one, so page 2 re-delivers page 1's last row. Concatenating
        // blind shows the same receipt twice — a reader reasonably concludes
        // stock arrived twice — and duplicates the React key besides.
        setRows((prev) => {
          if (offset === 0) return page.rows;
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...page.rows.filter((m) => !seen.has(m.id))];
        });
        setTotal(page.total);
        setHasMore(page.hasMore);
        if (page.itemName || page.itemSku) {
          setLoadedIdentity({ name: page.itemName, sku: page.itemSku });
        }
      } catch {
        setError('Could not load history.');
      } finally {
        setLoading(false);
      }
    },
    [activeItemId],
  );

  // Reload from the top every time the dialog opens — the reader is here
  // precisely because they distrust what the list shows, so stale cached rows
  // would be worse than a short spinner.
  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- clear the previous
       reading before refetching, same reset-on-open pattern as
       PlaceFromStagingDialog */
    setRows([]);
    setTotal(0);
    setHasMore(false);
    setHighlightId(null);
    setLoadedIdentity(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    void load(0);
  }, [open, load]);

  // Which records share this SKU. Best-effort and strictly ADDITIVE: the
  // history never waits on it, and a failure leaves `skuRecords` null so the
  // header simply says less. /api/v1/items/lookup is the existing endpoint the
  // scanner uses for exactly this question ("one code, possibly several
  // placement rows"), so no new read path is introduced.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/items/lookup?code=${encodeURIComponent(itemSku)}`);
        if (!res.ok) return;
        const body = (await res.json()) as {
          matches?: Array<{
            id: string;
            sku: string;
            placementLabel: string | null;
            quantityOnHand: number;
          }>;
        };
        if (cancelled) return;
        // lookup matches on barcode OR sku, so an item whose BARCODE happens to
        // equal this SKU would otherwise be reported as a sibling record.
        setSkuRecords(
          (body.matches ?? [])
            .filter((m) => m.sku === itemSku)
            .map((m) => ({
              id: m.id,
              placementLabel: m.placementLabel,
              quantityOnHand: m.quantityOnHand,
            })),
        );
      } catch {
        // Say nothing rather than something untrue.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, itemSku]);

  // Count only. The records are NOT navigable and NOT described — see the
  // header comment for why every available descriptor was falsifiable.
  const recordCount = (skuRecords ?? []).length;

  function handleOpenChange(next: boolean) {
    // Always reopen on the record the caller pointed at, never on whichever
    // sibling the reader wandered to last time.
    if (next) setActiveItemId(itemId);
    setOpen(next);
  }

  function jumpTo(movementId: string) {
    setHighlightId(movementId);
    // scrollIntoView is missing in some test DOMs — optional-call it rather
    // than making the jump throw.
    rowRefs.current[movementId]?.scrollIntoView?.({ block: 'center' });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Movement history</DialogTitle>
          <DialogDescription>
            {/* Deliberately makes NO claim about which record this is.
                A history is per ITEM RECORD, and under Model B a SKU can have
                several. Three attempts to name the record in human terms each
                introduced a new falsehood: bin_location is empty on records
                whose stock IS racked ("the no rack recorded record"), and two
                records can share a bin, which makes "the {rack} record" a false
                definite description. Every descriptor available here is either
                ambiguous or occasionally wrong, so this states only what is
                certain — these rows are one record's ledger — and lets the
                count speak for itself. */}
            One item record&rsquo;s movements, newest first.{' '}
            <span className="text-foreground font-medium">
              {loadedIdentity?.name || itemName}
            </span>{' '}
            <span className="font-mono text-xs">{loadedIdentity?.sku || itemSku}</span>
            {recordCount > 1 && (
              <>
                {' '}
                This SKU has{' '}
                <span className="tabular-nums">{recordCount}</span> records; the others are not
                included.
              </>
            )}
            {total > 0 && (
              <>
                {' '}
                Showing <span className="tabular-nums">{rows.length}</span> of{' '}
                <span className="tabular-nums">{total}</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        {loading && rows.length === 0 && !error && (
          <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
          </p>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className="text-muted-foreground py-6 text-sm">
            No stock movements recorded for this item yet.
          </p>
        )}

        {rows.length > 0 && (
          <ol className="relative space-y-0">
            {rows.map((row, i) => {
              const f = formatHistoryMovement(row);
              const Icon = iconFor(row.movementType);
              const isLast = i === rows.length - 1;
              const counterpartId = row.reversal?.counterpartMovementId ?? null;
              return (
                <li
                  key={row.id}
                  ref={(el) => {
                    rowRefs.current[row.id] = el;
                  }}
                  data-testid={`history-row-${row.id}`}
                  className={cn(
                    'relative flex gap-3 rounded-md pl-2 pr-1 transition-colors',
                    highlightId === row.id && 'bg-warning/10 ring-warning/40 ring-1',
                  )}
                >
                  {!isLast && (
                    <span
                      aria-hidden
                      className="bg-border absolute left-[19px] top-9 h-[calc(100%-1.25rem)] w-px"
                    />
                  )}
                  <div
                    className={cn(
                      'relative z-10 mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full border',
                      f.tone === 'pos' && 'border-success/30 bg-success/10 text-success',
                      f.tone === 'neg' &&
                        'border-destructive/30 bg-destructive/10 text-destructive',
                      f.tone === 'warn' && 'border-warning/30 bg-warning/10 text-warning',
                      f.tone === 'neutral' && 'border-border bg-muted text-foreground',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </div>

                  <div className="flex-1 border-b border-border/60 pb-3 pt-1.5 last:border-b-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{f.title}</span>
                      {f.deltaLabel && (
                        <span
                          className={cn(
                            'font-mono text-xs tabular-nums',
                            row.quantityChange > 0 && 'text-success',
                            row.quantityChange < 0 && 'text-destructive',
                          )}
                        >
                          {f.deltaLabel}
                        </span>
                      )}
                      {f.movedLabel && (
                        <span className="text-muted-foreground font-mono text-xs tabular-nums">
                          {f.movedLabel}
                        </span>
                      )}
                      <span className="text-muted-foreground text-[11px] tabular-nums">
                        {f.onHandLabel}
                      </span>
                    </div>

                    <div className="text-muted-foreground mt-0.5 text-xs">
                      {/* Rule 5: a movement with no recorded user shows no
                          person. We say the record has none rather than
                          inventing "System" as an actor. */}
                      {f.actorLabel ? (
                        <span>{f.actorLabel}</span>
                      ) : (
                        <span className="italic">No recorded user</span>
                      )}
                      {f.actorEmailLabel && (
                        <span className="ml-1 text-[11px]">({f.actorEmailLabel})</span>
                      )}
                      <span className="mx-1.5">·</span>
                      {/* Relative for scanability + the exact viewer-local
                          date and time, same as the activity feed. */}
                      <time dateTime={f.whenIso}>{formatRelative(f.whenIso)}</time>
                      <LocalDateTime iso={f.whenIso} prefix=" · " />
                      {f.routeLabel && (
                        <>
                          <span className="mx-1.5">·</span>
                          <span>{f.routeLabel}</span>
                        </>
                      )}
                    </div>

                    {f.sourceLabel && (
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        {f.sourceLabel}
                      </div>
                    )}

                    {/* The operator's own typed words. The formatter has
                        already dropped machine tokens and raw ids, so anything
                        that reaches here really was typed by a person. */}
                    {f.noteLabel && (
                      <div className="text-muted-foreground mt-0.5 text-xs italic">
                        &ldquo;{f.noteLabel}&rdquo;
                      </div>
                    )}

                    {/* Rule 3: a received-then-reversed pair nets to zero, and
                        a reader who cannot see the pairing misreads the whole
                        history. Mark both halves, and let the reader jump to
                        the other half when it is on screen. */}
                    {f.reversalLabel && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="bg-warning/10 text-warning border-warning/30 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]">
                          <Undo2 className="h-3 w-3" />
                          {f.reversalLabel}
                        </span>
                        {counterpartId && (
                          <button
                            type="button"
                            onClick={() => jumpTo(counterpartId)}
                            className="text-muted-foreground hover:text-foreground text-[11px] underline underline-offset-2"
                          >
                            Show the other half
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {hasMore && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void load(rows.length)}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load older movements'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
