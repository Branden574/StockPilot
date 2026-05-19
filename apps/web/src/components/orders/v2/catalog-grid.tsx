'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { ItemCard } from './item-card';
import type { AisleSummary, CatalogItem } from './types';

interface CatalogGridProps {
  items: CatalogItem[];
  aisles: AisleSummary[];
  activeAisleId: string | 'all';
  groupByAisle: boolean;
  cols: 2 | 3 | 4;
  onClearFilters: () => void;
}

const colsClassMap: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 md:grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4',
};

export function CatalogGrid({
  items,
  aisles,
  activeAisleId,
  groupByAisle,
  cols,
  onClearFilters,
}: CatalogGridProps) {
  const gridClass = cn('grid gap-3', colsClassMap[cols] ?? colsClassMap[4]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
        <p className="text-muted-foreground text-sm">
          No items match your filters.
        </p>
        <Button variant="outline" size="sm" onClick={onClearFilters}>
          Clear filters
        </Button>
      </div>
    );
  }

  // Flat grid when on a specific aisle or groupByAisle is off
  if (activeAisleId !== 'all' || !groupByAisle) {
    return (
      <div className={gridClass}>
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </div>
    );
  }

  // Grouped by aisle when on All view
  const aisleSections = buildAisleSections(items, aisles);

  return (
    <div className="space-y-8">
      {aisleSections.map(({ aisle, items: sectionItems }) => (
        <section key={aisle.id ?? 'uncategorized'}>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
            <span>{aisle.name}</span>
            <span className="font-normal normal-case text-[11px]">
              ({sectionItems.length})
            </span>
          </h2>
          <div className={gridClass}>
            {sectionItems.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface AisleSection {
  aisle: AisleSummary;
  items: CatalogItem[];
}

function buildAisleSections(
  items: CatalogItem[],
  aisles: AisleSummary[],
): AisleSection[] {
  // Build a map from aisleId → items
  const byAisle = new Map<string | null, CatalogItem[]>();
  for (const item of items) {
    const key = item.categoryId ?? null;
    const bucket = byAisle.get(key) ?? [];
    bucket.push(item);
    byAisle.set(key, bucket);
  }

  const sections: AisleSection[] = [];

  // Named aisles first (in the order they appear in aisles[])
  for (const aisle of aisles) {
    if (aisle.id === null) continue; // handle uncategorized below
    const sectionItems = byAisle.get(aisle.id);
    if (sectionItems && sectionItems.length > 0) {
      sections.push({ aisle, items: sectionItems });
    }
  }

  // Uncategorized at the end
  const uncategorized = byAisle.get(null);
  if (uncategorized && uncategorized.length > 0) {
    const uncatAisle = aisles.find((a) => a.id === null) ?? {
      id: null,
      name: 'Uncategorized',
      itemCount: uncategorized.length,
    };
    sections.push({ aisle: uncatAisle, items: uncategorized });
  }

  return sections;
}
