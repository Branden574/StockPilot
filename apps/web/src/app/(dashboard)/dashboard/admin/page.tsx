import {
  Building2,
  ChevronRight,
  FileLock,
  type LucideIcon,
  PlusCircle,
  Users,
  Warehouse,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { currentUserIsPlatformAdmin } from '@/lib/auth/platform-admin';
import { requireOrgContext } from '@/lib/auth/session';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { createClient } from '@/lib/supabase/server';

interface AdminCard {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  count?: number;
}

/**
 * The Admin hub (matrix W-AD-01): a navigation page, so it draws the
 * reference's compact rows (the Overview "Needs attention" list: icon, title,
 * detail, a mono count and a chevron) instead of big tiles. Which rows exist,
 * where they link and every count rule are unchanged: five exact head-counts,
 * never a row read (audit_logs is large).
 */
export default async function AdminOverviewPage() {
  const ctx = await requireOrgContext();
  const platformAdmin = await currentUserIsPlatformAdmin();
  const supabase = await createClient();

  const [chartersRes, warehousesRes, membersRes, invitesRes, auditRes, title] = await Promise.all([
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
    // A Settings > Navigation rename of the sidebar entry reaches the heading
    // too (no read of its own: the org row is cached for the request).
    effectiveNavLabel('/dashboard/admin', 'Admin overview'),
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
      href: '/dashboard/audit',
      icon: FileLock,
      title: 'Audit log',
      description: 'Every sensitive action — who, when, before/after diff. Read-only.',
      count: auditRes.count ?? 0,
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        eyebrow="Admin"
        title={title}
        subline="Configure the company structure, manage user access, and review what changed."
      />

      {platformAdmin && (
        // Only allowlisted platform admins see this card: it is labelled as
        // theirs and kept apart from the org's own admin rows.
        <DetailSection
          data-testid="admin-platform-block"
          title={
            <span className="inline-flex items-center gap-2">
              <PlusCircle className="text-muted-foreground h-4 w-4" strokeWidth={1.6} aria-hidden />
              Platform admin
            </span>
          }
          flush
        >
          <ul className="divide-border divide-y">
            <PlatformRow
              title="Provision a new organization"
              description="Create a customer account + org + magic-link invite in one step. Audit-logged."
              href="/dashboard/admin/orgs/new"
            />
            <PlatformRow
              title="Support tickets"
              description={
                <>Triage &ldquo;report a problem&rdquo; tickets from the public support page.</>
              }
              href="/dashboard/admin/support"
            />
          </ul>
        </DetailSection>
      )}

      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <ul className="divide-border divide-y">
          {cards.map((c) => (
            <li key={c.href}>
              <Link
                href={c.href}
                className="hover:bg-muted group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 px-[18px] py-[13px] transition-colors focus-visible:ring-inset focus-visible:ring-offset-0"
              >
                <span
                  aria-hidden
                  className="border-border bg-sunk text-ink-2 flex size-8 items-center justify-center rounded-md border"
                >
                  <c.icon className="h-4 w-4" strokeWidth={1.6} />
                </span>
                <span className="min-w-0">
                  <span className="text-foreground block text-[13.5px] font-medium leading-5">
                    {c.title}
                  </span>
                  <span className="text-muted-foreground block text-[12.5px] leading-[18.75px] [text-wrap:pretty]">
                    {c.description}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {c.count != null && (
                    <span className="text-muted-foreground font-mono text-[12px] tabular-nums">
                      {c.count}
                    </span>
                  )}
                  <ChevronRight
                    aria-hidden
                    className="text-muted-foreground h-3.5 w-3.5"
                    strokeWidth={1.8}
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PlatformRow({
  title,
  description,
  href,
}: {
  title: string;
  description: ReactNode;
  href: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-[18px] py-[13px]">
      <div className="min-w-0 flex-1 basis-60">
        <div className="text-foreground text-[13.5px] font-medium leading-5">{title}</div>
        <p className="text-muted-foreground text-[12.5px] leading-[18.75px]">{description}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href={href}>Open</Link>
      </Button>
    </li>
  );
}
