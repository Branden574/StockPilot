import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to purchase orders
        </Link>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">
        {RECEIVING_CHECKLIST_COPY.editorTitle}
      </h1>
      <p className="text-muted-foreground mb-6 mt-1 text-sm">
        {RECEIVING_CHECKLIST_COPY.procedureCardBody}
      </p>
      {editor ? (
        <ReceivingChecklistEditor editor={editor} />
      ) : (
        <ReceivingChecklistLoadFailed retryHref={PAGE} />
      )}
    </div>
  );
}
