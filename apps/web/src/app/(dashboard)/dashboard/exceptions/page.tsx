import { AlertTriangle, CheckCircle2, ChevronRight, Clock } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { ServiceError, withContext } from '@/server/services/context';
import {
  ExceptionOccurrencesService,
  type ExceptionOccurrence,
  type OccurrenceListResult,
} from '@/server/services/exception-occurrences';

import {
  countExceptions,
  describeOccurrence,
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  EXCEPTION_RULES,
  groupExceptions,
  occurrenceKey,
  recurrenceBadge,
  type WarehouseException,
} from '@stockpilot/core';

export const metadata = { title: 'Exceptions · StockPilot' };

/**
 * THE EXCEPTION CENTER.
 *
 * Built first, ahead of the warehouse work queue, because the operation was
 * measured before either was built: one order in flight, nothing sitting in a
 * non-terminal status, staging cleared inside two days. There is no backlog for
 * a queue to manage. What there was: conditions that were simply wrong, which
 * nothing surfaced. This page surfaces them.
 *
 * Since F1-1 (migration 0370) the page reads STORED occurrences: the system
 * evaluates the rules org-wide every 15 minutes and after each posted or
 * cancelled count, and this page renders what it found, with "Checked at".
 * The page never evaluates or syncs, so it costs one read. Before an org's
 * first check it says so, and never shows the all-clear state.
 *
 * INTERIM RENDERING: stage 3 of F1-1 replaces this body with the Open and
 * Resolved tabs, state chips and the occurrence detail. What is here keeps
 * the rules that stage must also keep: a failed read renders "unavailable",
 * never an empty list, and an unchecked org never reads as all clear.
 */
export default async function ExceptionsPage() {
  let svc: ExceptionOccurrencesService;
  try {
    svc = await ExceptionOccurrencesService.forCurrentUser();
  } catch (e) {
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'not_found')) notFound();
    throw e;
  }

  let result: OccurrenceListResult | null = null;
  try {
    result = await svc.list({ status: 'open' });
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'forbidden') notFound();
    // Any other failure renders "unavailable" below. An empty list here
    // would read as "nothing wrong", which is the one thing it must not say.
    result = null;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Exceptions</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Conditions that are wrong and that nothing else tells you about. The system checks
          every 15 minutes and after each posted count; fix the cause and the row resolves on the
          next check.
        </p>
      </header>
      {result === null ? (
        <Unavailable />
      ) : (
        <OpenList
          result={result}
          checkedAt={result.syncState ? await checkedAtLabel(result.syncState.lastSyncedAt) : null}
        />
      )}
    </div>
  );
}

function Unavailable() {
  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
    >
      <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <p>Exceptions are unavailable right now. Reload the page to try again.</p>
    </div>
  );
}

async function checkedAtLabel(iso: string): Promise<string> {
  let timeZone = 'America/Los_Angeles';
  try {
    const ctx = await withContext();
    timeZone = await getCachedOrgTimezone(ctx.organizationId);
  } catch {
    // Formatting only: fall back to the default zone.
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function toRow(o: ExceptionOccurrence): WarehouseException & { occurrence: ExceptionOccurrence } {
  const d = describeOccurrence(o.rule, o.facts, {
    itemName: o.item?.name ?? null,
    conditionSince: o.conditionSince,
  });
  return {
    rule: o.rule,
    key: occurrenceKey(o),
    title: d.title,
    detail: d.detail,
    href: `/dashboard/inventory/${o.itemId}`,
    units: d.units ?? undefined,
    occurrence: o,
  };
}

function OpenList({
  result,
  checkedAt,
}: {
  result: OccurrenceListResult;
  checkedAt: string | null;
}) {
  const state = result.syncState;
  if (state === null) {
    // Not checked yet. Whatever rows exist, the empty state must not read as
    // all clear.
    return (
      <div
        role="status"
        className="bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
      >
        <Clock className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{EXCEPTION_FIRST_CHECK_PENDING_COPY}</p>
      </div>
    );
  }

  const rows = result.occurrences.map(toRow);
  const byKey = new Map(rows.map((r) => [r.key, r.occurrence]));
  const groups = groupExceptions(rows);
  const { total, critical } = countExceptions(rows);
  // Rules the last check could not vouch for. Their silence is UNKNOWN, not
  // clean, so the page names them and never shows "Nothing needs attention"
  // while any is out.
  const uncheckedLabels = [...new Set([...state.failedRules, ...state.truncatedRules])].map(
    (rule) => EXCEPTION_RULES[rule].label,
  );

  return (
    <>
      <p className="text-muted-foreground mb-4 text-xs">Checked at {checkedAt}</p>

      {uncheckedLabels.length > 0 && (
        <div
          role="alert"
          className="border-warning/40 bg-warning/5 mb-5 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {uncheckedLabels.length === 1 ? 'One check' : `${uncheckedLabels.length} checks`} could
            not complete on the last run: {uncheckedLabels.join(', ')}. What{' '}
            {uncheckedLabels.length === 1 ? 'it' : 'they'} would show is unknown, not clean.
          </p>
        </div>
      )}

      {result.truncated && (
        <p className="text-warning mb-4 text-xs">
          Showing the first {rows.length} open exceptions. There are more.
        </p>
      )}

      {total === 0 && uncheckedLabels.length > 0 ? null : total === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CheckCircle2 className="text-success size-7" aria-hidden />
            <p className="text-base font-medium">Nothing needs attention</p>
            <p className="text-muted-foreground max-w-md text-sm">
              No archived locations holding stock, nothing over-promised, nothing stranded in
              Staging or Unplaced, and every rack label agrees with where the stock actually is.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Badge variant={critical > 0 ? 'destructive' : 'secondary'} className="gap-1">
              {critical > 0 && <AlertTriangle className="size-3" aria-hidden />}
              {total} open
            </Badge>
            {critical > 0 && (
              <span className="text-muted-foreground text-xs">{critical} need attention now</span>
            )}
          </div>

          <div className="space-y-4">
            {groups.map((g) => (
              <Card key={g.meta.rule}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{g.meta.label}</CardTitle>
                    <Badge
                      variant={g.meta.severity === 'critical' ? 'destructive' : 'secondary'}
                      className="gap-1"
                    >
                      {g.meta.severity === 'critical' && (
                        <AlertTriangle className="size-3" aria-hidden />
                      )}
                      {g.meta.severity === 'critical' ? 'Critical' : 'Warning'}
                    </Badge>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {g.items.length}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm">{g.meta.action}</p>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="divide-border divide-y">
                    {g.items.map((e) => (
                      <OccurrenceRow key={e.key} e={e} o={byKey.get(e.key)!} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function OccurrenceRow({ e, o }: { e: WarehouseException; o: ExceptionOccurrence }) {
  const recurred = recurrenceBadge(o.recurrenceIndex);
  return (
    <li>
      <Link
        href={e.href ?? `/dashboard/inventory/${o.itemId}`}
        className="hover:bg-muted/50 focus-visible:ring-ring block rounded-sm px-1 focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {o.reference && (
                <span className="text-muted-foreground mr-2 font-mono text-xs">{o.reference}</span>
              )}
              {e.title}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {e.detail}
              {o.presentWhenTrackingBegan && ' · Already present when tracking began'}
              {o.acknowledgedAt && ' · Acknowledged'}
              {recurred && ` · ${recurred}`}
            </p>
          </div>
          <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
        </div>
      </Link>
    </li>
  );
}
