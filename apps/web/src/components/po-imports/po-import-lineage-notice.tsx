import { History, Undo2 } from 'lucide-react';
import Link from 'next/link';

import { formatRelative } from '@/lib/utils';
import type { PoImportLineage } from '@/server/services/po-imports';

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
 */
export function PoImportLineageNotice({
  lineage,
  className,
}: {
  lineage: PoImportLineage;
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
        <div className="border-warning/40 bg-warning/5 text-foreground rounded-lg border px-4 py-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <History className="h-4 w-4 shrink-0" aria-hidden="true" />
            Replaced by a later import of this file
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            This file was imported again {formatRelative(replacement.createdAt)}. Open the newer
            import to see where it stands — if it was replaced in turn, it says so too. This import
            and the purchase order it created are kept unchanged for the record.
          </p>
          <Link
            href={`/dashboard/purchase-orders/imports/${replacement.id}`}
            className="mt-2 inline-block text-sm font-medium underline-offset-2 hover:underline"
          >
            Open the newer import
          </Link>
        </div>
      )}

      {pred && (
        <div className="border-border bg-muted/40 text-foreground rounded-lg border px-4 py-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <Undo2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            Re-import of an earlier purchase order
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {pred.poStatus === 'cancelled' && pred.poNumber
              ? `Re-import of ${pred.poNumber}, which was cancelled. The earlier import of ${pred.fileName} is kept for the record.`
              : `This file was imported once before. The earlier import of ${pred.fileName} is kept for the record.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-4">
            <Link
              href={`/dashboard/purchase-orders/imports/${pred.id}`}
              className="text-sm font-medium underline-offset-2 hover:underline"
            >
              View the earlier import
            </Link>
            {pred.poId && (
              <Link
                href={`/dashboard/purchase-orders/${pred.poId}`}
                className="text-sm font-medium underline-offset-2 hover:underline"
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
