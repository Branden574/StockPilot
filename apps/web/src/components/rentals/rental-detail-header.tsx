import { cn, formatRelative } from '@/lib/utils';
import type { RentalRow } from '@/server/services/rentals';

import {
  formatOrgDateTime,
  isRentalOverdue,
  RENTAL_BORROWER_NOT_LINKED,
  RENTAL_BORROWER_TEAM_MEMBER,
  RENTAL_NO_EMAIL_NOTE,
  RENTAL_NON_MEMBER_EMAIL_NOTE,
  rentalEmailOnFile,
} from '@stockpilot/core';

type StatusDisplay = 'out' | 'returned' | 'cancelled' | 'overdue';

function deriveStatus(rental: RentalRow, nowMs: number): StatusDisplay {
  if (rental.status === 'returned') return 'returned';
  if (rental.status === 'cancelled') return 'cancelled';
  if (isRentalOverdue(rental, nowMs)) return 'overdue';
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
        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold',
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  );
}

interface RentalDetailHeaderProps {
  rental: RentalRow;
  warehouseName: string;
  /**
   * The organization's zone. The expected return is printed with its time in
   * it: the overdue reminder's timing (the emails card) depends on that time,
   * and the server's own zone (UTC on Vercel) can name a different day.
   */
  timeZone: string;
  /** The page's render moment, shared with the emails card ("overdue" agrees). */
  nowMs: number;
}

export function RentalDetailHeader({
  rental,
  warehouseName,
  timeZone,
  nowMs,
}: RentalDetailHeaderProps) {
  const status = deriveStatus(rental, nowMs);
  const isMember = Boolean(rental.borrower_user_id);
  // The address the rental emails go to (the same check the sender makes).
  const email = rentalEmailOnFile(rental.borrower_email);

  return (
    <div className="rounded-xl border bg-card p-6 space-y-4">
      {/* Top row: borrower + status */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Borrower</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold break-words">{rental.borrower_name}</h2>
            <span
              data-testid="borrower-kind"
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                isMember ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {isMember ? RENTAL_BORROWER_TEAM_MEMBER : RENTAL_BORROWER_NOT_LINKED}
            </span>
          </div>
          {email ? (
            <>
              <p className="text-sm text-muted-foreground mt-0.5 break-all">
                <span className="sr-only">Email on file: </span>
                {email}
              </p>
              {!isMember ? (
                <p className="text-xs text-muted-foreground mt-0.5">{RENTAL_NON_MEMBER_EMAIL_NOTE}</p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">{RENTAL_NO_EMAIL_NOTE}</p>
          )}
        </div>
        <StatusPill status={status} />
      </div>

      {/* Details grid */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Warehouse
          </dt>
          <dd className="mt-1 font-medium">{warehouseName}</dd>
        </div>

        <div>
          <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Checked out
          </dt>
          <dd className="mt-1">{formatRelative(rental.checked_out_at)}</dd>
        </div>

        <div>
          <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Expected return
          </dt>
          <dd
            className={cn(
              'mt-1',
              status === 'overdue' ? 'text-red-600 dark:text-red-400 font-medium' : '',
            )}
          >
            {formatOrgDateTime(
              rental.expected_return_at,
              { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
              timeZone,
            )}
          </dd>
        </div>

        {rental.returned_at && (
          <div>
            <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Returned
            </dt>
            <dd className="mt-1 text-emerald-700 dark:text-emerald-400 font-medium">
              {formatRelative(rental.returned_at)}
            </dd>
          </div>
        )}

        {rental.cancelled_at && (
          <div>
            <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Cancelled
            </dt>
            <dd className="mt-1">{formatRelative(rental.cancelled_at)}</dd>
          </div>
        )}
      </dl>

      {/* Cancellation reason */}
      {rental.cancellation_reason && (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="font-medium text-muted-foreground">Cancellation reason: </span>
          {rental.cancellation_reason}
        </div>
      )}

      {/* Return notes */}
      {rental.return_notes && (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="font-medium text-muted-foreground">Return notes: </span>
          {rental.return_notes}
        </div>
      )}

      {/* Notes */}
      {rental.notes && (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="font-medium text-muted-foreground">Notes: </span>
          {rental.notes}
        </div>
      )}
    </div>
  );
}
