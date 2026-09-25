import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { OccurrenceActions } from '@/components/exceptions/occurrence-actions';
import {
  CheckedAt,
  ExceptionsUnavailable,
  exceptionTime,
  FirstCheckPending,
  RecurrenceChip,
  SeverityChip,
  StateChip,
  stateOf,
} from '@/components/exceptions/occurrence-display';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import {
  ExceptionOccurrencesService,
  type OccurrenceDetail,
} from '@/server/services/exception-occurrences';

import {
  describeOccurrence,
  describeOccurrenceEvent,
  EXCEPTION_ACTION_LABELS,
  EXCEPTION_RULES,
  exceptionActDisabledReason,
  formatCycleCountNumber,
  OCCURRENCE_RESOLVED_REASON_COPY,
  resolveOrgTimezone,
  uuidSchema,
  type ExceptionActionKind,
} from '@stockpilot/core';

export const metadata = { title: 'Exception · StockPilot' };

/**
 * ONE EXCEPTION OCCURRENCE (F1-1).
 *
 * The condition in core's words (describeOccurrence), what can cause it,
 * what clears it, where to go to fix it, its timeline, and every earlier
 * occurrence of the same condition (the recurrence chain).
 *
 * Acknowledge and Add note are rendered only for a reader the server says may
 * act (canAct: stock:adjust and write access to the warehouse, or a manager
 * when it has none); exception_occurrence_act re-checks on every call.
 * Everyone else sees why the actions are not offered. Nothing here resolves
 * an occurrence: the system does, once a check no longer finds it.
 *
 * Reads only, never syncs. Not found and not visible are the same answer
 * (404), so existence is not leaked; any other failed read renders
 * "unavailable", never an empty page.
 */
async function orgTimeZone(organizationId: string): Promise<string> {
  try {
    return await getCachedOrgTimezone(organizationId);
  } catch {
    return resolveOrgTimezone(null);
  }
}

function actionHref(kind: ExceptionActionKind, itemId: string): string {
  // Put-away is the Staging worklist; opening the item and editing its label
  // both start on the item page (its Edit form holds the label).
  return kind === 'put_away' ? '/dashboard/inventory/staging' : `/dashboard/inventory/${itemId}`;
}

export default async function ExceptionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();

  let ctx: ServiceContext;
  try {
    ctx = await withContext();
  } catch (e) {
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'not_found')) notFound();
    throw e;
  }

  let detail: OccurrenceDetail | null = null;
  try {
    detail = await new ExceptionOccurrencesService(ctx).get(id);
  } catch (e) {
    if (e instanceof ServiceError && (e.code === 'not_found' || e.code === 'forbidden')) notFound();
    detail = null;
  }
  const timeZone = await orgTimeZone(ctx.organizationId);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
      <Link
        href={detail?.occurrence.resolvedAt ? '/dashboard/exceptions?tab=resolved' : '/dashboard/exceptions'}
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Exceptions
      </Link>
      {detail === null ? <ExceptionsUnavailable /> : <Detail detail={detail} timeZone={timeZone} />}
    </div>
  );
}

function Detail({ detail, timeZone }: { detail: OccurrenceDetail; timeZone: string }) {
  const o = detail.occurrence;
  const meta = EXCEPTION_RULES[o.rule];
  const d = describeOccurrence(o.rule, o.facts, {
    itemName: o.item?.name ?? null,
    conditionSince: o.conditionSince,
    asOf: o.resolvedAt ?? new Date(),
  });
  const resolved = o.resolvedAt !== null;
  const disabledReason = exceptionActDisabledReason({ resolved, canAct: o.canAct, online: true });

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {o.reference && <span className="text-muted-foreground font-mono text-sm">{o.reference}</span>}
          <span className="text-muted-foreground text-sm">{meta.label}</span>
          <SeverityChip rule={o.rule} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight break-words">{d.title}</h1>
        <p className="text-base">{d.detail}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StateChip state={stateOf(o, detail.syncState)} />
          <RecurrenceChip recurrenceIndex={o.recurrenceIndex} />
        </div>
      </header>

      {detail.syncState === null ? (
        <FirstCheckPending />
      ) : (
        <CheckedAt syncState={detail.syncState} timeZone={timeZone} />
      )}

      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Item</dt>
            <dd>
              {o.item ? (
                <Link href={`/dashboard/inventory/${o.itemId}`} className="font-medium hover:underline">
                  {o.item.name}
                  {o.item.sku ? <span className="text-muted-foreground font-mono"> ({o.item.sku})</span> : null}
                </Link>
              ) : (
                <span className="text-muted-foreground">Not visible to you</span>
              )}
            </dd>
            {o.location ? (
              <>
                <dt className="text-muted-foreground">Location</dt>
                <dd>
                  {o.location.name}
                  {o.location.archived ? <span className="text-muted-foreground"> (archived)</span> : null}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">First seen</dt>
            <dd>
              {o.presentWhenTrackingBegan
                ? `Already present when tracking began, ${exceptionTime(o.firstSeenAt, timeZone)}`
                : exceptionTime(o.firstSeenAt, timeZone)}
            </dd>
            {!resolved ? (
              <>
                <dt className="text-muted-foreground">Last seen by a check</dt>
                <dd>{exceptionTime(o.lastSeenAt, timeZone)}</dd>
              </>
            ) : null}
            {o.acknowledgedAt ? (
              <>
                <dt className="text-muted-foreground">Acknowledged</dt>
                <dd>
                  {o.acknowledgedBy?.label ?? 'Former member'}, {exceptionTime(o.acknowledgedAt, timeZone)}
                </dd>
              </>
            ) : null}
            {o.resolvedAt ? (
              <>
                <dt className="text-muted-foreground">Resolved</dt>
                <dd>
                  {exceptionTime(o.resolvedAt, timeZone)}:{' '}
                  {OCCURRENCE_RESOLVED_REASON_COPY[o.resolvedReason ?? 'cleared']}
                </dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {meta.actions.map((kind) => (
          <Button key={kind} asChild variant="outline" size="sm">
            <Link href={actionHref(kind, o.itemId)}>{EXCEPTION_ACTION_LABELS[kind]}</Link>
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Acknowledge or add a note</CardTitle>
        </CardHeader>
        <CardContent>
          {disabledReason === null ? (
            <OccurrenceActions occurrenceId={o.id} acknowledged={o.acknowledgedAt !== null} />
          ) : (
            <p className="text-muted-foreground text-sm" data-testid="act-unavailable">
              {disabledReason}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">What can cause this</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {meta.explanations.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">What clears this</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{meta.clearedBy}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.timeline.length === 0 ? (
            <p className="text-muted-foreground text-sm">No events yet.</p>
          ) : (
            <ol className="space-y-3">
              {detail.timeline.map((e) => {
                const cc = e.cycleCount ? formatCycleCountNumber(e.cycleCount.countNumber) : null;
                return (
                  <li key={e.id} className="text-sm">
                    <p className="font-medium">
                      {describeOccurrenceEvent({
                        kind: e.kind,
                        actorLabel: e.actor?.label ?? null,
                        cycleCountNumber: e.cycleCount?.countNumber ?? null,
                        resolvedReason: o.resolvedReason,
                      })}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {exceptionTime(e.at, timeZone)}
                      {e.cycleCount ? (
                        <>
                          {' · '}
                          <Link href={`/dashboard/cycle-counts/${e.cycleCount.id}`} className="hover:underline">
                            {cc ?? 'Open the count'}
                          </Link>
                        </>
                      ) : null}
                    </p>
                    {e.note ? <p className="mt-1 whitespace-pre-wrap">{e.note}</p> : null}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {detail.history.length > 1 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">This condition over time</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {detail.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  {h.isCurrent ? (
                    <span className="font-mono font-medium">
                      {h.reference ?? 'Exception'} <span className="text-muted-foreground font-sans">(this one)</span>
                    </span>
                  ) : (
                    <Link href={`/dashboard/exceptions/${h.id}`} className="font-mono hover:underline">
                      {h.reference ?? 'Exception'}
                    </Link>
                  )}
                  <span className="text-muted-foreground text-xs">
                    First seen {exceptionTime(h.firstSeenAt, timeZone)}
                    {h.resolvedAt
                      ? `, resolved ${exceptionTime(h.resolvedAt, timeZone)}: ${OCCURRENCE_RESOLVED_REASON_COPY[h.resolvedReason ?? 'cleared']}`
                      : ', still open'}
                  </span>
                </li>
              ))}
            </ul>
            {detail.historyTruncated ? (
              <p className="text-muted-foreground mt-2 text-xs">Only the most recent occurrences are shown.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
