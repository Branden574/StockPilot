'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Input } from '@/components/ui/input';

import type { MaintenanceStatus } from '@stockpilot/core';

/**
 * Search box for "All maintenance requests" (read_all/manage). Brief
 * section 22 scopes filtering and search to that view — the plain "My
 * requests" list carries no search box, so this component is only ever
 * mounted with scope='all'.
 *
 * Same client-navigation idiom as the purchase-orders search box
 * (po-search.tsx): router.push carries the active scope + status so
 * neither is lost when the search term changes, and submitting always
 * drops back to page 1 (no `page` param is ever written here). The
 * service's own .or() sanitization (maintenance-requests.ts list()) does
 * the real escaping — this component only builds the URL.
 */
export function MaintenanceSearch({
  scope,
  status,
  initialQuery,
}: {
  scope: 'mine' | 'all';
  status?: MaintenanceStatus | 'active';
  initialQuery: string;
}) {
  const router = useRouter();
  // Seeded once; the parent remounts this via `key` when the URL query
  // changes (filter click / submit / back-forward), so no prop->state sync
  // effect is needed — same convention as PoSearch.
  const [q, setQ] = React.useState(initialQuery);

  const submit = (value: string) => {
    const sp = new URLSearchParams();
    if (scope === 'all') sp.set('scope', 'all');
    if (status) sp.set('status', status);
    const trimmed = value.trim();
    if (trimmed) sp.set('q', trimmed);
    router.push(`/dashboard/maintenance?${sp.toString()}`);
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit(q);
      }}
      className="relative min-w-[200px] max-w-xs flex-1 sm:flex-none"
    >
      <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search request #, subject, description, requester…"
        aria-label="Search maintenance requests"
        className="h-9 pl-8 text-[13px]"
      />
    </form>
  );
}
