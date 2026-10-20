import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { TagsManager } from '@/components/tags/tags-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { isNextControlFlowError } from '@/lib/error-reporter';
import { effectiveNavLabel } from '@/lib/nav-labels';
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
  // The heading follows a Settings > Navigation rename of this page's sidebar
  // entry, as the sidebar and the crumb do (PLAN rule 10): a lookup of the
  // request-cached org row the dashboard layout already read, so nothing new
  // is read; a failed lookup keeps the page's own word.
  const [rows, title] = await Promise.all([
    TagsService.forCurrentUser().then((svc) => svc.listWithCounts()),
    effectiveNavLabel('/dashboard/tags', 'Tags').catch((e: unknown) => {
      if (isNextControlFlowError(e)) throw e;
      return 'Tags';
    }),
  ]);

  return (
    // The header (h1, subline, New tag) is drawn by TagsManager, which holds
    // the dialog New tag opens.
    <div className={PAGE}>
      <TagsManager
        title={title}
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
