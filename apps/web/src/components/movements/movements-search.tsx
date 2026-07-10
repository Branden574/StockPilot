'use client';

import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Input } from '@/components/ui/input';

/**
 * Debounced search for the stock-movements ledger. Types filter as you go
 * (300ms debounce) via client-side router.replace — the dashboard shell stays
 * mounted, so it feels instant without re-firing the cold-load splash. Resets
 * to page 1 on every new query. Server-side search (the ledger can be huge).
 */
export function MovementsSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [q, setQ] = React.useState(initialQuery);

  const navigate = React.useCallback(
    (value: string) => {
      const sp = new URLSearchParams();
      const trimmed = value.trim();
      if (trimmed) sp.set('q', trimmed);
      const qs = sp.toString();
      router.replace(qs ? `/dashboard/movements?${qs}` : '/dashboard/movements');
    },
    [router],
  );

  React.useEffect(() => {
    // Skip the initial mount (value already reflected in the URL).
    if (q === initialQuery) return;
    const t = setTimeout(() => navigate(q), 300);
    return () => clearTimeout(t);
  }, [q, initialQuery, navigate]);

  return (
    <div className="relative min-w-[220px] max-w-xs flex-1 sm:flex-none">
      <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by item name or SKU…"
        aria-label="Search stock movements"
        className="h-9 pl-8 pr-8 text-[13px]"
      />
      {q && (
        <button
          type="button"
          onClick={() => {
            setQ('');
            navigate('');
          }}
          aria-label="Clear search"
          className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
