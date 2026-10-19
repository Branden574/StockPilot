'use client';

import { Loader2, PackageOpen } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { toast } from 'sonner';

import { StatePanel } from '@/components/patterns/state-panel';
import { deriveRentalStatus, RentalStatusBadge } from '@/components/rentals/rental-status-badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn, formatRelative } from '@/lib/utils';
import { cancelRentalAction, markRentalReturnedAction } from '@/server/actions/rentals';
import type { RentalLineRow, RentalRow } from '@/server/services/rentals';

import { hasPermission, RENTAL_BORROWER_TEAM_MEMBER, startOfOrgDay } from '@stockpilot/core';

type RentalWithLines = RentalRow & { lines: RentalLineRow[] };

interface RentalsListTableProps {
  rentals: RentalWithLines[];
  viewerRole: string;
  itemNames?: Map<string, string>;
  /**
   * The overdue reminder's mark per OVERDUE rental id ("Reminder sent Sep 26",
   * "No email on file"), decided on the server (rentals/page.tsx).
   */
  reminderMarks?: Record<string, string>;
  /**
   * The organization's zone (resolveOrgTimezone), resolved on the server
   * (rentals/page.tsx). "Due today" is a calendar day in it: the day the
   * detail page prints the expected return in.
   */
  timeZone: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Below sm the borrower and return cells keep a reading width, so the table
 * scrolls sideways inside its card. The Actions column (header and cells)
 * stays pinned to the card's right edge there, on the card's own fill with a
 * divider, so View, Mark returned and Cancel… are always on screen and the
 * other columns scroll underneath. From sm up the table fits and nothing is
 * pinned. The divider is an inset shadow, not a border: the table collapses
 * its borders, and a collapsed border stays with the grid instead of moving
 * with a sticky cell.
 */
const ACTIONS_PINNED =
  'max-sm:sticky max-sm:right-0 max-sm:z-[1] max-sm:bg-card max-sm:shadow-[inset_1px_0_0_var(--color-border)]';

const DAY_MS = 24 * HOUR_MS;

// The pill, the due label and the "Checked out" and "Returned" times are
// worked out from the clock while rendering, on the server and again in the
// browser, and a minute (or the due moment) can pass between the two. React
// then reported a hydration mismatch ("4 minutes ago" against "3 minutes
// ago", web walk 2026-09-25). Each of those elements carries
// suppressHydrationWarning, as the other client tables with relative times do
// (inventory-table.tsx, team-manager.tsx): the drift is expected.

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * When an out rental is due, beside its pill. Past due is decided exactly as
 * the pill decides it (the expected return has passed), so an Overdue row
 * never reads "Due today": it rounded the days to 0, and a rental 5 hours
 * late read "Due today" next to its Overdue pill and its reminder mark (web
 * walk 2026-09-25). Under a day late it says the hours; past that, the whole
 * days (floored like the hours: 36 hours late is 1 day, not 2).
 *
 * Not yet due, it counts CALENDAR days in the organization's zone, the zone
 * the detail page prints the expected return in. It used to round the hours
 * to days, so "Due today" meant "within about 12 hours": at 9 PM a rental due
 * at 8 AM tomorrow read "Due today" while its detail page said tomorrow, and
 * at 8 AM one due at 11 PM that day read "Due in 1 day".
 */
function dueLabel(
  expectedReturnAt: string,
  nowMs: number,
  timeZone: string,
): { text: string; tone: 'late' | 'today' | 'later' } {
  const dueMs = Date.parse(expectedReturnAt);
  if (!Number.isFinite(dueMs)) return { text: '—', tone: 'later' };
  const diffMs = dueMs - nowMs;
  if (diffMs < 0) {
    const lateMs = -diffMs;
    if (lateMs >= DAY_MS)
      return { text: `Overdue by ${plural(Math.floor(lateMs / DAY_MS), 'day')}`, tone: 'late' };
    const hours = Math.floor(lateMs / HOUR_MS);
    return {
      text: hours < 1 ? 'Overdue by less than an hour' : `Overdue by ${plural(hours, 'hour')}`,
      tone: 'late',
    };
  }
  // Midnight to midnight in the zone. Rounded, because a day that a clock
  // change shortens or lengthens is 23 or 25 hours long.
  const days = Math.round(
    (startOfOrgDay(new Date(dueMs), timeZone).getTime() -
      startOfOrgDay(new Date(nowMs), timeZone).getTime()) /
      DAY_MS,
  );
  if (days <= 0) return { text: 'Due today', tone: 'today' };
  return { text: `Due in ${plural(days, 'day')}`, tone: 'later' };
}

function DueLabel({
  expectedReturnAt,
  nowMs,
  timeZone,
}: {
  expectedReturnAt: string;
  nowMs: number;
  timeZone: string;
}) {
  const { text, tone } = dueLabel(expectedReturnAt, nowMs, timeZone);
  return (
    <span
      className={cn(
        'text-[12.5px]',
        tone === 'late' && 'text-destructive font-medium',
        tone === 'today' && 'text-warning font-medium',
        tone === 'later' && 'text-ink-2',
      )}
      suppressHydrationWarning
    >
      {text}
    </span>
  );
}

function MarkReturnedDialog({ rental, onClose }: { rental: RentalWithLines; onClose: () => void }) {
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
          Confirm that <strong>{rental.borrower_name}</strong> has returned the items. Reservations
          will be released.
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
          {isPending ? <Loader2 className="animate-spin" /> : null}
          Mark returned
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelRentalDialog({ rental, onClose }: { rental: RentalWithLines; onClose: () => void }) {
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
          Reason <span className="text-destructive">*</span>
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
          {isPending ? <Loader2 className="animate-spin" /> : null}
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
  reminderMarks,
  timeZone,
}: RentalsListTableProps) {
  const [returnTarget, setReturnTarget] = React.useState<RentalWithLines | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<RentalWithLines | null>(null);

  const canCreate = hasPermission(viewerRole as never, 'rentals:create');
  const canManage = hasPermission(viewerRole as never, 'rentals:manage');
  // One moment for every row, so a row's pill and its due label agree.
  const nowMs = Date.now();

  if (rentals.length === 0) {
    return (
      <StatePanel
        kind="empty"
        icon={PackageOpen}
        headingLevel={null}
        title="No rentals found for this filter."
      />
    );
  }

  return (
    <>
      {/* Return dialog */}
      <Dialog
        open={returnTarget !== null}
        onOpenChange={(o) => {
          if (!o) setReturnTarget(null);
        }}
      >
        {returnTarget && (
          <MarkReturnedDialog rental={returnTarget} onClose={() => setReturnTarget(null)} />
        )}
      </Dialog>

      {/* Cancel dialog */}
      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(o) => {
          if (!o) setCancelTarget(null);
        }}
      >
        {cancelTarget && (
          <CancelRentalDialog rental={cancelTarget} onClose={() => setCancelTarget(null)} />
        )}
      </Dialog>

      {/* The table card (DESIGN-SPEC 6.9). Items hides below sm and Checked
          out below md, as before; their facts then ride as quiet lines under
          the borrower's name (the accessible alternative: hidden with
          display:none at the widths where the column shows, so a screen
          reader never hears them twice). The cells keep their order:
          Borrower, Items, Checked out, Return, Status, Actions. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        {/* The scroll region is named by the page title (titleId="rentals-title"
            on the Rentals page); the table keeps its own name. */}
        <Table scrollLabelledBy="rentals-title" aria-label="Rentals">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Borrower</TableHead>
              <TableHead className="hidden sm:table-cell">Items</TableHead>
              <TableHead className="hidden whitespace-nowrap md:table-cell">Checked out</TableHead>
              <TableHead>Return</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className={cn('text-right', ACTIONS_PINNED)}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rentals.map((rental) => {
              const status = deriveRentalStatus(rental, nowMs);
              const firstLine = rental.lines[0];
              const firstName = firstLine
                ? (itemNames?.get(firstLine.item_id) ?? `Item ×${firstLine.quantity}`)
                : '—';
              const lineLabel =
                rental.lines.length > 1
                  ? `${firstName} + ${rental.lines.length - 1} more`
                  : firstName;

              return (
                <TableRow key={rental.id} className="group">
                  {/* Borrower */}
                  <TableCell className="min-w-[150px]">
                    <p className="text-foreground font-medium leading-tight [overflow-wrap:anywhere]">
                      {rental.borrower_name}
                    </p>
                    {/* The detail page's words (core). Only a team member is
                        tagged: most rows are borrowers not linked to an
                        account, and the detail says so for them. */}
                    {rental.borrower_user_id && (
                      <span
                        data-testid="borrower-kind"
                        className="text-muted-foreground block text-[12px] leading-[18px]"
                      >
                        {RENTAL_BORROWER_TEAM_MEMBER}
                      </span>
                    )}
                    {/* Narrow widths: the hidden Items and Checked out cells. */}
                    <span
                      data-testid="rental-items-narrow"
                      className="text-ink-2 mt-0.5 block text-[12px] leading-[18px] [overflow-wrap:anywhere] sm:hidden"
                    >
                      {lineLabel}
                    </span>
                    <span
                      data-testid="rental-checked-out-narrow"
                      className="text-muted-foreground block text-[12px] leading-[18px] md:hidden"
                      suppressHydrationWarning
                    >
                      Checked out {formatRelative(rental.checked_out_at)}
                    </span>
                  </TableCell>

                  {/* Items summary */}
                  <TableCell className="hidden sm:table-cell">
                    <span className="text-ink-2 block max-w-[220px] truncate" title={lineLabel}>
                      {lineLabel}
                    </span>
                  </TableCell>

                  {/* Checkout date */}
                  <TableCell
                    className="text-muted-foreground hidden whitespace-nowrap text-[12.5px] md:table-cell"
                    suppressHydrationWarning
                  >
                    {formatRelative(rental.checked_out_at)}
                  </TableCell>

                  {/* Expected return */}
                  <TableCell className="min-w-[120px]">
                    {rental.status === 'out' ? (
                      <>
                        <DueLabel
                          expectedReturnAt={rental.expected_return_at}
                          nowMs={nowMs}
                          timeZone={timeZone}
                        />
                        {reminderMarks?.[rental.id] ? (
                          <span
                            data-testid="reminder-mark"
                            className="text-muted-foreground block text-[12px] leading-[18px]"
                          >
                            {reminderMarks[rental.id]}
                          </span>
                        ) : null}
                      </>
                    ) : rental.returned_at ? (
                      <span
                        className="text-muted-foreground text-[12.5px]"
                        suppressHydrationWarning
                      >
                        {formatRelative(rental.returned_at)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-[12.5px]">—</span>
                    )}
                  </TableCell>

                  {/* Status */}
                  <TableCell>
                    <RentalStatusBadge status={status} />
                  </TableCell>

                  {/* Actions: 28 px buttons 8 px apart (the touch rule in
                      button.tsx): one row from sm up, stacked on a phone. The
                      borrower and return cells keep a reading width there, so
                      a phone scrolls the table inside its card instead of
                      squeezing the names to a word a line, and this cell stays
                      pinned to the card's right edge there (ACTIONS_PINNED) so
                      View, Mark returned and Cancel… are on screen without
                      scrolling. */}
                  <TableCell className={cn(ACTIONS_PINNED, 'max-sm:group-hover:bg-muted')}>
                    <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center sm:justify-end">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/dashboard/rentals/${rental.id}`}>View</Link>
                      </Button>

                      {canCreate && rental.status === 'out' && (
                        <Button variant="outline" size="sm" onClick={() => setReturnTarget(rental)}>
                          Mark returned
                        </Button>
                      )}

                      {canManage && rental.status === 'out' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setCancelTarget(rental)}
                        >
                          Cancel…
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
