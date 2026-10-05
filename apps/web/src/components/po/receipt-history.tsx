'use client';

import { ClipboardCheck, Loader2, TriangleAlert, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Timeline, TimelineEntry, type TimelineTone } from '@/components/patterns/timeline';
import { Badge } from '@/components/ui/badge';
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
import { LocalDateTime } from '@/components/ui/local-datetime';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatRelative } from '@/lib/utils';
import { reverseReceiptAction } from '@/server/actions/receiving';
import { startReceivingCheckAction } from '@/server/actions/receiving-checklist';

import {
  receiptChecklistAction,
  receiptChecklistActionLabel,
  receiptChecklistChipText,
  receiptChecklistChipTone,
  receiptChecklistState,
  RECEIVING_CHECKLIST_COPY,
  type ChecklistRunLite,
  type ChecklistVersionLite,
  type ReceiptChecklistState,
} from '@stockpilot/core';

import type { ReceiptLineRow, ReceiptRow } from '@/server/services/receiving';

interface ItemLookup {
  [id: string]: { name: string; sku: string };
}

/**
 * Each receipt status keeps its own word on a label in one of the shared tones
 * (DESIGN-SPEC 6.10), which hold their contrast in both themes where the old
 * fixed emerald, amber and blue chips did not; the timeline dot repeats the
 * tone, so colour is never the only cue.
 */
type ReceiptBadgeTone = 'outline' | 'success' | 'warning' | 'secondary';

const STATUS_BADGE: Record<ReceiptRow['status'], ReceiptBadgeTone> = {
  draft: 'outline',
  posted: 'success',
  reversed: 'warning',
  reversal: 'secondary',
  canceled: 'outline',
};

const STATUS_TONE: Record<ReceiptRow['status'], TimelineTone> = {
  draft: 'muted',
  posted: 'accent',
  reversed: 'warning',
  reversal: 'neutral',
  canceled: 'muted',
};

/**
 * The receiving checklist chip (F4-1) in the shared tones: done with no failed
 * check is the accent, failed checks and a status that did not load the
 * caution, in progress and not recorded the neutral label. The chip's words
 * carry the state, so colour is never the only cue.
 */
const CHECKLIST_CHIP_BADGE: Record<'ok' | 'warn' | 'muted', ReceiptBadgeTone> = {
  ok: 'success',
  warn: 'warning',
  muted: 'secondary',
};

/** The org's checklist versions and this PO's runs (F4-1); ok false = the read failed. */
export type ReceiptChecklists =
  | { ok: true; versions: ChecklistVersionLite[]; runs: ChecklistRunLite[] }
  | { ok: false };

interface ReceiptHistoryProps {
  receipts: ReceiptRow[];
  lines: ReceiptLineRow[];
  items: ItemLookup;
  /** Manager+ only — admins/managers see "Reverse"; others don't. */
  canReverse: boolean;
  /**
   * Receiving checklist state for each entry (F4-1). Absent: no chips at all
   * (the feature's reads were not made). `{ ok: false }`: every entry says
   * "Checklist status didn't load", never "not recorded".
   */
  checklists?: ReceiptChecklists;
  /** core receivingGate().canRecordChecklist for this person. */
  canRecordChecklist?: boolean;
  /** The purchase order, to refresh it after a start. */
  poId?: string;
}

/**
 * The PO's receipts, newest first as the service returns them, as a timeline
 * (matrix W-PU-02d, P-TL): one entry per receipt with its number and status,
 * when and by whom, Reverse where allowed, and its lines.
 */
export function ReceiptHistory({
  receipts,
  lines,
  items,
  canReverse,
  checklists,
  canRecordChecklist = false,
  poId,
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
      <p className="text-muted-foreground text-[13.5px] leading-[20.25px]">
        No receipts yet. Use the &quot;Receive items&quot; button on the line items above to record
        what was received — partial deliveries are fine.
      </p>
    );
  }

  return (
    <Timeline>
      {receipts.map((r) => (
        <ReceiptEntry
          key={r.id}
          receipt={r}
          lines={linesByReceipt.get(r.id) ?? []}
          items={items}
          canReverse={canReverse}
          checklist={
            checklists === undefined
              ? null
              : {
                  state: receiptChecklistState({
                    receipt: { id: r.id, status: r.status, receivedAt: r.received_at },
                    versions: checklists.ok ? checklists.versions : null,
                    runs: checklists.ok ? checklists.runs : null,
                  }),
                  versions: checklists.ok ? checklists.versions : [],
                }
          }
          canRecordChecklist={canRecordChecklist}
          poId={poId}
        />
      ))}
    </Timeline>
  );
}

function ReceiptEntry({
  receipt,
  lines,
  items,
  canReverse,
  checklist,
  canRecordChecklist,
  poId,
}: {
  receipt: ReceiptRow;
  lines: ReceiptLineRow[];
  items: ItemLookup;
  canReverse: boolean;
  checklist: { state: ReceiptChecklistState; versions: readonly ChecklistVersionLite[] } | null;
  canRecordChecklist: boolean;
  poId?: string;
}) {
  const router = useRouter();
  // The receipt number titles its lines table (a scroll region on a phone).
  const numberId = React.useId();
  const [reverseOpen, setReverseOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);

  const chip = checklist ? receiptChecklistChipText(checklist.state) : null;
  const tone = checklist ? receiptChecklistChipTone(checklist.state) : null;
  const action = checklist
    ? receiptChecklistAction({
        state: checklist.state,
        receipt: { status: receipt.status, receivedAt: receipt.received_at },
        versions: checklist.versions,
        canRecord: canRecordChecklist,
      })
    : null;
  const runId =
    checklist && (checklist.state.kind === 'completed' || checklist.state.kind === 'in_progress')
      ? checklist.state.runId
      : null;
  const showReverse = canReverse && receipt.status === 'posted';

  /** "Record checklist" on an entry: start (or reopen) the run, then open it. */
  async function record() {
    if (starting) return;
    setStartError(null);
    setStarting(true);
    let r: Awaited<ReturnType<typeof startReceivingCheckAction>>;
    try {
      r = await startReceivingCheckAction(receipt.id, poId ?? null);
    } catch {
      setStarting(false);
      setStartError(RECEIVING_CHECKLIST_COPY.didNotGoThrough);
      return;
    }
    if (!r.ok) {
      setStarting(false);
      setStartError(r.error.message);
      return;
    }
    router.push(`/dashboard/purchase-orders/receiving-checks/${r.data.runId}`);
  }

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
    <TimelineEntry
      tone={STATUS_TONE[receipt.status]}
      title={
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span id={numberId} className="font-mono text-[13.5px] font-medium">
            {receipt.receipt_number}
          </span>
          <Badge variant={STATUS_BADGE[receipt.status]}>{receipt.status}</Badge>
          {chip && tone && (
            <Badge variant={CHECKLIST_CHIP_BADGE[tone]} data-testid="receipt-checklist-chip">
              {chip}
            </Badge>
          )}
          {(action !== null || showReverse) && (
            // The entry's actions on the right of its title line: the
            // checklist's (Record, Continue or View) and Reverse.
            <span className="-my-1 ml-auto flex flex-wrap items-center gap-1">
              {action === 'record' && (
                <Button variant="ghost" size="sm" onClick={record} disabled={starting}>
                  {starting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ClipboardCheck className="h-3.5 w-3.5" />
                  )}
                  {receiptChecklistActionLabel('record')}
                </Button>
              )}
              {(action === 'continue' || action === 'view') && runId && (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/dashboard/purchase-orders/receiving-checks/${runId}`}>
                    <ClipboardCheck className="h-3.5 w-3.5" />
                    {receiptChecklistActionLabel(action)}
                  </Link>
                </Button>
              )}
              {showReverse && (
                <Button variant="ghost" size="sm" onClick={() => setReverseOpen(true)}>
                  <Undo2 className="h-3.5 w-3.5" /> Reverse
                </Button>
              )}
            </span>
          )}
        </span>
      }
      meta={
        // Relative for scanability + the viewer's own wall-clock time.
        // LocalDateTime renders CLIENT-side on purpose: this component is
        // SSR'd, and a toLocaleString() computed on the server prints the
        // container's timezone (UTC on Vercel). suppressHydrationWarning used
        // to sit on the whole line, which made that worse — it told React to
        // KEEP the server text, so a 9:47 AM receipt read "4:47 PM" forever.
        // It now sits on the relative <time> alone, whose server words stay
        // right to within the minute that passes before hydration (React
        // error #418 otherwise). Same order and prefix as the activity feed
        // so timestamps read identically across the app.
        <>
          <time dateTime={receipt.received_at} suppressHydrationWarning>
            {formatRelative(receipt.received_at)}
          </time>
          <LocalDateTime iso={receipt.received_at} prefix=" · " />
          {receipt.received_by_name && (
            <>
              {' '}
              · by <span className="text-foreground font-medium">{receipt.received_by_name}</span>
            </>
          )}
        </>
      }
    >
      {startError && (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive-wash text-destructive mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px] leading-[18.75px]"
        >
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{startError}</span>
        </p>
      )}
      <div className="border-border mt-1 overflow-hidden rounded-md border">
        <Table scrollLabelledBy={numberId} className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="whitespace-nowrap py-2 first:pl-3">Item</TableHead>
              <TableHead className="whitespace-nowrap py-2 text-right">Received</TableHead>
              <TableHead className="whitespace-nowrap py-2 text-right">Accepted</TableHead>
              <TableHead className="whitespace-nowrap py-2 text-right last:pr-3">
                Rejected
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const item = items[l.item_id];
              return (
                <TableRow key={l.id} className="hover:bg-transparent">
                  {/* The item keeps a readable width; on a phone the table
                      scrolls inside its own box instead of breaking names. */}
                  <TableCell className="min-w-36 py-2 first:pl-3">
                    <p className="text-foreground font-medium leading-5 [overflow-wrap:anywhere]">
                      {item?.name ?? 'Unknown item'}
                    </p>
                    <p className="text-muted-foreground font-mono text-[11.5px] leading-[17.25px]">
                      {item?.sku ?? ''}
                    </p>
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-[12.5px] tabular-nums">
                    {Number(l.qty_received_base).toLocaleString()}
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-[12.5px] tabular-nums">
                    {Number(l.qty_accepted_base).toLocaleString()}
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-[12.5px] tabular-nums last:pr-3">
                    {Number(l.qty_rejected_base).toLocaleString()}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {(receipt.notes || receipt.reversal_reason) && (
          <div className="border-border space-y-0.5 border-t px-3 py-2 text-[12.5px] leading-[18.75px] [overflow-wrap:anywhere]">
            {receipt.notes && (
              <p>
                <span className="text-muted-foreground">Notes:</span> {receipt.notes}
              </p>
            )}
            {receipt.reversal_reason && (
              <p>
                <span className="text-muted-foreground">Reversed:</span> {receipt.reversal_reason}
              </p>
            )}
          </div>
        )}
        <div className="border-border bg-sunk text-ink-2 border-t px-3 py-2 text-[12px] tabular-nums leading-[18px]">
          Total accepted: {totalAccepted.toLocaleString()} · Rejected:{' '}
          {totalRejected.toLocaleString()}
        </div>
      </div>

      <Dialog open={reverseOpen} onOpenChange={setReverseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse {receipt.receipt_number}?</DialogTitle>
            <DialogDescription>
              Stock will be decremented by the previously accepted quantities. The original receipt
              is preserved for audit; a sibling &quot;reversal&quot; receipt is created.
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
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirm reversal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TimelineEntry>
  );
}
