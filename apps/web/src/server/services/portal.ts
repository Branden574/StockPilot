import 'server-only';

import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { reportError } from '@/lib/error-reporter';

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
  lines: Array<{ itemId: string; name: string; quantity: number; unitPrice: number }>;
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
  const { data: mapping } = await admin
    .from('customer_users')
    .select('customer_id, email, accepted_at, customer:customers(id, name, status, organization_id, price_list_id)')
    .eq('user_id', user.id)
    .order('invited_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!mapping) return null;

  const customerRaw = (mapping as Record<string, unknown>).customer;
  const customer = (Array.isArray(customerRaw) ? customerRaw[0] : customerRaw) as {
    id: string;
    name: string;
    status: string;
    organization_id: string;
    price_list_id: string | null;
  } | null;
  if (!customer || customer.status !== 'active') return null;

  const { data: org } = await admin
    .from('organizations')
    .select('name, logo_url')
    .eq('id', customer.organization_id)
    .maybeSingle();

  if (!(mapping as { accepted_at: string | null }).accepted_at) {
    await admin
      .from('customer_users')
      .update({ accepted_at: new Date().toISOString() })
      .eq('customer_id', customer.id)
      .eq('user_id', user.id)
      .is('accepted_at', null);
  }

  return {
    userId: user.id,
    email: (mapping as { email: string }).email,
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

  const [{ data: catalogRows }, { data: priceRows }] = await Promise.all([
    admin.from('customer_catalog').select('item_id').eq('customer_id', ctx.customerId).limit(1000),
    admin
      .from('price_list_items')
      .select('item_id, unit_price')
      .eq('price_list_id', ctx.priceListId)
      .limit(1000),
  ]);
  const allowed = new Set(((catalogRows ?? []) as Array<{ item_id: string }>).map((r) => r.item_id));
  const prices = new Map(
    ((priceRows ?? []) as Array<{ item_id: string; unit_price: number }>).map((r) => [
      r.item_id,
      Number(r.unit_price) || 0,
    ]),
  );
  const ids = [...allowed].filter((id) => prices.has(id));
  if (ids.length === 0) return [];

  const { data: items } = await admin
    .from('inventory_items')
    .select('id, name, sku, quantity_on_hand, status')
    .eq('organization_id', ctx.organizationId)
    .in('id', ids)
    .eq('status', 'active')
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
  // Portal items may span warehouses; the order header needs ONE. Use the
  // first line's item warehouse (v1 — orgs overwhelmingly run one warehouse
  // per customer relationship).
  const firstLine = parsed.lines[0];
  if (!firstLine) throw new Error('Your cart is empty.');
  const { data: firstItem } = await admin
    .from('inventory_items')
    .select('warehouse_id')
    .eq('id', firstLine.itemId)
    .maybeSingle();
  const warehouseId = (firstItem as { warehouse_id: string | null } | null)?.warehouse_id;
  if (!warehouseId) throw new Error('Could not resolve a warehouse for this order.');

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
    throw new Error(headerErr?.message ?? 'Order could not be submitted.');
  }

  const linePayload = parsed.lines.map((l) => ({
    order_request_id: header.id as string,
    item_id: l.itemId,
    quantity_requested: l.quantity,
    unit_cost_at_request: byId.get(l.itemId)?.unitPrice ?? 0,
  }));
  const { error: lineErr } = await admin.from('order_request_lines').insert(linePayload);
  if (lineErr) {
    // Rollback-on-line-error pattern — never leave an orphan header.
    await admin.from('order_requests').delete().eq('id', header.id as string);
    void reportError(new Error(lineErr.message), { tag: 'portal.submit.lines' });
    throw new Error('Order could not be submitted. Please try again.');
  }

  return { id: header.id as string };
}

/** The customer's order history (this customer only, newest first). */
export async function portalOrders(ctx: PortalContext): Promise<PortalOrder[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('order_requests')
    .select(
      'id, status, created_at, lines:order_request_lines(item_id, quantity_requested, unit_cost_at_request, item:inventory_items(name))',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('customer_id', ctx.customerId)
    .order('created_at', { ascending: false })
    .limit(50);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const lines = ((r.lines as Array<Record<string, unknown>>) ?? []).map((l) => {
      const item = l.item as { name: string | null } | { name: string | null }[] | null;
      const itemObj = Array.isArray(item) ? item[0] : item;
      return {
        itemId: l.item_id as string,
        name: itemObj?.name ?? 'Item',
        quantity: Number(l.quantity_requested) || 0,
        unitPrice: Number(l.unit_cost_at_request) || 0,
      };
    });
    return {
      id: r.id as string,
      status: r.status as string,
      created_at: r.created_at as string,
      total: lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0),
      lines,
    };
  });
}
