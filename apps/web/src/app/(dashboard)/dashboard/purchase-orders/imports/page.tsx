import { FileText } from 'lucide-react';
import Link from 'next/link';

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
import { formatRelative } from '@/lib/utils';
import { PageTour } from '@/components/onboarding/page-tour';
import { PO_IMPORTS_TOUR } from '@/lib/onboarding/tours';
import { DEFAULT_TAB, isImportTab, TAB_LABELS, TAB_ORDER, TAB_STATUSES, type PoImportTab } from '@/lib/po-imports/tabs';

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

  let rows: PoImportRow[] = [];
  let total = 0;
  let counts: Record<PoImportTab, number> = { active: 0, approved: 0, cancelled: 0 };
  let loadFailed = false;
  try {
    const svc = await PoImportsService.forCurrentUser();
    // Rows + the current tab's filtered total (pagination) + the three
    // UNFILTERED per-tab totals (pill counts — always reflect the whole
    // bucket, independent of the active search, like an inbox count).
    const [rowsResult, totalResult, activeCount, approvedCount, cancelledCount] = await Promise.all([
      svc.list({
        statuses: TAB_STATUSES[tab],
        q,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
      svc.count({ statuses: TAB_STATUSES[tab], q }),
      svc.count({ statuses: TAB_STATUSES.active }),
      svc.count({ statuses: TAB_STATUSES.approved }),
      svc.count({ statuses: TAB_STATUSES.cancelled }),
    ]);
    rows = rowsResult;
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
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {formatRelative(i.created_at)}
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
