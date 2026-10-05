'use client';

import { Loader2, PackageCheck, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUnsavedWork } from '@/lib/unsaved-work';
import { cn } from '@/lib/utils';
import { postReceiptAction } from '@/server/actions/receiving';
import { startReceivingCheckAction } from '@/server/actions/receiving-checklist';

import { RECEIVING_CHECKLIST_COPY } from '@stockpilot/core';

import {
  SizeRunReceiveGrid,
  splitIntoRuns,
  varianceToneClass,
  type SizeRunGroup,
} from './size-run-receive-grid';

interface Line {
  id: string;
  name: string;
  sku: string;
  quantityOrdered: number;
  quantityReceived: number;
  trackingType: 'none' | 'lot' | 'serial' | 'serial_optional';
  /**
   * Sports variant identity (0298). NULL on every line in every non-sports
   * org, which is what keeps the flat renderer below the default path.
   */
  groupId?: string | null;
  variantSize?: string | null;
}

/** Both serial modes render the capture grid. */
function wantsSerials(t: Line['trackingType']): boolean {
  return t === 'serial' || t === 'serial_optional';
}

/** Only 'serial' demands one serial per accepted unit. */
function serialsRequired(t: Line['trackingType']): boolean {
  return t === 'serial';
}

interface PoReceiveDialogProps {
  poId: string;
  poNumber: string;
  warehouseId: string;
  lines: Line[];
  /**
   * Display metadata for the product groups this PO's lines belong to, keyed
   * by group id. Empty (the default) for every non-sports org — with no
   * groups every line renders exactly as it does today.
   */
  groups?: Record<string, SizeRunGroup>;
  /**
   * The live receiving checklist (F4-1), or null when none is turned on (or
   * its state did not load). With it AND `canRecordChecklist`, a successful
   * post shows the Posted panel with "Record checklist"; otherwise the post
   * closes the dialog with a toast exactly as before.
   */
  checklist?: { versionNumber: number; title: string } | null;
  /** core receivingGate().canRecordChecklist for this person. */
  canRecordChecklist?: boolean;
  /**
   * Whether the purchase order can take a receipt now (the page's
   * canReceive). The page keeps this dialog mounted for a poster even when it
   * cannot (desk check F1): the post that completes a PO refreshes the page
   * as 'received', and the Posted panel must stay until Done or Record
   * checklist. Without it there is no Receive items button, and an open
   * dialog stays open until it is closed.
   */
  receivable?: boolean;
}

interface LotRow {
  lotNumber: string;
  expirationDate: string; // YYYY-MM-DD or ''
  qtyBase: number;
}

interface LineEntry {
  received: number;
  accepted: number;
  rejected: number;
  notes: string;
  /** For lot-tracked items: one row per lot. */
  lots: LotRow[];
  /** For serial-tracked items: one entry per accepted unit. */
  serials: string[];
}

function blankEntry(): LineEntry {
  // Start blank (0 → rendered empty by BlankZeroNumberInput) so the user types
  // what actually arrived rather than clearing a pre-filled quantity. The "All"
  // button fills the full remaining for a complete delivery.
  return {
    received: 0,
    accepted: 0,
    rejected: 0,
    notes: '',
    lots: [],
    serials: [],
  };
}

export function PoReceiveDialog({
  poId,
  poNumber,
  warehouseId,
  lines,
  groups = {},
  checklist = null,
  canRecordChecklist = false,
  receivable = true,
}: PoReceiveDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  /**
   * The receipt this dialog just posted, when the Posted panel is showing
   * (F4-1). Set only when a checklist is live and the person may record it.
   * The receipt is posted and saved by then: nothing in the panel can undo
   * or change it.
   */
  const [posted, setPosted] = React.useState<{ receiptId: string; receiptNumber: string } | null>(
    null,
  );
  const [starting, setStarting] = React.useState(false);
  /** The inline failure of "Record checklist" (pattern #20). */
  const [startError, setStartError] = React.useState<string | null>(null);
  /**
   * Persistent, in-dialog failure message (recurring pattern #20).
   *
   * A Sonner toast renders bottom-right OUTSIDE this modal and auto-dismisses
   * in ~4s, so a receiver watching the form saw "clicked, nothing happened"
   * when `post_receipt_v2` refused the receipt (0296 raises po_already_closed,
   * forbidden — the RPC requires manager — idempotency_conflict, not_found,
   * negative_quantity). The dialog stays open on failure, unchanged, with the
   * button re-enabled, so the two things they could do next were both wrong:
   * click again, or close the dialog believing 40 lines of stock had landed.
   * Every failure branch now ALSO writes here, and it is cleared the moment
   * the next attempt starts so a stale message can never describe an
   * in-flight retry. Same shape as stock-transfer-dialog.tsx.
   */
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<Record<string, LineEntry>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, blankEntry()])),
  );
  // Ties each field's visible label to its control ("Received now", Notes):
  // the labels named nothing, so a screen reader announced bare spin buttons.
  const fieldId = React.useId();

  // UNSAVED WORK. Typed receipt quantities, lots and serials are a physical
  // count someone just did at a dock, and they live only in this component's
  // memory until the receipt posts. "Refresh to update" must ask before it
  // reloads over them. Dirty = the dialog is open and anything differs from a
  // blank entry, or a post is in flight (a reload mid-post would hide whether
  // the stock landed).
  useUnsavedWork('po-receive', `Receiving ${poNumber}`, () => {
    if (!open) return false;
    // Posted: the quantities are saved in the receipt, so a reload loses
    // nothing (F4-1's Posted panel).
    if (posted) return false;
    if (submitting || notes.trim().length > 0) return true;
    const blank = JSON.stringify(blankEntry());
    return Object.values(entries).some((e) => JSON.stringify(e) !== blank);
  });

  // Idempotency key: one per dialog open. New key when re-opening (resets state).
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());

  // Latest `lines` without making it an effect dependency — see the reset
  // effect below for why its identity must not trigger a reset.
  const linesRef = React.useRef(lines);
  React.useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  // Reset ONLY on the open transition.
  //
  // `lines` used to be in the deps, and it is a fresh array on every render of
  // the Server Component that owns it (purchase-orders/[id]/page.tsx rebuilds
  // it with .map on each RSC pass). Any router.refresh() — the realtime nudge
  // fires one whenever anybody touches the PO — therefore changed the dep
  // identity WHILE the dialog was open and blanked every quantity the receiver
  // had typed, plus the notes, plus the idempotency key. A receiver working
  // through a 40-line delivery lost the lot with no warning.
  //
  // Entry lookup already falls back to blankEntry() for any line id absent
  // from the map, so a line ADDED while the dialog is open still renders and
  // submits correctly without this effect re-running.
  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setIdempotencyKey(crypto.randomUUID());
      setEntries(Object.fromEntries(linesRef.current.map((l) => [l.id, blankEntry()])));
      setNotes('');
      setServerError(null);
      setPosted(null);
      setStartError(null);
      setStarting(false);
    }
    // `lines` is deliberately NOT a dependency — see the comment above; it is
    // read through linesRef so a new array identity from an RSC refresh cannot
    // wipe in-progress entry.
  }, [open]);

  function setField(lineId: string, patch: Partial<LineEntry>) {
    setEntries((m) => ({
      ...m,
      [lineId]: { ...(m[lineId] ?? blankEntry()), ...patch },
    }));
  }

  /**
   * Every refusal goes through here: the toast (unchanged, it is what a user
   * who has already looked away notices) PLUS the inline alert that stays put
   * inside the dialog the receiver is actually looking at.
   */
  function fail(message: string) {
    setServerError(message);
    toast.error(message);
  }

  async function submit() {
    // Clear the previous attempt's message up front — an error left on screen
    // while a retry is in flight cannot be told apart from a fresh one.
    setServerError(null);

    const submittable = lines
      .map((l) => ({ line: l, entry: entries[l.id] ?? blankEntry() }))
      .filter(({ entry }) => entry.received > 0);
    if (submittable.length === 0) {
      fail('Enter at least one received quantity to post the receipt.');
      return;
    }

    // Per-line validation
    for (const { line, entry } of submittable) {
      if (entry.accepted + entry.rejected > entry.received + 0.0001) {
        fail(`Line "${line.name}": accepted + rejected can't exceed received.`);
        return;
      }

      if (line.trackingType === 'lot' && entry.accepted > 0) {
        if (entry.lots.length === 0) {
          fail(`Line "${line.name}" is lot-tracked. Add at least one lot.`);
          return;
        }
        const lotSum = entry.lots.reduce((s, l) => s + (Number(l.qtyBase) || 0), 0);
        if (Math.abs(lotSum - entry.accepted) > 0.0001) {
          fail(
            `Line "${line.name}": lot quantities sum to ${lotSum}, must equal accepted (${entry.accepted}).`,
          );
          return;
        }
        if (entry.lots.some((l) => !l.lotNumber.trim())) {
          fail(`Line "${line.name}": all lots need a lot number.`);
          return;
        }
      }

      if (wantsSerials(line.trackingType) && entry.accepted > 0) {
        // 'serial' is unchanged: exactly one non-empty serial per accepted
        // unit. 'serial_optional' (0295/0296) accepts 0..accepted — blanks in
        // the grid are simply untagged units and are dropped from the payload
        // below, never sent as empty strings.
        const filled = entry.serials.map((s) => s.trim()).filter((s) => s.length > 0);

        if (serialsRequired(line.trackingType)) {
          if (entry.serials.length !== entry.accepted) {
            fail(
              `Line "${line.name}": expected ${entry.accepted} serials, got ${entry.serials.length}.`,
            );
            return;
          }
          if (entry.serials.some((s) => !s.trim())) {
            fail(`Line "${line.name}": every serial number must be non-empty.`);
            return;
          }
        } else if (filled.length > entry.accepted) {
          fail(
            `Line "${line.name}": ${filled.length} serials entered but only ${entry.accepted} units accepted.`,
          );
          return;
        }

        // The within-line duplicate check applies to BOTH modes — it is a real
        // guard the RPC does not have (the DB only catches duplicates that
        // collide with the item's EXISTING registry rows, and only as a raw
        // 23505). Compared over the non-blank entries so that untagged units
        // in a serial_optional grid do not read as duplicates of each other.
        if (new Set(filled).size !== filled.length) {
          fail(`Line "${line.name}": duplicate serials in the list.`);
          return;
        }
      }
    }

    setSubmitting(true);
    const res = await postReceiptAction({
      purchaseOrderId: poId,
      warehouseId,
      lines: submittable.map(({ line, entry }) => ({
        poLineId: line.id,
        qtyReceived: entry.received,
        qtyAccepted: entry.accepted,
        qtyRejected: entry.rejected,
        notes: entry.notes || undefined,
        lots:
          line.trackingType === 'lot' && entry.accepted > 0
            ? entry.lots.map((l) => ({
                lotNumber: l.lotNumber.trim(),
                expirationDate: l.expirationDate || null,
                qtyBase: Number(l.qtyBase),
              }))
            : undefined,
        // Blanks are filtered out, so a serial_optional line with an untouched
        // grid sends an empty array (a legitimate pure-quantity receipt) and a
        // partially filled grid sends only the tags that were actually
        // scanned. For 'serial' the filter is a no-op — validation above
        // already rejected any blank.
        serials:
          wantsSerials(line.trackingType) && entry.accepted > 0
            ? entry.serials.map((s) => s.trim()).filter((s) => s.length > 0)
            : undefined,
      })),
      notes: notes || undefined,
      idempotencyKey,
    });
    setSubmitting(false);
    if (!res.ok) {
      fail(res.error.message);
      return;
    }
    // Said on both paths, so a person who looks away still learns it.
    toast.success(`Receipt ${res.data.receiptNumber} posted against ${poNumber}.`);
    if (checklist && canRecordChecklist) {
      // F4-1: offer the checklist in place of the form. The receipt is posted;
      // the page refreshes underneath so Receipts shows it, and keeps this
      // dialog mounted even when the PO now reads 'received' (desk check F1).
      setPosted({ receiptId: res.data.receiptId, receiptNumber: res.data.receiptNumber });
      router.refresh();
      return;
    }
    setOpen(false);
    router.refresh();
  }

  /** "Record checklist": start (or reopen) the run, then open its page. */
  async function recordChecklist() {
    if (!posted || starting) return;
    setStartError(null);
    setStarting(true);
    let res: Awaited<ReturnType<typeof startReceivingCheckAction>>;
    try {
      res = await startReceivingCheckAction(posted.receiptId, poId);
    } catch {
      // The request never came back: the receipt is still posted.
      setStarting(false);
      setStartError(
        `${RECEIVING_CHECKLIST_COPY.didNotGoThrough} ${RECEIVING_CHECKLIST_COPY.startFailedAfterPostWeb}`,
      );
      return;
    }
    if (!res.ok) {
      setStarting(false);
      setStartError(
        res.error.details?.reason === 'no_checklist'
          ? `${RECEIVING_CHECKLIST_COPY.noChecklist} ${RECEIVING_CHECKLIST_COPY.startFailedAfterPostWeb}`
          : RECEIVING_CHECKLIST_COPY.startFailedAfterPostWeb,
      );
      return;
    }
    setOpen(false);
    router.push(`/dashboard/purchase-orders/receiving-checks/${res.data.runId}`);
  }

  // Lay the lines out as runs + loose rows. With no groups (every non-sports
  // org) every block is `loose`, in the original order, so the rows below are
  // the flat lines they were before Task 16.
  const blocks = React.useMemo(
    () =>
      splitIntoRuns(
        lines.map((l) => ({
          ...l,
          groupId: l.groupId ?? null,
          variantSize: l.variantSize ?? null,
        })),
        groups,
      ),
    [lines, groups],
  );

  // Nothing to receive and nothing open: no button. The dialog itself stays
  // mounted (the page keeps it for a poster), so an open Posted panel
  // survives the refresh that turns the PO 'received' (desk check F1).
  if (!receivable && !open) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {receivable && (
        <DialogTrigger asChild>
          {/* The ink primary: receiving commits the work in front of you
              (DESIGN-SPEC 6.2, CONFLICTS P5). */}
          <Button variant="default">
            <PackageCheck className="h-4 w-4" /> Receive items
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-3xl">
        {posted ? (
          <>
            <DialogHeader>
              <DialogTitle>{RECEIVING_CHECKLIST_COPY.postedTitle(posted.receiptNumber)}</DialogTitle>
              <DialogDescription>{RECEIVING_CHECKLIST_COPY.postedBody}</DialogDescription>
            </DialogHeader>
            {startError && (
              <p
                role="alert"
                className="border-destructive/30 bg-destructive-wash text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] leading-5"
              >
                <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{startError}</span>
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={starting}>
                {RECEIVING_CHECKLIST_COPY.done}
              </Button>
              {/* Recording the checklist is the panel's next piece of work,
                  in ink like Post receipt; the spinner shows beside the
                  words, so the button keeps its name. */}
              <Button variant="default" onClick={recordChecklist} disabled={starting}>
                {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {RECEIVING_CHECKLIST_COPY.recordChecklist}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Receive {poNumber}</DialogTitle>
              <DialogDescription>
                Enter how many you received for each line — the variance shows what&apos;s still
                outstanding. Receiving in parts is fine: post a receipt each time more arrives, until
                the variance reaches zero.
              </DialogDescription>
            </DialogHeader>
            {/* The lines scroll inside the dialog; 2 px each side keep the
                fields' focus rings inside the scroller's clip. */}
            <div className="-mx-0.5 max-h-[55vh] space-y-3 overflow-y-auto px-0.5 py-0.5">
              {blocks.map((block) => {
                if (block.kind === 'run') {
                  const group = groups[block.groupId];
                  // A run with no resolved group metadata cannot name its counting
                  // unit, and the unit is READ, never inferred (requirements 5).
                  // Fall back to the flat rows rather than guessing "each".
                  if (group) {
                    return (
                      <SizeRunReceiveGrid
                        key={block.groupId}
                        groupId={block.groupId}
                        group={group}
                        lines={block.lines}
                        entries={entries}
                        onChange={(lineId, patch) =>
                          setField(lineId, {
                            received: patch.received,
                            // Same split the flat row applies: everything received
                            // goes into usable stock.
                            accepted: patch.received,
                            rejected: 0,
                          })
                        }
                        renderExtras={(l) => (
                          <LineCapture
                            line={l}
                            entry={entries[l.id] ?? blankEntry()}
                            setField={setField}
                          />
                        )}
                      />
                    );
                  }
                }
                return block.lines.map((l) => {
                  const remaining = l.quantityOrdered - l.quantityReceived;
                  const e = entries[l.id] ?? blankEntry();
                  // Variance = what's still outstanding after this receipt. Positive =
                  // still waiting on stock; 0 = fully received; negative = over ordered.
                  const variance = remaining - e.received;
                  const receivedId = `${fieldId}-received-${l.id}`;
                  return (
                    // One card per line: the item, then what arrived (with All
                    // beside its field, the quantity it fills) and the variance;
                    // side by side on a phone under the item, in one row wider.
                    <div
                      key={l.id}
                      className="border-border bg-card grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border p-3 sm:grid-cols-12"
                    >
                      <div className="col-span-2 min-w-0 sm:col-span-5">
                        <p className="text-foreground text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]">
                          {l.name}
                        </p>
                        <p className="text-muted-foreground font-mono text-[11.5px] leading-[17.25px]">
                          {l.sku}
                        </p>
                        <p className="text-muted-foreground mt-1 text-[12px] leading-[18px]">
                          Ordered {l.quantityOrdered} · Already received {l.quantityReceived}
                        </p>
                      </div>
                      <div className="min-w-0 space-y-1 sm:col-span-4">
                        <Label
                          htmlFor={receivedId}
                          className="text-muted-foreground block text-[11px] leading-none"
                        >
                          Received now
                        </Label>
                        <div className="flex items-center gap-1.5">
                          <BlankZeroNumberInput
                            id={receivedId}
                            min={0}
                            step={1}
                            value={e.received}
                            onValueChange={(v) => {
                              const r = Math.max(0, v);
                              // Everything you receive goes into usable stock. We keep the
                              // accepted/rejected split in the payload (accepted = received,
                              // rejected = 0) but don't ask for it — the variance is what matters.
                              setField(l.id, { received: r, accepted: r, rejected: 0 });
                            }}
                            className="min-w-0 font-mono"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() =>
                              setField(l.id, { received: remaining, accepted: remaining, rejected: 0 })
                            }
                          >
                            All
                          </Button>
                        </div>
                      </div>
                      <div className="min-w-0 space-y-1 sm:col-span-3">
                        <p className="text-muted-foreground text-[11px] font-medium leading-none">
                          Variance
                        </p>
                        <div
                          className={cn(
                            'border-border bg-sunk flex h-8 items-center rounded-md border px-2.5 font-mono text-[13px] tabular-nums max-sm:h-11',
                            varianceToneClass(variance),
                          )}
                        >
                          {variance}
                        </div>
                        <p className="text-muted-foreground text-[11px] leading-4">
                          {variance > 0
                            ? `${variance} still to come`
                            : variance < 0
                              ? `${Math.abs(variance)} over ordered`
                              : 'Fully received'}
                        </p>
                      </div>
                      <LineCapture
                        line={l}
                        entry={e}
                        setField={setField}
                        wrapperClassName="col-span-2 sm:col-span-12"
                      />
                    </div>
                  );
                });
              })}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-notes`}>Notes</Label>
              <Textarea
                id={`${fieldId}-notes`}
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            {/*
              The failure surface for this dialog. Lives INSIDE the modal and
              persists until the next attempt — see the serverError comment above
              for the "clicked, nothing happened" bug this closes.
            */}
            {serverError && (
              <p
                role="alert"
                className="border-destructive/30 bg-destructive-wash text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] leading-5"
              >
                <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{serverError}</span>
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              {/* The dialog's commit, in ink; the spinner shows beside the words
                  while the receipt posts, so the button keeps its name. */}
              <Button variant="default" onClick={submit} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Post receipt
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The lot / serial capture panels for one line, shared by the flat rows and
 * the size-run grid so a `serial` item inside a run keeps EXACTLY the capture
 * UI it has outside one.
 *
 * Renders nothing at all when the line needs neither panel, and each panel is
 * individually wrapped in `wrapperClassName` — so in the flat row the two
 * full-width cells appear only when they are actually needed.
 */
function LineCapture({
  line,
  entry,
  setField,
  wrapperClassName,
}: {
  line: Line;
  entry: LineEntry;
  setField: (lineId: string, patch: Partial<LineEntry>) => void;
  wrapperClassName?: string;
}) {
  const wants = wantsSerials(line.trackingType) && entry.accepted > 0;
  const lot = line.trackingType === 'lot' && entry.accepted > 0;
  if (!wants && !lot) return null;
  return (
    <>
      {lot && (
        <div className={wrapperClassName}>
          <LotCapture
            lots={entry.lots}
            requiredQty={entry.accepted}
            onChange={(lots) => setField(line.id, { lots })}
          />
        </div>
      )}
      {wants && (
        <div className={wrapperClassName}>
          <SerialCapture
            serials={entry.serials}
            requiredCount={entry.accepted}
            required={serialsRequired(line.trackingType)}
            onChange={(serials) => setField(line.id, { serials })}
          />
        </div>
      )}
    </>
  );
}

/** The capture panels' recessed surface, in both themes. */
const CAPTURE_PANEL = 'border-border bg-sunk mt-2 rounded-md border p-3 text-[12.5px]';

function LotCapture({
  lots,
  requiredQty,
  onChange,
}: {
  lots: LotRow[];
  requiredQty: number;
  onChange: (next: LotRow[]) => void;
}) {
  const sum = lots.reduce((s, l) => s + (Number(l.qtyBase) || 0), 0);
  const valid = Math.abs(sum - requiredQty) < 0.0001;

  function update(i: number, patch: Partial<LotRow>) {
    onChange(lots.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function add() {
    onChange([...lots, { lotNumber: '', expirationDate: '', qtyBase: 0 }]);
  }
  function remove(i: number) {
    onChange(lots.filter((_, idx) => idx !== i));
  }

  return (
    <div className={CAPTURE_PANEL}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium">Lot capture</span>
        <span className={cn('font-mono tabular-nums', valid ? 'text-success' : 'text-warning')}>
          {sum.toLocaleString()} / {requiredQty.toLocaleString()}
        </span>
      </div>
      <div className="space-y-2">
        {lots.map((row, i) => (
          // A phone gives the lot number its own line and the date, the
          // quantity and Remove the next; wider, the four share one row.
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 sm:grid-cols-12"
          >
            <Input
              className="col-span-3 sm:col-span-5"
              placeholder="Lot #"
              value={row.lotNumber}
              onChange={(e) => update(i, { lotNumber: e.target.value })}
            />
            <Input
              className="sm:col-span-3"
              type="date"
              value={row.expirationDate}
              onChange={(e) => update(i, { expirationDate: e.target.value })}
            />
            <BlankZeroNumberInput
              className="sm:col-span-3"
              min={0}
              step={1}
              placeholder="Qty"
              value={row.qtyBase}
              onValueChange={(n) => update(i, { qtyBase: n })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              aria-label="Remove lot"
              className="max-sm:size-11"
            >
              ×
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add}>
          + Add lot
        </Button>
        {lots.length === 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([{ lotNumber: '', expirationDate: '', qtyBase: requiredQty }])}
          >
            Single lot of {requiredQty}
          </Button>
        )}
      </div>
    </div>
  );
}

function SerialCapture({
  serials,
  requiredCount,
  required,
  onChange,
}: {
  serials: string[];
  /** Always the accepted qty — the grid size, and the CAP in both modes. */
  requiredCount: number;
  /**
   * true for tracking_type='serial' (one serial per unit, all mandatory).
   * false for 'serial_optional', where any subset may be left blank and the
   * untouched grid is a legitimate pure-quantity receipt.
   */
  required: boolean;
  onChange: (next: string[]) => void;
}) {
  // Resize the array whenever requiredCount changes (accepted qty changed).
  React.useEffect(() => {
    if (serials.length === requiredCount) return;
    const next = Array.from({ length: requiredCount }, (_, i) => serials[i] ?? '');
    onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredCount]);

  const nonBlank = serials.map((s) => s.trim()).filter((s) => s.length > 0);
  const filled = nonBlank.length;
  // Compare over the NON-BLANK entries: in an optional grid several untagged
  // units are all '' and must not read as duplicates of one another.
  const hasDup = new Set(nonBlank).size !== nonBlank.length;

  function update(i: number, value: string) {
    onChange(serials.map((s, idx) => (idx === i ? value : s)));
  }
  // Enter moves to the next serial: the field's grandparent is this panel,
  // which holds every serial field of the line.
  function focusNext(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const next = e.currentTarget.parentElement?.parentElement?.querySelector<HTMLInputElement>(
        `[data-serial-idx="${i + 1}"]`,
      );
      next?.focus();
    }
  }

  return (
    <div className={CAPTURE_PANEL}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium">Serial capture{required ? '' : ' (optional)'}</span>
        <span
          className={cn(
            'font-mono tabular-nums',
            hasDup
              ? 'text-destructive'
              : !required || filled === requiredCount
                ? 'text-success'
                : 'text-ink-2',
          )}
        >
          {filled} / {requiredCount}
          {hasDup ? ' · duplicate detected' : ''}
        </span>
      </div>
      {!required && (
        <p className="text-muted-foreground mb-2 text-[11.5px] leading-[17.25px]">
          Serials are optional for this item. Fill in only the units that carry one and leave the
          rest blank — never enter a placeholder.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: requiredCount }, (_, i) => (
          <Input
            key={i}
            data-serial-idx={i}
            placeholder={`Serial #${i + 1}`}
            value={serials[i] ?? ''}
            onChange={(e) => update(i, e.target.value)}
            onKeyDown={(e) => focusNext(e, i)}
            className="font-mono"
          />
        ))}
      </div>
    </div>
  );
}
