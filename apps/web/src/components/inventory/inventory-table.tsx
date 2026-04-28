'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

interface Item {
  id: string;
  sku: string;
  name: string;
  status: 'active' | 'archived' | 'discontinued';
  quantity_on_hand: number;
  reorder_point: number;
  unit_cost: number;
  retail_price: number;
  category_id: string | null;
  primary_location_id: string | null;
  updated_at: string;
}

interface Lookups {
  categories: Map<string, { name: string; color: string | null }>;
  locations: Map<string, { name: string }>;
}

interface InventoryTableProps {
  items: Item[];
  lookups: Lookups;
  total: number;
  initialQuery?: string;
}

export function InventoryTable({ items, lookups, total, initialQuery = '' }: InventoryTableProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = React.useState(initialQuery);

  // Debounced URL sync.
  React.useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set('q', q.trim());
      else next.delete('q');
      router.replace(`/dashboard/inventory?${next.toString()}`);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, SKU, barcode…"
            className="h-10 pl-9"
            aria-label="Search items"
          />
        </div>
        <p className="text-sm text-muted-foreground">{formatNumber(total)} items</p>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-sm text-muted-foreground">
                  No items match your filters.
                </TableCell>
              </TableRow>
            )}
            {items.map((item) => {
              const category = item.category_id ? lookups.categories.get(item.category_id) : null;
              const location = item.primary_location_id ? lookups.locations.get(item.primary_location_id) : null;
              const value = item.quantity_on_hand * item.unit_cost;
              return (
                <TableRow key={item.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/dashboard/inventory/${item.id}`} className="font-medium hover:underline">
                      {item.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{item.sku}</TableCell>
                  <TableCell>
                    {category ? (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs"
                        style={category.color ? { backgroundColor: `${category.color}22`, color: category.color } : undefined}
                      >
                        {category.color && (
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: category.color }}
                          />
                        )}
                        {category.name}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{location?.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(item.quantity_on_hand)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(value)}</TableCell>
                  <TableCell>
                    <StockStatusBadge
                      quantity={item.quantity_on_hand}
                      reorderPoint={item.reorder_point}
                      itemStatus={item.status}
                    />
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {formatRelative(item.updated_at)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end">
        <Button asChild variant="gradient">
          <Link href="/dashboard/inventory/new">+ New item</Link>
        </Button>
      </div>
    </div>
  );
}
