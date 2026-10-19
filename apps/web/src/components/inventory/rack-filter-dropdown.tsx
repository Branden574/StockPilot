'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Per-page rack filter. The page passes the distinct rack list it
 * computed server-side via InventoryService.listDistinctRacks. The
 * dropdown reads / writes the `?rack=` URL param and preserves all
 * other params (search, status, category, ...).
 */
export function RackFilterDropdown({ racks }: { racks: string[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('rack') ?? '';

  function buildHref(rack: string | null): string {
    const sp = new URLSearchParams(params.toString());
    if (rack) sp.set('rack', rack);
    else sp.delete('rack');
    sp.delete('page');
    const q = sp.toString();
    return q ? `${pathname}?${q}` : (pathname ?? '/');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* A header action: the 32 px secondary button, "Rack: Any" with a
            chevron like the filter triggers below it. */}
        <Button variant="outline" className="font-normal">
          Rack: {current || 'Any'}
          <ChevronDown aria-hidden className="text-muted-foreground !size-3" strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        <DropdownMenuItem asChild>
          <Link href={buildHref(null)} className={cn(!current && 'font-semibold')}>
            Any rack
          </Link>
        </DropdownMenuItem>
        {racks.length === 0 ? (
          <DropdownMenuItem disabled>No racks set yet</DropdownMenuItem>
        ) : (
          racks.map((r) => (
            <DropdownMenuItem key={r} asChild>
              <Link
                href={buildHref(r)}
                className={cn(current === r && 'font-semibold')}
              >
                {r}
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
