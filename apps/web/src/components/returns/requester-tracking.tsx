'use client';

import { ArrowRight, Undo2 } from 'lucide-react';
import * as React from 'react';

import { eyebrowClass } from '@/components/returns/returns-ui';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';

import {
  RETURNS_COPY,
  requesterTrackingLineWords,
  type RequesterTrackingLine,
  type RequesterTrackingReturn,
} from '@stockpilot/core';

/**
 * "Your requests on this order" (returns RX-3, brief 28): the requester's own
 * requests, newest first, on the token page, the B2B portal and a member's
 * own order. Per request: its RMA number and day, one or two sentences the
 * server wrote (core requesterTrackingSentences: the return's status, then
 * the exchange's, never merged), and per line what comes back and what
 * replaces it ("Changed by the warehouse" when the warehouse approved another
 * item), then the replacement's SO number once it exists.
 *
 * It renders ONLY core's tracking fields, which cannot carry a rack, Staging,
 * a disposition or destination, a supplier, a cost, a quantity on record, a
 * note, a reason or a staff member (requester-exchange-types.ts).
 *
 * The day is the viewer's own: printed once hydrated (useHydrated), never the
 * server's zone (React error #418, the portal's lesson).
 */
export function RequesterTracking({
  requests,
  headingLevel = 2,
  density = 'page',
  className,
  id,
}: {
  requests: readonly RequesterTrackingReturn[];
  headingLevel?: 2 | 3;
  density?: 'page' | 'compact';
  className?: string;
  id?: string;
}) {
  const hydrated = useHydrated();
  const fallbackId = React.useId();
  const headingId = `${id ?? fallbackId}-heading`;
  if (requests.length === 0) return null;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const compact = density === 'compact';
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(compact ? 'space-y-2' : 'space-y-3', className)}
    >
      <Heading
        id={headingId}
        className={
          compact
            ? 'text-foreground text-[13.5px] font-medium leading-5'
            : 'text-foreground font-display text-[18px] font-medium leading-snug tracking-[-0.02em]'
        }
      >
        {RETURNS_COPY.requesterYourRequests}
      </Heading>
      <ul className={compact ? 'space-y-2' : 'space-y-3'}>
        {requests.map((r, i) => (
          <li
            key={`${r.returnNumber ?? 'request'}-${r.createdAt}-${i}`}
            className={cn(
              'bg-card border-border space-y-2 rounded-lg border',
              compact ? 'p-3' : 'p-4',
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] font-medium tabular-nums">
                {r.returnNumber ?? RETURNS_COPY.requesterRequestTitle}
              </span>
              {hydrated ? (
                <time dateTime={r.createdAt} className="text-muted-foreground text-[12px]">
                  {new Date(r.createdAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </time>
              ) : null}
            </div>
            {r.sentences.length > 0 ? (
              <div className="space-y-0.5">
                {r.sentences.map((s, j) => (
                  <p
                    key={`${j}-${s}`}
                    className={cn('text-[13px]', j === 0 ? 'font-medium' : 'text-ink-2')}
                  >
                    {s}
                  </p>
                ))}
              </div>
            ) : null}
            {r.lines.length > 0 ? (
              <ul className="space-y-2">
                {r.lines.map((line, j) => (
                  <TrackingLine key={j} line={line} compact={compact} />
                ))}
              </ul>
            ) : null}
            {r.replacementOrderNumber ? (
              <p className="text-[13px]">
                {RETURNS_COPY.replacementOrderHeading}:{' '}
                <span className="font-mono font-medium tabular-nums">
                  {r.replacementOrderNumber}
                </span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One returned line: RETURNING, and its REPLACEMENT when it asked for one.
 * Core's words, the phone's too (requesterTrackingLineWords; RX-3 fix round
 * 1, M3 and L4): every line state named, and a note-only request reads "A
 * different replacement" once declined or cancelled.
 */
function TrackingLine({ line, compact }: { line: RequesterTrackingLine; compact: boolean }) {
  const words = requesterTrackingLineWords(line);
  const box = cn('border-border rounded-md border text-[13px]', compact ? 'p-2.5' : 'p-3');
  return (
    <li className={cn('grid gap-2', words.replacement && 'sm:grid-cols-2')}>
      <div className={box}>
        <p className="text-muted-foreground flex items-center gap-1.5">
          <Undo2 className="h-3 w-3" aria-hidden />
          <span className={eyebrowClass}>{RETURNS_COPY.returning}</span>
        </p>
        <p className="mt-1">{words.returning}</p>
      </div>
      {words.replacement ? (
        <div className={cn(box, 'border-l-accent border-l-[3px]')}>
          <p className="flex items-center gap-1.5">
            <ArrowRight className="text-accent h-3 w-3" aria-hidden />
            <span className={eyebrowClass}>{RETURNS_COPY.replacement}</span>
          </p>
          <p className="mt-1">{words.replacement}</p>
          {words.changed ? (
            <p className="text-muted-foreground text-[12px]">{words.changed}</p>
          ) : null}
          {words.state ? <p className="text-muted-foreground text-[12px]">{words.state}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
