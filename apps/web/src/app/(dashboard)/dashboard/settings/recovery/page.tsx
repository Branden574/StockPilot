import { History } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { hasPermission, isAdminRole } from '@stockpilot/core';

import { RestoreButton } from '@/components/settings/restore-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { requireOrgContext } from '@/lib/auth/session';
import { formatRelative } from '@/lib/utils';
import {
  RECOVERY_AUDIT_ENTITY_TYPE,
  RecoveryService,
  type RecoveryEntity,
} from '@/server/services/recovery';

/**
 * Render an absolute timestamp for the title= tooltip. Uses the
 * browser/server's local format with seconds dropped — gives enough
 * precision to disambiguate same-day deletes without being verbose.
 */
function formatExact(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface SectionDef {
  entity: RecoveryEntity;
  title: string;
  description: string;
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  {
    entity: 'inventory_items',
    title: 'Items & Books',
    description: 'Soft-deleted inventory items (including books).',
  },
  {
    entity: 'categories',
    title: 'Categories',
    description: 'Soft-deleted categories.',
  },
  {
    entity: 'locations',
    title: 'Locations',
    description: 'Soft-deleted locations.',
  },
  {
    entity: 'suppliers',
    title: 'Suppliers',
    description: 'Soft-deleted suppliers.',
  },
  // Tags are hard-deleted (no `deleted_at` column); they can't be
  // restored. Categories / locations / suppliers / items have it.
];

export default async function RecoveryPage() {
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'items:delete')) {
    notFound();
  }
  // "View history" links route to /dashboard/settings/audit, which
  // requires admin role. Hide the link for non-admins so we don't
  // dangle a click that 404s.
  const canSeeAudit = isAdminRole(ctx.role);
  const svc = await RecoveryService.forCurrentUser();
  const buckets = await Promise.all(
    SECTIONS.map(async (s) => ({
      ...s,
      rows: await svc.listDeleted(s.entity),
    })),
  );
  const totalDeleted = buckets.reduce((sum, b) => sum + b.rows.length, 0);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/dashboard/settings" className="hover:text-foreground">
          Settings
        </Link>
        <span>/</span>
        <span>Recovery</span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Recovery</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Restore soft-deleted rows. Anything deleted via Archive (or the
        API equivalent) lives here until you restore it — no time limit.
        Restoring brings the row back exactly where it was, with its
        original ID and references intact.
      </p>

      {totalDeleted === 0 ? (
        <Card className="mt-6">
          <CardContent className="pt-6">
            <EmptyState
              icon={History}
              title="Nothing to restore"
              description="Soft-deleted items, categories, suppliers, and locations show up here when they exist."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-4">
          {buckets.map((b) =>
            b.rows.length === 0 ? null : (
              <Card key={b.entity}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{b.title}</CardTitle>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {b.description}
                      </p>
                    </div>
                    <span className="rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-[var(--ed-ink-2)]">
                      {b.rows.length}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="divide-border divide-y">
                    {b.rows.map((r) => {
                      const auditHref = `/dashboard/settings/audit?entityType=${RECOVERY_AUDIT_ENTITY_TYPE[b.entity]}&entityId=${r.id}`;
                      return (
                        <li
                          key={r.id}
                          className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13px]"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{r.name}</div>
                            {r.sku && (
                              <div className="text-muted-foreground truncate font-mono text-[11px]">
                                SKU {r.sku}
                              </div>
                            )}
                            <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
                              <span title={formatExact(r.deleted_at)}>
                                Deleted {formatRelative(r.deleted_at)}
                                {r.deleted_by_name && (
                                  <> by <span className="text-foreground">{r.deleted_by_name}</span></>
                                )}
                              </span>
                              {canSeeAudit && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <Link
                                    href={auditHref}
                                    className="underline-offset-2 hover:text-foreground hover:underline"
                                  >
                                    View history
                                  </Link>
                                </>
                              )}
                            </div>
                          </div>
                          <RestoreButton
                            entity={b.entity}
                            id={r.id}
                            label={r.name}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            ),
          )}
        </div>
      )}

      <p className="text-muted-foreground mt-6 text-[11.5px]">
        Showing the most recent 200 deletes per type. If you need
        something older, contact support.
      </p>
    </div>
  );
}
