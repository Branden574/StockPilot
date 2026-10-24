import { unstable_rethrow } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ReceivingChecklistEditor } from '@/components/po/receiving-checklist-editor';
import { ReceivingChecklistLoadFailed } from '@/components/po/receiving-checklist-load-failed';
import { reportError } from '@/lib/error-reporter';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import {
  ReceivingChecklistService,
  type ChecklistEditorView,
} from '@/server/services/receiving-checklist';

import { RECEIVING_CHECKLIST_COPY } from '@stockpilot/core';

export const metadata = { title: 'Receiving checklist' };

const PAGE = '/dashboard/purchase-orders/receiving-checklist';

/** The page area (DESIGN-SPEC 4 and 5.3), the box every redesigned page draws. */
const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The checklist at the new PO form's reading width. */
const FORM_WIDTH = 'w-full max-w-[960px]';

/**
 * The receiving checklist (F4-1). Anyone who can read purchase orders (the
 * section layout's gate) sees the live version and the earlier ones;
 * publishing a new version and turning it off need a manager with
 * purchase_orders:manage (core receivingGate().canPublishChecklist, checked
 * again by the service and the database). A failed read shows "The checklist
 * didn't load" with Try again, never the error boundary and never "no
 * checklist yet".
 */
export default async function ReceivingChecklistPage() {
  const moduleAccess = await checkModuleAccess('receiving');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="receiving" canManage={moduleAccess.canManage} />;
  }
  const svc = await ReceivingChecklistService.forCurrentUser();
  let editor: ChecklistEditorView | null = null;
  try {
    editor = await svc.getEditor();
  } catch (e) {
    unstable_rethrow(e);
    void reportError(e, { tag: 'dashboard.receiving_checklist.load', level: 'warning' });
  }
  return (
    <div className={PAGE_BOX}>
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/purchase-orders">
            ← Back to purchase orders
          </PageHeaderBackLink>
        }
        title={RECEIVING_CHECKLIST_COPY.editorTitle}
        subline={RECEIVING_CHECKLIST_COPY.procedureCardBody}
        className={FORM_WIDTH}
      />
      <div className={FORM_WIDTH}>
        {editor ? (
          <ReceivingChecklistEditor editor={editor} />
        ) : (
          <ReceivingChecklistLoadFailed retryHref={PAGE} />
        )}
      </div>
    </div>
  );
}
