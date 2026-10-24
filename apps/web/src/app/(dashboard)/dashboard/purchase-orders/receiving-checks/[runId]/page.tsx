import { notFound, unstable_rethrow } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
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

/** The page area (DESIGN-SPEC 4 and 5.3), the box every redesigned page draws. */
const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The run at the new PO form's reading width. */
const FORM_WIDTH = 'w-full max-w-[960px]';

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
      <div className={PAGE_BOX}>
        {/* Nothing about the run is known, so the h1 is the page's name (its
            metadata title) and the panel under it says what failed. */}
        <PageHeader
          back={
            <PageHeaderBackLink href="/dashboard/purchase-orders">
              ← Back to purchase orders
            </PageHeaderBackLink>
          }
          title={RECEIVING_CHECKLIST_COPY.editorTitle}
          className={FORM_WIDTH}
        />
        <div className={FORM_WIDTH}>
          <ReceivingChecklistLoadFailed
            retryHref={`/dashboard/purchase-orders/receiving-checks/${runId}`}
          />
        </div>
      </div>
    );
  }
  return (
    <div className={PAGE_BOX}>
      {/* The record's header (DESIGN-SPEC 6.1): which receipt of which PO is
          the h1, the version it records against under it. */}
      <PageHeader
        back={
          <PageHeaderBackLink href={`/dashboard/purchase-orders/${view.po.id}`}>
            ← Back to {view.po.poNumber}
          </PageHeaderBackLink>
        }
        title={RECEIVING_CHECKLIST_COPY.runHeading(
          view.receipt.receiptNumber,
          view.po.poNumber,
          view.po.supplierName,
        )}
        subline={RECEIVING_CHECKLIST_COPY.versionLine(
          view.version.versionNumber,
          view.version.title,
        )}
        className={FORM_WIDTH}
      />
      <div className={FORM_WIDTH}>
        {/* Keyed on the run only (desk check F3): a newer save reaching the
            page must not remount the form over typed answers. The form adopts
            it when nothing is typed, and otherwise keeps the answers and
            offers Reload. */}
        <ReceivingCheckForm key={view.run.id} view={view} />
      </div>
    </div>
  );
}
