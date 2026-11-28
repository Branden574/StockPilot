import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  isUuid,
  resolveOrgTimezone,
  VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
  vendorRiskFollowUpEmail,
  zonedParts,
} from '@stockpilot/core';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { SupplierRiskAnswersList } from '@/components/suppliers/risk/answers-list';
import { CopyText } from '@/components/suppliers/risk/copy-text';
import { SupplierRiskHistory } from '@/components/suppliers/risk/history';
import { SupplierRiskReviewForm } from '@/components/suppliers/risk/review-form';
import { SupplierRiskItems } from '@/components/suppliers/risk/review-items';
import { SupplierRiskReviewSummary } from '@/components/suppliers/risk/review-summary';
import {
  SupplierRiskLimits,
  SupplierRiskRules,
} from '@/components/suppliers/risk/rules-and-limits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { sendSupplierRiskRefusalAway } from '@/lib/supplier-risk/page-gate';
import { supplierNameAsText } from '@/lib/supplier-risk/reminder-words';
import { SupplierRiskTime } from '@/components/suppliers/risk/when';
import {
  SUPPLIER_RISK_SUPPLIER_STATE_WORDS,
  supplierRiskResultWords,
} from '@/lib/supplier-risk/words';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { withContext } from '@/server/services/context';
import {
  assertMayUseSupplierRisk,
  SUPPLIER_RISK_COULD_NOT_CHECK,
  SupplierRiskService,
  type SupplierRiskEventsPage,
  type SupplierRiskHistoryRow,
  type SupplierRiskPerson,
  type SupplierRiskRead,
  type SupplierRiskRegisterRead,
  type SupplierRiskReview,
  type SupplierRiskSeat,
} from '@/server/services/supplier-risk';

// The Liquid Glass operations composition (every page under suppliers draws
// the shared frame's root; glass-scope.guard.test.ts reads the folder).
import '@/styles/liquid-glass/pages/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Vendor review' };

/** The page area (DESIGN-SPEC 5.3 and 4): max 1320, 16 px gutters on a phone. */
const PAGE = 'mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

const NONE: SupplierRiskRead<null> = { state: 'ok', value: null };

const SEAT_WORDS: Record<Exclude<SupplierRiskSeat, 'member'>, string> = {
  support: VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
  unknown:
    'We could not check whether this session may change vendor reviews, so the page is read-only. Reload it to try again.',
};

/** The organization's day ('YYYY-MM-DD'), the day a finish judges the dates on. */
function dayIn(zone: string): string {
  const p = zonedParts(new Date(), zone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * ONE SUPPLIER'S VENDOR REVIEW (part 7 of the security tools), for owners and
 * admins: the current review with its result and every reason, the items, the
 * questions to send the vendor, the form for a draft or a new version, and the
 * earlier versions, read-only. The rules and the honest limits are on the
 * page.
 *
 * Asked before anything is read: the id is a uuid (else Page not found), the
 * Suppliers module, then the service's gate (the module, the authenticator
 * step, the role): a member who is not an owner or admin gets Page not found,
 * one who owes the authenticator step is sent to it. A supplier that is not
 * in this organization's register is Page not found. A read that could not be
 * made says so, never "not reviewed".
 *
 * A support (act-as) seat reads everything and gets no write control (the
 * server and the database refuse its writes anyway). An archived or deleted
 * supplier's reviews are read-only, but an owner or admin can discard its
 * draft and change the items of its current review.
 */
export default async function SupplierRiskReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string | string[]; history?: string | string[] }>;
}) {
  const { id } = await params;
  notFoundUnlessUuid(id);
  const supplierId = id.toLowerCase();
  const here = `/dashboard/suppliers/${supplierId}/risk`;

  const moduleAccess = await checkModuleAccess('suppliers');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="suppliers" access={moduleAccess} />;
  }
  const ctx = await withContext();
  try {
    assertMayUseSupplierRisk(ctx);
  } catch (e) {
    sendSupplierRiskRefusalAway(e, here);
  }
  const svc = new SupplierRiskService(ctx);
  const query = await searchParams;
  const versionParam = typeof query.version === 'string' ? query.version.toLowerCase() : null;
  // The history page to read ('<when>~<event id>', the service's cursor), or the newest.
  const historyParam = typeof query.history === 'string' ? query.history : null;

  let register: SupplierRiskRegisterRead;
  let history: SupplierRiskRead<SupplierRiskHistoryRow[]>;
  let seat: SupplierRiskSeat;
  try {
    [register, history, seat] = await Promise.all([
      svc.register(),
      svc.history(supplierId),
      svc.seat(),
    ]);
  } catch (e) {
    sendSupplierRiskRefusalAway(e, here);
  }

  const header = (title: string) => (
    <PageHeader
      title={title}
      titleId="supplier-risk-title"
      back={
        <PageHeaderBackLink href="/dashboard/suppliers/risk">
          ← Vendor risk register
        </PageHeaderBackLink>
      }
    />
  );

  if (register.state !== 'ok' || history.state !== 'ok') {
    return (
      <div className={PAGE} data-glass-page="ops" data-glass-view="suppliers">
        {header('Vendor review')}
        <StatePanel
          kind="failed"
          live="polite"
          title={SUPPLIER_RISK_COULD_NOT_CHECK}
          description="This is not the same as not reviewed: nothing was read."
          action={
            <Button asChild variant="outline" size="sm">
              <a href={here}>Try again</a>
            </Button>
          }
        />
      </div>
    );
  }
  const row = register.value.find((r) => r.supplierId.toLowerCase() === supplierId);
  if (!row && !register.complete) {
    // Past the rows the register could read: not known, so never Page not found.
    return (
      <div className={PAGE} data-glass-page="ops" data-glass-view="suppliers">
        {header('Vendor review')}
        <StatePanel
          kind="failed"
          live="polite"
          title={SUPPLIER_RISK_COULD_NOT_CHECK}
          description={`This supplier is not among the first ${register.value.length.toLocaleString('en-US')} suppliers this page could read of the register, so its review cannot be shown here.`}
        />
      </div>
    );
  }
  if (!row) notFound();

  const versions = history.value;
  const draftRow = versions.find((v) => v.status === 'draft') ?? null;
  const viewing =
    versionParam && isUuid(versionParam)
      ? (versions.find(
          (v) => v.reviewId === versionParam && v.status === 'final' && !v.isCurrent,
        ) ?? null)
      : null;

  let current: SupplierRiskRead<SupplierRiskReview | null>;
  let draft: SupplierRiskRead<SupplierRiskReview | null>;
  let earlier: SupplierRiskRead<SupplierRiskReview | null>;
  let people: SupplierRiskRead<SupplierRiskPerson[]>;
  let events: SupplierRiskRead<SupplierRiskEventsPage>;
  let timezone: string | null | undefined;
  try {
    let org;
    [current, draft, earlier, people, events, org] = await Promise.all([
      row.reviewId ? svc.review(row.reviewId) : NONE,
      draftRow ? svc.review(draftRow.reviewId) : NONE,
      viewing ? svc.review(viewing.reviewId) : NONE,
      svc.ownersAndAdmins(),
      svc.listEvents(supplierId, historyParam),
      getOrgRowForRequest(ctx.organizationId),
    ]);
    timezone = org?.timezone;
  } catch (e) {
    sendSupplierRiskRefusalAway(e, here);
  }
  // The organization's zone: every time on the page is written in it.
  const timeZone = resolveOrgTimezone(timezone);
  const orgToday = dayIn(timeZone);
  const utcToday = new Date().toISOString().slice(0, 10);

  const currentReview = current.state === 'ok' ? current.value : null;
  const draftReview = draft.state === 'ok' ? draft.value : null;
  // A review the register names but that could not be read is "could not
  // check", never "not reviewed".
  const couldNotCheck =
    current.state !== 'ok' ||
    draft.state !== 'ok' ||
    earlier.state !== 'ok' ||
    (row.reviewId !== null && currentReview === null) ||
    (draftRow !== null && draftReview === null);
  const earlierReview = earlier.state === 'ok' ? earlier.value : null;
  const owners = people.state === 'ok' ? people.value : [];

  const member = seat === 'member';
  const active = row.supplierState === 'active';
  const canWrite = member && active && !couldNotCheck;
  const canDiscard = member && draftReview !== null;
  const start = draftReview
    ? { dataLevel: draftReview.dataLevel, answers: draftReview.answers, from: 'draft' as const }
    : currentReview
      ? {
          dataLevel: currentReview.dataLevel,
          answers: currentReview.answers,
          from: 'current' as const,
        }
      : { dataLevel: null, answers: {}, from: 'empty' as const };
  const followUp =
    currentReview && currentReview.dataLevel
      ? // Plain text for an email: the name cleaned of line breaks, control
        // and direction characters (a manager typed it); core says "your
        // company" when nothing is left.
        vendorRiskFollowUpEmail(
          supplierNameAsText(row.supplierName),
          currentReview.dataLevel,
          currentReview.answers,
          { reviewedOn: currentReview.reviewedOn },
        )
      : null;

  return (
    <div className={PAGE} data-glass-page="ops" data-glass-view="suppliers">
      <PageHeader
        title="Vendor review"
        titleId="supplier-risk-title"
        subline={
          <>
            <bdi className="text-foreground font-medium">{row.supplierName}</bdi>
            {row.nameChanged && row.reviewedAsName ? (
              <>
                {' · Reviewed as '}
                <bdi>{row.reviewedAsName}</bdi>
              </>
            ) : null}
          </>
        }
        back={
          <PageHeaderBackLink href="/dashboard/suppliers/risk">
            ← Vendor risk register
          </PageHeaderBackLink>
        }
        actions={
          row.supplierState !== 'active' ? (
            <Badge variant="outline">{SUPPLIER_RISK_SUPPLIER_STATE_WORDS[row.supplierState]}</Badge>
          ) : null
        }
      />

      {!member ? (
        <p
          role="status"
          className="border-border bg-sunk text-ink-2 rounded-md border px-3 py-2 text-[13px]"
          data-slot="supplier-risk-read-only"
        >
          {SEAT_WORDS[seat as Exclude<SupplierRiskSeat, 'member'>]}
        </p>
      ) : null}
      {member && row.supplierState === 'archived' ? (
        <p
          role="status"
          className="border-border bg-sunk text-ink-2 rounded-md border px-3 py-2 text-[13px]"
        >
          This supplier is archived. Restore it to review it again. Its reviews stay readable, its
          draft can be discarded and the items of its current review can still be changed.
        </p>
      ) : null}
      {member && row.supplierState === 'deleted' ? (
        <p
          role="status"
          className="border-border bg-sunk text-ink-2 rounded-md border px-3 py-2 text-[13px]"
        >
          This supplier was deleted. Its reviews are kept as they were.
        </p>
      ) : null}
      {couldNotCheck ? (
        <StatePanel
          kind="failed"
          size="sm"
          live="polite"
          title={SUPPLIER_RISK_COULD_NOT_CHECK}
          description="Part of this review could not be read, so nothing can be changed here until it is. Reload the page to try again."
        />
      ) : null}

      <SupplierRiskLimits />

      {earlierReview ? (
        <>
          <p className="text-ink-2 text-[13px]">
            You are reading version {earlierReview.version}, an earlier review, as it was finished.{' '}
            <Link href={here} className="text-accent underline-offset-4 hover:underline">
              Back to the current review
            </Link>
          </p>
          <SupplierRiskReviewSummary
            review={earlierReview}
            title={`Version ${earlierReview.version}`}
            timeZone={timeZone}
          />
          <DetailSection title={`Items of version ${earlierReview.version}`} headingLevel={2}>
            <SupplierRiskItems
              reviewId={earlierReview.id}
              items={earlierReview.items}
              people={[]}
              canWrite={false}
              orgToday={orgToday}
              timeZone={timeZone}
            />
          </DetailSection>
          <SupplierRiskAnswersList
            title={`Answers of version ${earlierReview.version}`}
            dataLevel={earlierReview.dataLevel}
            answers={earlierReview.answers}
          />
        </>
      ) : currentReview ? (
        <>
          <SupplierRiskReviewSummary
            review={currentReview}
            title="Current review"
            reviewDue={row.reviewDue}
            dueReminder={row.dueReminder}
            reviewerAccountDeleted={row.reviewerAccountDeleted}
            timeZone={timeZone}
          />
          <DetailSection title="Items" headingLevel={2}>
            <SupplierRiskItems
              reviewId={currentReview.id}
              items={currentReview.items}
              people={owners}
              peopleKnown={people.state === 'ok'}
              canWrite={member && !couldNotCheck}
              orgToday={orgToday}
              timeZone={timeZone}
            />
          </DetailSection>
          <DetailSection title="Questions to send the vendor" headingLevel={2}>
            {followUp ? (
              <CopyText
                text={followUp}
                label="Paste these into an email to the vendor. Plain text: check it before you send it."
              />
            ) : (
              <p className="text-ink-2 text-[13px]">
                Nothing to ask: every question was answered Yes.
              </p>
            )}
          </DetailSection>
        </>
      ) : !couldNotCheck ? (
        <StatePanel
          kind="empty"
          size="sm"
          title="Not reviewed yet"
          description={
            canWrite
              ? 'Answer the questions below, then save a draft or finish the review.'
              : undefined
          }
        />
      ) : null}

      <SupplierRiskRules />

      {!earlierReview ? (
        <DetailSection
          title={draftReview ? 'Draft' : currentReview ? 'A new version' : 'Review'}
          headingLevel={2}
          aside={
            draftRow?.updatedAt ? (
              <span className="text-muted-foreground text-[12px]">
                Draft saved <SupplierRiskTime at={draftRow.updatedAt} timeZone={timeZone} clock />
              </span>
            ) : null
          }
        >
          {people.state !== 'ok' && canWrite ? (
            <p className="text-warning mb-3 text-[12.5px]">
              The owners and admins could not be listed just now, so items can be given an owner
              later.
            </p>
          ) : null}
          {!canWrite && !canDiscard ? (
            draftReview || currentReview ? (
              <SupplierRiskAnswersList
                title={draftReview ? 'Answers of the draft' : 'Answers of the current review'}
                dataLevel={(draftReview ?? currentReview)!.dataLevel}
                answers={(draftReview ?? currentReview)!.answers}
              />
            ) : (
              <p className="text-ink-2 text-[13px]">
                {active
                  ? 'Nothing to show.'
                  : 'A review cannot be started for a supplier that is not active.'}
              </p>
            )
          ) : (
            <SupplierRiskReviewForm
              key={`${draftRow?.reviewId ?? 'none'}:${draftRow?.updatedAt ?? ''}:${currentReview?.id ?? 'none'}`}
              supplierId={supplierId}
              supplierName={row.supplierName}
              orgToday={orgToday}
              utcToday={utcToday}
              start={start}
              draftUpdatedAt={draftRow?.updatedAt ?? null}
              canWrite={canWrite}
              canDiscard={canDiscard}
              people={owners}
              timeZone={timeZone}
            />
          )}
        </DetailSection>
      ) : null}

      {versions.length > 0 ? (
        <DetailSection title="Versions" headingLevel={2} headingId="supplier-risk-versions" flush>
          <Table scrollLabelledBy="supplier-risk-versions" className="min-w-[560px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Version</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Reviewed</TableHead>
                <TableHead className="text-right">Read</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.reviewId}>
                  <TableCell className="tabular-nums">{v.version}</TableCell>
                  <TableCell>
                    {v.status === 'draft' ? 'Draft' : v.isCurrent ? 'Current' : 'Earlier'}
                  </TableCell>
                  <TableCell>
                    {v.result ? supplierRiskResultWords(v.result) : '—'}
                    {v.overridden ? ' (set by an admin)' : ''}
                  </TableCell>
                  <TableCell>
                    {v.reviewedAt ? (
                      <>
                        <SupplierRiskTime at={v.reviewedAt} timeZone={timeZone} />
                        {v.reviewerName ? (
                          <>
                            {' by '}
                            <bdi>{v.reviewerName}</bdi>
                          </>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {v.status === 'final' && !v.isCurrent ? (
                      <Link
                        href={`${here}?version=${v.reviewId}`}
                        className="text-accent underline-offset-4 hover:underline"
                        aria-label={`Read version ${v.version}`}
                      >
                        Read
                      </Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailSection>
      ) : null}

      {/* The history: the database's own record (0481's admin-only events),
          never the shared audit log. Its own "could not check": a history
          that could not be read does not stop the review being changed. */}
      <DetailSection title="History" headingLevel={2} headingId="supplier-risk-history-heading">
        <SupplierRiskHistory
          read={events}
          timeZone={timeZone}
          olderHref={
            events.state === 'ok' && events.value.next
              ? `${here}?history=${encodeURIComponent(events.value.next)}`
              : null
          }
          newestHref={historyParam ? here : null}
        />
      </DetailSection>
    </div>
  );
}
