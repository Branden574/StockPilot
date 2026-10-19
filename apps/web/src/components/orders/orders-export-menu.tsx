'use client';

import { ChevronDown, Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Export the org-wide order history from the orders list page — CSV or PDF.
 *
 * Both items are plain download anchors to the sibling export routes
 * (GET /api/orders/export.csv | export.pdf), each carrying the active
 * status tab so the file matches what's on screen. The routes re-check the
 * orders:approve permission server-side; the page additionally gates
 * rendering this menu on the same permission.
 *
 * The trigger is the header's secondary button with a trailing chevron, the
 * look of a button that opens a menu (DESIGN-SPEC 6.21 "Export"). Its icons are
 * decorative, so its name stays "Export".
 */
export function OrdersExportMenu({ tab }: { tab: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The chevron is the last svg: 12 px, quieter than the 16 px icons
            Button gives every svg inside it. */}
        <Button variant="outline" className="[&_svg:last-child]:size-3">
          <Download aria-hidden />
          Export
          <ChevronDown aria-hidden strokeWidth={2} className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <a
            href={`/api/orders/export.csv?status=${tab}`}
            download
            aria-label="Export orders to CSV"
          >
            CSV
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={`/api/orders/export.pdf?status=${tab}`}
            download
            aria-label="Export orders to PDF"
          >
            PDF (print)
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
