'use client';

import { ChevronDown, Download, List, Printer } from 'lucide-react';

import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isOrderStatusTab, ORDER_EXPORT_TAB_LABELS } from '@/lib/orders/export';

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
 *
 * Liquid Glass draws each item as Orders.dc.html's Export menu does: an icon,
 * the format with the tab it exports ("CSV · Needs approval") and a quieter
 * line under it. Those parts are glass-only words and icons (no new action;
 * each item keeps its link and its accessible name), hidden in Classic by
 * styles/liquid-glass/visibility.css and not rendered under the `off`
 * rollout, so the classic menu is today's.
 */
export function OrdersExportMenu({ tab }: { tab: string }) {
  const glass = liquidGlassRollout() !== 'off';
  const tabLabel = isOrderStatusTab(tab) ? ORDER_EXPORT_TAB_LABELS[tab] : null;
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
      <DropdownMenuContent align="end" data-glass-role="orders-export-menu">
        <DropdownMenuItem asChild>
          <a
            href={`/api/orders/export.csv?status=${tab}`}
            download
            aria-label="Export orders to CSV"
          >
            {glass ? <List aria-hidden data-glass-only="" /> : null}
            CSV
            {glass && tabLabel ? <span data-glass-only=""> · {tabLabel}</span> : null}
            {glass ? (
              <span data-glass-only="" data-glass="export-item-sub">
                Matches the tab you are on
              </span>
            ) : null}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={`/api/orders/export.pdf?status=${tab}`}
            download
            aria-label="Export orders to PDF"
          >
            {glass ? <Printer aria-hidden data-glass-only="" /> : null}
            PDF (print)
            {glass && tabLabel ? <span data-glass-only=""> · {tabLabel}</span> : null}
            {glass ? (
              <span data-glass-only="" data-glass="export-item-sub">
                Printable order history
              </span>
            ) : null}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
