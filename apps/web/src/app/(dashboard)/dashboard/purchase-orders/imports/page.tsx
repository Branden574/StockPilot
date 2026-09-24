import { FileText } from 'lucide-react';
import Link from 'next/link';

import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PoImportSearch } from '@/components/po-imports/po-import-search';
import { PoImportStatusBadge } from '@/components/po-imports/po-import-status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PoImportsService, type PoImportRow } from '@/server/services/po-imports';
import { PageTour } from '@/components/onboarding/page-tour';
import { PO_IMPORTS_TOUR } from '@/lib/onboarding/tours';
import { DEFAULT_TAB, isImportTab, TAB_LABELS, TAB_ORDER, TAB_STATUSES, type PoImportTab } from '@/lib/po-imports/tabs';

import {
  formatOrgDate,
  formatOrgDateTime,
  poImportUploaderLabel,
  resolveOrgTimezone,
  type PoImportUploaderProfile,
} from '@stockpilot/core';

export const metadata = { title: 'PO imports' };

/** Rows per page — matches the purchase-orders page's server-pagination convention. */
const PAGE_SIZE = 30;

export default async function PoImportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('po_imports');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="po_imports" canManage={moduleAccess.canManage} />;
  }

  const params = await searchParams;
  // DEFAULT = Active: this alone unmixes cancelled/approved runs — especially
  // the owner's own test uploads — from the working set that actually needs
  // attention (owner request 2026-07-16).
  const tab: PoImportTab = isImportTab(params.status) ? params.status : DEFAULT_TAB;
  const q = (params.q ?? '').trim();
  const page = Math.max(1, Number(params.page) || 1);

  // The Uploaded column prints a calendar day, and whose day it is matters: in
  // the server's zone (UTC on Vercel) an evening upload in California lands on
  // the next date. So the org's zone, from the request-cached org row (the same
  // one the layout and the cycle-counts list read; normally already in hand
  // from the membership bundle). Started before the list reads rather than
  // awaited ahead of them, and an unreadable row falls back to the documented
  // default zone instead of taking the list down (getOrgRowForRequest throws
  // on a read error).
  const ctx = await requireOrgContext();
  const timezoneRead = getOrgRowForRequest(ctx.organizationId)
    .then((org) => resolveOrgTimezone(org?.timezone))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'po_imports.list.org_timezone_failed', level: 'warning' });
      return resolveOrgTimezone(null);
    });

  let rows: PoImportRow[] = [];
  // Who uploaded each row, keyed by user id; null when the lookup failed.
  let uploaders: ReadonlyMap<string, PoImportUploaderProfile> | null = new Map();
  let total = 0;
  let counts: Record<PoImportTab, number> = { active: 0, approved: 0, cancelled: 0 };
  let loadFailed = false;
  // True when the search matched more suppliers or POs than one request can
  // carry: the list then covers the most recent of them only, and says so.
  let searchCapped = false;
  try {
    const svc = await PoImportsService.forCurrentUser();
    // Rows + the current tab's filtered total (pagination) + the three
    // UNFILTERED per-tab totals (pill counts — always reflect the whole
    // bucket, independent of the active search, like an inbox count).
    const [listed, totalResult, activeCount, approvedCount, cancelledCount, capped] =
      await Promise.all([
        // The uploader lookup starts as soon as the rows land, so it runs
        // beside the counts instead of after them. It never throws: a failed
        // lookup comes back as null (reported) and the rows show "—".
        svc
          .list({
            statuses: TAB_STATUSES[tab],
            q,
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
          })
          .then(async (listRows) => ({
            listRows,
            profiles: await svc.uploaderProfiles(listRows.map((r) => r.uploaded_by)),
          })),
        svc.count({ statuses: TAB_STATUSES[tab], q }),
        svc.count({ statuses: TAB_STATUSES.active }),
        svc.count({ statuses: TAB_STATUSES.approved }),
        svc.count({ statuses: TAB_STATUSES.cancelled }),
        // Shares list()'s memoized search resolution: no extra query.
        q ? svc.searchCapped(q) : Promise.resolve(false),
      ]);
    searchCapped = capped;
    rows = listed.listRows;
    uploaders = listed.profiles;
    total = totalResult;
    counts = { active: activeCount, approved: approvedCount, cancelled: cancelledCount };
  } catch (error) {
    // Fail CLOSED: a read error must NEVER crash the whole page (recurring
    // bug pattern #1). Degrade to an inline retry banner so the header,
    // tabs, and "+ New import" button still work.
    console.error('[dashboard/purchase-orders/imports] failed to load imports', {
      tab,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    loadFailed = true;
  }

  const totalAcrossTabs = counts.active + counts.approved + counts.cancelled;
  const tz = await timezoneRead;

  // SERIALIZABLE props only: this is a server component rendering a 'use
  // client' pager, and a function prop (hrefForPage) crashes any non-empty
  // list at runtime — RSC refuses to serialize functions (digest
  // 3969804129; see dashboard/maintenance/page.tsx's fix, Task 25 fast-follow
  // BUG 1 sibling). baseParams mirrors this page's query contract
  // (status/q) exactly, the same pair the tab links and search box write.
  const importsBaseParams: Record<string, string> = { status: tab };
  if (q) importsBaseParams.q = q;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PO imports</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Upload a vendor PO PDF or CSV to stage expected inbound. Inventory
            is not changed until you receive the items.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PageTour tour={PO_IMPORTS_TOUR} />
          <Button asChild variant="gradient">
            <Link href="/dashboard/purchase-orders/imports/new">+ New import</Link>
          </Button>
        </div>
      </div>

      {/* Filter tabs + search — mutually-exclusive status partition (see
          lib/po-imports/tabs.ts): every po_imports.status lands in exactly
          one tab. Pill counts are UNFILTERED per-tab totals (ignore the
          active search), so they read like inbox counts. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          {TAB_ORDER.map((t) => {
            const isActive = t === tab;
            const href =
              `/dashboard/purchase-orders/imports?status=${t}` +
              (q ? `&q=${encodeURIComponent(q)}` : '');
            return (
              <Link
                key={t}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={
                  'rounded-full px-3 py-1 text-sm transition-colors ' +
                  (isActive
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:bg-muted')
                }
              >
                {TAB_LABELS[t]} <span className="tabular-nums opacity-70">{counts[t]}</span>
              </Link>
            );
          })}
        </nav>

        <PoImportSearch key={`${tab}:${q}`} status={tab} initialQuery={q} />
      </div>

      {!loadFailed && searchCapped && (
        /* A search term that matches many suppliers or POs ("a") can only
           carry the most recent of them in one request. Say so, rather than
           present a partial list as every match. */
        <p role="status" className="text-muted-foreground mt-3 text-sm">
          Showing matches for the most recent suppliers and POs only. Refine the search to find
          older ones.
        </p>
      )}

      <div className="mt-4">
        {loadFailed ? (
          <div className="bg-card border-destructive/40 rounded-xl border p-6 text-center">
            <h2 className="text-destructive text-sm font-medium">
              We couldn&apos;t load imports
            </h2>
            <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
              Something went wrong loading this list. This is usually temporary — try again in a
              moment.
            </p>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/dashboard/purchase-orders/imports">Try again</Link>
            </Button>
          </div>
        ) : totalAcrossTabs === 0 ? (
          <EmptyState
            icon={FileText}
            title="No imports yet"
            description="Upload a vendor PO PDF or CSV to get started — inventory won't change until you receive against it."
            cta={{ label: 'Upload your first import', href: '/dashboard/purchase-orders/imports/new' }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={
              total > 0
                ? 'Nothing on this page'
                : q
                  ? `No imports match "${q}"`
                  : `Nothing in ${TAB_LABELS[tab].toLowerCase()}`
            }
            description={
              total > 0
                ? 'This page is past the end of the list — jump back with the pagination below.'
                : q
                  ? 'Try a different import name, file name, supplier, or PO number, or clear the search.'
                  : 'Switch tabs above to see imports in other stages.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Uploaded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      {/* Primary label is the human name (mig 0333); the real
                          uploaded filename stays visible underneath, because
                          "which document was this?" is still a question people
                          answer from this list. An unnamed import (every
                          historical row) renders exactly as it always did: the
                          filename as the link, nothing below it. */}
                      <Link
                        href={`/dashboard/purchase-orders/imports/${i.id}`}
                        className="font-medium hover:underline"
                      >
                        {i.display_name ?? i.file_name}
                      </Link>
                      {i.display_name && (
                        <p className="text-muted-foreground mt-0.5 truncate text-xs">
                          {i.file_name}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {i.source_type}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <PoImportStatusBadge status={i.status} />
                        {/* Orthogonal to status (migs 0286/0287): a superseded
                            import keeps status='approved' and stays in its tab,
                            so these pills add no tab and change no count — they
                            only make a stale row (and its redo) recognizable
                            without opening it. */}
                        {i.superseded_at && (
                          <span
                            className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px]"
                            title="Replaced by a later import of this file"
                          >
                            superseded
                          </span>
                        )}
                        {i.reimported_from_id && (
                          <span
                            className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]"
                            title="Re-import of an earlier import whose purchase order was cancelled"
                          >
                            re-import
                          </span>
                        )}
                      </div>
                    </TableCell>
                    {/* The date itself, not "2 weeks ago": people track
                        uploads against a calendar (owner request 2026-09-24).
                        The hover gives the time as well. Who uploaded it is
                        the second line rather than a column of its own: the
                        date and the person are one fact, and a fifth column
                        would take its width from Name on a narrow screen. */}
                    <TableCell className="text-muted-foreground whitespace-nowrap text-right text-xs tabular-nums">
                      <time
                        dateTime={i.created_at}
                        title={formatOrgDateTime(
                          i.created_at,
                          { dateStyle: 'medium', timeStyle: 'short' },
                          tz,
                        )}
                      >
                        {formatOrgDate(i.created_at, { dateStyle: 'medium' }, tz)}
                      </time>
                      <UploadedByLine label={poImportUploaderLabel(uploaders, i.uploaded_by)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Server-side numbered pagination — hidden on single-page lists,
            same convention as the purchase-orders page. */}
        {!loadFailed && (total > PAGE_SIZE || page > 1) && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            basePath="/dashboard/purchase-orders/imports"
            baseParams={importsBaseParams}
            className="mt-3"
          />
        )}
      </div>
    </div>
  );
}

/** The Uploaded cell's second line. Truncated so a long name cannot widen the
 *  column; the hover shows it whole. */
function UploadedByLine({ label }: { label: string }) {
  return (
    <p className="mt-0.5 ml-auto max-w-[12rem] truncate" title={`Uploaded by ${label}`}>
      by {label}
    </p>
  );
}
