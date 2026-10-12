import 'server-only';

import { revalidateTag } from 'next/cache';

import {
  formatPlacementLabel,
  GROUPING_ERROR_WORDS,
  GROUPING_MAX_ITEMS,
  mapGroupingError,
  parseSplitSkuBody,
  parseSplitSkuOutcome,
  resolvePlacement,
  sharedSkuKey,
  toSplitSkuRpcRequest,
  type GroupingDbError,
  type GroupingSurface,
  type SplitCandidate,
  type SplitSkuOutcomeItem,
} from '@stockpilot/core';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import { fetchRackHoldingsByItem } from './rack-holdings';

/**
 * Grouping writes, shared by the web action (server/actions/item-grouping.ts)
 * and the phone's bearer route (POST /api/v1/items/ungroup). Slice G1 is
 * Ungroup: split_item_sku (migration 0399) gives each selected record that
 * shares its SKU a fresh SKU of its own, changing that record only.
 *
 * It never calls InventoryService.update(): that method's Model B fan-out
 * re-keys every record of a SKU together, which is exactly why a group could
 * not be split. The database function decides everything (visible siblings,
 * the anchor, the fresh SKU, the audit row) in one transaction; this service
 * checks what it can know first (the permission, the organization and the
 * account the screen was opened for, the body's shape), retries a busy answer
 * with the same key, refreshes the cached views, and words every refusal from
 * core's map (by hint, never by message text).
 */

/** How many times a busy answer (a held row, the grouping lock) is retried
 *  with the same key before the caller is told to try again (design 3.4). */
export const UNGROUP_BUSY_RETRIES = 2;

/** The order catalog's tag (loaders/orders-new-catalog.ts): it shows SKUs. */
const ORDER_CATALOG_TAG = 'orders-new-v2-catalog';

/** At most this many candidate rows are read for a preview (100 SKUs at
 *  production's largest share of 4 is 400). */
const PREVIEW_ROW_CAP = 1000;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A readable live record of a selected SKU, as the review dialog shows it. */
export interface UngroupCandidate extends SplitCandidate {
  itemType: string;
  barcode: string | null;
  binLocation: string | null;
  /** Where the record's stock is, as the lists say it (core resolvePlacement:
   *  split or crate-only holdings, then the book rack keys or the neutral
   *  rack pair, then bin_location), one line; null when nothing is known. */
  placementLabel: string | null;
  charterName: string | null;
  warehouseName: string | null;
  quantityOnHand: number;
  status: string;
}

export interface UngroupResult {
  organizationId: string;
  replay: boolean;
  items: SplitSkuOutcomeItem[];
}

interface Options {
  /** Injected by tests; real calls wait 150 to 400 ms between busy retries. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function refusal(error: GroupingDbError): ServiceError {
  const m = mapGroupingError(error);
  if (m.code === 'internal_error') {
    return new ServiceError(
      'internal_error',
      `split_item_sku: ${error.code ?? ''} ${error.message ?? ''}`.trim(),
    );
  }
  return new ServiceError(m.code, m.message, {
    reason: m.reason,
    ...(m.retryable ? { retryable: true } : {}),
    ...(m.itemIds.length > 0 ? { itemIds: m.itemIds } : {}),
    ...(m.field ? { field: m.field } : {}),
  });
}

/**
 * The gate, FIRST in every entry point (before any read or RPC): the MFA
 * floor and items:update, through assertPermission. The database does not
 * read the aal claim, so this order is the MFA floor for the web action and
 * the phone's route (pinned by the service tests). An MFA refusal passes
 * through unchanged: its reason ('aal2_required' / 'mfa_required') is what
 * the web's useStepUp() and the phone's challenge screen act on. A missing
 * permission (a grant revoked after the screen loaded) is said in core's
 * words instead of "Missing permission: items:update".
 */
function gate(ctx: ServiceContext): void {
  try {
    assertPermission(ctx, 'items:update');
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'forbidden') {
      const reason = e.details?.reason;
      if (reason === 'aal2_required' || reason === 'mfa_required') throw e;
      throw new ServiceError('forbidden', GROUPING_ERROR_WORDS.permission, {
        reason: 'permission',
      });
    }
    throw e;
  }
}

export class ItemGroupingService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ctx: ServiceContext,
    options: Options = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  static async forCurrentUser() {
    return new ItemGroupingService(await withContext());
  }

  /**
   * What the Ungroup dialog shows: every live record of the selected records'
   * SKUs that the caller can read (the caller's own RLS: the same set the
   * database's visible-sibling rule reads), oldest first, the order its
   * "oldest keeps" rule uses. Reads only; Cancel writes nothing.
   */
  async previewSplit(itemIds: readonly string[]): Promise<{ candidates: UngroupCandidate[] }> {
    gate(this.ctx);
    if (itemIds.length > GROUPING_MAX_ITEMS) {
      throw new ServiceError('validation_error', GROUPING_ERROR_WORDS.tooMany, {
        reason: 'invalid',
        field: 'item_ids',
      });
    }
    if (!itemIds.every((id) => UUID.test(id))) {
      throw new ServiceError('validation_error', GROUPING_ERROR_WORDS.invalid, {
        reason: 'invalid',
        field: 'item_ids',
      });
    }
    const ids = [...new Set(itemIds.map((id) => id.toLowerCase()))];
    if (ids.length === 0) return { candidates: [] };

    const { data: selected, error: selErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, sku')
      .eq('organization_id', this.ctx.organizationId)
      // in-list-bound: at most GROUPING_MAX_ITEMS (100) ids, refused above
      .in('id', ids)
      .is('deleted_at', null);
    if (selErr) throw new ServiceError('internal_error', selErr.message);
    const skus = [
      ...new Set(
        ((selected ?? []) as Array<{ sku: string | null }>)
          .map((r) => sharedSkuKey(r.sku))
          .filter((k): k is string => k !== null),
      ),
    ];
    if (skus.length === 0) return { candidates: [] };

    const { data: rows, error } = await this.ctx.supabase
      .from('inventory_items')
      .select(
        `id, sku, name, item_type, is_bundle, group_id, barcode, bin_location, custom_fields, quantity_on_hand, status, created_at,
         charter:charters!charter_id (name),
         warehouse:warehouses!warehouse_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      // in-list-bound: one SKU per selected record at most, so 100 or fewer
      .in('sku', skus)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PREVIEW_ROW_CAP);
    if (error) throw new ServiceError('internal_error', error.message);

    const list = (rows ?? []) as Array<Record<string, unknown>>;
    // The rack and crate holdings, under the caller's RLS (batched, paged): the
    // review line names where each record IS, by the same rule the lists use,
    // so a book whose bin_location is blank still shows its rack (fix round 1,
    // P2). A failed batch degrades to the stored keys, never to an error.
    const holdings = await fetchRackHoldingsByItem(
      this.ctx,
      list.map((r) => r.id as string),
    );
    const one = (v: unknown): { name?: string | null } | null =>
      (Array.isArray(v) ? v[0] : v) as { name?: string | null } | null;
    const candidates = list.map((r): UngroupCandidate => {
      const itemType = (r.item_type as string | null) ?? 'product';
      const binLocation = (r.bin_location as string | null) ?? null;
      const placementLabel = formatPlacementLabel(
        resolvePlacement({
          itemType,
          customFields: (r.custom_fields as Record<string, unknown> | null) ?? null,
          binLocation,
          holdings: holdings.get(r.id as string) ?? [],
        }),
      );
      return {
        id: r.id as string,
        sku: r.sku as string,
        name: (r.name as string | null) ?? '',
        itemType,
        isBundle: r.is_bundle === true,
        inFamily: r.group_id != null,
        barcode: (r.barcode as string | null) ?? null,
        binLocation,
        placementLabel,
        charterName: one(r.charter)?.name ?? null,
        warehouseName: one(r.warehouse)?.name ?? null,
        quantityOnHand: Number(r.quantity_on_hand ?? 0),
        status: (r.status as string | null) ?? 'active',
      };
    });
    return { candidates };
  }

  /**
   * How many OTHER live records with this record's raw SKU the caller can
   * read (their own RLS: hidden records are never counted, design 5). For the
   * item page's shared-SKU note and the edit form's banner. 0 for a blank SKU
   * (it never groups); null when the read failed (say nothing, never guess).
   */
  async countSkuSiblings(itemId: string, sku: string | null | undefined): Promise<number | null> {
    const key = sharedSkuKey(sku);
    if (!key) return 0;
    const { count, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('sku', key)
      .is('deleted_at', null)
      .neq('id', itemId);
    if (error) return null;
    return count ?? 0;
  }

  /**
   * Ungroup: split_item_sku with the body the screen built (core
   * SplitSkuBody). The organization and the account must be the ones this
   * request runs as (a pending retry from another workspace or account on a
   * shared device is refused here, and again by the database). A busy answer
   * is retried at most twice with the SAME key; a replay answers the first
   * outcome. After an answer the Items/Books cache and the order catalog are
   * refreshed (the catalog shows SKUs): also on a replay, whose first answer
   * may have been lost before its refresh.
   */
  async splitSku(raw: unknown, surface: GroupingSurface): Promise<UngroupResult> {
    gate(this.ctx);
    const parsed = parseSplitSkuBody(raw);
    if (!parsed.ok) {
      throw new ServiceError('validation_error', parsed.refusal.message, {
        reason: parsed.refusal.reason,
        field: parsed.refusal.field,
      });
    }
    const body = parsed.body;
    if (body.organizationId !== this.ctx.organizationId.toLowerCase()) {
      throw new ServiceError('forbidden', GROUPING_ERROR_WORDS.workspaceChanged, {
        reason: 'workspace_changed',
      });
    }
    if (body.actorUserId !== this.ctx.userId.toLowerCase()) {
      throw new ServiceError('forbidden', GROUPING_ERROR_WORDS.actorMismatch, {
        reason: 'actor_mismatch',
      });
    }
    const args = toSplitSkuRpcRequest(body, surface);

    let attempt = 0;
    for (;;) {
      const { data, error } = await this.ctx.supabase.rpc('split_item_sku', args);
      if (error) {
        const mapped = mapGroupingError(error);
        if (mapped.reason === 'busy' && attempt < UNGROUP_BUSY_RETRIES) {
          attempt += 1;
          await this.sleep(150 + Math.floor(Math.random() * 250));
          continue;
        }
        throw refusal(error);
      }
      const outcome = parseSplitSkuOutcome(data);
      if (!outcome)
        throw new ServiceError('internal_error', 'split_item_sku answered something unreadable');
      invalidateInventoryListAfterWrite(this.ctx.organizationId, 'item.grouping');
      try {
        revalidateTag(ORDER_CATALOG_TAG, 'max');
      } catch (err) {
        // Outside a request scope (a script, a test) there is nothing to
        // record the tag in; the catalog's 60 s TTL is the bound. Never turn
        // a committed split into an error the user retries.
        console.warn(
          '[item-grouping] order catalog refresh skipped:',
          err instanceof Error ? err.message : String(err),
        );
      }
      return {
        organizationId: this.ctx.organizationId,
        replay: outcome.replay,
        items: outcome.items,
      };
    }
  }
}
