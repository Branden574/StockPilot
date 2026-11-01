import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformTable } from '@/components/platform/platform-table';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { formatExactUtc } from '@/lib/platform/last-active';
import {
  platformAuditActorLabel,
  platformAuditTargetLabel,
} from '@/lib/people/deleted-person-labels';
import {
  auditDetailReason,
  auditDetailSuperseded,
  listPlatformAudit,
  type PlatformAuditAction,
} from '@/server/services/platform/audit';

import {
  ORDER_ITEMS_ACCESS_AUDIT_LABEL,
  ORDER_ITEMS_ACCESS_STATE_LABELS,
  PERMISSION_EXCEPTION_STATES,
  type PermissionExceptionState,
} from '@stockpilot/core';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Audit · Platform' };

const ACTION_LABEL: Record<PlatformAuditAction, string> = {
  viewed_org: 'Viewed org',
  acted_as_start: 'Started acting as',
  acted_as_end: 'Stopped acting as',
  billing_changed: 'Changed billing',
  password_reset_sent: 'Sent password reset',
  org_provisioned: 'Provisioned org',
  ticket_updated: 'Updated ticket',
  deletion_passphrase_set: 'Set org-deletion passphrase',
  org_deleted: 'Deleted org',
  user_disabled: 'Disabled account',
  user_reenabled: 'Re-enabled account',
  permission_exception_changed: ORDER_ITEMS_ACCESS_AUDIT_LABEL,
};

const EXCEPTION_STATES: ReadonlySet<string> = new Set(PERMISSION_EXCEPTION_STATES);

function isExceptionState(v: unknown): v is PermissionExceptionState {
  return typeof v === 'string' && EXCEPTION_STATES.has(v);
}

/**
 * "Follow role default → Deny" for an Order items access change (migration
 * 0413 writes detail {permission, before, after, target_role}); null for any
 * other row, or a detail this build cannot read, so nothing is guessed.
 */
function exceptionChangeOf(action: string, detail: Record<string, unknown>): string | null {
  if (action !== 'permission_exception_changed') return null;
  const { before, after } = detail;
  if (!isExceptionState(before) || !isExceptionState(after)) return null;
  return `${ORDER_ITEMS_ACCESS_STATE_LABELS[before]} → ${ORDER_ITEMS_ACCESS_STATE_LABELS[after]}`;
}

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  // In-page gate — the layout renders in parallel and can't stop this body's
  // service-role read of the cross-org platform-admin audit trail.
  await requirePlatformAdmin();

  const { org } = await searchParams;
  const orgFilter = org && /^[0-9a-f-]{36}$/i.test(org) ? org : undefined;
  const rows = await listPlatformAudit({ limit: 200, organizationId: orgFilter });

  return (
    <PlatformPage>
      <PageHeader
        title="Platform audit"
        subline="Every god-mode action — who, what, against whom, which org, why, when. Append-only, newest first."
      >
        {orgFilter ? (
          <p className="mt-2 text-[12.5px]">
            <span className="text-muted-foreground">Filtered to one organization.</span>{' '}
            <Link
              href="/platform/audit"
              className="text-accent hover:text-foreground font-medium transition-colors"
            >
              Show all
            </Link>
          </p>
        ) : null}
      </PageHeader>

      <PlatformTable label="Platform audit" minWidth={980}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {/* The trail spans organizations, so it is printed in UTC and says
                so: this page renders on the server, and a bare toLocaleString()
                printed the server's clock with no zone named (B9). */}
            <TableHead title="In UTC.">When</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            {/* A disable is only auditable if you can see WHO it hit and WHY.
                Both were already on the row; only the read and this table
                were dropping them. */}
            <TableHead>Target user</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Target org</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="p-0">
                <StatePanel
                  kind="empty"
                  surface="plain"
                  headingLevel={null}
                  icon={null}
                  title="No platform-admin actions recorded yet."
                />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => {
              const reason = auditDetailReason(r.detail);
              // `action` alone reads identically for a real disable and a
              // press that lost the race to a peer admin's concurrent
              // transition (account-status.ts CONVERGENCE) — both write
              // `user_disabled`/`user_reenabled`. Surfacing it here means
              // an operator scanning this table doesn't have to open the
              // row's raw detail to tell them apart.
              const superseded = auditDetailSuperseded(r.detail);
              const exceptionChange = exceptionChangeOf(r.action, r.detail);
              return (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                    {formatExactUtc(r.createdAt) ?? '—'}
                  </TableCell>
                  {/* An admin who deleted their account (0393) keeps the
                      email the row recorded: "Deleted user · email". */}
                  <TableCell className="text-ink-2">{platformAuditActorLabel(r)}</TableCell>
                  <TableCell className="text-foreground whitespace-nowrap font-medium">
                    {ACTION_LABEL[r.action] ?? r.action}
                    {superseded ? (
                      <span className="text-muted-foreground ml-1.5 text-[12px] font-normal">
                        (superseded)
                      </span>
                    ) : null}
                    {exceptionChange ? (
                      <div className="text-muted-foreground text-[12px] font-normal">
                        {exceptionChange}
                      </div>
                    ) : null}
                  </TableCell>
                  {/* Email when it resolves, uuid when it does not — never a
                      blank cell for a row that names a user. */}
                  <TableCell
                    className={
                      r.targetUserEmail
                        ? 'text-ink-2'
                        : 'text-muted-foreground font-mono text-[12px]'
                    }
                    title={r.targetUserId ?? undefined}
                  >
                    {platformAuditTargetLabel(r)}
                  </TableCell>
                  {/* `title` carries the full text: a reason can run to 500
                      characters and must not stretch the row. */}
                  <TableCell
                    className="text-ink-2 max-w-[280px] truncate"
                    title={reason ?? undefined}
                  >
                    {reason ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap font-mono text-[12px]">
                    {r.targetOrganizationId ?? '—'}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </PlatformTable>
    </PlatformPage>
  );
}
