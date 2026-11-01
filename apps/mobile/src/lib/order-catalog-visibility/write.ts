import {
  ORDER_CATALOG_VISIBILITY_MAX_ITEMS,
  ORDER_ITEMS_OFFLINE_COPY,
  ORDER_ITEMS_SELECTION_CAP_COPY,
  randomRequestUuid,
  type OrderCatalogVisibilityWriteAnswer,
  type OrderCatalogVisibilityWriteBody,
} from '@stockpilot/core';

import { manageFailure, type ManageCallScope, type ManageFailure, type OrderCatalogManageApi } from './api';
import { ORDER_ITEMS_PHONE_REVIEW_EMPTY_COPY } from './words';

/**
 * MANAGE ORDER ITEMS ON THE PHONE: SHOW AND HIDE (ordering visibility, 0413;
 * design 4.2, 8.6). The pattern of the phone grouping client's keyed body
 * (this file reads no grouping data, and the web guard that keeps display
 * groups off order paths scans it):
 *
 *   - a Show or Hide is the EXPLICIT ids, lower-cased, once each (bulk actions
 *     apply only to explicitly selected ids, brief 6);
 *   - one operationId per body, kept for its retries: sending the same body
 *     again (busy, a rate limit, no answer) reuses it, and the server answers
 *     a retry of a change that already landed as "unchanged" with no second
 *     audit row; any change to the ids or the state is a new operation;
 *   - ONLINE ONLY and NEVER QUEUED: a change of what appears in Orders is
 *     decided by the server at the moment it is made (brief 12), so nothing
 *     here touches the offline outbox, and an offline phone is refused before
 *     anything is built.
 */

export interface VisibilityDraft {
  itemIds: string[];
  visible: boolean;
}

/** The explicit ids, lower-cased, once each, sorted (so one change has one
 *  spelling whatever order it was picked in). */
export function visibilityDraft(ids: Iterable<string>, visible: boolean): VisibilityDraft {
  return { itemIds: [...new Set([...ids].map((id) => id.toLowerCase()))].sort(), visible };
}

/** The pending body of a change: one operationId, kept for its retries. */
export interface PendingVisibilityBody {
  json: string;
  body: OrderCatalogVisibilityWriteBody;
}

/** The body to send: the pending one when the draft is unchanged (a retry
 *  keeps its operationId), else the draft with a fresh one. */
export function keyedVisibilityBody(
  pending: PendingVisibilityBody | null,
  draft: VisibilityDraft,
  mint: () => string = randomRequestUuid,
): PendingVisibilityBody {
  const normal = visibilityDraft(draft.itemIds, draft.visible);
  const json = JSON.stringify(normal);
  if (pending && pending.json === json) return pending;
  return { json, body: { itemIds: normal.itemIds, visible: normal.visible, operationId: mint().toLowerCase() } };
}

/**
 * Why a Show or Hide cannot be sent now, or null. `locked` is the words of a
 * final refusal already received (the screen is locked, design 3.7).
 */
export function visibilityWriteBlockedBy(input: { offline: boolean; count: number; locked: string | null }): string | null {
  if (input.locked) return input.locked;
  if (input.offline) return ORDER_ITEMS_OFFLINE_COPY;
  if (input.count < 1) return ORDER_ITEMS_PHONE_REVIEW_EMPTY_COPY;
  if (input.count > ORDER_CATALOG_VISIBILITY_MAX_ITEMS) return ORDER_ITEMS_SELECTION_CAP_COPY;
  return null;
}

export type VisibilitySendResult =
  | { ok: true; answer: OrderCatalogVisibilityWriteAnswer }
  | { ok: false; failure: ManageFailure };

/** Send the pending body once, now. Never throws and never queues. */
export async function sendVisibility(
  api: OrderCatalogManageApi,
  scope: ManageCallScope,
  pending: PendingVisibilityBody,
): Promise<VisibilitySendResult> {
  try {
    return { ok: true, answer: await api.write(scope, pending.body) };
  } catch (e) {
    return { ok: false, failure: manageFailure(e, 'write') };
  }
}
