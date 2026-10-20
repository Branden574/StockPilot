import { AlertTriangle, CheckCircle2, Clock, Mail, MinusCircle } from 'lucide-react';

import { DetailSection, DetailSectionMeta } from '@/components/patterns/detail-section';
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

// Token tones (DESIGN-SPEC 6.10) in place of the old emerald / blue / amber
// palette. Each line keeps its own icon and its words, so the colour is never
// the only cue. An email still to come is the neutral ink, not the accent: the
// accent is the "recorded" (already sent) tone, and the two must not read alike.
const TONE_CLASS: Record<RentalEmailTone, string> = {
  recorded: 'text-success',
  rule: 'text-muted-foreground',
  upcoming: 'text-ink-2',
  none: 'text-ink-4',
  warn: 'text-warning',
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
    <DetailSection
      aria-labelledby="rental-emails-heading"
      title={<span id="rental-emails-heading">Emails to the borrower</span>}
      aside={
        <DetailSectionMeta className="min-w-0 [overflow-wrap:anywhere]">
          {email ? <>Rental emails go to {email}</> : 'No email on file'}
        </DetailSectionMeta>
      }
      footer={
        email ? (
          <p className="text-muted-foreground text-[12px] leading-[18px]">
            {RENTAL_EMAILS_RECORD_NOTE}
          </p>
        ) : undefined
      }
      flush
    >
      <ul className="divide-border divide-y">
        {lines.map((line) => {
          const Icon = TONE_ICON[line.tone];
          return (
            <li
              key={line.key}
              data-email={line.key}
              data-tone={line.tone}
              className="flex gap-3 px-[18px] py-3"
            >
              <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 flex-none', TONE_CLASS[line.tone])} />
              <div className="min-w-0">
                <p className="text-foreground text-[13.5px] font-medium">{line.label}</p>
                <p className="text-muted-foreground text-[13px]">{line.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </DetailSection>
  );
}
