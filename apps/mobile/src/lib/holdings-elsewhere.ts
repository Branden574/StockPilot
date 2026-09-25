/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STOCK A SCOPED MEMBER CANNOT SEE, ON THE PHONE (migration 0371)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Since 0371 a member below manager (staff and viewers) reads
 * `item_stock_levels` only in their assigned warehouses, plus locations with no
 * warehouse. The item's `quantity_on_hand` is still the org-wide total. So a
 * phone screen that lists the holdings it can see is showing part of the stock,
 * and must say where the rest is, or say that it could not find out.
 *
 * The gated SECURITY DEFINER RPC `item_holdings_elsewhere(uuid[])` answers the
 * missing half as totals per item (Staging, Unplaced, placed, the placed
 * location ids and how many of them are racks). The parser, the per-item
 * state and the id batching live in
 * @stockpilot/core (holdings-elsewhere.ts), shared with the web; the words live
 * beside them (stock-writeoff.ts). This module is the phone's one caller of the
 * RPC, and the one place the phone decides what a move or remove sheet says.
 *
 * THE RULES (the same ones the web's InventoryService.hiddenHoldingsFor keeps):
 *
 *   • Managers and above see every holding: NO CALL. Decided by ROLE, never by
 *     the all-warehouses flag. A staff member with that flag still reads by
 *     their assignment rows, so a flag-based skip could show a partial view as
 *     complete. An unknown role (still loading) makes the call: managers get
 *     no rows anyway, so the only cost of not knowing is one request. The
 *     role comes from useRole, whose cache is re-read once it is due and
 *     cleared on sign-out (role-cache.ts): a demoted manager's phone must not
 *     keep skipping.
 *   • At most HOLDINGS_ELSEWHERE_MAX_IDS ids per call, all batches in
 *     parallel. The ids go in the POST body of the RPC, never a URL.
 *   • Start it ALONGSIDE the screen's own holdings read, never after it.
 *   • NEVER THROWS, and a failure is never "nothing elsewhere": an error
 *     (including PGRST202, the function missing), a rejected request or a
 *     payload the parser refuses resolves `{ ok: false }`, which renders as
 *     "could not load stock in other warehouses". Nothing here caches.
 *
 * Pure: no React Native import, no Supabase client (the screens pass
 * `supabase`). Do not import ./supabase here; it pulls in expo-secure-store and
 * would put this module out of reach of the node test environment.
 */

import {
  chunkHoldingsElsewhereIds,
  ELSEWHERE_UNAVAILABLE_NOTE,
  formatElsewhereSourcesNote,
  holdingsElsewhereTotal,
  isManagerOrAbove,
  itemElsewhereFrom,
  parseHoldingsElsewhereRows,
  type HoldingsElsewhere,
  type ItemElsewhere,
  type Role,
} from '@stockpilot/core';

// ── The read ────────────────────────────────────────────────────────────────

/** The slice of the Supabase client the RPC read uses. */
export interface ElsewhereRpcClient {
  rpc(fn: string, args?: Record<string, unknown>): unknown;
}

/** One RPC answer, as supabase-js resolves it (it does not reject on errors). */
interface RpcResponse {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

/**
 * The batch answer: every requested item's hidden totals, or `{ ok: false }`
 * when ANY batch failed (the whole answer is then unknown, never partial).
 */
export type ElsewhereRead = { ok: true; byItem: Map<string, HoldingsElsewhere> } | { ok: false };

/**
 * True when the member sees every holding already, so the call is skipped.
 * By ROLE: owner, admin and manager. Anything else, including a role that has
 * not loaded yet or one this build does not know, makes the call.
 */
export function seesEveryHolding(role: Role | string | null | undefined): boolean {
  if (typeof role !== 'string' || role === '') return false;
  try {
    return isManagerOrAbove(role as Role);
  } catch {
    // An unknown role string is not in core's role table. Asking costs one
    // request; skipping could present a partial view as complete.
    return false;
  }
}

/**
 * What each item holds in warehouses the caller cannot see. Never throws.
 */
export async function readHoldingsElsewhere(
  client: ElsewhereRpcClient,
  itemIds: readonly (string | null | undefined)[],
  role: Role | string | null | undefined,
): Promise<ElsewhereRead> {
  if (seesEveryHolding(role)) return { ok: true, byItem: new Map() };
  const batches = chunkHoldingsElsewhereIds(itemIds);
  if (batches.length === 0) return { ok: true, byItem: new Map() };
  try {
    const answers = await Promise.all(
      batches.map(async (batch) => {
        const res = (await (client.rpc('item_holdings_elsewhere', {
          p_item_ids: batch,
        }) as PromiseLike<RpcResponse>)) as RpcResponse | null | undefined;
        if (!res || res.error) {
          throw new Error(
            `item_holdings_elsewhere failed (${res?.error?.code ?? 'no code'}): ${
              res?.error?.message ?? 'no response'
            }`,
          );
        }
        return parseHoldingsElsewhereRows(res.data);
      }),
    );
    const byItem = new Map<string, HoldingsElsewhere>();
    for (const answer of answers) for (const [id, h] of answer) byItem.set(id, h);
    return { ok: true, byItem };
  } catch (e) {
    console.warn(
      '[holdings-elsewhere] stock in other warehouses could not be read; screens say so',
      e instanceof Error ? e.message : String(e),
    );
    return { ok: false };
  }
}

/** The state ONE item's screen renders from. Never throws. */
export async function readItemElsewhere(
  client: ElsewhereRpcClient,
  itemId: string,
  role: Role | string | null | undefined,
): Promise<ItemElsewhere> {
  const read = await readHoldingsElsewhere(client, [itemId], role);
  return itemElsewhereFrom(read.ok ? read.byItem : null, itemId);
}

// ── What a move or remove sheet says about it ───────────────────────────────

/**
 * The copy a source list (Move stock's FROM chips, Remove from rack's RACK /
 * CRATE chips) shows about stock the member cannot act on. The same decisions
 * the web StockTransferDialog makes, in the same shared words:
 *
 *   • `empty` — the text for an EMPTY source list. When part of the item's
 *     stock is in other warehouses and the member holds none of it here, that
 *     is the whole explanation ("This item's stock (12) is in warehouses you
 *     don't manage."). When the member does hold some here (in Staging, say,
 *     for a sheet that lists placed stock only), the sheet's own sentence stays
 *     and the elsewhere sentence follows it. A failed read says so instead of
 *     the sheet's own sentence when that sentence might be the false one.
 *   • `note` — one line under a NON-EMPTY source list: the rest of the stock
 *     is elsewhere, or could not be looked up. Null when there is nothing to
 *     add.
 *
 * `emptyDefault` is what the sheet said before 0371. `holdsSomeHere` is true
 * when the member can see any of the item's stock, placed or not.
 */
export function elsewhereSourcesCopy(input: {
  elsewhere: ItemElsewhere | null | undefined;
  emptyDefault: string;
  holdsSomeHere: boolean;
}): { empty: string; note: string | null } {
  const el = input.elsewhere;
  if (el?.status === 'unavailable') {
    return {
      empty: input.holdsSomeHere
        ? `${input.emptyDefault} ${ELSEWHERE_UNAVAILABLE_NOTE}`
        : ELSEWHERE_UNAVAILABLE_NOTE,
      note: ELSEWHERE_UNAVAILABLE_NOTE,
    };
  }
  const total = el?.status === 'some' ? holdingsElsewhereTotal(el) : 0;
  if (total <= 0) return { empty: input.emptyDefault, note: null };
  const rest = formatElsewhereSourcesNote(total, { noneHere: false });
  return {
    empty: input.holdsSomeHere
      ? `${input.emptyDefault} ${rest}`
      : formatElsewhereSourcesNote(total, { noneHere: true }),
    note: rest,
  };
}

/**
 * Shown by a move or remove sheet when its OWN holdings read failed. Without
 * it the sheet fell through to its empty state, and since 0371 that state can
 * say where the stock is ("in warehouses you don't manage"): a confident
 * sentence built on a read that did not happen.
 */
export const SHEET_HOLDINGS_UNREADABLE_NOTE =
  "Could not load this item's stock. Close this and try again.";

// ── Where a scoped member may move stock TO (owner decision Q4) ─────────────

/** The slice of the Supabase client the assignment read uses. */
export interface AssignmentReadClient {
  from(table: string): unknown;
}

interface AssignmentChain {
  select(columns: string): AssignmentChain;
  eq(column: string, value: string): AssignmentChain & PromiseLike<RpcResponse>;
}

/**
 * The warehouses a member may move stock INTO.
 *
 *   • `writableIds` null: unrestricted. Managers and above (and a role that is
 *     not known yet: this is a UI filter, and the server decides either way).
 *   • `writableIds` []: no warehouse. Viewers, and a failed read.
 *   • `unreadable`: the assignment read failed. The sheet then offers only
 *     locations with no warehouse and SAYS that it could not load the member's
 *     warehouses, instead of presenting a narrowed list as complete.
 */
export interface DestinationWarehouseScope {
  writableIds: readonly string[] | null;
  unreadable: boolean;
}

/** Shown in the move sheet when the member's warehouse access could not be read. */
export const DESTINATION_ACCESS_UNREADABLE_NOTE =
  'Could not load your warehouse access, so racks in your warehouses may be missing here. Close this and try again.';

/**
 * Read the member's writable warehouses: their `user_warehouse_assignments`
 * rows, which is exactly what the server's write check reads for staff
 * (user_can_access_warehouse 'write'; 0365 caller_can_write_location). The
 * all-warehouses flag (0280) needs no read of its own: it gives the member one
 * assignment row per warehouse, including warehouses added later.
 *
 * Managers and above, and viewers, make no read. Never throws.
 */
export async function readDestinationWarehouseScope(
  client: AssignmentReadClient,
  input: {
    role: Role | string | null | undefined;
    organizationId: string;
    userId: string | null | undefined;
  },
): Promise<DestinationWarehouseScope> {
  const { role } = input;
  if (typeof role !== 'string' || role === '' || seesEveryHolding(role)) {
    return { writableIds: null, unreadable: false };
  }
  if (role === 'viewer') return { writableIds: [], unreadable: false };
  if (!input.userId) return { writableIds: [], unreadable: true };
  try {
    const table = client.from('user_warehouse_assignments') as AssignmentChain;
    const res = await table
      .select('warehouse_id')
      .eq('organization_id', input.organizationId)
      .eq('user_id', input.userId);
    if (!res || res.error || !Array.isArray(res.data)) {
      return { writableIds: [], unreadable: true };
    }
    const ids = (res.data as { warehouse_id?: unknown }[])
      .map((r) => r?.warehouse_id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
    return { writableIds: [...new Set(ids)], unreadable: false };
  } catch {
    return { writableIds: [], unreadable: true };
  }
}
