'use client';

import { Loader2, PackageCheck } from 'lucide-react';
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
import { postReceiptAction } from '@/server/actions/receiving';

import {
  SizeRunReceiveGrid,
  splitIntoRuns,
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
}: PoReceiveDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [notes, setNotes] = React.useState('');
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
    Object.fromEntries(
      lines.map((l) => [l.id, blankEntry()]),
    ),
  );

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
    toast.success(`Receipt ${res.data.receiptNumber} posted against ${poNumber}.`);
    setOpen(false);
    router.refresh();
  }

  // Lay the lines out as runs + loose rows. With no groups (every non-sports
  // org) every block is `loose`, in the original order, so the markup below is
  // byte-for-byte what it was before Task 16.
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="gradient">
          <PackageCheck className="h-4 w-4" /> Receive items
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Receive {poNumber}</DialogTitle>
          <DialogDescription>
            Enter how many you received for each line — the variance shows what&apos;s
            still outstanding. Receiving in parts is fine: post a receipt each time
            more arrives, until the variance reaches zero.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto">
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
              const varianceTone =
                variance > 0
                  ? 'text-amber-600 dark:text-amber-400'
                  : variance < 0
                  ? 'text-destructive'
                  : 'text-emerald-600 dark:text-emerald-400';
              return (
                <div key={l.id} className="grid gap-3 rounded-md border p-3 sm:grid-cols-12">
                  <div className="sm:col-span-5">
                    <p className="font-medium">{l.name}</p>
                    <p className="text-muted-foreground font-mono text-xs">{l.sku}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Ordered {l.quantityOrdered} · Already received {l.quantityReceived}
                    </p>
                  </div>
                  <div className="sm:col-span-3 space-y-1">
                    <Label className="text-muted-foreground text-[11px]">Received now</Label>
                    <BlankZeroNumberInput
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
                    />
                  </div>
                  <div className="sm:col-span-3 space-y-1">
                    <Label className="text-muted-foreground text-[11px]">Variance</Label>
                    <div
                      className={`border-border bg-muted/30 flex h-9 items-center rounded-md border px-3 text-sm tabular-nums ${varianceTone}`}
                    >
                      {variance}
                    </div>
                    <p className="text-muted-foreground text-[11px]">
                      {variance > 0
                        ? `${variance} still to come`
                        : variance < 0
                        ? `${Math.abs(variance)} over ordered`
                        : 'Fully received'}
                    </p>
                  </div>
                  <div className="sm:col-span-1 flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setField(l.id, { received: remaining, accepted: remaining, rejected: 0 })
                      }
                    >
                      All
                    </Button>
                  </div>
                  <LineCapture
                    line={l}
                    entry={e}
                    setField={setField}
                    wrapperClassName="sm:col-span-12"
                  />
                </div>
              );
            });
          })}
        </div>
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {/*
          The failure surface for this dialog. Lives INSIDE the modal and
          persists until the next attempt — see the serverError comment above
          for the "clicked, nothing happened" bug this closes.
        */}
        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="gradient" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Post receipt'}
          </Button>
        </DialogFooter>
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
 * `sm:col-span-12` cells appear only when they are actually needed, which is
 * the markup that shipped before Task 16.
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
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/40 p-3 text-xs dark:border-amber-900/40 dark:bg-amber-950/20">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Lot capture</span>
        <span className={valid ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>
          {sum.toLocaleString()} / {requiredQty.toLocaleString()}
        </span>
      </div>
      <div className="space-y-2">
        {lots.map((row, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Input
              className="col-span-5"
              placeholder="Lot #"
              value={row.lotNumber}
              onChange={(e) => update(i, { lotNumber: e.target.value })}
            />
            <Input
              className="col-span-3"
              type="date"
              value={row.expirationDate}
              onChange={(e) => update(i, { expirationDate: e.target.value })}
            />
            <BlankZeroNumberInput
              className="col-span-3"
              min={0}
              step={1}
              placeholder="Qty"
              value={row.qtyBase}
              onValueChange={(n) => update(i, { qtyBase: n })}
            />
            <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove lot">
              ×
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add}>
          + Add lot
        </Button>
        {lots.length === 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange([{ lotNumber: '', expirationDate: '', qtyBase: requiredQty }])
            }
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
    <div className="mt-2 rounded-md border border-blue-200 bg-blue-50/40 p-3 text-xs dark:border-blue-900/40 dark:bg-blue-950/20">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">
          Serial capture{required ? '' : ' (optional)'}
        </span>
        <span
          className={
            hasDup
              ? 'text-destructive'
              : !required || filled === requiredCount
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-blue-700 dark:text-blue-300'
          }
        >
          {filled} / {requiredCount}
          {hasDup ? ' · duplicate detected' : ''}
        </span>
      </div>
      {!required && (
        <p className="text-muted-foreground mb-2 text-[11px]">
          Serials are optional for this item. Fill in only the units that carry
          one and leave the rest blank — never enter a placeholder.
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
