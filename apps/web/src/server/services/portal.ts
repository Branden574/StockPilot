import 'server-only';

import { z } from 'zod';

import {
  planAllowsB2bPortal,
  resolvePortalPricingMode,
  type OrgBillingState,
  type PortalPricingMode,
} from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { loadAccountStatus } from '@/lib/auth/account-status';
import { reportError } from '@/lib/error-reporter';
import { dispatchEvent } from '@/server/services/integration-events';
import { pendingReturnQuantitiesByLine } from '@/server/services/returns';

/**
 * Paginate an admin-client select to exhaustion in 1000-row windows. Portal
 * reads run on the service-role client (portal users have no RLS grants), so
 * they don't get fetchAllRows' RLS context — this is the same range-loop with
 * an explicit 1000 cap per PostgREST's max_rows.
 *
 * A page error is NEVER swallowed. Both callers feed portalCatalog, whose
 * result decides both what the customer SEES and what checkout accepts, and a
 * silently-empty page there is not a degraded read but a WRONG one: an empty
 * price map turns every priced item into a "Request quote" line and checkout
 * then writes an unpriced order_request_line for goods that ARE priced.
 * Failing the whole read (same posture as the chunked item read below) keeps
 * that failure visible and recoverable.
 */
async function fetchAllAdmin<T>(
  tag: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) {
      const message = (error as { message?: string } | null)?.message ?? 'read failed';
      void reportError(new Error(message), { tag });
      throw new Error('Catalog could not be loaded. Please try again.');
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < SIZE) break;
  }
  return out;
}

/**
 * B2B customer portal — the CUSTOMER-facing read/write surface (P2/P3).
 *
 * SECURITY MODEL: portal users have ZERO direct table grants. Every read and
 * write below runs on the service-role client AFTER resolvePortalContext()
 * proves the signed-in auth user is an invited customer_user, and every query
 * is explicitly scoped to that customer's org + catalog + price list. Only
 * SAFE projections leave this module: name/sku/image/price/availability —
 * never cost, bin, or anything org-internal. (Available quantity is exposed
 * by owner decision 2026-07-24, the same call the public item page already
 * made; the dashboard principal keeps using RLS-scoped services.)
 */

export interface PortalContext {
  userId: string;
  email: string;
  customerId: string;
  customerName: string;
  organizationId: string;
  orgName: string;
  orgLogoUrl: string | null;
  priceListId: string | null;
  /** How this org's portal treats money (org setting; defaults to no_charge). */
  pricingMode: PortalPricingMode;
}

export interface PortalCatalogItem {
  itemId: string;
  name: string;
  sku: string | null;
  imageUrl: string | null;
  /** null in no_charge, and in a priced org when the item has no price yet. */
  unitPrice: number | null;
  /** Priced org, no price for this item — the customer asks instead of buying. */
  quotable: boolean;
  /** Real on-hand units (owner decision 2026-07-24) — never cost or bin. */
  quantityAvailable: number;
}

export interface PortalOrder {
  id: string;
  status: string;
  created_at: string;
  total: number;
  lines: Array<{
    orderRequestLineId: string;
    itemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    /** Shipped units on this line — the base of the durable return budget. */
    quantityFulfilled: number;
    /** Units already APPLIED against this line (durable counter, mig 0153). */
    quantityReturned: number;
    /** Units on live PENDING (unapplied, not cancelled/denied) return
     *  requests — the DB cap trigger counts these too, so the portal's
     *  returnable calc must subtract them (fulfilled − returned − pending). */
    quantityPendingReturn: number;
  }>;
  /**
   * The customer's OWN return requests on this order — status + date ONLY
   * (portal-safe projection; never staff fields like approver/denial reason).
   */
  returns: Array<{ id: string; status: string; created_at: string }>;
}

/**
 * Resolve the signed-in user's portal context, or null when they are not a
 * portal user. First successful resolution stamps accepted_at. A user invited
 * to several customers gets the most recently invited one (switcher = later).
 */
export async function resolvePortalContext(): Promise<PortalContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Account-status gate (install point 3 of 3 — see lib/auth/account-status.ts).
  // This funnel resolves identity ITSELF and then reads with the service-role
  // client, so it inherits nothing from loadSessionAndContext or withApiContext.
  // Without this line a disabled customer keeps full catalog browsing and order
  // submission whenever the GoTrue ban half of the disable did not land — which
  // is exactly the case the disable service reports as `partial: true`. The
  // caller already treats null as "not a portal user".
  const status = await loadAccountStatus(supabase, user.id);
  if (status.disabled) return null;

  const admin = createAdminClient();
  const { data: mappings } = await admin
    .from('customer_users')
    .select(
      'customer_id, email, accepted_at, invited_at, customer:customers(id, name, status, organization_id, price_list_id)',
    )
    .eq('user_id', user.id);

  type Cust = {
    id: string;
    name: string;
    status: string;
    organization_id: string;
    price_list_id: string | null;
  };
  const candidates = ((mappings ?? []) as Array<Record<string, unknown>>)
    .map((m) => {
      const cRaw = m.customer;
      const c = (Array.isArray(cRaw) ? cRaw[0] : cRaw) as Cust | null;
      return c && c.status === 'active'
        ? {
            email: m.email as string,
            accepted_at: (m.accepted_at as string | null) ?? null,
            invited_at: (m.invited_at as string) ?? '',
            customer: c,
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (candidates.length === 0) return null;

  // SECURITY (cross-org hijack, caught in review): an ACCEPTED mapping always
  // wins over a merely-invited one, so a fresh, unconsented invite from another
  // org can NEVER shadow the customer's existing portal. Among equal
  // accept-status, newest invite wins (lets a legitimate re-assignment take
  // effect once the user actually returns).
  candidates.sort((a, b) => {
    const aAcc = a.accepted_at ? 1 : 0;
    const bAcc = b.accepted_at ? 1 : 0;
    if (aAcc !== bAcc) return bAcc - aAcc;
    return String(b.invited_at).localeCompare(String(a.invited_at));
  });
  const chosen = candidates[0]!;
  const customer = chosen.customer;

  // Module + plan gate: disabling b2b_portal OR downgrading below Business
  // shuts the customer portal off, mirroring the org-side gate. On the admin
  // client (portal users have no RLS grants), scoped to the customer's org.
  const [{ data: moduleRow }, { data: org }] = await Promise.all([
    admin
      .from('organization_modules')
      .select('module_id, settings')
      .eq('organization_id', customer.organization_id)
      .eq('module_id', 'b2b_portal')
      .eq('enabled', true)
      .maybeSingle(),
    admin
      .from('organizations')
      .select(
        'name, logo_url, plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
      )
      .eq('id', customer.organization_id)
      .maybeSingle(),
  ]);
  if (!moduleRow) return null;
  if (!planAllowsB2bPortal(((org as OrgBillingState | null) ?? { plan: null }) as OrgBillingState)) {
    return null;
  }

  if (!chosen.accepted_at) {
    await admin
      .from('customer_users')
      .update({ accepted_at: new Date().toISOString() })
      .eq('customer_id', customer.id)
      .eq('user_id', user.id)
      .is('accepted_at', null);
  }

  return {
    userId: user.id,
    email: chosen.email,
    customerId: customer.id,
    customerName: customer.name,
    organizationId: customer.organization_id,
    orgName: (org as { name?: string } | null)?.name ?? 'Supplier',
    orgLogoUrl: (org as { logo_url?: string | null } | null)?.logo_url ?? null,
    priceListId: customer.price_list_id,
    // The mode rides on the SAME b2b_portal row the gate above already read.
    // Absent/malformed settings resolve to no_charge inside the shared
    // resolver — never add a second default here.
    pricingMode: resolvePortalPricingMode((moduleRow as { settings?: unknown } | null)?.settings),
  };
}

/**
 * The customer's catalog: the items on THEIR allowlist, in their org, active,
 * not soft-deleted and not awaiting first receipt. The allowlist alone decides
 * membership; the org's pricing mode only decides what money is shown. Checkout
 * re-validates every line against this exact set (portalSubmitOrder), so
 * anything added here becomes orderable — never relax the allowlist.
 */
export async function portalCatalog(ctx: PortalContext): Promise<PortalCatalogItem[]> {
  const admin = createAdminClient();
  const noCharge = ctx.pricingMode === 'no_charge';

  // Paginate both to exhaustion — checkout re-validates against this exact set,
  // so a silent 1000-row cap would let a visible item fail at checkout (recurring
  // pattern: never leave an undisclosed cap on a set another path re-checks).
  //
  // In no_charge the price list is irrelevant and is not read at all — an org
  // that does not charge has no price list, and requiring one is exactly what
  // left its portal empty.
  const [catalogRows, priceRows] = await Promise.all([
    fetchAllAdmin<{ item_id: string }>('portal.catalog.allowlist', (from, to) =>
      admin
        .from('customer_catalog')
        .select('item_id')
        .eq('customer_id', ctx.customerId)
        .order('item_id', { ascending: true })
        .range(from, to),
    ),
    noCharge || !ctx.priceListId
      ? Promise.resolve([] as Array<{ item_id: string; unit_price: number }>)
      : fetchAllAdmin<{ item_id: string; unit_price: number }>('portal.catalog.prices', (from, to) =>
          admin
            .from('price_list_items')
            .select('item_id, unit_price')
            .eq('price_list_id', ctx.priceListId as string)
            .order('item_id', { ascending: true })
            .range(from, to),
        ),
  ]);
  const prices = new Map(priceRows.map((r) => [r.item_id, Number(r.unit_price) || 0]));
  // The ALLOWLIST alone decides what a customer can see. Previously an unpriced
  // item was filtered out here; the owner's 2026-07-24 decision is to show it
  // with a request-quote action instead.
  const ids = catalogRows.map((r) => r.item_id);
  if (ids.length === 0) return [];

  // Chunked, not one `.in(...)`: this now receives the customer's ENTIRE
  // allowlist (previously it got the smaller allowlist-∩-priced set), and two
  // things silently break at scale otherwise. First, PostgREST caps a single
  // response at max_rows regardless of how many ids matched (1000,
  // supabase/config.toml) — a big-enough allowlist would come back truncated
  // with no error. Second, a few hundred UUIDs in one `.in(...)` can overrun a
  // proxy's URL length limit before the request reaches Postgres. 500 ids per
  // batch (UUIDs are 36 chars, so ~18KB of query string) matches the existing
  // chunkIdsForInFilter precedent (services/inventory.ts) and keeps each
  // batch's own response bounded well under the row cap, since this query
  // returns at most one row per id. A batch error is NOT swallowed — unlike a
  // decorative lookup, this set decides catalog membership, so a failed batch
  // must fail the whole read rather than quietly rendering an incomplete (or
  // empty) catalog.
  const ITEMS_BATCH_SIZE = 500;
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += ITEMS_BATCH_SIZE) {
    const batch = ids.slice(i, i + ITEMS_BATCH_SIZE);
    const { data, error } = await admin
      .from('inventory_items')
      .select('id, name, sku, quantity_on_hand, status')
      .eq('organization_id', ctx.organizationId)
      .in('id', batch)
      .eq('status', 'active')
      // Expected items (mig 0277): never received — excluded from the
      // customer catalog until first stock arrives. Checkout re-validates
      // every line against THIS set (portalSubmitOrder), so the exclusion
      // also rejects a crafted submit.
      .eq('awaiting_first_receipt', false)
      .is('deleted_at', null);
    if (error) {
      void reportError(new Error(error.message), { tag: 'portal.catalog.items' });
      throw new Error('Catalog could not be loaded. Please try again.');
    }
    items.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  return items.map((i) => ({
    itemId: i.id as string,
    name: (i.name as string) ?? '',
    sku: (i.sku as string | null) ?? null,
    // Item photos live in a private bucket (storage_path + signed URLs) —
    // portal images are a follow-up; the catalog stands without them.
    imageUrl: null,
    unitPrice: noCharge ? null : (prices.get(i.id as string) ?? null),
    // Quotable = a priced org has no price for this item yet, so the customer
    // asks rather than buys. Never true in no_charge, where nothing is sold.
    quotable: !noCharge && !prices.has(i.id as string),
    // Real on-hand (owner decision 2026-07-24, replacing the in-stock badge).
    // Still never cost or bin — those remain org-internal.
    quantityAvailable: Number(i.quantity_on_hand) || 0,
  }));
}

const submitSchema = z.object({
  lines: z
    .array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1).max(100000) }))
    .min(1)
    .max(100),
  notes: z.string().max(2000).optional(),
});
export type PortalSubmitInput = z.infer<typeof submitSchema>;

/**
 * Checkout: validates every line against the catalog set above — the
 * customer's own allowlist, org-scoped and orderable — then
 * creates ONE normal order_requests row (source 'portal', pending_approval —
 * the same approval pipeline internal requests use; decided default) with the
 * customer's prices recorded per line. Returns the new order id.
 */
export async function portalSubmitOrder(
  ctx: PortalContext,
  input: PortalSubmitInput,
): Promise<{ id: string }> {
  const parsed = submitSchema.parse(input);
  const catalog = await portalCatalog(ctx);
  const byId = new Map(catalog.map((c) => [c.itemId, c]));
  for (const line of parsed.lines) {
    if (!byId.has(line.itemId)) {
      throw new Error('One of the items is no longer available to order.');
    }
  }

  const admin = createAdminClient();

  // Resolve item cost + warehouse for every line (org-scoped). The order header
  // needs ONE warehouse and the approve pipeline rejects mixed-warehouse lines
  // (item_warehouse_mismatch), so a cart spanning warehouses is refused up
  // front with a clear message rather than creating an un-approvable order.
  const itemIds = [...new Set(parsed.lines.map((l) => l.itemId))];
  const { data: itemRows } = await admin
    .from('inventory_items')
    .select('id, warehouse_id, unit_cost')
    .eq('organization_id', ctx.organizationId)
    .in('id', itemIds);
  const itemMeta = new Map(
    ((itemRows ?? []) as Array<{ id: string; warehouse_id: string | null; unit_cost: number | null }>).map(
      (r) => [r.id, r],
    ),
  );
  const warehouses = new Set<string>();
  for (const id of itemIds) {
    const wh = itemMeta.get(id)?.warehouse_id;
    if (wh) warehouses.add(wh);
  }
  if (warehouses.size === 0) throw new Error('Could not resolve a warehouse for this order.');
  if (warehouses.size > 1) {
    throw new Error(
      'These items ship from different warehouses — please place a separate order per warehouse.',
    );
  }
  const warehouseId = [...warehouses][0]!;

  const { data: header, error: headerErr } = await admin
    .from('order_requests')
    .insert({
      organization_id: ctx.organizationId,
      warehouse_id: warehouseId,
      status: 'pending_approval',
      source: 'portal',
      customer_id: ctx.customerId,
      requester_user_id: ctx.userId,
      requester_email: ctx.email,
      requester_name: ctx.customerName,
      notes: parsed.notes ?? null,
      fulfillment_type: 'pickup',
    })
    .select('id')
    .single();
  if (headerErr || !header) {
    void reportError(new Error(headerErr?.message ?? 'header insert failed'), {
      tag: 'portal.submit.header',
    });
    throw new Error('Order could not be submitted. Please try again.');
  }

  // Accounting split: unit_cost_at_request = the item's COST (consistent with
  // internal/public orders + the Sage/QBO return-valuation readers);
  // unit_price_at_request = the customer's SELL price (portal history reads it).
  //
  // A line with no agreed price stamps NULL, never 0. The column is nullable, and
  // the two cases are genuinely different: 0 means "agreed, costs nothing", NULL
  // means "no price yet — to be quoted". That is every line in a no_charge org,
  // and the quotable ones in a priced org. Writing 0 for both would tell anyone
  // reading the history later that a to-be-quoted line had been settled at free.
  const linePayload = parsed.lines.map((l) => ({
    order_request_id: header.id as string,
    item_id: l.itemId,
    quantity_requested: l.quantity,
    unit_cost_at_request: Number(itemMeta.get(l.itemId)?.unit_cost) || 0,
    unit_price_at_request: byId.get(l.itemId)?.unitPrice ?? null,
  }));
  const { error: lineErr } = await admin.from('order_request_lines').insert(linePayload);
  if (lineErr) {
    // Rollback-on-line-error pattern — never leave an orphan header.
    await admin.from('order_requests').delete().eq('id', header.id as string);
    void reportError(new Error(lineErr.message), { tag: 'portal.submit.lines' });
    throw new Error('Order could not be submitted. Please try again.');
  }

  // Feed the org's integration/audit surfaces like any other new order.
  void dispatchEvent(ctx.organizationId, 'order.created', {
    id: header.id as string,
    orderNumber: (header.id as string).slice(0, 8).toUpperCase(),
    source: 'portal',
    customerId: ctx.customerId,
  });

  return { id: header.id as string };
}

/** The customer's order history (this customer only, newest first). */
export async function portalOrders(ctx: PortalContext): Promise<PortalOrder[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('order_requests')
    .select(
      'id, status, created_at, lines:order_request_lines(id, item_id, quantity_requested, quantity_fulfilled, returned_quantity, unit_price_at_request, item:inventory_items(name))',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('customer_id', ctx.customerId)
    .order('created_at', { ascending: false })
    .limit(50);

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // The customer's own return requests on these orders — SAFE projection only
  // (status + date; the id keys React rows). Never approver/denial/staff data.
  // source='requester' only: staff-created internal returns (including
  // denied/cancelled ones) are org-internal workflow and must never surface
  // on the customer's portal card.
  const orderIds = rows.map((r) => r.id as string);
  const returnsByOrder = new Map<string, PortalOrder['returns']>();
  if (orderIds.length > 0) {
    const { data: returnRows } = await admin
      .from('returns')
      .select('id, order_request_id, status, created_at')
      .eq('organization_id', ctx.organizationId)
      .eq('source', 'requester')
      .in('order_request_id', orderIds)
      .order('created_at', { ascending: false });
    for (const ret of (returnRows ?? []) as Array<Record<string, unknown>>) {
      const key = ret.order_request_id as string;
      const list = returnsByOrder.get(key) ?? [];
      list.push({
        id: ret.id as string,
        status: ret.status as string,
        created_at: ret.created_at as string,
      });
      returnsByOrder.set(key, list);
    }
  }

  // Live pending return demand per line (unapplied lines on not-cancelled/
  // denied returns) — the DB cap trigger counts it, so the portal's
  // returnable calc (fulfilled − returned − pending) must too. Best-effort:
  // on a read failure fall back to zero pending (the create path re-validates
  // server-side and the DB trigger is the authoritative backstop), matching
  // this reader's lenient posture on the returns list above.
  let pendingByLine = new Map<string, number>();
  try {
    const allLineIds = rows.flatMap((r) =>
      (((r.lines as Array<Record<string, unknown>>) ?? []).map((l) => l.id as string)),
    );
    pendingByLine = await pendingReturnQuantitiesByLine(admin, ctx.organizationId, allLineIds);
  } catch {
    pendingByLine = new Map<string, number>();
  }

  return rows.map((r) => {
    const lines = ((r.lines as Array<Record<string, unknown>>) ?? []).map((l) => {
      const item = l.item as { name: string | null } | { name: string | null }[] | null;
      const itemObj = Array.isArray(item) ? item[0] : item;
      return {
        orderRequestLineId: l.id as string,
        itemId: l.item_id as string,
        name: itemObj?.name ?? 'Item',
        quantity: Number(l.quantity_requested) || 0,
        // SELL price the customer paid — never the cost snapshot.
        unitPrice: Number(l.unit_price_at_request) || 0,
        quantityFulfilled: Number(l.quantity_fulfilled) || 0,
        quantityReturned: Number(l.returned_quantity) || 0,
        quantityPendingReturn: pendingByLine.get(l.id as string) ?? 0,
      };
    });
    return {
      id: r.id as string,
      status: r.status as string,
      created_at: r.created_at as string,
      total: lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0),
      lines,
      returns: returnsByOrder.get(r.id as string) ?? [],
    };
  });
}

/**
 * Whether the supplier org has the `returns` module enabled — drives the
 * portal's "Request a return" affordance. UI-gating only: the create path
 * re-checks the module server-side (loadPortalReturnContext), so flipping
 * the flag client-side buys nothing.
 */
export async function portalReturnsEnabled(ctx: PortalContext): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'returns')
    .eq('enabled', true)
    .maybeSingle();
  return Boolean(data);
}
