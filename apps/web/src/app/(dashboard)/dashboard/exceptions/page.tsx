import { CheckCircle2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CheckNowButton } from '@/components/exceptions/check-now-button';
import {
  CheckedAt,
  ExceptionsUnavailable,
  exceptionTime,
  FirstCheckPending,
  RecurrenceChip,
  SeverityChip,
  StateChip,
  stateOf,
  UncheckedRulesBanner,
  uncheckedRuleLabels,
} from '@/components/exceptions/occurrence-display';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import {
  ExceptionOccurrencesService,
  type ExceptionOccurrence,
  type ExceptionSyncState,
  type OccurrenceListResult,
  type OccurrenceListStatus,
} from '@/server/services/exception-occurrences';

import {
  describeOccurrence,
  EXCEPTION_ALL_CLEAR_TITLE,
  EXCEPTION_NONE_RESOLVED_COPY,
  EXCEPTION_RESOLVED_WINDOW_DAYS,
  EXCEPTION_RULES,
  groupOccurrences,
  resolveOrgTimezone,
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
 * ═══ CONDITIONS ARE DERIVED, THE LIFECYCLE IS STORED (F1-1, migration 0370) ═══
 *
 * The rules are still evaluated from live data, never stored as settings. What
 * is stored is each occurrence's lifecycle: the system evaluates every rule
 * org-wide every 15 minutes (the cron) and after each posted or cancelled
 * count, raises an occurrence (EX-000042) the first time it finds a condition,
 * and resolves it by itself once a complete check no longer finds it. NO
 * PERSON RESOLVES AN OCCURRENCE: people can acknowledge one and add notes.
 *
 * This page renders the stored state with "Checked at". It never evaluates or
 * syncs (owner decision F1 Q9: freshness must not slow a page down), so it
 * costs one list read plus the org's sync state. A manager's "Check now"
 * schedules a check after the response and returns at once.
 *
 * What it must never get wrong:
 *   - a failed read renders "unavailable", never an empty list (pattern #1);
 *   - before the org's first check it says so, and never shows all clear;
 *   - a rule the last check could not vouch for (failed or truncated) is
 *     named, and the all-clear state is withheld while any is out.
 */
type SearchParams = { tab?: string | string[] };

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function orgTimeZone(organizationId: string): Promise<string> {
  try {
    return await getCachedOrgTimezone(organizationId);
  } catch {
    // Formatting only: the default zone.
    return resolveOrgTimezone(null);
  }
}

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  let ctx: ServiceContext;
  try {
    ctx = await withContext();
  } catch (e) {
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'not_found')) notFound();
    throw e;
  }
  const sp = (await searchParams) ?? {};
  const tab: OccurrenceListStatus = firstParam(sp.tab) === 'resolved' ? 'resolved' : 'open';

  let result: OccurrenceListResult | null = null;
  try {
    result = await new ExceptionOccurrencesService(ctx).list({ status: tab });
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'forbidden') notFound();
    // Any other failure renders "unavailable" below. An empty list here
    // would read as "nothing wrong", which is the one thing it must not say.
    result = null;
  }
  const timeZone = await orgTimeZone(ctx.organizationId);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:py-8">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Exceptions</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Conditions that are wrong and that nothing else tells you about. Each one keeps its
            number while it lasts; fix the cause and the system resolves it on the next check.
          </p>
        </div>
        {result?.canCheckNow ? <CheckNowButton /> : null}
      </header>

      <nav aria-label="Exception lists" className="mb-4 flex flex-wrap gap-1">
        <TabLink href="/dashboard/exceptions" active={tab === 'open'}>
          Open
          {tab === 'open' && result && result.syncState ? ` (${result.occurrences.length})` : ''}
        </TabLink>
        <TabLink href="/dashboard/exceptions?tab=resolved" active={tab === 'resolved'}>
          Resolved, last {EXCEPTION_RESOLVED_WINDOW_DAYS} days
        </TabLink>
      </nav>

      {result === null ? (
        <ExceptionsUnavailable />
      ) : result.syncState === null ? (
        // Not checked yet. Whatever rows exist, nothing here may read as all
        // clear.
        <FirstCheckPending />
      ) : tab === 'open' ? (
        <OpenList result={result} syncState={result.syncState} timeZone={timeZone} />
      ) : (
        <ResolvedList result={result} syncState={result.syncState} timeZone={timeZone} />
      )}
    </div>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'bg-foreground text-background rounded-md px-2.5 py-1.5 text-xs font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted rounded-md px-2.5 py-1.5 text-xs font-medium'
      }
    >
      {children}
    </Link>
  );
}

function OpenList({
  result,
  syncState,
  timeZone,
}: {
  result: OccurrenceListResult;
  syncState: ExceptionSyncState;
  timeZone: string;
}) {
  const groups = groupOccurrences(result.occurrences);
  const unchecked = uncheckedRuleLabels(syncState);

  return (
    <div className="space-y-4">
      <CheckedAt syncState={syncState} timeZone={timeZone} />
      <UncheckedRulesBanner labels={unchecked} />
      {result.truncated && (
        <p className="text-warning text-xs">
          Showing the first {result.occurrences.length} open exceptions. There are more.
        </p>
      )}

      {groups.length === 0 ? (
        // With a rule unchecked, silence is unknown: no all-clear.
        unchecked.length > 0 ? null : (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <CheckCircle2 className="text-success size-7" aria-hidden />
              <p className="text-base font-medium">{EXCEPTION_ALL_CLEAR_TITLE}</p>
              <p className="text-muted-foreground max-w-md text-sm">
                No archived locations holding stock, nothing over-promised, nothing stranded in
                Staging or Unplaced, and every rack label agrees with where the stock actually is.
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        groups.map((g) => (
          <Card key={g.meta.rule}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{g.meta.label}</CardTitle>
                <SeverityChip rule={g.meta.rule} />
                <span className="text-muted-foreground text-xs tabular-nums">{g.rows.length}</span>
              </div>
              <p className="text-muted-foreground mt-1 text-sm">{g.meta.action}</p>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="divide-border divide-y">
                {g.rows.map((r) => (
                  <OccurrenceRow
                    key={r.occurrence.id}
                    o={r.occurrence}
                    title={r.description.title}
                    detail={r.description.detail}
                    syncState={syncState}
                    timeZone={timeZone}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function ResolvedList({
  result,
  syncState,
  timeZone,
}: {
  result: OccurrenceListResult;
  syncState: ExceptionSyncState;
  timeZone: string;
}) {
  return (
    <div className="space-y-4">
      <CheckedAt syncState={syncState} timeZone={timeZone} />
      {result.truncated && (
        <p className="text-warning text-xs">
          Showing the {result.occurrences.length} most recently resolved. There are more.
        </p>
      )}
      {result.occurrences.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground text-sm">{EXCEPTION_NONE_RESOLVED_COPY}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-2">
            <ul className="divide-border divide-y">
              {result.occurrences.map((o) => {
                const d = describeOccurrence(o.rule, o.facts, {
                  itemName: o.item?.name ?? null,
                  conditionSince: o.conditionSince,
                  asOf: o.resolvedAt ?? new Date(),
                });
                return (
                  <OccurrenceRow
                    key={o.id}
                    o={o}
                    title={d.title}
                    detail={d.detail}
                    syncState={syncState}
                    timeZone={timeZone}
                    showRule
                  />
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OccurrenceRow({
  o,
  title,
  detail,
  syncState,
  timeZone,
  showRule = false,
}: {
  o: ExceptionOccurrence;
  title: string;
  detail: string;
  syncState: ExceptionSyncState;
  timeZone: string;
  showRule?: boolean;
}) {
  const when = o.resolvedAt
    ? `Resolved ${exceptionTime(o.resolvedAt, timeZone)}`
    : o.presentWhenTrackingBegan
      ? 'Already present when tracking began'
      : `First seen ${exceptionTime(o.firstSeenAt, timeZone)}`;
  return (
    <li>
      <Link
        href={`/dashboard/exceptions/${o.id}`}
        className="hover:bg-muted/50 focus-visible:ring-ring block rounded-sm px-1 focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium break-words">
              {o.reference && (
                <span className="text-muted-foreground mr-2 font-mono text-xs">{o.reference}</span>
              )}
              {title}
            </p>
            <p className="text-muted-foreground text-xs break-words">
              {showRule ? `${EXCEPTION_RULES[o.rule].label} · ` : ''}
              {detail}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <StateChip state={stateOf(o, syncState)} />
              <RecurrenceChip recurrenceIndex={o.recurrenceIndex} />
              <span className="text-muted-foreground text-xs">{when}</span>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
        </div>
      </Link>
    </li>
  );
}
