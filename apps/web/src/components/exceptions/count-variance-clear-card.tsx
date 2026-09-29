import Link from 'next/link';

import { RecountButton } from '@/components/exceptions/recount-selection';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ExceptionOccurrence } from '@/server/services/exception-occurrences';

import {
  activeRecountCopy,
  COUNT_VARIANCE_CLEARS_TITLE,
  countVarianceClearCopy,
  RECOUNT_NONE_LINKED_COPY,
  type CountConfirmBlock,
  type OccurrenceState,
} from '@stockpilot/core';

/**
 * WHAT CLEARS THIS, at the top of an open count difference (count_variance;
 * owner decision 2026-09-29, after EX-000059 was acknowledged in the belief
 * that it would close). Directly under the header and above the facts, where
 * it is read before Acknowledge; for this rule it replaces the page's Recount
 * card and the "What clears this" card at the bottom.
 *
 * Every word is core's countVarianceClearCopy (the phone shows the same):
 * the always-true lead, what clears it for this state and this reader, and
 * the reason when Confirm is withheld. It carries everything the Recount card
 * did: the active recount (linked to its count), that none is linked, Recount
 * itself, and what a count covers or why this reader cannot start one.
 *
 * `countConfirm` is the server's block; this release never sends one, so the
 * words are the recount-only ones and nothing here offers Confirm. Whether
 * Recount shows, and whether it is the filled button, is core's too
 * (offerRecount, recountEmphasis): filled only where it is this reader's way
 * to clear the row, outline beside Confirm and while the row settles by
 * itself (a linked recount in progress, a posted one being checked), and
 * hidden once the item can no longer be counted.
 *
 * Server-safe (no 'use client'): the page renders it, and RecountButton is its
 * own client component (recurring pattern #8).
 */
export function CountVarianceClearCard({
  occurrence: o,
  displayed,
  countConfirm,
  timeZone,
}: {
  occurrence: ExceptionOccurrence;
  displayed: OccurrenceState;
  countConfirm: CountConfirmBlock | null;
  timeZone: string;
}) {
  const copy = countVarianceClearCopy({
    facts: o.facts,
    displayed,
    recount: o.recount,
    canAct: o.canAct,
    canRecount: o.canRecount,
    recountUnavailableReason: o.recountUnavailableReason,
    confirm: countConfirm,
  });
  const titleId = `count-variance-clears-${o.id}`;
  return (
    <Card role="region" aria-labelledby={titleId} data-testid="count-variance-clears">
      <CardHeader className="pb-2">
        <CardTitle id={titleId} className="text-base">
          {COUNT_VARIANCE_CLEARS_TITLE}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="font-medium">{copy.lead}</p>
        <p>{copy.options}</p>
        {copy.who ? <p className="text-muted-foreground">{copy.who}</p> : null}
        {o.recount ? (
          <p data-testid="active-recount">
            <Link href={`/dashboard/cycle-counts/${o.recount.cycleCountId}`} className="font-medium hover:underline">
              {activeRecountCopy(o.recount)}
            </Link>
          </p>
        ) : copy.offerRecount ? (
          <p className="text-muted-foreground">{RECOUNT_NONE_LINKED_COPY}</p>
        ) : null}
        {copy.offerRecount ? (
          <div className="flex flex-wrap gap-2">
            <RecountButton
              occurrenceId={o.id}
              reference={o.reference}
              timeZone={timeZone}
              variant={copy.recountEmphasis === 'primary' ? 'default' : 'outline'}
              size="default"
              className="pointer-coarse:min-h-11"
            />
          </div>
        ) : null}
        {copy.recountLine ? <p className="text-muted-foreground">{copy.recountLine}</p> : null}
        {copy.reason ? (
          <p className="text-muted-foreground" data-testid="confirm-unavailable">
            {copy.reason}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
