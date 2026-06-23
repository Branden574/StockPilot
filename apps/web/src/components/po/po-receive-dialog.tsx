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

interface Line {
  id: string;
  name: string;
  sku: string;
  quantityOrdered: number;
  quantityReceived: number;
  trackingType: 'none' | 'lot' | 'serial';
}

interface PoReceiveDialogProps {
  poId: string;
  poNumber: string;
  warehouseId: string;
  lines: Line[];
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
}: PoReceiveDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const [entries, setEntries] = React.useState<Record<string, LineEntry>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.id, blankEntry()]),
    ),
  );

  // Idempotency key: one per dialog open. New key when re-opening (resets state).
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setIdempotencyKey(crypto.randomUUID());
      setEntries(
        Object.fromEntries(
          lines.map((l) => [l.id, blankEntry()]),
        ),
      );
      setNotes('');
    }
  }, [open, lines]);

  function setField(lineId: string, patch: Partial<LineEntry>) {
    setEntries((m) => ({
      ...m,
      [lineId]: { ...(m[lineId] ?? blankEntry()), ...patch },
    }));
  }

  async function submit() {
    const submittable = lines
      .map((l) => ({ line: l, entry: entries[l.id] ?? blankEntry() }))
      .filter(({ entry }) => entry.received > 0);
    if (submittable.length === 0) {
      toast.error('Enter at least one received quantity to post the receipt.');
      return;
    }

    // Per-line validation
    for (const { line, entry } of submittable) {
      if (entry.accepted + entry.rejected > entry.received + 0.0001) {
        toast.error(`Line "${line.name}": accepted + rejected can't exceed received.`);
        return;
      }

      if (line.trackingType === 'lot' && entry.accepted > 0) {
        if (entry.lots.length === 0) {
          toast.error(`Line "${line.name}" is lot-tracked. Add at least one lot.`);
          return;
        }
        const lotSum = entry.lots.reduce((s, l) => s + (Number(l.qtyBase) || 0), 0);
        if (Math.abs(lotSum - entry.accepted) > 0.0001) {
          toast.error(
            `Line "${line.name}": lot quantities sum to ${lotSum}, must equal accepted (${entry.accepted}).`,
          );
          return;
        }
        if (entry.lots.some((l) => !l.lotNumber.trim())) {
          toast.error(`Line "${line.name}": all lots need a lot number.`);
          return;
        }
      }

      if (line.trackingType === 'serial' && entry.accepted > 0) {
        if (entry.serials.length !== entry.accepted) {
          toast.error(
            `Line "${line.name}": expected ${entry.accepted} serials, got ${entry.serials.length}.`,
          );
          return;
        }
        if (entry.serials.some((s) => !s.trim())) {
          toast.error(`Line "${line.name}": every serial number must be non-empty.`);
          return;
        }
        const dedup = new Set(entry.serials.map((s) => s.trim()));
        if (dedup.size !== entry.serials.length) {
          toast.error(`Line "${line.name}": duplicate serials in the list.`);
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
        serials:
          line.trackingType === 'serial' && entry.accepted > 0
            ? entry.serials.map((s) => s.trim())
            : undefined,
      })),
      notes: notes || undefined,
      idempotencyKey,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Receipt ${res.data.receiptNumber} posted against ${poNumber}.`);
    setOpen(false);
    router.refresh();
  }

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
          {lines.map((l) => {
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
                {l.trackingType === 'lot' && e.accepted > 0 && (
                  <div className="sm:col-span-12">
                    <LotCapture
                      lots={e.lots}
                      requiredQty={e.accepted}
                      onChange={(lots) => setField(l.id, { lots })}
                    />
                  </div>
                )}
                {l.trackingType === 'serial' && e.accepted > 0 && (
                  <div className="sm:col-span-12">
                    <SerialCapture
                      serials={e.serials}
                      requiredCount={e.accepted}
                      onChange={(serials) => setField(l.id, { serials })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
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
  onChange,
}: {
  serials: string[];
  requiredCount: number;
  onChange: (next: string[]) => void;
}) {
  // Resize the array whenever requiredCount changes (accepted qty changed).
  React.useEffect(() => {
    if (serials.length === requiredCount) return;
    const next = Array.from({ length: requiredCount }, (_, i) => serials[i] ?? '');
    onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredCount]);

  const filled = serials.filter((s) => s.trim().length > 0).length;
  const dedup = new Set(serials.map((s) => s.trim())).size;
  const hasDup = dedup !== serials.length && serials.some((s) => s.trim().length > 0);

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
        <span className="font-medium">Serial capture</span>
        <span
          className={
            hasDup
              ? 'text-destructive'
              : filled === requiredCount
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-blue-700 dark:text-blue-300'
          }
        >
          {filled} / {requiredCount}
          {hasDup ? ' · duplicate detected' : ''}
        </span>
      </div>
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
