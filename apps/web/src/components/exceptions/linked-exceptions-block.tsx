import { AlertTriangle, Link2 } from 'lucide-react';
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
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'not_found')) return null;
    void reportError(e, { tag: 'cycle_counts.linked_exceptions' });
    linked = null;
  }
  return <LinkedExceptionsView linked={linked} />;
}

/** The block itself, from an answer (null = the read failed). Exported for
 *  tests. */
export function LinkedExceptionsView({ linked }: { linked: CountLinkedExceptions | null }) {
  if (linked === null) {
    return (
      <div
        role="alert"
        className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
        data-testid="linked-exceptions-unavailable"
      >
        <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY} Reload the page to try again.</p>
      </div>
    );
  }
  const unrecognized = exceptionUnrecognizedCopy(linked.unrecognized);
  if (linked.exceptions.length === 0 && !unrecognized) return null;

  return (
    <section
      aria-label="Linked exceptions"
      className="border-border bg-card rounded-xl border px-4 py-3"
      data-testid="linked-exceptions"
    >
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Link2 className="text-muted-foreground size-4" aria-hidden />
        Linked exceptions
      </h2>
      <p className="text-muted-foreground mt-0.5 text-xs">
        This count was started to recheck these. The system checks them again after it is posted.
      </p>
      <ul className="divide-border mt-2 divide-y">
        {linked.exceptions.map((x) => (
          <LinkedRow key={x.occurrence.id} x={x} linked={linked} />
        ))}
      </ul>
      {unrecognized ? <p className="text-muted-foreground mt-2 text-xs">{unrecognized}</p> : null}
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
      ? (x.reviewLine ?? (x.line ? 'Not counted yet' : 'This item’s line could not be found in the count'))
      : recountOutcomeCopy(x.outcome);
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0 space-y-0.5">
        <Link href={`/dashboard/exceptions/${o.id}`} className="text-sm font-medium break-words hover:underline">
          {o.reference ? <span className="text-muted-foreground mr-2 font-mono text-xs">{o.reference}</span> : null}
          {d.title}
        </Link>
        <p className="text-xs break-words" data-testid="linked-exception-result">
          {result}
        </p>
      </div>
      <div className="shrink-0">
        <StateChip state={stateOf(o, linked.syncState)} />
      </div>
    </li>
  );
}
