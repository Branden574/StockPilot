'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Input } from '@/components/ui/input';

/**
 * Search box for the purchase-orders list. Uses client-side navigation
 * (router.push) rather than a native GET form so searching is an in-app SPA
 * navigation — the dashboard shell stays mounted rather than cold-loading.
 * Preserves the active status tab in the query string.
 *
 * Drawn as the list's toolbar search (DESIGN-SPEC 6.3): 240 px beside the
 * status tabs, the whole row on a phone.
 */
export function PoSearch({ status, initialQuery }: { status: string; initialQuery: string }) {
  const router = useRouter();
  // Seeded once; the parent remounts this via `key` when the URL query changes
  // (tab click / submit / back-forward), so no prop→state sync effect is needed.
  const [q, setQ] = React.useState(initialQuery);

  const submit = (value: string) => {
    const sp = new URLSearchParams();
    sp.set('status', status);
    const trimmed = value.trim();
    if (trimmed) sp.set('q', trimmed);
    router.push(`/dashboard/purchase-orders?${sp.toString()}`);
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit(q);
      }}
      className="relative w-full sm:w-60"
    >
      <Search
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
      />
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search PO #, supplier…"
        aria-label="Search purchase orders"
        className="pl-8"
      />
    </form>
  );
}
