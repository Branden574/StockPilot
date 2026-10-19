import { ArrowLeft, Lock } from 'lucide-react';
import Link from 'next/link';
import type * as React from 'react';

import {
  formatStockQuantity,
  LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY,
  LOCATION_HOLDINGS_TRUNCATED_COPY,
  locationOpenIssuesEmptyCopy,
  locationRecountProblemOf,
  locationRowVerificationCopy,
  locationVerificationTotalsCopy,
  VERIFICATION_UNAVAILABLE_COPY,
  verificationRefusalCopy,
  type VerificationRefusal,
} from '@stockpilot/core';

import { exceptionTime, FirstCheckPending } from '@/components/exceptions/occurrence-display';
import { VerificationIssueChips } from '@/components/inventory/item-verification-card';
import { LocationRecountButton } from '@/components/locations/location-recount-button';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import type { LocationVerification, LocationVerificationRow } from '@/server/services/verification';

/**
 * ONE LOCATION'S PAGE (F1-3): what is held here and when each item was last
 * physically counted, in core's words (locationRowVerificationCopy), with the
 * open exceptions recorded here and a totals line across EVERY row, not just
 * the 50 shown. Server-safe: no 'use client' (the recount button and the
 * pager are the only client islands).
 *
 * What it must never get wrong:
 *   - a location whose stock the reader's warehouses do not cover says so
 *     (LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY), never "nothing here";
 *   - a row whose summary could not be read says "Couldn't load
 *     verification", never "Not counted";
 *   - no open exceptions is "none recorded here" only after a check has run,
 *     and only when nothing here is hidden from the reader (core
 *     locationOpenIssuesEmptyCopy: out of their warehouses it says so; with
 *     items they cannot open, "none you can see");
 *   - a refused read (not found, not permitted, a bad link) says why, in the
 *     phone's words (core verificationRefusalCopy);
 *   - nothing says "verified" or shows a percentage.
 */

const KIND_LABELS: Record<string, string> = {
  rack: 'Rack',
  crate: 'Crate',
  area: 'Area',
  staging: 'System location',
  unplaced: 'System location',
};
const TYPE_LABELS: Record<string, string> = {
  warehouse: 'Warehouse',
  room: 'Room',
  shelf: 'Shelf',
  bin: 'Bin',
  vehicle: 'Vehicle',
  jobsite: 'Job site',
  other: 'Other',
};

/** "Rack", "Warehouse", "System location", or "Location". */
export function locationKindLabel(kind: string | null, type: string | null): string {
  return (kind && KIND_LABELS[kind]) || (type && TYPE_LABELS[type]) || 'Location';
}

export function LocationBackLink({ archived = false }: { archived?: boolean }) {
  return (
    <Link
      href={archived ? '/dashboard/locations?view=archived' : '/dashboard/locations'}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px] transition-colors"
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      Locations
    </Link>
  );
}

/**
 * The whole page could not be read. Never an empty location. A refusal (the
 * location is not found or not the reader's, no permission, a bad link) says
 * why, in the same words as the phone; any other failure says to reload.
 */
export function LocationVerificationUnavailable({
  refusal = null,
}: {
  refusal?: VerificationRefusal | null;
}) {
  // The shared state panel (failed kind), announced as an alert as before.
  // It is the page's only heading when it shows, so it is the h1.
  return (
    <StatePanel
      kind="failed"
      live="assertive"
      headingLevel={1}
      title={VERIFICATION_UNAVAILABLE_COPY}
      description={
        refusal ? (
          <p data-testid="location-refusal">{verificationRefusalCopy(refusal, 'location')}</p>
        ) : (
          <p>Reload the page to try again.</p>
        )
      }
    />
  );
}

export function LocationVerificationView({
  data,
  canOpenCounts,
  back,
}: {
  data: LocationVerification;
  /** The reader can open a count's page (cycle_counts:read or stock:adjust). */
  canOpenCounts: boolean;
  /** The back link (LocationBackLink), drawn above the title. */
  back?: React.ReactNode;
}) {
  const loc = data.location;
  const kindLabel = locationKindLabel(loc.kind, loc.type);
  return (
    <>
      {/* The record's header (DESIGN-SPEC 6.1): the kind and warehouse as the
          eyebrow, the name as the h1 with Archived beside it. */}
      <PageHeader
        back={back}
        eyebrow={
          <span data-testid="location-kind">
            {kindLabel}
            {loc.warehouseName ? ` · ${loc.warehouseName}` : ''}
          </span>
        }
        title={loc.name}
        titleAside={loc.archived ? <Badge variant="outline">Archived</Badge> : null}
      />

      {/* Stock here beside Open issues here once the content area holds both
          (about 2 x 420 + 16 px, measured on the content, as on a purchase
          order's page); one column below that, Open issues here first as
          before. */}
      <div className="@container min-w-0">
        <div className="@min-[856px]:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)] grid items-start gap-4">
          <OpenIssuesHere
            data={data}
            className="@min-[856px]:col-start-2 @min-[856px]:row-start-1"
          />
          <StockHere
            data={data}
            canOpenCounts={canOpenCounts}
            className="@min-[856px]:col-start-1 @min-[856px]:row-start-1"
          />
        </div>
      </div>
    </>
  );
}

function StockHere({
  data,
  canOpenCounts,
  className,
}: {
  data: LocationVerification;
  canOpenCounts: boolean;
  className?: string;
}) {
  const loc = data.location;
  const showList = data.holdingsVisible && data.rows.length > 0;
  return (
    <DetailSection
      title="Stock here"
      className={className}
      aside={
        data.holdingsVisible && data.canRecount ? (
          <LocationRecountButton
            itemIds={data.recountItemIds}
            // The server's reason, else the same rule on this page: a
            // partial holdings read is never recounted as "the items
            // here" (the phone applies the same core rule).
            problem={locationRecountProblemOf(data)}
            timeZone={data.timeZone}
          />
        ) : undefined
      }
      flush
      footer={
        showList && data.pageCount > 1 ? (
          <Pagination
            className="w-full"
            page={data.page}
            pageSize={data.pageSize}
            total={data.totalRows}
            basePath={`/dashboard/locations/${loc.id}`}
          />
        ) : undefined
      }
    >
      {(data.holdingsVisible && data.totals) || data.truncated ? (
        <div className="border-border space-y-1 border-b px-[18px] py-3">
          {data.holdingsVisible && data.totals ? (
            <p
              className="text-foreground text-[13.5px] leading-[20.25px]"
              data-testid="location-totals"
            >
              {locationVerificationTotalsCopy(data.totals, {
                locationKind: loc.kind,
                locationType: loc.type,
              })}
            </p>
          ) : null}
          {data.truncated ? (
            <p className="text-warning text-[12.5px]" data-testid="location-truncated">
              {LOCATION_HOLDINGS_TRUNCATED_COPY}
            </p>
          ) : null}
        </div>
      ) : null}
      {!data.holdingsVisible ? (
        <div className="p-[18px]">
          <p
            role="status"
            className="border-border bg-sunk flex items-start gap-2 rounded-md border px-3 py-2 text-[13.5px]"
            data-testid="location-out-of-scope"
          >
            <Lock className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            {LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY}
          </p>
        </div>
      ) : showList ? (
        <ul className="divide-border divide-y" data-testid="location-rows">
          {data.rows.map((row) => (
            <LocationRow
              key={row.itemId}
              row={row}
              locationId={loc.id}
              locationKind={loc.kind}
              locationType={loc.type}
              timeZone={data.timeZone}
              canOpenCounts={canOpenCounts}
            />
          ))}
        </ul>
      ) : null}
    </DetailSection>
  );
}

function OpenIssuesHere({ data, className }: { data: LocationVerification; className?: string }) {
  // Read under the reader's RLS: "none" only when nothing here is hidden.
  const empty = locationOpenIssuesEmptyCopy({
    holdingsVisible: data.holdingsVisible,
    hiddenItems: data.totals?.hiddenItems ?? 0,
    checkedAt: data.checkedAt,
  });
  return (
    <DetailSection
      aria-labelledby="open-issues-here"
      title={<span id="open-issues-here">Open issues here</span>}
      className={className}
      bodyClassName="space-y-2"
      data-testid="location-open-issues"
    >
      {data.openIssues.length > 0 ? (
        <VerificationIssueChips issues={data.openIssues} />
      ) : empty.kind === 'first_check_pending' ? (
        <FirstCheckPending />
      ) : empty.kind === 'out_of_scope' ? (
        <p
          role="status"
          className="border-border bg-sunk flex items-start gap-2 rounded-md border px-3 py-2 text-[13.5px]"
          data-testid="location-issues-out-of-scope"
        >
          <Lock className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          {empty.text}
        </p>
      ) : (
        <p className="text-muted-foreground text-[13.5px]" data-testid="location-no-open-issues">
          {empty.text}
        </p>
      )}
      {data.openIssuesTruncated ? (
        <p className="text-muted-foreground text-[12px]">
          More open exceptions exist than are shown here.
        </p>
      ) : null}
      {data.checkedAt ? (
        <p className="text-muted-foreground text-[12px]">
          Checked at {exceptionTime(data.checkedAt, data.timeZone)}.
        </p>
      ) : null}
    </DetailSection>
  );
}

function LocationRow({
  row,
  locationId,
  locationKind,
  locationType,
  timeZone,
  canOpenCounts,
}: {
  row: LocationVerificationRow;
  locationId: string;
  locationKind: string | null;
  locationType: string | null;
  timeZone: string;
  canOpenCounts: boolean;
}) {
  const copy = locationRowVerificationCopy(row.summary, locationId, {
    timeZone,
    locationKind,
    locationType,
  });
  const itemHref = `/dashboard/inventory/${row.itemId}`;
  return (
    <li className="px-[18px] py-3" data-testid="location-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={itemHref}
            className="text-foreground text-[13.5px] font-medium [overflow-wrap:anywhere] hover:underline"
          >
            {row.name}
          </Link>
          {row.sku ? (
            <p className="text-muted-foreground break-all font-mono text-[11.5px]">{row.sku}</p>
          ) : null}
        </div>
        <p
          className="text-muted-foreground shrink-0 text-[13px] tabular-nums"
          data-testid="location-row-quantity"
        >
          <span className="text-foreground font-mono text-[13.5px] font-medium">
            {formatStockQuantity(row.quantity)}
          </span>{' '}
          here
        </p>
      </div>
      <div className="text-ink-2 mt-1 space-y-0.5 text-[12.5px] leading-[18.75px]">
        <p
          className={row.summary === null ? 'text-warning' : undefined}
          data-testid="location-row-count"
        >
          {copy.count}
        </p>
        {copy.movementsSince ? (
          <p className="text-muted-foreground">
            {row.summary?.movementsSince != null ? (
              <Link
                href={`${itemHref}?tab=movements`}
                className="hover:text-foreground hover:underline"
              >
                {copy.movementsSince}
              </Link>
            ) : (
              copy.movementsSince
            )}
          </p>
        ) : null}
        {copy.beingCounted ? (
          <p>
            {canOpenCounts ? (
              <Link
                href={`/dashboard/cycle-counts/${copy.beingCounted.cycleCountId}`}
                className="text-accent hover:text-foreground hover:underline"
              >
                {copy.beingCounted.text}
              </Link>
            ) : (
              copy.beingCounted.text
            )}
          </p>
        ) : null}
        {copy.notCountable ? <p className="text-muted-foreground">{copy.notCountable}</p> : null}
        {row.issues.length > 0 ? (
          <div className="pt-1">
            <VerificationIssueChips issues={row.issues} />
          </div>
        ) : null}
      </div>
    </li>
  );
}
