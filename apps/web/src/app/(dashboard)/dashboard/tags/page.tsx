import { redirect } from 'next/navigation';

import { TagsManager } from '@/components/tags/tags-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { TagsService } from '@/server/services/tags';

import { can } from '@stockpilot/core';

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
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tags</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Flexible labels you can apply to many items at once. Stack them
          with categories for finer-grained filtering.
        </p>
      </div>
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
