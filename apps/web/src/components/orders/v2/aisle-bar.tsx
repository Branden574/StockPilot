'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

import type { AisleSummary } from './types';

interface AisleBarProps {
  aisles: AisleSummary[];
  totalItemCount: number;
  activeAisleId: string | 'all';
  onSelect: (id: string | 'all') => void;
}

export function AisleBar({
  aisles,
  totalItemCount,
  activeAisleId,
  onSelect,
}: AisleBarProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Whether the row is scrolled away from each end — drives the fade + arrows.
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

  // Build the pill list: All + named aisles + Uncategorized (if present)
  const namedAisles = aisles.filter((a) => a.id !== null);
  const uncatAisle = aisles.find((a) => a.id === null);

  const pills: Array<{ key: string; label: string; count: number }> = [
    { key: 'all', label: 'All', count: totalItemCount },
    ...namedAisles.map((a) => ({
      key: a.id as string,
      label: a.name,
      count: a.itemCount,
    })),
    ...(uncatAisle
      ? [{ key: 'uncategorized', label: 'Uncategorized', count: uncatAisle.itemCount }]
      : []),
  ];

  // Recompute the overflow state. The category row is horizontally scrollable
  // but its scrollbar is hidden (it rendered under the pills and looked
  // truncated), so without these fades + arrows there was no signal that more
  // categories existed past the visible edge — the bug being fixed.
  const updateOverflow = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  React.useEffect(() => {
    updateOverflow();
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateOverflow, { passive: true });
    window.addEventListener('resize', updateOverflow);
    return () => {
      el.removeEventListener('scroll', updateOverflow);
      window.removeEventListener('resize', updateOverflow);
    };
    // Re-measure when the set of categories changes (pill count drives width).
  }, [updateOverflow, pills.length]);

  function scrollByDir(dir: 1 | -1) {
    const el = containerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' });
  }

  // Map 'uncategorized' pill key back to null aisle id
  function resolveActiveKey(key: string): string | 'all' {
    if (key === 'all') return 'all';
    if (key === 'uncategorized') return 'uncategorized';
    return key;
  }

  function currentKey(): string {
    if (activeAisleId === 'all') return 'all';
    if (activeAisleId === 'uncategorized') return 'uncategorized';
    return activeAisleId;
  }

  // Keyboard navigation: arrow keys move focus within pill row
  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    if (!buttons) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = buttons[(idx + 1) % buttons.length];
      next?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = buttons[(idx - 1 + buttons.length) % buttons.length];
      prev?.focus();
    }
  }

  const active = currentKey();

  return (
    <nav
      aria-label="Aisles"
      className="bg-card sticky top-0 z-10 -mx-4 border-b px-4 py-2"
    >
      <div className="relative">
        {/* Left fade + scroll-left arrow — only when scrolled off the left edge. */}
        {canScrollLeft && (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-card to-transparent" />
            <button
              type="button"
              aria-label="Scroll categories left"
              onClick={() => scrollByDir(-1)}
              className="border-line-strong bg-card text-ink-2 hover:bg-muted hover:text-foreground focus-visible:ring-ring absolute left-0 top-1/2 z-20 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </>
        )}

        <div
          ref={containerRef}
          role="tablist"
          aria-label="Filter by aisle"
          className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {pills.map((pill, idx) => {
            const isActive = pill.key === active;
            return (
              <button
                key={pill.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-current={isActive ? 'page' : undefined}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onSelect(resolveActiveKey(pill.key))}
                onKeyDown={(e) => handleKeyDown(e, idx)}
                className={cn(
                  'focus-visible:ring-ring flex h-[30px] flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 max-sm:h-11',
                  isActive
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-line-strong text-ink-2 hover:bg-muted hover:text-foreground',
                )}
              >
                <span>{pill.label}</span>
                <span
                  className={cn(
                    'font-mono text-[11px] leading-none',
                    isActive ? 'opacity-75' : 'text-muted-foreground',
                  )}
                >
                  {pill.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right fade + scroll-right arrow — only when more categories are off-screen. */}
        {canScrollRight && (
          <>
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-card to-transparent" />
            <button
              type="button"
              aria-label="Scroll categories right"
              onClick={() => scrollByDir(1)}
              className="border-line-strong bg-card text-ink-2 hover:bg-muted hover:text-foreground focus-visible:ring-ring absolute right-0 top-1/2 z-20 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
