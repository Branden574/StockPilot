import { Package } from 'lucide-react';
import Link from 'next/link';

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
  searchParams: Promise<{ q?: string; show?: string }>;
}) {
  const params = await searchParams;
  const search = params.q?.trim() || undefined;
  const includeInactive = params.show === 'all' || params.show === 'archived';

  const ctx = await requireOrgContext();
  const canManage = hasPermission(ctx.role, 'bundles:manage');
  const svc = await BundlesService.forCurrentUser();
  const bundles = await svc.list({ search, includeInactive });

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bundles</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Reusable kits + book packs. Pre-assemble ahead of time, or draw
            components at distribution.
          </p>
        </div>
        {canManage && (
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
        <div className="border-border bg-background flex items-center gap-1 rounded-md border p-0.5 text-xs">
          <Link
            href="/dashboard/bundles"
            className={`rounded-sm px-2 py-1 ${!includeInactive ? 'bg-foreground text-background' : 'hover:bg-muted'}`}
          >
            Active
          </Link>
          <Link
            href="/dashboard/bundles?show=all"
            className={`rounded-sm px-2 py-1 ${includeInactive ? 'bg-foreground text-background' : 'hover:bg-muted'}`}
          >
            All
          </Link>
        </div>
      </form>

      <div className="mt-6">
        {bundles.length === 0 && !search ? (
          <EmptyState
            icon={Package}
            title="No bundles yet"
            description="Create a bundle to ship grouped sets of items in one click — useful for school packs, kits, or recurring drop-offs."
            cta={canManage ? { label: 'Create your first bundle', href: '/dashboard/bundles/new' } : undefined}
          />
        ) : bundles.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No bundles match this search"
            description="Try a different name or SKU, or clear the search to see all bundles."
            cta={{ label: 'Clear search', href: includeInactive ? '/dashboard/bundles?show=all' : '/dashboard/bundles' }}
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
                  <TableHead className="text-right">Last distributed</TableHead>
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
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {b.lastDistributedAt ? formatRelative(b.lastDistributedAt) : 'Never'}
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
