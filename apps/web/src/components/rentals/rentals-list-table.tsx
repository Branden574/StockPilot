'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn, formatRelative } from '@/lib/utils';
import { cancelRentalAction, markRentalReturnedAction } from '@/server/actions/rentals';
import type { RentalLineRow, RentalRow } from '@/server/services/rentals';

import { hasPermission } from '@stockpilot/core';

type RentalWithLines = RentalRow & { lines: RentalLineRow[] };

interface RentalsListTableProps {
  rentals: RentalWithLines[];
  viewerRole: string;
  itemNames?: Map<string, string>;
}

type StatusDisplay = 'out' | 'returned' | 'cancelled' | 'overdue';

function deriveStatus(rental: RentalRow): StatusDisplay {
  if (rental.status === 'returned') return 'returned';
  if (rental.status === 'cancelled') return 'cancelled';
  if (new Date(rental.expected_return_at) < new Date()) return 'overdue';
  return 'out';
}

function StatusPill({ status }: { status: StatusDisplay }) {
  const styles: Record<StatusDisplay, string> = {
    out: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    returned: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    overdue: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  };
  const labels: Record<StatusDisplay, string> = {
    out: 'Out',
    returned: 'Returned',
    cancelled: 'Cancelled',
    overdue: 'Overdue',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none',
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  );
}

function DueLabel({ expectedReturnAt }: { expectedReturnAt: string }) {
  const expected = new Date(expectedReturnAt);
  const now = new Date();
  const diffMs = expected.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return <span className="text-amber-600 dark:text-amber-400 text-xs font-medium">Due today</span>;
  }
  if (diffDays < 0) {
    return (
      <span className="text-red-600 dark:text-red-400 text-xs font-medium">
        Overdue by {Math.abs(diffDays)} day{Math.abs(diffDays) !== 1 ? 's' : ''}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      Due in {diffDays} day{diffDays !== 1 ? 's' : ''}
    </span>
  );
}

function MarkReturnedDialog({
  rental,
  onClose,
}: {
  rental: RentalWithLines;
  onClose: () => void;
}) {
  const [notes, setNotes] = React.useState('');
  const [isPending, startTransition] = React.useTransition();

  function handleSubmit() {
    startTransition(async () => {
      const res = await markRentalReturnedAction({ id: rental.id, returnNotes: notes || null });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Rental marked as returned.');
      onClose();
    });
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Mark returned</DialogTitle>
        <DialogDescription>
          Confirm that <strong>{rental.borrower_name}</strong> has returned the items.
          Reservations will be released.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="return-notes">Notes (optional)</Label>
        <Textarea
          id="return-notes"
          placeholder="Any condition notes, damage, etc."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={isPending}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Mark returned
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelRentalDialog({
  rental,
  onClose,
}: {
  rental: RentalWithLines;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [isPending, startTransition] = React.useTransition();

  function handleSubmit() {
    if (!reason.trim()) {
      toast.error('A cancellation reason is required.');
      return;
    }
    startTransition(async () => {
      const res = await cancelRentalAction({ id: rental.id, reason: reason.trim() });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Rental cancelled.');
      onClose();
    });
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel rental</DialogTitle>
        <DialogDescription>
          Cancel <strong>{rental.borrower_name}</strong>&apos;s rental. A reason is required.
          Reservations will be released.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="cancel-reason">
          Reason <span className="text-red-500">*</span>
        </Label>
        <Textarea
          id="cancel-reason"
          placeholder="Never picked up, booking error, etc."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          disabled={isPending}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          Back
        </Button>
        <Button variant="destructive" onClick={handleSubmit} disabled={isPending || !reason.trim()}>
          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Cancel rental
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function RentalsListTable({
  rentals,
  viewerRole,
  itemNames,
}: RentalsListTableProps) {
  const [returnTarget, setReturnTarget] = React.useState<RentalWithLines | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<RentalWithLines | null>(null);

  const canCreate = hasPermission(viewerRole as never, 'rentals:create');
  const canManage = hasPermission(viewerRole as never, 'rentals:manage');

  if (rentals.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-6 py-12 text-center text-muted-foreground text-sm">
        No rentals found for this filter.
      </div>
    );
  }

  return (
    <>
      {/* Return dialog */}
      <Dialog open={returnTarget !== null} onOpenChange={(o) => { if (!o) setReturnTarget(null); }}>
        {returnTarget && (
          <MarkReturnedDialog rental={returnTarget} onClose={() => setReturnTarget(null)} />
        )}
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelTarget !== null} onOpenChange={(o) => { if (!o) setCancelTarget(null); }}>
        {cancelTarget && (
          <CancelRentalDialog rental={cancelTarget} onClose={() => setCancelTarget(null)} />
        )}
      </Dialog>

      <div className="rounded-lg border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Borrower</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden sm:table-cell">
                Items
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden md:table-cell">
                Checked out
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Return</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rentals.map((rental) => {
              const status = deriveStatus(rental);
              const firstLine = rental.lines[0];
              const firstName = firstLine
                ? (itemNames?.get(firstLine.item_id) ?? `Item ×${firstLine.quantity}`)
                : '—';
              const lineLabel =
                rental.lines.length > 1
                  ? `${firstName} + ${rental.lines.length - 1} more`
                  : firstName;

              return (
                <tr key={rental.id} className="hover:bg-muted/30 transition-colors">
                  {/* Borrower */}
                  <td className="px-4 py-3">
                    <p className="font-medium leading-tight">{rental.borrower_name}</p>
                    {rental.borrower_user_id && (
                      <span className="text-[10px] text-muted-foreground">(member)</span>
                    )}
                  </td>

                  {/* Items summary */}
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="text-muted-foreground truncate max-w-[200px] block">
                      {lineLabel}
                    </span>
                  </td>

                  {/* Checkout date */}
                  <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                    {formatRelative(rental.checked_out_at)}
                  </td>

                  {/* Expected return */}
                  <td className="px-4 py-3">
                    {rental.status === 'out' ? (
                      <DueLabel expectedReturnAt={rental.expected_return_at} />
                    ) : rental.returned_at ? (
                      <span className="text-muted-foreground text-xs">
                        {formatRelative(rental.returned_at)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <StatusPill status={status} />
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                      <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                        <Link href={`/dashboard/rentals/${rental.id}`}>View</Link>
                      </Button>

                      {canCreate && rental.status === 'out' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setReturnTarget(rental)}
                        >
                          Mark returned
                        </Button>
                      )}

                      {canManage && rental.status === 'out' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => setCancelTarget(rental)}
                        >
                          Cancel…
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
