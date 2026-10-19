import { CheckCircle2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CheckNowButton } from '@/components/exceptions/check-now-button';
import {
  RecountCheckbox,
  RecountSelectionProvider,
} from '@/components/exceptions/recount-selection';
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
  UncheckedRulesBanner,
  uncheckedRulesMessage,
  UnrecognizedNotice,
} from '@/components/exceptions/occurrence-display';
import { FilterChipLink } from '@/components/patterns/chip';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatePanel } from '@/components/patterns/state-panel';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { cn } from '@/lib/utils';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import {
  ExceptionOccurrencesService,
  type ExceptionOccurrence,
  type ExceptionSyncState,
  type OccurrenceListResult,
  type OccurrenceListStatus,
} from '@/server/services/exception-occurrences';

import {
  CONFIRMED_ONLY_FILTER_LABEL,
  describeOccurrence,
  EXCEPTION_ALL_CLEAR_BODY,
  EXCEPTION_ALL_CLEAR_TITLE,
  EXCEPTION_NONE_CONFIRMED_COPY,
  EXCEPTION_NONE_RESOLVED_COPY,
  EXCEPTION_RESOLVED_WINDOW_DAYS,
  EXCEPTION_RULES,
  groupOccurrences,
  recountOutcomeCopy,
  resolveOrgTimezone,
} from '@stockpilot/core';

export const metadata = { title: 'Exceptions' };

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
 *     named, and the all-clear state is withheld while any is out;
 *   - an open row of a rule this build cannot word (a newer build's rule,
 *     seen after a rollback) is counted, and the all-clear state is withheld
 *     while any exists: an open exception never reads as all clear.
 *
 * The Resolved tab can list only the exceptions a count confirmation closed
 * (`?tab=resolved&confirmed=1`, "Closed without a second count"; count
 * differences R2, 0386): the oversight view of the risk the owner accepted,
 * for the people who review exceptions. Web only; the phone's Resolved list
 * shows the role in each row's chip.
 */
type SearchParams = { tab?: string | string[]; confirmed?: string | string[] };

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The page area every redesigned page uses (DESIGN-SPEC 4 and 5.3): max
 *  1320, 28 / 32 / 64 padding, a 16 px gutter on a phone, 16 px between
 *  blocks. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

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
  // Only the Resolved tab has the filter; anywhere else the parameter is
  // ignored.
  const confirmedOnly = tab === 'resolved' && firstParam(sp.confirmed) === '1';

  let result: OccurrenceListResult | null = null;
  try {
    result = await new ExceptionOccurrencesService(ctx).list(
      confirmedOnly ? { status: tab, confirmedOnly: true } : { status: tab },
    );
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'forbidden') notFound();
    // Any other failure renders "unavailable" below. An empty list here
    // would read as "nothing wrong", which is the one thing it must not say.
    result = null;
  }
  const timeZone = await orgTimeZone(ctx.organizationId);

  return (
    <div className={PAGE}>
      <PageHeader
        title="Exceptions"
        subline={
          // A reading width, so Check now keeps its place on the title's
          // line instead of wrapping under a full-width sentence.
          <span className="block max-w-[640px]">
            Conditions that are wrong and that nothing else tells you about. Each one keeps its
            number while it lasts; fix the cause and the system resolves it on the next check.
          </span>
        }
        actions={result?.canCheckNow ? <CheckNowButton /> : null}
      />

      {/* The two lists (DESIGN-SPEC 6.5): links, so the URL stays the state;
          the current one carries aria-current="page". */}
      <SegmentedTabs
        semantics="nav"
        aria-label="Exception lists"
        activeId={tab}
        items={[
          {
            id: 'open',
            href: '/dashboard/exceptions',
            prefetch: false,
            label: `Open${
              tab === 'open' && result && result.syncState
                ? ` (${result.occurrences.length + (result.unrecognized ?? 0)})`
                : ''
            }`,
          },
          {
            id: 'resolved',
            href: '/dashboard/exceptions?tab=resolved',
            prefetch: false,
            label: `Resolved, last ${EXCEPTION_RESOLVED_WINDOW_DAYS} days`,
          },
        ]}
      />

      {result === null ? (
        <ExceptionsUnavailable />
      ) : result.syncState === null ? (
        // Not checked yet. Whatever rows exist, nothing here may read as all
        // clear.
        <FirstCheckPending />
      ) : tab === 'open' ? (
        <OpenList result={result} syncState={result.syncState} timeZone={timeZone} />
      ) : (
        <ResolvedList
          result={result}
          syncState={result.syncState}
          timeZone={timeZone}
          confirmedOnly={confirmedOnly}
        />
      )}
    </div>
  );
}

/** The card every list of rows sits in (DESIGN-SPEC 6.7). */
const LIST_CARD = 'border-border bg-card min-w-0 overflow-hidden rounded-lg border';

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
  const unchecked = uncheckedRulesMessage(syncState);
  const unrecognized = result.unrecognized ?? 0;
  // Multi-select recount (F1-2): a manager who can start counts, and at least
  // one row the server says a recount can settle.
  const selectable = result.canRecount && result.occurrences.some((o) => o.canRecount);

  return (
    <RecountSelectionProvider enabled={selectable} timeZone={timeZone}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="space-y-2">
          <CheckedAt syncState={syncState} timeZone={timeZone} />
          <UncheckedRulesBanner message={unchecked} />
          <UnrecognizedNotice count={unrecognized} />
          {result.truncated && (
            <p className="text-warning text-xs">
              Showing the first {result.occurrences.length} open exceptions. There are more.
            </p>
          )}
          {selectable && (
            <p className="text-muted-foreground text-xs" data-testid="recount-hint">
              Tick the exceptions a count can settle to recount them together in one count.
            </p>
          )}
        </div>

        {groups.length === 0 ? (
          // With a rule unchecked, silence is unknown; with rows this build
          // cannot show, something is open. Either way: no all-clear.
          unchecked !== null || unrecognized > 0 ? null : (
            <StatePanel
              kind="empty"
              icon={CheckCircle2}
              title={EXCEPTION_ALL_CLEAR_TITLE}
              description={EXCEPTION_ALL_CLEAR_BODY}
            />
          )
        ) : (
          groups.map((g) => (
            // One card per rule (DESIGN-SPEC 6.7): the rule and its severity
            // in the header, what to do about it under it, then its rows.
            <DetailSection
              key={g.meta.rule}
              title={g.meta.label}
              aside={
                <span className="flex items-center gap-2">
                  <SeverityChip rule={g.meta.rule} />
                  <span className="text-muted-foreground font-mono text-[12px] tabular-nums">
                    {g.rows.length}
                  </span>
                </span>
              }
              flush
              data-rule={g.meta.rule}
            >
              <p className="text-muted-foreground border-border border-b px-[18px] py-2.5 text-[12.5px] leading-[18px]">
                {g.meta.action}
              </p>
              <ul className="divide-border divide-y">
                {g.rows.map((r) => (
                  <OccurrenceRow
                    key={r.occurrence.id}
                    o={r.occurrence}
                    title={r.description.title}
                    detail={r.description.detail}
                    syncState={syncState}
                    timeZone={timeZone}
                    selectable={selectable && r.occurrence.canRecount}
                  />
                ))}
              </ul>
            </DetailSection>
          ))
        )}
      </div>
    </RecountSelectionProvider>
  );
}

function ResolvedList({
  result,
  syncState,
  timeZone,
  confirmedOnly,
}: {
  result: OccurrenceListResult;
  syncState: ExceptionSyncState;
  timeZone: string;
  /** Only the rows a count confirmation closed. */
  confirmedOnly: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <CheckedAt syncState={syncState} timeZone={timeZone} />
      {/* Which resolved rows: all of them, or only those a count
          confirmation closed without a second count. Filter chips (DESIGN-SPEC
          6.6), marked as the current choice with "true", not "page": the tab
          above is the page. */}
      <nav
        aria-label="Filter resolved exceptions"
        className="flex flex-wrap gap-2"
        data-testid="resolved-filter"
      >
        <FilterChipLink
          href="/dashboard/exceptions?tab=resolved"
          prefetch={false}
          active={!confirmedOnly}
          aria-current={!confirmedOnly ? 'true' : undefined}
        >
          All
        </FilterChipLink>
        <FilterChipLink
          href="/dashboard/exceptions?tab=resolved&confirmed=1"
          prefetch={false}
          active={confirmedOnly}
          aria-current={confirmedOnly ? 'true' : undefined}
        >
          {CONFIRMED_ONLY_FILTER_LABEL}
        </FilterChipLink>
      </nav>
      {result.truncated && (
        <p className="text-warning text-xs">
          Showing the {result.occurrences.length} most recently resolved. There are more.
        </p>
      )}
      {result.occurrences.length === 0 ? (
        <StatePanel
          kind={confirmedOnly ? 'no-match' : 'empty'}
          headingLevel={null}
          size="sm"
          title={confirmedOnly ? EXCEPTION_NONE_CONFIRMED_COPY : EXCEPTION_NONE_RESOLVED_COPY}
        />
      ) : (
        <div className={LIST_CARD}>
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
        </div>
      )}
    </div>
  );
}

/**
 * One exception (DESIGN-SPEC 6.16 rows): the whole row is the link to its
 * page, with the reference in mono, the title, the detail, then its chips and
 * time; a chevron on the right. The recount checkbox (when offered) and the
 * location link are siblings of that link, never inside it (no control inside
 * a link). A ticked row takes the accent wash (DESIGN-SPEC 6.21, selected
 * row); the ticked box is the cue that is not colour.
 */
function OccurrenceRow({
  o,
  title,
  detail,
  syncState,
  timeZone,
  showRule = false,
  selectable = false,
}: {
  o: ExceptionOccurrence;
  title: string;
  detail: string;
  syncState: ExceptionSyncState;
  timeZone: string;
  showRule?: boolean;
  /** Offer a recount checkbox: the server said this row can be recounted,
   *  inside an enabled selection. */
  selectable?: boolean;
}) {
  const when = o.resolvedAt
    ? `Resolved ${exceptionTime(o.resolvedAt, timeZone)}`
    : o.presentWhenTrackingBegan
      ? 'Already present when tracking began'
      : `First seen ${exceptionTime(o.firstSeenAt, timeZone)}`;
  const state = stateOf(o, syncState);
  // What the linked recount has come to so far (progress, or once posted,
  // what it found while the check catches up).
  const recountNote =
    o.recount && (state.kind === 'recount_in_progress' || state.kind === 'rechecking')
      ? recountOutcomeCopy(o.recount.outcome)
      : null;
  // The row's left edge: 12 px after the checkbox, the card's 18 px padding
  // without one.
  const inset = selectable ? 'pl-3' : 'pl-[18px]';
  return (
    <li className="hover:bg-muted has-[[role=checkbox][aria-checked=true]]:bg-success-wash flex items-start transition-colors">
      {selectable ? (
        <div className="shrink-0 pl-[18px] pt-3">
          <RecountCheckbox occurrenceId={o.id} label={o.reference ?? title} />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <Link
          href={`/dashboard/exceptions/${o.id}`}
          className={cn(
            'focus-visible:ring-ring flex min-w-0 items-center justify-between gap-3 py-3 pr-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
            inset,
          )}
        >
          <div className="min-w-0 space-y-1">
            <p className="text-foreground text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]">
              {o.reference && (
                <span className="text-muted-foreground mr-2 font-mono text-[12px] font-normal">
                  {o.reference}
                </span>
              )}
              {title}
            </p>
            <p className="text-muted-foreground text-[12.5px] leading-[18px] [overflow-wrap:anywhere]">
              {showRule ? `${EXCEPTION_RULES[o.rule].label} · ` : ''}
              {detail}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <StateChip state={state} />
              <RecurrenceChip recurrenceIndex={o.recurrenceIndex} />
              {/* "Escalated: MR-..." (F1-5): text only here, since the row
                  is a link already; the occurrence page links it. */}
              <EscalationChip escalation={o.escalation} />
              {recountNote ? (
                <span className="text-muted-foreground text-xs" data-testid="recount-note">
                  {recountNote}
                </span>
              ) : null}
              <span className="text-muted-foreground text-xs">{when}</span>
            </div>
          </div>
          <ChevronRight className="text-ink-4 size-4 shrink-0" aria-hidden />
        </Link>
        {/* A holding rule's location opens its own page (F1-3): what is held
            there and when each item was last counted. A sibling of the row's
            link, never inside it (no nested links). */}
        {o.locationId && o.location ? (
          <p
            className={cn('-mt-1.5 pb-3 pr-[18px] text-xs', inset)}
            data-testid="occurrence-location-link"
          >
            <Link
              href={`/dashboard/locations/${o.locationId}`}
              className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            >
              Location: {o.location.name}
            </Link>
          </p>
        ) : null}
      </div>
    </li>
  );
}
