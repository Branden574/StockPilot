import type { Metadata } from 'next';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { SuppliersManager } from '@/components/suppliers/suppliers-manager';
import { requireOrgContext } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Suppliers' };
import { SuppliersService } from '@/server/services/suppliers';

import { can } from '@stockpilot/core';

/** The page area (DESIGN-SPEC 5.3 and 4): max 1320, 16 px gutters on a phone. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

interface SuppliersPageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function SuppliersPage({ searchParams }: SuppliersPageProps) {
  const moduleAccess = await checkModuleAccess('suppliers');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="suppliers" access={moduleAccess} />;
  }
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';
  const [ctx, svc] = await Promise.all([requireOrgContext(), SuppliersService.forCurrentUser()]);
  const canManage = can(ctx, 'suppliers:manage');
  const rows = await svc.list({ includeArchived: isArchivedView });

  return (
    // The header (h1, subline, Active / Archived, New supplier) is drawn by
    // SuppliersManager, which also holds the New supplier dialog it opens.
    <div className={PAGE}>
      <SuppliersManager
        view={isArchivedView ? 'archived' : 'active'}
        canManage={canManage}
        initial={rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          contact_name: (r.contact_name as string | null) ?? null,
          email: (r.email as string | null) ?? null,
          phone: (r.phone as string | null) ?? null,
          website: (r.website as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
        }))}
      />
    </div>
  );
}
