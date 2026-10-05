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

import { chipActionClass } from '@/components/patterns/chip';
import { StatePanel } from '@/components/patterns/state-panel';
import {
  DeltaText,
  Timeline,
  TimelineEntry,
  type TimelineTone,
} from '@/components/patterns/timeline';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn, formatRelative } from '@/lib/utils';

import {
  formatHistoryMovement,
  formatMovementWhen,
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
 * Timestamps: raw ISO from the service, printed in the ORGANIZATION's time zone
 * (core formatMovementWhen; owner decision Q1, 2026-10-05, L7), the same words
 * as the phone's item history sheet. They used to print in the viewer's zone
 * (<LocalDateTime>). The page hands the zone in; the rows arrive after a
 * client-side fetch, so there is no server render to disagree with.
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
  /**
   * The organization's time zone (`organizations.timezone`), read by the page.
   * Absent or null (a read that failed) prints core's documented default zone,
   * never the viewer's.
   */
  timeZone?: string | null;
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

/** The formatter's tone → the timeline marker's tone. */
const TONE: Record<ReturnType<typeof formatHistoryMovement>['tone'], TimelineTone> = {
  pos: 'accent',
  neg: 'destructive',
  warn: 'warning',
  neutral: 'neutral',
};

function iconFor(movementType: string): LucideIcon {
  return MOVEMENT_ICONS[movementType] ?? History;
}

export function ItemHistoryDialog({
  itemId,
  itemName,
  itemSku,
  trigger,
  timeZone,
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
            <span className="font-mono text-[12px]">{loadedIdentity?.sku || itemSku}</span>
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
          <p
            role="alert"
            className="bg-destructive-wash text-destructive rounded-md px-3 py-2 text-[13px]"
          >
            {error}
          </p>
        )}

        {loading && rows.length === 0 && !error && (
          <p className="text-muted-foreground flex items-center gap-2 py-6 text-[13px]">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Loading history…
          </p>
        )}

        {!loading && !error && rows.length === 0 && (
          <StatePanel
            kind="empty"
            surface="plain"
            size="sm"
            icon={History}
            headingLevel={null}
            title="No stock movements recorded for this item yet."
          />
        )}

        {rows.length > 0 && (
          // The ledger as a rail timeline (DESIGN-SPEC 6.16, matrix W-BK-06c):
          // an icon in a tone circle per movement, joined by a hairline.
          <Timeline className="-mx-1 px-1">
            {rows.map((row) => {
              const f = formatHistoryMovement(row);
              const when = formatMovementWhen(f.whenIso, timeZone);
              const Icon = iconFor(row.movementType);
              const counterpartId = row.reversal?.counterpartMovementId ?? null;
              return (
                <TimelineEntry
                  key={row.id}
                  ref={(el: HTMLLIElement | null) => {
                    rowRefs.current[row.id] = el;
                  }}
                  data-testid={`history-row-${row.id}`}
                  tone={TONE[f.tone]}
                  icon={<Icon strokeWidth={1.75} />}
                  className={cn(
                    'rounded-md transition-colors',
                    highlightId === row.id && 'bg-warning-wash ring-warning/40 ring-1',
                  )}
                  title={
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{f.title}</span>
                      {f.deltaLabel && (
                        <DeltaText
                          value={row.quantityChange}
                          negativeTone="destructive"
                          className="text-[12.5px]"
                        >
                          {f.deltaLabel}
                        </DeltaText>
                      )}
                      {f.movedLabel && (
                        <span className="text-muted-foreground font-mono text-[12px] tabular-nums">
                          {f.movedLabel}
                        </span>
                      )}
                      <span className="text-muted-foreground text-[12px] tabular-nums">
                        {f.onHandLabel}
                      </span>
                    </span>
                  }
                  meta={
                    <>
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
                      <span aria-hidden className="mx-1.5">
                        ·
                      </span>
                      {/* Relative for scanability + the exact date and time
                          in the organization's zone (L7), the phone's words. */}
                      <time dateTime={f.whenIso}>{formatRelative(f.whenIso)}</time>
                      {when && <span>{` · ${when}`}</span>}
                      {f.routeLabel && (
                        <>
                          <span aria-hidden className="mx-1.5">
                            ·
                          </span>
                          <span>{f.routeLabel}</span>
                        </>
                      )}
                    </>
                  }
                >
                  {f.sourceLabel && (
                    <div className="text-muted-foreground text-[12px] leading-[18px]">
                      {f.sourceLabel}
                    </div>
                  )}

                  {/* The operator's own typed words. The formatter has
                      already dropped machine tokens and raw ids, so anything
                      that reaches here really was typed by a person. */}
                  {f.noteLabel && (
                    <div className="text-ink-2 mt-0.5 text-[12px] italic leading-[18px]">
                      &ldquo;{f.noteLabel}&rdquo;
                    </div>
                  )}

                  {/* Rule 3: a received-then-reversed pair nets to zero, and
                      a reader who cannot see the pairing misreads the whole
                      history. Mark both halves, and let the reader jump to
                      the other half when it is on screen. */}
                  {f.reversalLabel && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="bg-warning-wash text-warning inline-flex items-center gap-1 rounded-full px-2 py-px text-[11px] leading-[16.5px]">
                        <Undo2 aria-hidden className="h-3 w-3" />
                        {f.reversalLabel}
                      </span>
                      {counterpartId && (
                        <button
                          type="button"
                          onClick={() => jumpTo(counterpartId)}
                          className={chipActionClass}
                        >
                          Show the other half
                        </button>
                      )}
                    </div>
                  )}
                </TimelineEntry>
              );
            })}
          </Timeline>
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
