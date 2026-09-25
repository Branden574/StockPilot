import { AlertTriangle, CheckCircle2, Clock, Mail, MinusCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  RENTAL_EMAILS_RECORD_NOTE,
  rentalEmailLines,
  rentalEmailOnFile,
  type RentalEmailFacts,
  type RentalEmailTone,
} from '@stockpilot/core';

const TONE_ICON: Record<RentalEmailTone, typeof Mail> = {
  recorded: CheckCircle2,
  rule: Mail,
  upcoming: Clock,
  none: MinusCircle,
  warn: AlertTriangle,
};

const TONE_CLASS: Record<RentalEmailTone, string> = {
  recorded: 'text-emerald-600 dark:text-emerald-400',
  rule: 'text-muted-foreground',
  upcoming: 'text-blue-600 dark:text-blue-400',
  none: 'text-muted-foreground/70',
  warn: 'text-amber-600 dark:text-amber-400',
};

interface RentalEmailsCardProps {
  rental: RentalEmailFacts;
  /** The organization's Rentals row as the overdue sweep reads it; null = unreadable. */
  remindersOn: boolean | null;
  /** The moment the page was rendered, so the card and the header agree on "overdue". */
  nowMs: number;
  /** The organization's zone, for the reminder's date and time. */
  timeZone: string;
}

/**
 * The emails this rental's borrower gets, and where each one stands.
 *
 * Every sentence comes from @stockpilot/core (rentals/emails.ts), which the
 * phone renders too and which shares its overdue rule with the daily sweep
 * that sends the reminder. The receipt and the confirmation are described by
 * their rule, never as sent: nothing records them. Only the overdue reminder
 * carries a real time.
 */
export function RentalEmailsCard({ rental, remindersOn, nowMs, timeZone }: RentalEmailsCardProps) {
  const email = rentalEmailOnFile(rental.borrower_email);
  const lines = rentalEmailLines(rental, remindersOn, nowMs, timeZone);

  return (
    <section aria-labelledby="rental-emails-heading" className="rounded-xl border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b">
        <h2 id="rental-emails-heading" className="text-sm font-semibold">
          Emails to the borrower
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {email ? <>Rental emails go to {email}</> : 'No email on file'}
        </p>
      </div>
      <ul className="divide-y">
        {lines.map((line) => {
          const Icon = TONE_ICON[line.tone];
          return (
            <li key={line.key} data-email={line.key} data-tone={line.tone} className="flex gap-3 px-4 py-3">
              <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 flex-none', TONE_CLASS[line.tone])} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{line.label}</p>
                <p className="text-sm text-muted-foreground">{line.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
      {email ? (
        <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">{RENTAL_EMAILS_RECORD_NOTE}</p>
      ) : null}
    </section>
  );
}
