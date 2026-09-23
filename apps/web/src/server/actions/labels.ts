'use server';

import { unstable_rethrow } from 'next/navigation';
import { z } from 'zod';

import { cleanLabelIds, isUuid, LABELS_MAX_ITEMS } from '@/lib/inventory/labels-selection';
import { mfaGateError, ServiceError, withContext } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

import { err, ok, type ActionResult } from '@stockpilot/core';

export interface LabelItem {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
}

const schema = z.object({
  ids: z
    .array(z.string().refine(isUuid, 'Invalid item id.'))
    .min(1, 'No items selected.')
    .max(LABELS_MAX_ITEMS, `Print labels for at most ${LABELS_MAX_ITEMS} items at a time.`),
});

/**
 * The label rows for a selection the Items bulk bar handed to the labels page
 * (see lib/inventory/labels-selection.ts). The ids arrive in the POST body, so
 * a 500-item selection never rides in a URL.
 *
 * THE SAME READ AS THE PAGE: InventoryService.byIds on the caller's own
 * RLS-scoped client, filtered to their organization and to live items. An id
 * the caller may not read is simply absent from the answer, exactly as on
 * /dashboard/inventory/labels?items=.
 *
 * The page also sits behind the dashboard layout, which refuses a session
 * that has not passed the MFA its org or its enrolled factor requires. A
 * Server Action does not run through that layout, so the equivalent gate is
 * applied here (the one every other action uses). It is never looser than the
 * layout; it is stricter in one case: an admin who has not enrolled yet under
 * an admins-only policy sees the layout's banner on pages but cannot load
 * label data through this action until they enroll.
 */
export async function loadLabelItemsAction(input: {
  ids: string[];
}): Promise<ActionResult<LabelItem[]>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const ids = cleanLabelIds(parsed.data.ids);
  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) throw mfaGateError(ctx);
    const rows = await new InventoryService(ctx).byIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: LabelItem[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (r) items.push({ id: r.id, name: r.name, sku: r.sku, barcode: r.barcode });
    }
    return ok(items);
  } catch (e) {
    // A signed-out session redirects to sign-in; that is not a failure.
    unstable_rethrow(e);
    if (e instanceof ServiceError) {
      // internal_error's message is already the generic one (S13); its cause
      // stays in the server log, as the page's error boundary would log it.
      if (e.code === 'internal_error') {
        console.error('[labels] item read failed', e.internalDetail ?? e.message);
      }
      return err(e.code, e.message, e.code === 'internal_error' ? undefined : e.details);
    }
    console.error(e);
    return err('internal_error', 'Something went wrong. Please try again.');
  }
}
