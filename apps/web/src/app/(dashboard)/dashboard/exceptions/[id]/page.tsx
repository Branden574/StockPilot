import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import {
  ConfirmCountProvider,
  ConfirmCountStatus,
} from '@/components/exceptions/confirm-count-dialog';
import {
  CountVarianceClearCard,
  countVarianceClearCopyFor,
} from '@/components/exceptions/count-variance-clear-card';
import { OccurrenceActions } from '@/components/exceptions/occurrence-actions';
import { OccurrencePhotos } from '@/components/exceptions/occurrence-photos';
import { RecountButton } from '@/components/exceptions/recount-selection';
import {
  CheckedAt,
  EscalationChip,
  ExceptionsUnavailable,
  exceptionTime,
  FirstCheckPending,
  RecurrenceChip,
  SeverityChip,
  StateChip,
  stateOf,
} from '@/components/exceptions/occurrence-display';
import {
  ItemVerificationCard,
  ItemVerificationCardSkeleton,
} from '@/components/inventory/item-verification-card';
import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { Timeline, TimelineEntry, type TimelineTone } from '@/components/patterns/timeline';
import { Button } from '@/components/ui/button';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import {
  ExceptionOccurrencesService,
  type OccurrenceDetail,
  type OccurrenceEvent,
} from '@/server/services/exception-occurrences';

import {
  activeRecountCopy,
  confirmationFactsRow,
  countConfirmationFor,
  countVarianceAcknowledgeHelp,
  describeEvidenceEvent,
  describeOccurrence,
  describeTimelineEvent,
  ESCALATE_TO_MAINTENANCE_HELP,
  ESCALATE_TO_MAINTENANCE_LABEL,
  escalationAlreadyEscalatedCopy,
  escalationBadgeCopy,
  escalationOpenRequestLabel,
  escalationRequestStateCopy,
  EXCEPTION_ACTION_LABELS,
  EXCEPTION_RULES,
  exceptionActDisabledReason,
  formatCycleCountNumber,
  isRecountableRule,
  RECOUNT_COUNTS_TOTAL_COPY,
  RECOUNT_NONE_LINKED_COPY,
  recountAbilityOf,
  recountUnavailableCopy,
  resolvedReasonCopy,
  resolveOrgTimezone,
  uuidSchema,
  type ExceptionActionKind,
} from '@stockpilot/core';

export const metadata = { title: 'Exception' };

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
 * Everyone else sees why the actions are not offered. Acknowledging and notes
 * never resolve an occurrence: the system does, once a check no longer finds
 * it, and a count difference also closes when its count is confirmed.
 *
 * Recount (F1-2) is offered on a count_variance or over_reserved exception to
 * a reader the server says can start one (canRecount: a manager with the
 * cycle_counts module, cycle_counts:assign and stock:adjust). Its linked
 * recount and what it has come to so far are shown, and a closed recount's
 * timeline entry says what it found (core describeTimelineEvent).
 *
 * A count difference (count_variance; owner decision 2026-09-29, EX-000059)
 * opens with "What clears this" at the top (CountVarianceClearCard): the
 * always-true lead, what clears it for this reader, and Recount with its
 * linked recount. That card replaces the Recount card and the bottom "What
 * clears this" for the rule, and Acknowledge there says it does not clear
 * it. A row resolved by a confirmation reads with who confirmed it (core),
 * and a reason this build cannot word reads "Resolved", never "Cleared".
 *
 * Confirm this count (count differences R2, migration 0386) comes with the
 * server's countConfirm block: the person who counted it, or a manager, can
 * confirm the counted number, which closes the exception at once without a
 * second count. It is offered where core's offerConfirm says so (the card's
 * filled button, and Confirm this count instead in the Acknowledge step,
 * which carries the typed note); both open one dialog (ConfirmCountProvider),
 * which shows the numbers the server sent and sends them back, and
 * exception_confirm_count re-checks everything. After a confirm the page
 * says "Count confirmed. EX-... is closed." and refreshes into the resolved
 * row. With the switch off (no block) nothing here names Confirm.
 *
 * The item's last physical count (F1-3) is the shared verification card,
 * streamed under its own Suspense boundary so this page never waits for it,
 * and shown only when the reader can see the item. The location of a holding
 * rule links to that location's page.
 *
 * Photos (F1-4) come with the read (1-hour signed links). Everyone who can
 * open the exception sees them; adding is offered through the same act gate
 * as Acknowledge and Add note, removing where the server says so (the
 * uploader or a manager, while open). A failed photo read says so, never "no
 * photos". A photo's timeline entries are core's describeEvidenceEvent: who
 * added or removed it, its two times (the device's clock and the server's),
 * and its note or the removal's reason.
 *
 * Escalate to maintenance (F1-5) is offered only where the server says so
 * (canEscalate: the maintenance_requests module, maintenance_requests:submit,
 * an open exception and no linked request that is not cancelled); it opens
 * the maintenance request form prefilled from this exception, and saving
 * there creates one linked request. Nothing is emailed: the request's review
 * screen opens a draft only when the person taps it. An escalated exception
 * shows "Escalated: MR-..." to every reader; for a reader who can open the
 * request it links to it, says whether an email draft was opened (the one
 * thing StockPilot records about the email), and the action opens that
 * request instead of making another. Escalating neither acknowledges nor
 * resolves the exception.
 *
 * Reads only, never syncs. Not found and not visible are the same answer
 * (404), so existence is not leaked; any other failed read renders
 * "unavailable", never an empty page.
 *
 * LAYOUT (redesign, DESIGN-SPEC 6.1, 6.7 and the detail pattern): the shared
 * page header (the back link, the title as the page's one h1 with the
 * severity beside it, the reference and rule under it, the detail, then the
 * state chips) carries the rule's action links and Recount as its secondary
 * buttons. Below it, two columns once the content area holds them (measured
 * on the content, as the purchase order page does): the main column is what
 * to do (What clears this for a count difference, the Recount card,
 * Acknowledge or add a note, Photos, what causes and clears it, the
 * Timeline); the side rail is the record (its facts as label / value rows,
 * the last physical count, Maintenance, This condition over time). One
 * column below that, main first. Every block, word, gate and link is the one
 * this page had.
 */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The marker tone of a timeline entry: raised in the caution tone, closed
 *  in the accent, everything else neutral (the words carry the meaning). */
function timelineTone(kind: OccurrenceEvent['kind']): TimelineTone {
  if (kind === 'raised') return 'warning';
  if (kind === 'resolved' || kind === 'count_confirmed') return 'accent';
  return 'neutral';
}
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

/**
 * One timeline entry's words. A photo's entries are core's
 * describeEvidenceEvent: the headline, the photo's two times (each named by
 * its clock) and its note, or the removal's reason. The times line is left out
 * when the photos could not be read (`e.evidence` null): the headline stands,
 * and no time is guessed. Every other kind is describeTimelineEvent with the
 * event's own note.
 */
function timelineLine(
  e: OccurrenceEvent,
  o: OccurrenceDetail['occurrence'],
  timeZone: string,
): { headline: string; detail: string | null; note: string | null } {
  if (e.kind === 'evidence_added' || e.kind === 'evidence_removed') {
    const ev = describeEvidenceEvent({
      kind: e.kind,
      actorLabel: e.actor?.label ?? null,
      capturedAt: e.evidence?.capturedAt ?? null,
      uploadedAt: e.evidence?.uploadedAt ?? null,
      note: e.note,
      timeZone,
    });
    return { headline: ev.headline, detail: e.evidence ? ev.detail : null, note: ev.note };
  }
  return {
    headline: describeTimelineEvent({
      kind: e.kind,
      actorLabel: e.actor?.label ?? null,
      cycleCountNumber: e.cycleCount?.countNumber ?? null,
      resolvedReason: o.resolvedReason,
      recountOutcome: e.cycleCount?.outcome ?? null,
      maintenanceRequestReference: e.maintenanceRequestReference ?? null,
      confirmation:
        e.kind === 'count_confirmed'
          ? countConfirmationFor(
              o.facts,
              o.confirmation?.as ?? null,
              e.cycleCount?.countNumber ?? null,
            )
          : null,
    }),
    detail: null,
    note: e.note,
  };
}

/** "Sep 21, 3:00 PM: Confirmed by the counter", or the time alone for a
 *  reason this build cannot word (never "Cleared", never "undefined"). */
function historyResolved(h: OccurrenceDetail['history'][number], timeZone: string): string {
  const copy = resolvedReasonCopy(h.resolvedReason, h.confirmedAs ?? null);
  const at = exceptionTime(h.resolvedAt, timeZone);
  return copy ? `${at}: ${copy}` : at;
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

  const back = (
    <PageHeaderBackLink
      href={
        detail?.occurrence.resolvedAt
          ? '/dashboard/exceptions?tab=resolved'
          : '/dashboard/exceptions'
      }
    >
      <ArrowLeft className="size-4" aria-hidden />
      Exceptions
    </PageHeaderBackLink>
  );

  return (
    <div className={PAGE}>
      {detail === null ? (
        <>
          <div>{back}</div>
          <ExceptionsUnavailable />
        </>
      ) : (
        <Detail detail={detail} timeZone={timeZone} back={back} />
      )}
    </div>
  );
}

function Detail({
  detail,
  timeZone,
  back,
}: {
  detail: OccurrenceDetail;
  timeZone: string;
  back: ReactNode;
}) {
  const o = detail.occurrence;
  const meta = EXCEPTION_RULES[o.rule];
  const d = describeOccurrence(o.rule, o.facts, {
    itemName: o.item?.name ?? null,
    conditionSince: o.conditionSince,
    asOf: o.resolvedAt ?? new Date(),
  });
  const resolved = o.resolvedAt !== null;
  const disabledReason = exceptionActDisabledReason({ resolved, canAct: o.canAct, online: true });
  const displayed = stateOf(o, detail.syncState);
  // A count difference: "What clears this" at the top, Recount inside it,
  // and its own Acknowledge help (owner decision 2026-09-29).
  const countVariance = o.rule === 'count_variance';
  const countConfirm = detail.countConfirm ?? null;
  // The card's own words decide whether Confirm is offered (core
  // offerConfirm); the Acknowledge step's "instead" follows the same value.
  const offerConfirm =
    countVariance && !resolved
      ? countVarianceClearCopyFor(o, displayed, countConfirm).offerConfirm
      : false;
  const resolvedCopy = resolvedReasonCopy(o.resolvedReason, o.confirmation?.as ?? null);
  const confirmedRow = o.confirmation
    ? confirmationFactsRow(o.confirmation, exceptionTime(o.confirmation.at, timeZone))
    : null;
  const escalation = o.escalation;
  // The linked request opens only for a reader the server confirmed can see
  // it (visibleToReader true: read through their own RLS), and only while
  // the module is on (the request page says "not enabled" otherwise).
  const requestHref =
    escalation?.requestId &&
    escalation.visibleToReader === true &&
    o.escalateUnavailableReason !== 'module_disabled'
      ? `/dashboard/maintenance/${escalation.requestId}`
      : null;
  const recountOffered = o.canRecount && !countVariance;

  return (
    <ConfirmCountProvider
      occurrenceId={o.id}
      reference={o.reference}
      confirm={countVariance && !resolved ? countConfirm : null}
      offered={offerConfirm}
      recountAbility={recountAbilityOf(o.canRecount, o.recountUnavailableReason)}
      recountNumber={o.recount?.countNumber ?? null}
    >
      <PageHeader
        back={back}
        title={d.title}
        titleAside={<SeverityChip rule={o.rule} />}
        meta={
          <>
            {o.reference && <span className="text-ink-2 font-mono">{o.reference}</span>}
            {o.reference && <span aria-hidden="true">·</span>}
            <span>{meta.label}</span>
          </>
        }
        subline={
          <p className="text-foreground mt-1 max-w-[720px] text-[14px] leading-[21px]">
            {d.detail}
          </p>
        }
        actions={
          meta.actions.length > 0 || recountOffered ? (
            <>
              {meta.actions.map((kind) => (
                <Button key={kind} asChild variant="outline">
                  <Link href={actionHref(kind, o.itemId)}>{EXCEPTION_ACTION_LABELS[kind]}</Link>
                </Button>
              ))}
              {recountOffered ? (
                <RecountButton
                  occurrenceId={o.id}
                  reference={o.reference}
                  timeZone={timeZone}
                  size="default"
                />
              ) : null}
            </>
          ) : null
        }
      >
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <StateChip state={displayed} />
          <RecurrenceChip recurrenceIndex={o.recurrenceIndex} />
          <EscalationChip escalation={escalation} href={requestHref} />
        </div>
      </PageHeader>

      {/* "Count confirmed. EX-... is closed.", once a confirm succeeds. */}
      {countVariance ? <ConfirmCountStatus /> : null}

      {detail.syncState === null ? (
        <FirstCheckPending />
      ) : (
        <CheckedAt syncState={detail.syncState} timeZone={timeZone} />
      )}

      <div className="@container min-w-0">
        <div className="@min-[856px]:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)] grid items-start gap-4">
          <div className="flex min-w-0 flex-col gap-4">
            {countVariance && !resolved ? (
              <CountVarianceClearCard
                occurrence={o}
                displayed={displayed}
                countConfirm={countConfirm}
                timeZone={timeZone}
              />
            ) : null}

            {isRecountableRule(o.rule) && !countVariance && !resolved ? (
              <DetailSection
                title="Recount"
                data-testid="recount-card"
                bodyClassName="space-y-2 text-[13.5px]"
              >
                {o.recount ? (
                  <p data-testid="active-recount">
                    <Link
                      href={`/dashboard/cycle-counts/${o.recount.cycleCountId}`}
                      className="font-medium hover:underline"
                    >
                      {activeRecountCopy(o.recount)}
                    </Link>
                  </p>
                ) : (
                  <p className="text-muted-foreground">{RECOUNT_NONE_LINKED_COPY}</p>
                )}
                <p className="text-muted-foreground">
                  {o.canRecount
                    ? RECOUNT_COUNTS_TOTAL_COPY
                    : recountUnavailableCopy(o.recountUnavailableReason)}
                </p>
              </DetailSection>
            ) : null}

            <DetailSection title="Acknowledge or add a note">
              {disabledReason === null ? (
                <OccurrenceActions
                  occurrenceId={o.id}
                  acknowledged={o.acknowledgedAt !== null}
                  rule={o.rule}
                  ackHelp={
                    countVariance
                      ? countVarianceAcknowledgeHelp({
                          facts: o.facts,
                          displayed,
                          recount: o.recount,
                          canRecount: o.canRecount,
                          confirm: countConfirm,
                        })
                      : null
                  }
                />
              ) : (
                <p className="text-muted-foreground text-[13.5px]" data-testid="act-unavailable">
                  {disabledReason}
                </p>
              )}
            </DetailSection>

            <OccurrencePhotos
              occurrenceId={o.id}
              evidence={detail.evidence}
              resolved={resolved}
              canAct={o.canAct}
              timeZone={timeZone}
            />

            {/* A count difference says what clears it at the top; "What can
                cause this" then spans the column. */}
            <div className="@container min-w-0">
              <div
                className={
                  countVariance
                    ? 'grid items-start gap-4'
                    : '@min-[520px]:grid-cols-2 grid items-start gap-4'
                }
              >
                <DetailSection title="What can cause this">
                  <ul className="list-disc space-y-1 pl-5 text-[13.5px] leading-5">
                    {meta.explanations.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </DetailSection>
                {countVariance ? null : (
                  <DetailSection title="What clears this">
                    <p className="text-[13.5px] leading-5">{meta.clearedBy}</p>
                  </DetailSection>
                )}
              </div>
            </div>

            <DetailSection title="Timeline">
              {detail.timeline.length === 0 ? (
                <p className="text-muted-foreground text-[13.5px]">No events yet.</p>
              ) : (
                <Timeline>
                  {detail.timeline.map((e) => {
                    const cc = e.cycleCount
                      ? formatCycleCountNumber(e.cycleCount.countNumber)
                      : null;
                    const line = timelineLine(e, o, timeZone);
                    return (
                      <TimelineEntry
                        key={e.id}
                        tone={timelineTone(e.kind)}
                        title={<span className="font-medium">{line.headline}</span>}
                        meta={
                          <>
                            {exceptionTime(e.at, timeZone)}
                            {e.cycleCount ? (
                              <>
                                {' · '}
                                <Link
                                  href={`/dashboard/cycle-counts/${e.cycleCount.id}`}
                                  className="hover:underline"
                                >
                                  {cc ?? 'Open the count'}
                                </Link>
                              </>
                            ) : null}
                          </>
                        }
                      >
                        {line.detail || line.note ? (
                          <>
                            {line.detail ? (
                              <p className="text-muted-foreground text-[12px]">{line.detail}</p>
                            ) : null}
                            {line.note ? (
                              <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-5">
                                {line.note}
                              </p>
                            ) : null}
                          </>
                        ) : null}
                      </TimelineEntry>
                    );
                  })}
                </Timeline>
              )}
            </DetailSection>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {/* The record's facts as label / value rows (DESIGN-SPEC 6.7). */}
            <DetailSection flush data-testid="occurrence-facts">
              <KeyValueList>
                <KeyValueRow label="Item">
                  {o.item ? (
                    <Link
                      href={`/dashboard/inventory/${o.itemId}`}
                      className="font-medium hover:underline"
                    >
                      {o.item.name}
                      {o.item.sku ? (
                        <span className="text-muted-foreground whitespace-nowrap font-mono">
                          {' '}
                          ({o.item.sku})
                        </span>
                      ) : null}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Not visible to you</span>
                  )}
                </KeyValueRow>
                {o.location ? (
                  <KeyValueRow label="Location">
                    {o.locationId ? (
                      <Link
                        href={`/dashboard/locations/${o.locationId}`}
                        className="font-medium hover:underline"
                      >
                        {o.location.name}
                      </Link>
                    ) : (
                      o.location.name
                    )}
                    {o.location.archived ? (
                      <span className="text-muted-foreground"> (archived)</span>
                    ) : null}
                  </KeyValueRow>
                ) : null}
                <KeyValueRow label="First seen">
                  {o.presentWhenTrackingBegan
                    ? `Already present when tracking began, ${exceptionTime(o.firstSeenAt, timeZone)}`
                    : exceptionTime(o.firstSeenAt, timeZone)}
                </KeyValueRow>
                {!resolved ? (
                  <KeyValueRow label="Last seen by a check">
                    {exceptionTime(o.lastSeenAt, timeZone)}
                  </KeyValueRow>
                ) : null}
                {o.acknowledgedAt ? (
                  <KeyValueRow label="Acknowledged">
                    {o.acknowledgedBy?.label ?? 'Former member'},{' '}
                    {exceptionTime(o.acknowledgedAt, timeZone)}
                  </KeyValueRow>
                ) : null}
                {o.resolvedAt ? (
                  <KeyValueRow label="Resolved">
                    {exceptionTime(o.resolvedAt, timeZone)}
                    {resolvedCopy ? `: ${resolvedCopy}` : null}
                  </KeyValueRow>
                ) : null}
                {confirmedRow ? (
                  <KeyValueRow label={confirmedRow.label}>{confirmedRow.value}</KeyValueRow>
                ) : null}
              </KeyValueList>
            </DetailSection>

            {o.item ? (
              // The item's last physical count, off this page's critical path.
              <Suspense fallback={<ItemVerificationCardSkeleton />}>
                <ItemVerificationCard
                  itemId={o.itemId}
                  movementsHref={`/dashboard/inventory/${o.itemId}?tab=movements`}
                  excludeIssueId={o.id}
                />
              </Suspense>
            ) : null}

            {escalation || o.canEscalate ? (
              <EscalationCard
                occurrenceId={o.id}
                escalation={escalation}
                canEscalate={o.canEscalate}
                alreadyEscalated={o.escalateUnavailableReason === 'already_escalated'}
                requestHref={requestHref}
                timeZone={timeZone}
              />
            ) : null}

            {detail.history.length > 1 ? (
              <DetailSection title="This condition over time" flush>
                <ul className="divide-border divide-y text-[13.5px]">
                  {detail.history.map((h) => (
                    <li
                      key={h.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-[18px] py-2.5"
                    >
                      {h.isCurrent ? (
                        <span className="font-mono font-medium">
                          {h.reference ?? 'Exception'}{' '}
                          <span className="text-muted-foreground font-sans font-normal">
                            (this one)
                          </span>
                        </span>
                      ) : (
                        <Link
                          href={`/dashboard/exceptions/${h.id}`}
                          className="font-mono hover:underline"
                        >
                          {h.reference ?? 'Exception'}
                        </Link>
                      )}
                      <span className="text-muted-foreground text-[12px]">
                        First seen {exceptionTime(h.firstSeenAt, timeZone)}
                        {h.resolvedAt
                          ? `, resolved ${historyResolved(h, timeZone)}`
                          : ', still open'}
                      </span>
                    </li>
                  ))}
                </ul>
                {detail.historyTruncated ? (
                  <p className="text-muted-foreground border-border border-t px-[18px] py-2.5 text-[12px]">
                    Only the most recent occurrences are shown.
                  </p>
                ) : null}
              </DetailSection>
            ) : null}
          </div>
        </div>
      </div>
    </ConfirmCountProvider>
  );
}

/**
 * The exception's maintenance request (F1-5). Rendered when the exception was
 * escalated, or when this reader may escalate it; hidden otherwise (the
 * module off, no maintenance_requests:submit, or a resolved exception never
 * escalated).
 *
 *   - Escalated: the handle (the header's badge links it for a reader who
 *     can open the request), who escalated it and when, and, for that reader
 *     only, what StockPilot records about the request (an email draft opened
 *     or not yet; cancelled). Never "sent": nothing here knows whether an
 *     email went.
 *   - May escalate: "Escalate to maintenance" opens the request form
 *     prefilled from this exception. Saving there makes one linked request.
 *   - Already escalated to a request that is not cancelled: the action opens
 *     that request for a reader who can open it; everyone else is told a new
 *     one can be made only if it is cancelled.
 */
function EscalationCard({
  occurrenceId,
  escalation,
  canEscalate,
  alreadyEscalated,
  requestHref,
  timeZone,
}: {
  occurrenceId: string;
  escalation: OccurrenceDetail['occurrence']['escalation'];
  canEscalate: boolean;
  alreadyEscalated: boolean;
  requestHref: string | null;
  timeZone: string;
}) {
  const stateLine = escalation ? escalationRequestStateCopy(escalation.request) : null;
  return (
    <DetailSection
      title="Maintenance"
      data-testid="escalation-card"
      bodyClassName="space-y-3 text-[13.5px]"
    >
      {escalation ? (
        <div className="space-y-0.5" data-testid="escalation-status">
          <p className="font-medium">
            {escalationBadgeCopy(escalation.reference, escalation.requestCancelled)}
          </p>
          <p className="text-muted-foreground text-[12px]">
            {escalation.escalatedBy?.label ?? 'Former member'},{' '}
            {exceptionTime(escalation.escalatedAt, timeZone)}
          </p>
          {stateLine ? <p data-testid="escalation-request-state">{stateLine}</p> : null}
        </div>
      ) : null}
      {canEscalate ? (
        <div className="space-y-2">
          {/* Outline: the page's one ink-filled button is Acknowledge
              (DESIGN-SPEC 6.2, at most one commit per page). */}
          <Button asChild variant="outline">
            <Link href={`/dashboard/maintenance/new?exceptionOccurrenceId=${occurrenceId}`}>
              {ESCALATE_TO_MAINTENANCE_LABEL}
            </Link>
          </Button>
          <p className="text-muted-foreground">{ESCALATE_TO_MAINTENANCE_HELP}</p>
        </div>
      ) : alreadyEscalated && escalation ? (
        requestHref ? (
          <Button asChild variant="outline">
            <Link href={requestHref}>{escalationOpenRequestLabel(escalation.reference)}</Link>
          </Button>
        ) : (
          <p className="text-muted-foreground" data-testid="escalate-unavailable">
            {escalationAlreadyEscalatedCopy(escalation.reference)}
          </p>
        )
      ) : null}
    </DetailSection>
  );
}
