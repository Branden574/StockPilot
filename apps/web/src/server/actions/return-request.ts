'use server';

import { rethrowControlFlow } from '@/lib/control-flow';
import { withContext } from '@/server/services/context';
import { recordReturnRequestDrafted } from '@/server/services/return-request-draft';

/**
 * The website's call to record that a return request draft was opened (F14).
 * Called AFTER window.open came back with a window, never before, so a
 * blocked pop-up is not recorded as a draft (the maintenance rule, B29).
 *
 * Every check is the service's (services/return-request-draft.ts): the
 * returns module, the caller's organization, requester or returns permission,
 * and the return being on that order and still open. The input is only a
 * hint; nothing in it is trusted.
 *
 * It answers nothing and never rejects, except for a redirect (the session
 * ended), which the router is already following.
 */
export async function recordReturnRequestDraftedAction(input: {
  orderId: string;
  returnNumber: string;
  isCondensed: boolean;
  surface: 'order' | 'return';
}): Promise<void> {
  try {
    const ctx = await withContext();
    await recordReturnRequestDrafted(ctx, input);
  } catch (e) {
    rethrowControlFlow(e);
  }
}
