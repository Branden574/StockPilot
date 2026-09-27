import { AlertTriangle, ArrowLeft, Lock } from 'lucide-react';
import Link from 'next/link';

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
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
      className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="size-4" aria-hidden />
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
  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
    >
      <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      {refusal ? (
        <div className="space-y-1">
          <p className="font-medium">{VERIFICATION_UNAVAILABLE_COPY}</p>
          <p data-testid="location-refusal">{verificationRefusalCopy(refusal, 'location')}</p>
        </div>
      ) : (
        <p>{VERIFICATION_UNAVAILABLE_COPY}. Reload the page to try again.</p>
      )}
    </div>
  );
}

export function LocationVerificationView({
  data,
  canOpenCounts,
}: {
  data: LocationVerification;
  /** The reader can open a count's page (cycle_counts:read or stock:adjust). */
  canOpenCounts: boolean;
}) {
  const loc = data.location;
  const kindLabel = locationKindLabel(loc.kind, loc.type);
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-muted-foreground text-sm" data-testid="location-kind">
          {kindLabel}
          {loc.warehouseName ? ` · ${loc.warehouseName}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="break-words text-2xl font-semibold tracking-tight">{loc.name}</h1>
          {loc.archived ? <Badge variant="outline">Archived</Badge> : null}
        </div>
      </header>

      <OpenIssuesHere data={data} />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-base">Stock here</CardTitle>
              {data.holdingsVisible && data.totals ? (
                <p className="text-sm" data-testid="location-totals">
                  {locationVerificationTotalsCopy(data.totals, {
                    locationKind: loc.kind,
                    locationType: loc.type,
                  })}
                </p>
              ) : null}
              {data.truncated ? (
                <p className="text-warning text-xs" data-testid="location-truncated">
                  {LOCATION_HOLDINGS_TRUNCATED_COPY}
                </p>
              ) : null}
            </div>
            {data.holdingsVisible && data.canRecount ? (
              <LocationRecountButton
                itemIds={data.recountItemIds}
                // The server's reason, else the same rule on this page: a
                // partial holdings read is never recounted as "the items
                // here" (the phone applies the same core rule).
                problem={locationRecountProblemOf(data)}
                timeZone={data.timeZone}
              />
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {!data.holdingsVisible ? (
            <p
              role="status"
              className="bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
              data-testid="location-out-of-scope"
            >
              <Lock className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
              {LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY}
            </p>
          ) : data.rows.length === 0 ? null : (
            <>
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
              {data.pageCount > 1 ? (
                <Pagination
                  className="mt-4"
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.totalRows}
                  basePath={`/dashboard/locations/${loc.id}`}
                />
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OpenIssuesHere({ data }: { data: LocationVerification }) {
  // Read under the reader's RLS: "none" only when nothing here is hidden.
  const empty = locationOpenIssuesEmptyCopy({
    holdingsVisible: data.holdingsVisible,
    hiddenItems: data.totals?.hiddenItems ?? 0,
    checkedAt: data.checkedAt,
  });
  return (
    <section
      aria-labelledby="open-issues-here"
      className="border-border bg-card space-y-2 rounded-xl border px-4 py-3"
      data-testid="location-open-issues"
    >
      <h2 id="open-issues-here" className="text-sm font-semibold">
        Open issues here
      </h2>
      {data.openIssues.length > 0 ? (
        <VerificationIssueChips issues={data.openIssues} />
      ) : empty.kind === 'first_check_pending' ? (
        <FirstCheckPending />
      ) : empty.kind === 'out_of_scope' ? (
        <p
          role="status"
          className="bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
          data-testid="location-issues-out-of-scope"
        >
          <Lock className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          {empty.text}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="location-no-open-issues">
          {empty.text}
        </p>
      )}
      {data.openIssuesTruncated ? (
        <p className="text-muted-foreground text-xs">
          More open exceptions exist than are shown here.
        </p>
      ) : null}
      {data.checkedAt ? (
        <p className="text-muted-foreground text-xs">
          Checked at {exceptionTime(data.checkedAt, data.timeZone)}.
        </p>
      ) : null}
    </section>
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
    <li className="py-3" data-testid="location-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={itemHref} className="break-words text-sm font-medium hover:underline">
            {row.name}
          </Link>
          {row.sku ? (
            <p className="text-muted-foreground break-all font-mono text-xs">{row.sku}</p>
          ) : null}
        </div>
        <p className="shrink-0 text-sm tabular-nums" data-testid="location-row-quantity">
          <span className="font-semibold">{formatStockQuantity(row.quantity)}</span> here
        </p>
      </div>
      <div className="mt-1 space-y-0.5 text-xs">
        <p
          className={row.summary === null ? 'text-warning' : undefined}
          data-testid="location-row-count"
        >
          {copy.count}
        </p>
        {copy.movementsSince ? (
          <p className="text-muted-foreground">
            {row.summary?.movementsSince != null ? (
              <Link href={`${itemHref}?tab=movements`} className="hover:underline">
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
                className="hover:underline"
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
