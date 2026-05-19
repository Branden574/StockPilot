'use client';

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
      className="sticky top-0 z-10 -mx-4 border-b bg-card/95 backdrop-blur px-4 py-2"
    >
      <div
        ref={containerRef}
        role="tablist"
        aria-label="Filter by aisle"
        className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5"
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
                'flex-none flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span>{pill.label}</span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                  isActive ? 'bg-background/20' : 'bg-muted text-muted-foreground',
                )}
              >
                {pill.count}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
