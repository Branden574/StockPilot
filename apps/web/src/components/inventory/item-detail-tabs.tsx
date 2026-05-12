'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { type DetailTabId } from './item-detail-tabs-shared';

// Re-export so existing call sites that import { DetailTabId, ItemDetailTabs }
// from this file continue to work without a sweep. parseDetailTab lives in
// the shared module and must be imported from there for server-component use.
export type { DetailTabId };

const TABS: ReadonlyArray<{ id: DetailTabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'movements', label: 'Movements' },
  { id: 'activity', label: 'Activity' },
];

/**
 * Client-side tab strip for the item detail page. Renders `Link` rows so
 * deep-linking to ?tab=activity works on the very first paint (no client
 * round-trip needed), and the URL stays canonical for sharing.
 */
export function ItemDetailTabs({ activeTab }: { activeTab: DetailTabId }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Preserve any other query params (filters, etc.) when swapping tabs.
  function hrefFor(tab: DetailTabId) {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (tab === 'overview') {
      params.delete('tab');
    } else {
      params.set('tab', tab);
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <div role="tablist" aria-label="Item detail sections" className="border-border border-b">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 sm:w-auto">
          {TABS.map((t) => {
            const isActive = t.id === activeTab;
            return (
              <Link
                key={t.id}
                href={hrefFor(t.id)}
                role="tab"
                aria-selected={isActive}
                aria-controls={`item-detail-panel-${t.id}`}
                scroll={false}
                className={cn(
                  'relative inline-flex h-10 items-center px-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors',
                    isActive ? 'bg-foreground' : 'bg-transparent',
                  )}
                />
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
