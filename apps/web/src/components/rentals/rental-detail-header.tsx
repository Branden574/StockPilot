import type * as React from 'react';

import { deriveRentalStatus, RentalStatusBadge } from '@/components/rentals/rental-status-badge';
import { Badge } from '@/components/ui/badge';
import { cn, formatRelative } from '@/lib/utils';
import type { RentalRow } from '@/server/services/rentals';

import {
  formatRentalDateTime,
  RENTAL_BORROWER_NOT_LINKED,
  RENTAL_BORROWER_TEAM_MEMBER,
  RENTAL_NO_EMAIL_NOTE,
  RENTAL_NON_MEMBER_EMAIL_NOTE,
  rentalEmailOnFile,
} from '@stockpilot/core';

/** A label over its value in the details grid. */
function Detail({
  label,
  children,
  valueClassName,
}: {
  label: string;
  children: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-[12px] leading-[18px]">{label}</dt>
      <dd
        className={cn(
          'text-foreground mt-0.5 text-[13.5px] [overflow-wrap:anywhere]',
          valueClassName,
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/** One of the three note blocks: a quiet inset panel, its label in front. */
function NoteBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-sunk border-border rounded-md border px-3 py-2 text-[13.5px] [overflow-wrap:anywhere]">
      <span className="text-muted-foreground font-medium">{label}: </span>
      {children}
    </div>
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
  const status = deriveRentalStatus(rental, nowMs);
  const isMember = Boolean(rental.borrower_user_id);
  // The address the rental emails go to (the same check the sender makes).
  const email = rentalEmailOnFile(rental.borrower_email);

  return (
    <div className="border-border bg-card text-card-foreground rounded-lg border pb-[18px]">
      {/* Top: borrower and status */}
      <div className="flex items-start justify-between gap-4 px-[18px] pt-[18px]">
        <div className="min-w-0">
          <p className="text-muted-foreground text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.1em]">
            Borrower
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="text-foreground font-display text-[20px] font-medium leading-[28px] tracking-[-0.02em] [overflow-wrap:anywhere]">
              {rental.borrower_name}
            </h2>
            <Badge data-testid="borrower-kind" variant={isMember ? 'success' : 'outline'}>
              {isMember ? RENTAL_BORROWER_TEAM_MEMBER : RENTAL_BORROWER_NOT_LINKED}
            </Badge>
          </div>
          {email ? (
            <>
              <p className="text-ink-2 mt-1 break-all text-[13.5px]">
                <span className="sr-only">Email on file: </span>
                {email}
              </p>
              {!isMember ? (
                <p className="text-muted-foreground mt-0.5 text-[12.5px]">
                  {RENTAL_NON_MEMBER_EMAIL_NOTE}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-warning mt-1 text-[13.5px]">{RENTAL_NO_EMAIL_NOTE}</p>
          )}
        </div>
        <RentalStatusBadge status={status} className="shrink-0" />
      </div>

      {/* Details grid */}
      <dl className="border-border mx-[18px] mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4 sm:grid-cols-3">
        <Detail label="Warehouse">{warehouseName}</Detail>
        <Detail label="Checked out">{formatRelative(rental.checked_out_at)}</Detail>
        <Detail
          label="Expected return"
          valueClassName={status === 'overdue' ? 'text-destructive font-medium' : undefined}
        >
          {/* Core's rental spelling, which the phone's EXPECTED RETURN uses
              too: the same words on every engine ("Oct 2, 2026, 9:51 PM"). */}
          {formatRentalDateTime(rental.expected_return_at, timeZone, { withYear: true })}
        </Detail>
        {rental.returned_at && (
          <Detail label="Returned" valueClassName="text-success font-medium">
            {formatRelative(rental.returned_at)}
          </Detail>
        )}
        {rental.cancelled_at && (
          <Detail label="Cancelled">{formatRelative(rental.cancelled_at)}</Detail>
        )}
      </dl>

      {/* Cancellation reason, return notes, notes */}
      {rental.cancellation_reason || rental.return_notes || rental.notes ? (
        <div className="mt-4 space-y-2 px-[18px]">
          {rental.cancellation_reason && (
            <NoteBlock label="Cancellation reason">{rental.cancellation_reason}</NoteBlock>
          )}
          {rental.return_notes && <NoteBlock label="Return notes">{rental.return_notes}</NoteBlock>}
          {rental.notes && <NoteBlock label="Notes">{rental.notes}</NoteBlock>}
        </div>
      ) : null}
    </div>
  );
}
