'use client';

import { Search, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { AUDIT_CATEGORIES as CATEGORIES } from './audit-categories';

interface AuditFiltersProps {
  /** Currently selected category prefix from the URL. */
  activeCategory: string;
  /** Free-text actor search. */
  initialActor?: string;
}

export function AuditFilters({ activeCategory, initialActor = '' }: AuditFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [actor, setActor] = React.useState(initialActor);

  // Debounce the actor search → URL push.
  React.useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(searchParams.toString());
      const trimmed = actor.trim();
      if (trimmed) next.set('actor', trimmed);
      else next.delete('actor');
      const qs = next.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  function pickCategory(slug: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (slug === 'all') next.delete('category');
    else next.set('category', slug);
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }

  function clearAll() {
    const next = new URLSearchParams();
    setActor('');
    router.replace('?' + next.toString(), { scroll: false });
  }

  const hasFilters =
    activeCategory !== 'all' || (initialActor && initialActor.trim().length > 0);

  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {CATEGORIES.map((c) => {
          const isActive = c.slug === activeCategory;
          return (
            <button
              key={c.slug}
              type="button"
              onClick={() => pickCategory(c.slug)}
              className={cn(
                'inline-flex h-7 items-center rounded-full border px-3 text-[12px] transition-colors',
                isActive
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
              )}
            >
              {c.label}
            </button>
          );
        })}
        {hasFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-[11.5px]"
          >
            <X className="h-3 w-3" /> Clear filters
          </button>
        )}
      </div>

      <div className="relative max-w-md">
        <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
        <Input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Search by actor name or email…"
          className="h-8 pl-8 text-[12.5px]"
          aria-label="Search audit log by actor"
        />
      </div>
    </div>
  );
}

