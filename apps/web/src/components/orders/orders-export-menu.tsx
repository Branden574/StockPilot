'use client';

import { Download } from 'lucide-react';

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
 */
export function OrdersExportMenu({ tab }: { tab: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Download className="mr-1.5 h-4 w-4" />
          Export
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
