import type { Metadata } from 'next';
import Link from 'next/link';

import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { listPlatformAudit, type PlatformAuditAction } from '@/server/services/platform/audit';

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
};

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
    <div className="mx-auto w-full max-w-[1280px] px-6 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <h1 className="font-display text-[26px] font-medium tracking-[-0.025em]">Platform audit</h1>
        <p className="mt-1 text-[13px] text-[var(--ed-ink-3)]">
          Every god-mode action — who, what, which org, when. Append-only, newest first.
        </p>
        {orgFilter ? (
          <p className="mt-2 text-[12px]">
            <span className="text-[var(--ed-ink-4)]">Filtered to one organization.</span>{' '}
            <Link href="/platform/audit" className="font-medium hover:underline">
              Show all
            </Link>
          </p>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-[10px] border border-border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-card text-left text-[11px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Actor</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Target org</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-[var(--ed-ink-4)]">
                  No platform-admin actions recorded yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-[12px] text-[var(--ed-ink-4)]">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--ed-ink-3)]">{r.actorEmail}</td>
                  <td className="px-4 py-2.5 font-medium">{ACTION_LABEL[r.action] ?? r.action}</td>
                  <td className="px-4 py-2.5 font-mono text-[11.5px] text-[var(--ed-ink-4)]">
                    {r.targetOrganizationId ?? '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
