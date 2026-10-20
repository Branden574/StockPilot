import { Link2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';

import { StateChip, stateOf } from '@/components/exceptions/occurrence-display';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, withContext } from '@/server/services/context';
import {
  ExceptionOccurrencesService,
  type CountLinkedException,
  type CountLinkedExceptions,
} from '@/server/services/exception-occurrences';

import {
  COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY,
  describeOccurrence,
  exceptionUnrecognizedCopy,
  recountOutcomeCopy,
} from '@stockpilot/core';

/**
 * A COUNT'S LINKED EXCEPTIONS (F1-2), on the web cycle-count page.
 *
 * Every exception a recount linked to this count (read from the
 * recount_linked events, so the list survives after the count closes), with
 * what the count says about its item:
 *   - while the count is open, the counted line's numbers at count time and
 *     WHERE THE DIFFERENCE LANDS when it is posted (core varianceReviewLine,
 *     mirroring ledger.post_cycle_count), or "Not counted yet";
 *   - once it is closed, what it came to (core recountOutcomeCopy).
 *
 * The count page streams this under Suspense, so the count itself never waits
 * for it. A failed read says "unavailable", never nothing: a missing block on
 * a recount would read as "this count settles no exception". A count no
 * exception is linked to renders nothing at all.
 */
export async function LinkedExceptionsBlock({ cycleCountId }: { cycleCountId: string }) {
  let linked: CountLinkedExceptions | null;
  try {
    const ctx = await withContext();
    linked = await new ExceptionOccurrencesService(ctx).listForCount(cycleCountId);
  } catch (e) {
    // Not permitted to read exceptions (or the count is gone): nothing to
    // show this reader. Anything else is a failure the reader is told about.
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'not_found'))
      return null;
    void reportError(e, { tag: 'cycle_counts.linked_exceptions' });
    linked = null;
  }
  return <LinkedExceptionsView linked={linked} />;
}

/** The block itself, from an answer (null = the read failed). Exported for
 *  tests. Drawn as a card in the count page's side rail (DESIGN-SPEC 6.7): the
 *  title and its one-line explanation in the header, one row per exception
 *  (its link, where the difference lands or what it came to, its state), and a
 *  failed read as the caution wash, never as nothing. */
export function LinkedExceptionsView({ linked }: { linked: CountLinkedExceptions | null }) {
  if (linked === null) {
    return (
      <div
        role="alert"
        className="bg-warning-wash text-warning flex items-start gap-2.5 rounded-lg px-[18px] py-3 text-[13px] leading-5"
        data-testid="linked-exceptions-unavailable"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY} Reload the page to try again.</p>
      </div>
    );
  }
  const unrecognized = exceptionUnrecognizedCopy(linked.unrecognized);
  if (linked.exceptions.length === 0 && !unrecognized) return null;

  return (
    <section
      aria-label="Linked exceptions"
      className="border-border bg-card text-card-foreground min-w-0 overflow-hidden rounded-lg border"
      data-testid="linked-exceptions"
    >
      <div className="border-border border-b px-[18px] py-3.5">
        <h2 className="flex items-center gap-1.5 text-[13.5px] font-medium leading-5">
          <Link2 className="text-muted-foreground size-4 shrink-0" aria-hidden />
          Linked exceptions
        </h2>
        <p className="text-muted-foreground mt-1 text-[12px] leading-[18px]">
          This count was started to recheck these. The system checks them again after it is posted.
        </p>
      </div>
      {linked.exceptions.length > 0 ? (
        <ul className="divide-border divide-y">
          {linked.exceptions.map((x) => (
            <LinkedRow key={x.occurrence.id} x={x} linked={linked} />
          ))}
        </ul>
      ) : null}
      {unrecognized ? (
        <p
          className={
            linked.exceptions.length > 0
              ? 'border-border text-muted-foreground border-t px-[18px] py-3 text-[12px]'
              : 'text-muted-foreground px-[18px] py-3 text-[12px]'
          }
        >
          {unrecognized}
        </p>
      ) : null}
    </section>
  );
}

function LinkedRow({ x, linked }: { x: CountLinkedException; linked: CountLinkedExceptions }) {
  const o = x.occurrence;
  const d = describeOccurrence(o.rule, o.facts, {
    itemName: o.item?.name ?? null,
    conditionSince: o.conditionSince,
    asOf: o.resolvedAt ?? new Date(),
  });
  // While the count is open: where this line's difference lands. Once it is
  // closed: what it came to.
  const result =
    linked.status === 'in_progress'
      ? (x.reviewLine ??
        (x.line ? 'Not counted yet' : 'This item’s line could not be found in the count'))
      : recountOutcomeCopy(x.outcome);
  return (
    <li className="flex min-w-0 flex-col items-start gap-1.5 px-[18px] py-3">
      <Link
        href={`/dashboard/exceptions/${o.id}`}
        className="text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere] hover:underline"
      >
        {o.reference ? (
          <span className="text-muted-foreground mr-2 font-mono text-[11.5px] font-normal">
            {o.reference}
          </span>
        ) : null}
        {d.title}
      </Link>
      <p
        className="text-ink-2 text-[12.5px] leading-[18px] [overflow-wrap:anywhere]"
        data-testid="linked-exception-result"
      >
        {result}
      </p>
      <StateChip state={stateOf(o, linked.syncState)} />
    </li>
  );
}
