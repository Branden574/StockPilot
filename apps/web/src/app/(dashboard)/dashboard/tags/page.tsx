import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { TagsManager } from '@/components/tags/tags-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { TagsService } from '@/server/services/tags';

import { can } from '@stockpilot/core';

// The tab names the page ("Tags · StockPilot"); before, it read the group's
// "Dashboard" (CONFLICTS D16).
export const metadata: Metadata = { title: 'Tags' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box the other pages use. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function TagsPage() {
  // Tags has no dedicated permission — ride on items:update as the
  // closest writer perm so viewers don't see the manager UI.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:update')) {
    redirect('/dashboard');
  }
  const svc = await TagsService.forCurrentUser();
  const rows = await svc.listWithCounts();

  return (
    // The header (h1, subline, New tag) is drawn by TagsManager, which holds
    // the dialog New tag opens.
    <div className={PAGE}>
      <TagsManager
        initial={rows.map((r) => ({
          id: r.id,
          name: r.name,
          color: r.color,
          usage_count: r.usage_count,
        }))}
      />
    </div>
  );
}
