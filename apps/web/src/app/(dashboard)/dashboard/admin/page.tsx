import { Building2, FileLock, type LucideIcon, Users, Warehouse } from 'lucide-react';
import Link from 'next/link';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

interface AdminCard {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  count?: number;
}

export default async function AdminOverviewPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [chartersRes, warehousesRes, membersRes, invitesRes, auditRes] = await Promise.all([
    supabase
      .from('charters')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .neq('status', 'archived'),
    supabase
      .from('warehouses')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .neq('status', 'archived'),
    supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .not('accepted_at', 'is', null),
    supabase
      .from('organization_invites')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
    supabase
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId),
  ]);

  const cards: AdminCard[] = [
    {
      href: '/dashboard/admin/charters',
      icon: Building2,
      title: 'Charters',
      description:
        'Top-level company groupings. Rename to Region / Division / Branch from organization settings.',
      count: chartersRes.count ?? 0,
    },
    {
      href: '/dashboard/admin/warehouses',
      icon: Warehouse,
      title: 'Warehouses',
      description: 'Physical locations stock lives in. Each user is assigned to one or more.',
      count: warehousesRes.count ?? 0,
    },
    {
      href: '/dashboard/admin/users',
      icon: Users,
      title: 'Users & invites',
      description: `${membersRes.count ?? 0} active · ${invitesRes.count ?? 0} pending invite${
        (invitesRes.count ?? 0) === 1 ? '' : 's'
      }`,
      count: membersRes.count ?? 0,
    },
    {
      href: '/dashboard/admin/audit',
      icon: FileLock,
      title: 'Audit log',
      description: 'Every sensitive action — who, when, before/after diff. Read-only.',
      count: auditRes.count ?? 0,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
          Admin
        </p>
        <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">Admin overview</h1>
        <p className="mt-1 text-[13.5px] text-[var(--ed-ink-3)]">
          Configure the company structure, manage user access, and review what changed.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5 transition-colors hover:border-[var(--ed-line-strong)]"
          >
            <div className="flex items-center justify-between">
              <c.icon className="h-5 w-5 text-foreground" strokeWidth={1.5} />
              {c.count != null && (
                <span className="font-mono text-[11px] tabular-nums text-[var(--ed-ink-3)]">
                  {c.count}
                </span>
              )}
            </div>
            <div className="font-display text-[16px] font-medium tracking-[-0.01em]">{c.title}</div>
            <p className="text-[12.5px] leading-[1.55] text-[var(--ed-ink-3)]">{c.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
