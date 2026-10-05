import Link from 'next/link';
import { notFound, unstable_rethrow } from 'next/navigation';

import { ReceivingCheckForm } from '@/components/po/receiving-check-form';
import { ReceivingChecklistLoadFailed } from '@/components/po/receiving-checklist-load-failed';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import {
  ReceivingChecklistService,
  type ReceivingRunView,
} from '@/server/services/receiving-checklist';

import { RECEIVING_CHECKLIST_COPY, uuidSchema } from '@stockpilot/core';

export const metadata = { title: 'Receiving checklist' };

/**
 * One receiving checklist run (F4-1). A static segment beside [id] on
 * purpose, never nested under a PO id: the phone's PO rewrite rule is
 * unanchored. The section layout already requires purchase_orders:read; the
 * run itself is visible exactly when its PO is (a run the caller cannot see
 * is not found). A completed run, or one this person may not record, is read
 * only. A failed read shows "The checklist didn't load" with Try again, never
 * the error boundary.
 */
export default async function ReceivingCheckPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  if (!uuidSchema.safeParse(runId).success) notFound();
  const svc = await ReceivingChecklistService.forCurrentUser();
  let view: ReceivingRunView | null = null;
  try {
    view = await svc.getRun(runId);
  } catch (e) {
    unstable_rethrow(e);
    // Not found, or not this person's to see: the same answer, so a run id
    // never tells anyone more than the PO page would.
    if (e instanceof ServiceError && (e.code === 'not_found' || e.code === 'forbidden')) {
      notFound();
    }
    void reportError(e, { tag: 'dashboard.receiving_check.load', level: 'warning' });
  }
  if (!view) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <Link
            href="/dashboard/purchase-orders"
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ← Back to purchase orders
          </Link>
        </div>
        <ReceivingChecklistLoadFailed
          retryHref={`/dashboard/purchase-orders/receiving-checks/${runId}`}
        />
      </div>
    );
  }
  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href={`/dashboard/purchase-orders/${view.po.id}`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to {view.po.poNumber}
        </Link>
      </div>
      <h1 className="text-xl font-semibold tracking-tight">
        {RECEIVING_CHECKLIST_COPY.runHeading(
          view.receipt.receiptNumber,
          view.po.poNumber,
          view.po.supplierName,
        )}
      </h1>
      <p className="text-muted-foreground mb-6 mt-1 text-sm">
        {RECEIVING_CHECKLIST_COPY.versionLine(view.version.versionNumber, view.version.title)}
      </p>
      {/* Keyed on the run only (desk check F3): a newer save reaching the
          page must not remount the form over typed answers. The form adopts
          it when nothing is typed, and otherwise keeps the answers and offers
          Reload. */}
      <ReceivingCheckForm key={view.run.id} view={view} />
    </div>
  );
}
