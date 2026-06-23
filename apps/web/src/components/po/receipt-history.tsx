'use client';

import { Loader2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { reverseReceiptAction } from '@/server/actions/receiving';
import { formatRelative } from '@/lib/utils';

import type {
  ReceiptLineRow,
  ReceiptRow,
} from '@/server/services/receiving';

interface ItemLookup {
  [id: string]: { name: string; sku: string };
}

/** Absolute received date+time. Rendered inside a suppressHydrationWarning span. */
function formatReceiptDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const STATUS_COLORS: Record<ReceiptRow['status'], string> = {
  draft: 'bg-muted text-muted-foreground',
  posted: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  reversed: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  reversal: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  canceled: 'bg-muted text-muted-foreground',
};

interface ReceiptHistoryProps {
  receipts: ReceiptRow[];
  lines: ReceiptLineRow[];
  items: ItemLookup;
  /** Manager+ only — admins/managers see "Reverse"; others don't. */
  canReverse: boolean;
}

export function ReceiptHistory({
  receipts,
  lines,
  items,
  canReverse,
}: ReceiptHistoryProps) {
  const linesByReceipt = React.useMemo(() => {
    const m = new Map<string, ReceiptLineRow[]>();
    for (const l of lines) {
      const arr = m.get(l.receipt_id) ?? [];
      arr.push(l);
      m.set(l.receipt_id, arr);
    }
    return m;
  }, [lines]);

  if (receipts.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No receipts yet. Use the &quot;Receive items&quot; button on the line items above to
        record what was received — partial deliveries are fine.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {receipts.map((r) => (
        <ReceiptCard
          key={r.id}
          receipt={r}
          lines={linesByReceipt.get(r.id) ?? []}
          items={items}
          canReverse={canReverse}
        />
      ))}
    </div>
  );
}

function ReceiptCard({
  receipt,
  lines,
  items,
  canReverse,
}: {
  receipt: ReceiptRow;
  lines: ReceiptLineRow[];
  items: ItemLookup;
  canReverse: boolean;
}) {
  const router = useRouter();
  const [reverseOpen, setReverseOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const totalAccepted = lines.reduce((s, l) => s + Number(l.qty_accepted_base), 0);
  const totalRejected = lines.reduce((s, l) => s + Number(l.qty_rejected_base), 0);

  async function reverse() {
    if (reason.trim().length < 3) {
      toast.error('Enter a reason (3+ characters) for the reversal.');
      return;
    }
    setBusy(true);
    const r = await reverseReceiptAction({ receiptId: receipt.id, reason: reason.trim() });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Receipt reversed.');
    setReverseOpen(false);
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm font-medium">{receipt.receipt_number}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_COLORS[receipt.status]}`}>
            {receipt.status}
          </span>
          <span className="text-muted-foreground text-xs" suppressHydrationWarning>
            {formatReceiptDate(receipt.received_at)} · {formatRelative(receipt.received_at)}
          </span>
          {receipt.received_by_name && (
            <span className="text-muted-foreground text-xs">
              · by <span className="text-foreground font-medium">{receipt.received_by_name}</span>
            </span>
          )}
        </div>
        {canReverse && receipt.status === 'posted' && (
          <Button variant="ghost" size="sm" onClick={() => setReverseOpen(true)}>
            <Undo2 className="mr-1 h-3.5 w-3.5" /> Reverse
          </Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Accepted</TableHead>
            <TableHead className="text-right">Rejected</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => {
            const item = items[l.item_id];
            return (
              <TableRow key={l.id}>
                <TableCell>
                  <p className="font-medium">{item?.name ?? 'Unknown item'}</p>
                  <p className="text-muted-foreground font-mono text-xs">
                    {item?.sku ?? ''}
                  </p>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(l.qty_received_base).toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(l.qty_accepted_base).toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(l.qty_rejected_base).toLocaleString()}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {(receipt.notes || receipt.reversal_reason) && (
        <div className="border-t border-border px-4 py-2 text-xs">
          {receipt.notes && (
            <p>
              <span className="text-muted-foreground">Notes:</span> {receipt.notes}
            </p>
          )}
          {receipt.reversal_reason && (
            <p>
              <span className="text-muted-foreground">Reversed:</span>{' '}
              {receipt.reversal_reason}
            </p>
          )}
        </div>
      )}
      <div className="border-t border-border bg-muted/20 px-4 py-2 text-xs tabular-nums">
        Total accepted: {totalAccepted.toLocaleString()} · Rejected:{' '}
        {totalRejected.toLocaleString()}
      </div>

      <Dialog open={reverseOpen} onOpenChange={setReverseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse {receipt.receipt_number}?</DialogTitle>
            <DialogDescription>
              Stock will be decremented by the previously accepted quantities.
              The original receipt is preserved for audit; a sibling
              &quot;reversal&quot; receipt is created.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason</Label>
            <Input
              id="reason"
              placeholder="Wrong items, miscount, supplier credit, …"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={reverse} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm reversal'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
