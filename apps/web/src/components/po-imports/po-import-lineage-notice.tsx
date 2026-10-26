import { History, Undo2 } from 'lucide-react';
import Link from 'next/link';

import type { PoImportLineage } from '@/server/services/po-imports';

import { formatOrgDate, formatOrgDateTime } from '@stockpilot/core';

/**
 * Re-import lineage notice (migs 0286/0287). Reads in BOTH directions because
 * a single import can be both ends of a chain: superseded by a later import of
 * the same file, and itself a redo of a cancelled purchase order.
 *
 * The "superseded" branch keys off a RESOLVED successor, never off the raw
 * superseded_at stamp — a stamped row whose successor was deleted would
 * otherwise render a notice with a dead link. The page supplies the plain-text
 * fallback for that case.
 *
 * Predecessor links go to the PO by id, never by number: cancelling a purchase
 * order releases its po_number (PurchaseOrdersService.updateStatus), so the
 * number may already belong to a different, live PO. It is shown only as a
 * recognition aid, always alongside the word "cancelled".
 *
 * The later import is dated as a calendar day in the ORGANIZATION's zone
 * (`timeZone`, which the page resolves from the org row), with the time on
 * hover: the same words as the imports list's Uploaded column. It used to say
 * "imported again 2 weeks ago", which names no day and drifts while the page
 * sits open (owner request 2026-09-24: people track imports against a
 * calendar). Formatted on the server in a fixed zone, so the server's own
 * zone (UTC on Vercel) and the viewer's never move the day.
 */
export function PoImportLineageNotice({
  lineage,
  timeZone,
  className,
}: {
  lineage: PoImportLineage;
  /** The organization's IANA zone, already resolved (resolveOrgTimezone). */
  timeZone: string;
  className?: string;
}) {
  // The successor resolved by PoImportsService.resolveLineage is exactly ONE
  // hop forward (`.eq('reimported_from_id', header.id)`). On a chain of three
  // or more imports of the same file the row linked here is itself superseded,
  // so the copy must not call it "the live one" — it can only claim the file
  // was imported again. Following the link lands on that import's own notice,
  // which walks the chain one hop at a time until it reaches the live import.
  // Index access is T | undefined under noUncheckedIndexedAccess.
  const replacement = lineage.successors[lineage.successors.length - 1];
  const pred = lineage.predecessor;
  if (!replacement && !pred) return null;

  return (
    <div className={className ? `space-y-3 ${className}` : 'space-y-3'}>
      {replacement && (
        // On the caution wash: everything below reads differently on a
        // replaced import.
        <div className="bg-warning-wash text-foreground rounded-lg px-4 py-3 text-[13px]">
          <p className="flex items-center gap-2 font-medium">
            <History className="text-warning h-4 w-4 shrink-0" aria-hidden="true" />
            Replaced by a later import of this file
          </p>
          <p className="text-muted-foreground mt-0.5 text-[12.5px]">
            This file was imported again on{' '}
            <time
              dateTime={replacement.createdAt}
              title={formatOrgDateTime(
                replacement.createdAt,
                { dateStyle: 'medium', timeStyle: 'short' },
                timeZone,
              )}
            >
              {formatOrgDate(replacement.createdAt, { dateStyle: 'medium' }, timeZone)}
            </time>
            . Open the newer import to see where it stands — if it was replaced in turn, it says so
            too. This import and the purchase order it created are kept unchanged for the record.
          </p>
          <Link
            href={`/dashboard/purchase-orders/imports/${replacement.id}`}
            className="mt-2 inline-block text-[13px] font-medium underline underline-offset-2 hover:no-underline"
          >
            Open the newer import
          </Link>
        </div>
      )}

      {pred && (
        <div className="border-border bg-sunk text-foreground rounded-lg border px-4 py-3 text-[13px]">
          <p className="flex items-center gap-2 font-medium">
            <Undo2 className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
            Re-import of an earlier purchase order
          </p>
          <p className="text-muted-foreground mt-0.5 text-[12.5px]">
            {pred.poStatus === 'cancelled' && pred.poNumber
              ? `Re-import of ${pred.poNumber}, which was cancelled. The earlier import of ${pred.displayName ?? pred.fileName} is kept for the record.`
              : `This file was imported once before. The earlier import of ${pred.displayName ?? pred.fileName} is kept for the record.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link
              href={`/dashboard/purchase-orders/imports/${pred.id}`}
              className="text-accent hover:text-foreground text-[13px] font-medium"
            >
              View the earlier import
            </Link>
            {pred.poId && (
              <Link
                href={`/dashboard/purchase-orders/${pred.poId}`}
                className="text-accent hover:text-foreground text-[13px] font-medium"
              >
                {pred.poNumber ? `View ${pred.poNumber}` : 'View the earlier purchase order'}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
