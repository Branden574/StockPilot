import 'server-only';

import { z } from 'zod';

import { planAllowsB2bPortal, type OrgBillingState } from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { reportError } from '@/lib/error-reporter';
import { dispatchEvent } from '@/server/services/integration-events';

/**
 * Paginate an admin-client select to exhaustion in 1000-row windows. Portal
 * reads run on the service-role client (portal users have no RLS grants), so
 * they don't get fetchAllRows' RLS context — this is the same range-loop with
 * an explicit 1000 cap per PostgREST's max_rows.
 */
async function fetchAllAdmin<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data } = await page(from, from + SIZE - 1);
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
 * SAFE projections leave this module: name/sku/image/price/in-stock — never
 * cost, quantity, bin, or anything org-internal. (Mirrors the public-catalog
 * posture; the dashboard principal keeps using RLS-scoped services.)
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
}

export interface PortalCatalogItem {
  itemId: string;
  name: string;
  sku: string | null;
  imageUrl: string | null;
  unitPrice: number;
  inStock: boolean;
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
    /** Units already on return requests (durable counter, mig 0153). */
    quantityReturned: number;
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
      .select('module_id')
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
  };
}

/**
 * The customer's catalog: allowlisted items ∩ price-list entries. BOTH are
 * required — an item without an explicit price never appears (decided
 * default), and an unassigned price list means an empty portal.
 */
export async function portalCatalog(ctx: PortalContext): Promise<PortalCatalogItem[]> {
  if (!ctx.priceListId) return [];
  const admin = createAdminClient();

  // Paginate both to exhaustion — checkout re-validates against this exact set,
  // so a silent 1000-row cap would let a visible item fail at checkout (recurring
  // pattern: never leave an undisclosed cap on a set another path re-checks).
  const [catalogRows, priceRows] = await Promise.all([
    fetchAllAdmin<{ item_id: string }>((from, to) =>
      admin
        .from('customer_catalog')
        .select('item_id')
        .eq('customer_id', ctx.customerId)
        .order('item_id', { ascending: true })
        .range(from, to),
    ),
    fetchAllAdmin<{ item_id: string; unit_price: number }>((from, to) =>
      admin
        .from('price_list_items')
        .select('item_id, unit_price')
        .eq('price_list_id', ctx.priceListId as string)
        .order('item_id', { ascending: true })
        .range(from, to),
    ),
  ]);
  const allowed = new Set(catalogRows.map((r) => r.item_id));
  const prices = new Map(priceRows.map((r) => [r.item_id, Number(r.unit_price) || 0]));
  const ids = [...allowed].filter((id) => prices.has(id));
  if (ids.length === 0) return [];

  const { data: items } = await admin
    .from('inventory_items')
    .select('id, name, sku, quantity_on_hand, status')
    .eq('organization_id', ctx.organizationId)
    .in('id', ids)
    .eq('status', 'active')
    // Expected items (mig 0277): never received — excluded from the
    // customer catalog until first stock arrives. Checkout re-validates
    // every line against THIS set (portalSubmitOrder), so the exclusion
    // also rejects a crafted submit.
    .eq('awaiting_first_receipt', false)
    .is('deleted_at', null);

  return ((items ?? []) as Array<Record<string, unknown>>).map((i) => ({
    itemId: i.id as string,
    name: (i.name as string) ?? '',
    sku: (i.sku as string | null) ?? null,
    // Item photos live in a private bucket (storage_path + signed URLs) —
    // portal images are a follow-up; the catalog stands without them.
    imageUrl: null,
    unitPrice: prices.get(i.id as string) ?? 0,
    // Badge only — never the actual quantity (decided default).
    inStock: (Number(i.quantity_on_hand) || 0) > 0,
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
 * Checkout: validates every line against the catalog∩price-list set, then
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
  const linePayload = parsed.lines.map((l) => ({
    order_request_id: header.id as string,
    item_id: l.itemId,
    quantity_requested: l.quantity,
    unit_cost_at_request: Number(itemMeta.get(l.itemId)?.unit_cost) || 0,
    unit_price_at_request: byId.get(l.itemId)?.unitPrice ?? 0,
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
  const orderIds = rows.map((r) => r.id as string);
  const returnsByOrder = new Map<string, PortalOrder['returns']>();
  if (orderIds.length > 0) {
    const { data: returnRows } = await admin
      .from('returns')
      .select('id, order_request_id, status, created_at')
      .eq('organization_id', ctx.organizationId)
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
