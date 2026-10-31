import { History, Package, Search, SearchX } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { FilterBar } from '@/components/patterns/filter-bar';
import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { RestoreBundleButton } from '@/components/bundles/restore-bundle-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { BundlesService } from '@/server/services/bundles';
import { formatNumber, formatRelative } from '@/lib/utils';

/** The page area (DESIGN-SPEC 4 and 5.3): max 1320, 28 / 32 / 64 padding, a
 *  16 px gutter on a phone, 16 px between blocks. The same box the loading
 *  skeleton draws. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/**
 * The bundle (kit) list. Bundles are kits with a recipe, pre-assembly and
 * distribution; they are NOT product groups, so this list has no row
 * selection, no group headers and no Group selected / Ungroup (CONFLICTS K6).
 */
export default async function BundlesListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('bundles');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="bundles" access={moduleAccess} />;
  }
  const params = await searchParams;
  const search = params.q?.trim() || undefined;
  const isArchivedView = params.view === 'archived';

  const ctx = await requireOrgContext();
  // Visibility gates on bundles:read (staff+ by default, grantable to
  // viewers for read-only audit access). bundles:distribute holders keep
  // access even if an org revokes the read perm from a role that can still
  // distribute. Create/edit CTAs below stay gated on bundles:manage.
  if (!can(ctx, 'bundles:read') && !can(ctx, 'bundles:distribute')) {
    redirect('/dashboard');
  }
  const canManage = can(ctx, 'bundles:manage');
  const svc = await BundlesService.forCurrentUser();
  const bundles = await svc.list({ search, includeArchived: isArchivedView });

  return (
    <div className={PAGE}>
      <PageHeader
        title="Bundles"
        titleId="bundles-title"
        subline={
          isArchivedView
            ? 'Bundles you archived. Restore one to put it back in rotation.'
            : 'Reusable kits + book packs. Pre-assemble ahead of time, or draw components at distribution.'
        }
        primaryAction={
          canManage && !isArchivedView ? (
            <Button asChild variant="gradient">
              <Link href="/dashboard/bundles/new">+ New bundle</Link>
            </Button>
          ) : null
        }
      />

      {/* One wrapping row (DESIGN-SPEC 6.4 / 6.5): the Active / Archived views
          on the left, the search on the right. The search is still a GET form
          to this page, submitted with Enter, carrying the archived view. */}
      <FilterBar leading={<ArchiveViewToggle view={isArchivedView ? 'archived' : 'active'} />}>
        <form action="/dashboard/bundles" className="w-full sm:w-auto">
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
              strokeWidth={1.8}
            />
            <Input
              type="text"
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search by name or SKU"
              aria-label="Search by name or SKU"
              className="pl-8 sm:w-[260px]"
            />
          </div>
          {isArchivedView && <input type="hidden" name="view" value="archived" />}
        </form>
      </FilterBar>

      {/* One card for the list, whatever it holds: the table, or the empty or
          no-match state in its place. */}
      <div className="border-border bg-card min-w-0 overflow-hidden rounded-lg border">
        {bundles.length === 0 && !search ? (
          isArchivedView ? (
            <StatePanel
              kind="empty"
              surface="plain"
              icon={History}
              title="No archived bundles"
              description="Bundles you archive show up here so you can restore them later."
            />
          ) : (
            <StatePanel
              kind="empty"
              surface="plain"
              icon={Package}
              title="No bundles yet"
              description="Create a bundle to ship grouped sets of items in one click — useful for school packs, kits, or recurring drop-offs."
              action={
                canManage ? (
                  <Button asChild variant="gradient">
                    <Link href="/dashboard/bundles/new">Create your first bundle</Link>
                  </Button>
                ) : null
              }
            />
          )
        ) : bundles.length === 0 ? (
          <StatePanel
            kind="no-match"
            surface="plain"
            icon={SearchX}
            title="No bundles match this search"
            description="Try a different name or SKU, or clear the search to see all bundles."
            action={
              <Button asChild variant="outline">
                <Link
                  href={isArchivedView ? '/dashboard/bundles?view=archived' : '/dashboard/bundles'}
                >
                  Clear search
                </Link>
              </Button>
            }
          />
        ) : (
          <Table scrollLabelledBy="bundles-title" className="min-w-[720px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Components</TableHead>
                <TableHead className="text-right">Pre-assembled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  {isArchivedView ? 'Actions' : 'Last distributed'}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bundles.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/bundles/${b.id}`}
                      className="text-foreground font-medium [overflow-wrap:anywhere] hover:underline"
                    >
                      {b.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap font-mono text-[12.5px]">
                    {b.sku ?? '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatNumber(b.componentCount)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {b.preassemblyEnabled ? formatNumber(b.preassembledQty) : '—'}
                  </TableCell>
                  <TableCell>
                    {b.archivedAt ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : b.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="warning">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isArchivedView ? (
                      canManage ? (
                        <RestoreBundleButton bundleId={b.id} bundleName={b.name} />
                      ) : (
                        <span className="text-muted-foreground text-[12.5px]">—</span>
                      )
                    ) : (
                      <span className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                        {b.lastDistributedAt ? formatRelative(b.lastDistributedAt) : 'Never'}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
