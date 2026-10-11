import {
  GROUPING_ERROR_TABLE,
  GROUPING_ERROR_WORDS,
  sharedSkuKey,
  type SplitSkuBody,
} from '@stockpilot/core';

import { api, ApiError } from './api';
import { CONNECTION_FAILURE_COPY } from './connection-copy';

/**
 * The phone's "Make this its own item" (Ungroup, migration 0399): give ONE
 * record that shares its SKU a fresh SKU of its own, changing that record
 * only. It goes through POST /api/v1/items/ungroup, the web's own service
 * (ItemGroupingService) and database function (split_item_sku).
 *
 * ONLINE ONLY. It is never queued: the answer (the new SKU, or why not) is
 * the whole point, and a split decided later against a list that moved since
 * could surprise the person. The screen refuses offline with core's words.
 *
 * THE KEY. One per attempt, kept with its body for a retry of a busy or lost
 * answer: the database replays the first outcome instead of splitting twice.
 */

/** A minimal Supabase client shape, so this module stays testable. */
interface CountClient {
  from: (table: string) => {
    select: (
      cols: string,
      opts: { count: 'exact'; head: true },
    ) => {
      eq: (c: string, v: unknown) => unknown;
    };
  };
}

/**
 * How many OTHER live records with this raw SKU the member can read (their own
 * RLS: hidden records are never counted). 0 for a blank SKU (it never groups);
 * null when the read failed (the screen then says nothing).
 */
export async function readSkuSiblingCount(
  client: CountClient,
  organizationId: string,
  itemId: string,
  sku: string | null | undefined,
): Promise<number | null> {
  const key = sharedSkuKey(sku);
  if (!key) return 0;
  type Q = {
    eq: (c: string, v: unknown) => Q;
    is: (c: string, v: unknown) => Q;
    neq: (c: string, v: unknown) => Q;
  } & PromiseLike<{ count: number | null; error: unknown }>;
  const q = client
    .from('inventory_items')
    .select('id', { count: 'exact', head: true }) as unknown as Q;
  const { count, error } = await q
    .eq('organization_id', organizationId)
    .eq('sku', key)
    .is('deleted_at', null)
    .neq('id', itemId);
  if (error) return null;
  return count ?? 0;
}

/** Core's request body for one record: its SKU as the screen showed it. */
export function singleUngroupBody(args: {
  itemId: string;
  sku: string;
  organizationId: string;
  actorUserId: string;
  key: string;
}): SplitSkuBody {
  return {
    idempotencyKey: args.key,
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    itemIds: [args.itemId],
    expectedSkus: { [args.itemId]: args.sku },
    anchorItemIds: [],
  };
}

export interface UngroupAnswer {
  /** True when the key had already applied (a retry of a lost answer). */
  replay: boolean;
  /** The record's SKU now. */
  newSku: string;
}

/**
 * Send it, under the record's organization and ONLY the signed-in account
 * (api's asUserId: a request left by another account on a shared phone never
 * leaves). Throws ApiError for a refusal (describeUngroupError words it).
 */
export async function postUngroup(body: SplitSkuBody): Promise<UngroupAnswer> {
  const raw = (await api('/api/v1/items/ungroup', {
    method: 'POST',
    body,
    orgId: body.organizationId,
    asUserId: body.actorUserId,
  })) as unknown;
  const answer = raw as {
    organizationId?: unknown;
    result?: { replay?: unknown; items?: { id?: unknown; afterSku?: unknown }[] };
  } | null;
  if (
    !answer ||
    typeof answer.organizationId !== 'string' ||
    !Array.isArray(answer.result?.items)
  ) {
    throw new Error('The answer could not be read.');
  }
  if (answer.organizationId.toLowerCase() !== body.organizationId.toLowerCase()) {
    throw new Error('The answer came from another organization.');
  }
  const mine = answer.result!.items!.find((i) => i.id === body.itemIds[0]);
  if (!mine || typeof mine.afterSku !== 'string') throw new Error('The answer could not be read.');
  return { replay: answer.result!.replay === true, newSku: mine.afterSku };
}

/** Refusals the same body and key may be sent again for. */
const RETRY_SAME_REASONS = new Set(['busy', 'sku_generation_failed']);

/**
 * The words for a failed attempt, and whether the SAME body and key may be
 * sent again (a busy answer, a rate limit, or no answer at all: if it did
 * arrive, the retry replays it). Never a raw code or a network error's text.
 */
export function describeUngroupError(e: unknown): { message: string; retrySame: boolean } {
  if (e instanceof ApiError) {
    const details = e.details as { reason?: unknown } | undefined;
    const reason = typeof details?.reason === 'string' ? details.reason : null;
    if (e.status === 401)
      return { message: GROUPING_ERROR_WORDS.unauthenticated, retrySame: false };
    if (e.status === 429) return { message: GROUPING_ERROR_WORDS.rateLimited, retrySame: true };
    const sentence = e.message && !/^[a-z0-9_]+$/.test(e.message) ? e.message : null;
    const fromTable = reason ? GROUPING_ERROR_TABLE[reason]?.message : undefined;
    const retrySame = (reason !== null && RETRY_SAME_REASONS.has(reason)) || e.status === 503;
    if (e.status >= 500 && e.status !== 503)
      return { message: GROUPING_ERROR_WORDS.internal, retrySame: false };
    return { message: sentence ?? fromTable ?? GROUPING_ERROR_WORDS.internal, retrySame };
  }
  return { message: CONNECTION_FAILURE_COPY, retrySame: true };
}
