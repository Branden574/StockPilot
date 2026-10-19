import { History } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { can } from '@stockpilot/core';

import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { DeletedAtTooltip, RestoreButton } from '@/components/settings/restore-button';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
import { requireOrgContext } from '@/lib/auth/session';
import { formatRelative } from '@/lib/utils';
import {
  RECOVERY_AUDIT_ENTITY_TYPE,
  RecoveryService,
  type RecoveryEntity,
} from '@/server/services/recovery';

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
  if (!can(ctx, 'items:delete')) {
    notFound();
  }
  // "View history" links route to /dashboard/audit, which is gated on
  // `activity_logs:read`. The audit_logs SELECT RLS is permission-driven
  // (mig 0279) matching the matrix — so checking the permission instead
  // of `isAdminRole` lets managers (who already have activity_logs:read)
  // follow the link cleanly. See C11.
  const canSeeAudit = can(ctx, 'activity_logs:read');
  const svc = await RecoveryService.forCurrentUser();
  const buckets = await Promise.all(
    SECTIONS.map(async (s) => ({
      ...s,
      rows: await svc.listDeleted(s.entity),
    })),
  );
  const totalDeleted = buckets.reduce((sum, b) => sum + b.rows.length, 0);

  return (
    <SettingsPage width="wide">
      <PageHeader
        title="Recovery"
        subline="Restore soft-deleted rows. Anything deleted via Archive (or the API equivalent) lives here until you restore it — no time limit. Restoring brings the row back exactly where it was, with its original ID and references intact."
        back={
          <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
            <Link href="/dashboard/settings" className="hover:text-foreground transition-colors">
              Settings
            </Link>
            <span aria-hidden className="text-ink-4">
              /
            </span>
            <span>Recovery</span>
          </div>
        }
      />

      {totalDeleted === 0 ? (
        <StatePanel
          kind="empty"
          icon={History}
          title="Nothing to restore"
          description="Soft-deleted items, categories, suppliers, and locations show up here when they exist."
        />
      ) : (
        buckets.map((b) =>
          b.rows.length === 0 ? null : (
            <SettingsPanel
              key={b.entity}
              title={b.title}
              description={b.description}
              aside={
                <span className="text-ink-2 rounded-full border border-[var(--ed-line-strong)] px-2 py-0.5 font-mono text-[11px] tabular-nums">
                  {b.rows.length}
                </span>
              }
              flush
            >
              <ul className="divide-border divide-y">
                {b.rows.map((r) => {
                  const auditHref = `/dashboard/audit?entityType=${RECOVERY_AUDIT_ENTITY_TYPE[b.entity]}&entityId=${r.id}`;
                  return (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-[18px] py-2.5 text-[13.5px]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{r.name}</div>
                        {r.sku && (
                          <div className="text-muted-foreground truncate font-mono text-[11.5px]">
                            SKU {r.sku}
                          </div>
                        )}
                        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                          <DeletedAtTooltip iso={r.deleted_at}>
                            Deleted {formatRelative(r.deleted_at)}
                            {r.deleted_by_name && (
                              <>
                                {' '}
                                by <span className="text-foreground">{r.deleted_by_name}</span>
                              </>
                            )}
                          </DeletedAtTooltip>
                          {canSeeAudit && (
                            <>
                              <span aria-hidden="true">·</span>
                              <Link
                                href={auditHref}
                                className="hover:text-foreground underline-offset-2 hover:underline"
                              >
                                View history
                              </Link>
                            </>
                          )}
                        </div>
                      </div>
                      <RestoreButton entity={b.entity} id={r.id} label={r.name} />
                    </li>
                  );
                })}
              </ul>
            </SettingsPanel>
          ),
        )
      )}

      <p className="text-muted-foreground text-[12px]">
        Showing the most recent 200 deletes per type. If you need something older, contact support.
      </p>
    </SettingsPage>
  );
}
