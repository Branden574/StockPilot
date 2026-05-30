import { History, Package } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { RestoreBundleButton } from '@/components/bundles/restore-bundle-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { BundlesService } from '@/server/services/bundles';
import { formatNumber, formatRelative } from '@/lib/utils';

export default async function BundlesListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('bundles');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="bundles" canManage={moduleAccess.canManage} />;
  }
  const params = await searchParams;
  const search = params.q?.trim() || undefined;
  const isArchivedView = params.view === 'archived';

  const ctx = await requireOrgContext();
  // Bundles list is staff-or-better (bundles:distribute). Viewers don't
  // have it and shouldn't see the list either. Sidebar already hides
  // this; redirect here covers direct URL access.
  if (!hasPermission(ctx.role, 'bundles:distribute')) {
    redirect('/dashboard');
  }
  const canManage = hasPermission(ctx.role, 'bundles:manage');
  const svc = await BundlesService.forCurrentUser();
  const bundles = await svc.list({ search, includeArchived: isArchivedView });

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bundles</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {isArchivedView
              ? 'Bundles you archived. Restore one to put it back in rotation.'
              : 'Reusable kits + book packs. Pre-assemble ahead of time, or draw components at distribution.'}
          </p>
        </div>
        {canManage && !isArchivedView && (
          <Button asChild variant="gradient">
            <Link href="/dashboard/bundles/new">+ New bundle</Link>
          </Button>
        )}
      </div>

      <form className="mt-6 flex flex-wrap items-center gap-2" action="/dashboard/bundles">
        <input
          type="text"
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search by name or SKU"
          className="border-border bg-card focus:ring-ring h-9 w-full max-w-sm rounded-md border px-3 text-sm focus:outline-none focus:ring-2"
        />
        {isArchivedView && <input type="hidden" name="view" value="archived" />}
        <ArchiveViewToggle view={isArchivedView ? 'archived' : 'active'} />
      </form>

      <div className="mt-6">
        {bundles.length === 0 && !search ? (
          isArchivedView ? (
            <EmptyState
              icon={History}
              title="No archived bundles"
              description="Bundles you archive show up here so you can restore them later."
            />
          ) : (
            <EmptyState
              icon={Package}
              title="No bundles yet"
              description="Create a bundle to ship grouped sets of items in one click — useful for school packs, kits, or recurring drop-offs."
              cta={canManage ? { label: 'Create your first bundle', href: '/dashboard/bundles/new' } : undefined}
            />
          )
        ) : bundles.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No bundles match this search"
            description="Try a different name or SKU, or clear the search to see all bundles."
            cta={{
              label: 'Clear search',
              href: isArchivedView ? '/dashboard/bundles?view=archived' : '/dashboard/bundles',
            }}
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
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
                        className="text-sm font-medium hover:underline"
                      >
                        {b.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {b.sku ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(b.componentCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
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
                          <span className="text-muted-foreground text-xs">—</span>
                        )
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {b.lastDistributedAt ? formatRelative(b.lastDistributedAt) : 'Never'}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
