import 'server-only';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  ORDER_MAX_UNITS_PER_LINE,
  planAllowsB2bPortal,
  resolvePortalPricingMode,
  type ExchangeStatus,
  type OrgBillingState,
  type PortalPricingMode,
  type RequesterTrackingLine,
} from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { accountIsDisabledOrThrow, loadAccountStatus } from '@/lib/auth/account-status';
import { stepUpIsOwedByUser } from '@/lib/auth/step-up-gate';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { dispatchEvent } from '@/server/services/integration-events';
import { fetchAllRowsByIds, rawErrorText } from '@/server/services/lib/fetch-by-ids';
import { pendingReturnQuantitiesByLine } from '@/server/services/returns';
import { trackingRowsForOrders } from '@/server/services/returns-requester';

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
      throw new ServiceError('validation_error', 'Catalog could not be loaded. Please try again.');
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
   * The customer's OWN return requests on this order: status, date, and
   * (returns RX-3) the requester's tracking (core requester-exchange-types):
   * the RMA number, the sentences, the replacement order once it exists, and
   * per line what is coming back and what replaces it. A portal-safe
   * projection: never staff fields like the approver, a reason, a rack or a
   * disposition.
   */
  returns: Array<{
    id: string;
    status: string;
    created_at: string;
    returnNumber: string | null;
    exchangeStatus: ExchangeStatus;
    sentences: string[];
    replacementOrderNumber: string | null;
    lines: RequesterTrackingLine[];
  }>;
}

/**
 * Where the portal sends a session that still owes its authenticator code:
 * the code page, which returns to the portal (its one page) after the code.
 */
export const PORTAL_CODE_PAGE = `/signin/mfa?${new URLSearchParams({ redirect: '/portal' }).toString()}`;

/** A time column as milliseconds, or null when it is missing or unreadable. */
function timeOf(value: string | null): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** Ascending by time, a missing time last. */
function earliestFirst(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

/** Descending by time, a missing time last. */
function newestFirst(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return b - a;
}

/**
 * The order an account's portal mappings are tried in: accepted before
 * invited; among accepted, the earliest acceptance first; among invited, the
 * newest invitation first. Times are compared as times (PostgREST may write
 * an offset), and equal times fall back to the customer id so the order never
 * depends on the order the rows were read in.
 */
function comparePortalMappings(
  a: { accepted_at: string | null; invited_at: string; customer: { id: string } },
  b: { accepted_at: string | null; invited_at: string; customer: { id: string } },
): number {
  const aAcc = a.accepted_at ? 1 : 0;
  const bAcc = b.accepted_at ? 1 : 0;
  if (aAcc !== bAcc) return bAcc - aAcc;
  const byTime = aAcc
    ? earliestFirst(timeOf(a.accepted_at), timeOf(b.accepted_at))
    : newestFirst(timeOf(a.invited_at || null), timeOf(b.invited_at || null));
  if (byTime !== 0) return byTime;
  return a.customer.id < b.customer.id ? -1 : a.customer.id > b.customer.id ? 1 : 0;
}

/**
 * How many of an account's mappings resolvePortalContext asks the module and
 * plan gate of, first in comparePortalMappings order. An account with more
 * accepted mappings than this is served from its earliest acceptances only:
 * if none of their orgs has the portal on, it is not a portal user, even when
 * a later acceptance's org has it on.
 */
export const PORTAL_MAPPINGS_TRIED_MAX = 10;

type PortalGate = { moduleRow: unknown; org: unknown };

const PORTAL_GATE_ORG_COLUMNS =
  'name, logo_url, plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier';

/**
 * The b2b_portal module row (enabled only) and the billing row of each org,
 * two requests however many orgs: the per-org reads it always made for one
 * org, and one batched read of each table for several. A failed read gives no
 * row, which the gate treats as the portal off, as before.
 */
async function readPortalGates(
  admin: ReturnType<typeof createAdminClient>,
  orgIds: readonly string[],
): Promise<Map<string, PortalGate>> {
  const ids = [...new Set(orgIds)];
  const gates = new Map<string, PortalGate>();
  if (ids.length === 0) return gates;
  if (ids.length === 1) {
    const orgId = ids[0]!;
    const [{ data: moduleRow }, { data: org }] = await Promise.all([
      admin
        .from('organization_modules')
        .select('module_id, settings')
        .eq('organization_id', orgId)
        .eq('module_id', 'b2b_portal')
        .eq('enabled', true)
        .maybeSingle(),
      admin.from('organizations').select(PORTAL_GATE_ORG_COLUMNS).eq('id', orgId).maybeSingle(),
    ]);
    gates.set(orgId, { moduleRow, org });
    return gates;
  }
  const [{ data: moduleRows }, { data: orgRows }] = await Promise.all([
    admin
      .from('organization_modules')
      .select('organization_id, module_id, settings')
      .in('organization_id', ids)
      .eq('module_id', 'b2b_portal')
      .eq('enabled', true),
    admin.from('organizations').select(`id, ${PORTAL_GATE_ORG_COLUMNS}`).in('id', ids),
  ]);
  const modules = new Map(
    ((moduleRows ?? []) as Array<{ organization_id: string }>).map((m) => [m.organization_id, m]),
  );
  const orgs = new Map(((orgRows ?? []) as Array<{ id: string }>).map((o) => [o.id, o]));
  for (const id of ids) {
    gates.set(id, { moduleRow: modules.get(id) ?? null, org: orgs.get(id) ?? null });
  }
  return gates;
}

/**
 * Resolve the signed-in user's portal context, or null when they are not a
 * portal user. The first resolution of an invited mapping stamps accepted_at.
 * A user mapped to several customers gets the first accepted one, in
 * comparePortalMappings order, whose organization has the portal on; a user
 * with no accepted mapping gets the newest invitation if its organization has
 * the portal on (switcher = later).
 *
 * An account that has a verified authenticator, on a session that has not
 * entered its code, is sent to the code page before anything is resolved: the
 * rule requireOrgContext() applies to a member (lib/auth/step-up-gate), here
 * for the portal page and every portal action, which all build on this.
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
  //
  // An UNREADABLE status throws rather than returning null: "not a portal user"
  // would log a legitimate customer out of a catalog they are entitled to
  // because of a database error, and it is not what happened.
  const status = await loadAccountStatus(supabase, user.id);
  if (accountIsDisabledOrThrow(status)) return null;

  // ═══ THE AUTHENTICATOR CODE COMES FIRST ═══
  //
  // Like the account-status gate above, this funnel inherits nothing from
  // requireOrgContext() or withApiContext, and it reads with the service-role
  // client, which no database rule narrows. So it asks the one step-up rule
  // itself, before the service-role client is made and before accepted_at is
  // stamped: an account with a verified factor is a portal customer only on a
  // session at aal2. The factors are those of the getUser() answer above and
  // the level is this account's own verified claims; an account with no
  // authenticator is not asked and costs no extra Auth call. Every caller
  // awaits this outside any try, so the redirect gets out (the action-step-up
  // and page-step-up guards hold that they ask this first).
  if (await stepUpIsOwedByUser(supabase, user)) redirect(PORTAL_CODE_PAGE);

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

  // SECURITY (cross-org): an ACCEPTED mapping always comes before a merely
  // invited one, so a fresh invite from another org that the customer never
  // opened cannot shadow the customer's existing portal. Among accepted
  // mappings the EARLIEST acceptance comes first, so a later acceptance never
  // takes the place of an earlier one. accepted_at and invited_at are written
  // only by the server: the stamp below (service role), and the database's
  // customer_users trigger for every other writer (accepted_at null and
  // invited_at now() on insert, neither changed on update). Among invited
  // mappings, the newest invite comes first (lets a legitimate re-assignment
  // take effect once the user actually returns).
  candidates.sort(comparePortalMappings);

  // Module + plan gate: disabling b2b_portal OR downgrading below Business
  // shuts that org's customer portal off, mirroring the org-side gate. On the
  // admin client (portal users have no RLS grants), scoped to the mapping's
  // org. Which mappings it is asked of:
  //   - an account with an accepted mapping: each ACCEPTED mapping, in the
  //     order above, and the first that passes is opened, so one org turning
  //     its portal off never hides another org the customer already uses.
  //     An invitation is never opened in their place: an org does not gain a
  //     customer because another org switched its portal off;
  //   - an account with none: the newest invitation alone, as it always was.
  // An account may have many mappings, so the number tried is bounded (the
  // earliest acceptances, which the sort puts first, are always inside the
  // bound), and the gate is read once for all their orgs.
  const accepted = candidates.filter((c) => c.accepted_at);
  const tried = (accepted.length > 0 ? accepted : candidates.slice(0, 1)).slice(
    0,
    PORTAL_MAPPINGS_TRIED_MAX,
  );
  const gates = await readPortalGates(
    admin,
    tried.map((c) => c.customer.organization_id),
  );
  let opened: {
    chosen: (typeof candidates)[number];
    moduleRow: unknown;
    org: unknown;
  } | null = null;
  for (const candidate of tried) {
    const { moduleRow, org } = gates.get(candidate.customer.organization_id) ?? {
      moduleRow: null,
      org: null,
    };
    if (!moduleRow) continue;
    if (
      !planAllowsB2bPortal(((org as OrgBillingState | null) ?? { plan: null }) as OrgBillingState)
    ) {
      continue;
    }
    opened = { chosen: candidate, moduleRow, org };
    break;
  }
  if (!opened) return null;
  const { chosen, moduleRow, org } = opened;
  const customer = chosen.customer;

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
      : fetchAllAdmin<{ item_id: string; unit_price: number }>(
          'portal.catalog.prices',
          (from, to) =>
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

  // Batched, not one `.in(...)`: this receives the customer's ENTIRE
  // allowlist, and two things silently break at scale otherwise. First,
  // PostgREST caps a single response at max_rows regardless of how many ids
  // matched (1000, supabase/config.toml), so each batch is also paged. Second,
  // the ids ride in the URL: one `.in()` past ~215 uuids answers 414 locally,
  // and past ~395 production fails as "fetch failed" after ~7 s of retries.
  // The old batch of 500 exceeded both. fetchAllRowsByIds sends 100 per
  // request. A batch error is NOT swallowed — unlike a decorative lookup, this
  // set decides catalog membership, so a failed batch must fail the whole read
  // rather than quietly rendering an incomplete (or empty) catalog.
  let items: Array<Record<string, unknown>>;
  try {
    items = await fetchAllRowsByIds<Record<string, unknown>>(
      ids,
      (batch) => (from, to) =>
        admin
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
          .is('deleted_at', null)
          // Ordering visibility (0413): an item hidden from new ordering is
          // not in any customer's catalog, so checkout (which re-validates
          // against this set) refuses it too. Showing it again adds nothing
          // to an allowlist: the allowlist above still decides membership.
          .eq('order_catalog_visible', true)
          .order('id')
          .range(from, to),
    );
  } catch (err) {
    void reportError(new Error(rawErrorText(err)), { tag: 'portal.catalog.items' });
    throw new ServiceError('validation_error', 'Catalog could not be loaded. Please try again.');
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

/** A portal line above the one line ceiling (10,000 units of one item). */
const PORTAL_LINE_TOO_LARGE_COPY = 'A line can have at most 10,000 units.';

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
  // A cart the schema refuses is the customer's to fix: its first issue's
  // words, as a refusal (the action answers a ServiceError's words and the
  // fixed sentence for anything else, S31).
  const result = submitSchema.safeParse(input);
  if (!result.success) {
    throw new ServiceError(
      'validation_error',
      result.error.issues[0]?.message ?? 'Order could not be submitted. Please try again.',
    );
  }
  const parsed = result.data;
  const catalog = await portalCatalog(ctx);
  const byId = new Map(catalog.map((c) => [c.itemId, c]));
  for (const line of parsed.lines) {
    if (!byId.has(line.itemId)) {
      throw new ServiceError(
        'validation_error',
        'One of the items is no longer available to order.',
      );
    }
  }

  // One line per item: a cart that names an item twice is summed into one
  // line, the same collapse internal and public orders apply. Two lines for
  // one item used to reach the pick slip as two rows.
  const qtyByItem = new Map<string, number>();
  for (const l of parsed.lines) {
    qtyByItem.set(l.itemId, (qtyByItem.get(l.itemId) ?? 0) + l.quantity);
  }
  // In item-id order: the lock order of every gated writer of new demand
  // (0413: the ordering-visibility gate takes each item's key-share lock as
  // its line is inserted, and a hide locks the same rows in id order), so a
  // multi-line submit never deadlocks with a bulk hide.
  const mergedLines = Array.from(qtyByItem.entries())
    .map(([itemId, quantity]) => ({ itemId, quantity }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  // One ceiling for a line on every path that adds demand (0413, integrator
  // D2): placement's per-item cap, after the per-item sum. The database
  // refuses the same line (order_lines_invalid), mapped below.
  if (mergedLines.some((l) => l.quantity > ORDER_MAX_UNITS_PER_LINE)) {
    throw new ServiceError('validation_error', PORTAL_LINE_TOO_LARGE_COPY);
  }

  const admin = createAdminClient();

  // Resolve item cost + warehouse for every line (org-scoped). The order header
  // needs ONE warehouse and the approve pipeline rejects mixed-warehouse lines
  // (item_warehouse_mismatch), so a cart spanning warehouses is refused up
  // front with a clear message rather than creating an un-approvable order.
  const itemIds = mergedLines.map((l) => l.itemId);
  const { data: itemRows, error: itemErr } = await admin
    .from('inventory_items')
    .select('id, name, warehouse_id, unit_cost, is_bundle')
    .eq('organization_id', ctx.organizationId)
    // in-list-bound: a portal order has at most 100 lines (submitSchema)
    .in('id', itemIds);
  // The warehouse and unit cost below are decided from this read; an error
  // used to read as "no warehouse" and cost 0.
  if (itemErr) {
    void reportError(new Error(itemErr.message), { tag: 'portal.submit.items' });
    throw new ServiceError('validation_error', 'Order could not be submitted. Please try again.');
  }
  type ItemMeta = {
    id: string;
    name: string | null;
    warehouse_id: string | null;
    unit_cost: number | null;
    is_bundle: boolean | null;
  };
  const itemMeta = new Map(((itemRows ?? []) as ItemMeta[]).map((r) => [r.id, r]));
  // A kit's pre-assembled stock (is_bundle) is built and handed out through
  // Bundles; picking draws placed stock and assembled kits sit in Staging, so
  // an order line on one could never be picked. The New order page's service
  // refuses it (OrderRequestsService.create/addLines); this path inserts its
  // lines with the service-role client, and the database line guard does not
  // refuse kit stock yet (next migration), so it refuses here, before the
  // header is written. An allowlist can name such an item; nothing else stops it.
  for (const id of itemIds) {
    const row = itemMeta.get(id);
    if (row?.is_bundle === true) {
      throw new ServiceError(
        'validation_error',
        `${row.name?.trim() || 'One of the items'} is a pre-assembled kit and can't be put on an order. Order the kit's items instead.`,
      );
    }
  }
  const warehouses = new Set<string>();
  for (const id of itemIds) {
    const wh = itemMeta.get(id)?.warehouse_id;
    if (wh) warehouses.add(wh);
  }
  if (warehouses.size === 0)
    throw new ServiceError('validation_error', 'Could not resolve a warehouse for this order.');
  if (warehouses.size > 1) {
    throw new ServiceError(
      'validation_error',
      'These items ship from different warehouses — please place a separate order per warehouse.',
    );
  }
  const warehouseId = [...warehouses][0]!;

  // Accounting split: unit_cost_at_request = the item's COST (consistent with
  // internal/public orders + the Sage/QBO return-valuation readers);
  // unit_price_at_request = the customer's SELL price (portal history reads it).
  //
  // A line with no agreed price stamps NULL, never 0. The column is nullable, and
  // the two cases are genuinely different: 0 means "agreed, costs nothing", NULL
  // means "no price yet — to be quoted". That is every line in a no_charge org,
  // and the quotable ones in a priced org. Writing 0 for both would tell anyone
  // reading the history later that a to-be-quoted line had been settled at free.
  const linePayload = mergedLines.map((l) => ({
    item_id: l.itemId,
    quantity_requested: l.quantity,
    unit_cost_at_request: Number(itemMeta.get(l.itemId)?.unit_cost) || 0,
    unit_price_at_request: byId.get(l.itemId)?.unitPrice ?? null,
  }));

  // The header and its lines in ONE transaction (0413 review fix round). They
  // used to be two calls with a compensating delete; a hide that won the race
  // refused the lines after the header's notify trigger had already written a
  // "New order request" notification, and a failed delete left the header.
  // Now any refusal rolls all of it back, so there is nothing to clean up.
  const { data: header, error: writeErr } = await admin.rpc('insert_order_request_with_lines', {
    p_header: {
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
    },
    p_lines: linePayload,
  });
  const headerId = (header as { id?: unknown } | null)?.id;
  if (writeErr || typeof headerId !== 'string') {
    // The ordering-visibility gate (0413): an item hidden after the catalog
    // read above. The customer hears what the pre-check says, never why.
    if ((writeErr as { hint?: string | null } | null)?.hint === 'order_item_hidden') {
      throw new ServiceError(
        'validation_error',
        'One of the items is no longer available to order.',
      );
    }
    if ((writeErr as { hint?: string | null } | null)?.hint === 'order_lines_invalid') {
      throw new ServiceError('validation_error', PORTAL_LINE_TOO_LARGE_COPY);
    }
    void reportError(new Error(writeErr?.message ?? 'order write answered no row'), {
      tag: 'portal.submit.write',
    });
    throw new ServiceError('validation_error', 'Order could not be submitted. Please try again.');
  }

  // Feed the org's integration/audit surfaces like any other new order.
  void dispatchEvent(ctx.organizationId, 'order.created', {
    id: headerId,
    orderNumber: headerId.slice(0, 8).toUpperCase(),
    source: 'portal',
    customerId: ctx.customerId,
  });

  return { id: headerId };
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

  // The customer's own return requests on these orders: SAFE projection only
  // (status, date, and the requester's tracking; the id keys React rows).
  // Never approver/denial/staff data. source='requester' only: staff-created
  // internal returns (including denied/cancelled ones) are org-internal
  // workflow and must never surface on the customer's portal card. Returns
  // RX-3: one batched return_overview read for the page (trackingRowsForOrders),
  // which fails closed to "no requests shown".
  const orderIds = rows.map((r) => r.id as string);
  const returnsByOrder = new Map<string, PortalOrder['returns']>();
  for (const row of await trackingRowsForOrders(admin, ctx.organizationId, orderIds)) {
    const list = returnsByOrder.get(row.orderId) ?? [];
    list.push({
      id: row.returnId,
      status: row.tracking.returnStatus,
      created_at: row.tracking.createdAt,
      returnNumber: row.tracking.returnNumber,
      exchangeStatus: row.tracking.exchangeStatus,
      sentences: row.tracking.sentences,
      replacementOrderNumber: row.tracking.replacementOrderNumber,
      lines: row.tracking.lines,
    });
    returnsByOrder.set(row.orderId, list);
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
      ((r.lines as Array<Record<string, unknown>>) ?? []).map((l) => l.id as string),
    );
    pendingByLine = await pendingReturnQuantitiesByLine(admin, ctx.organizationId, allLineIds);
  } catch (err) {
    void reportError(new Error(rawErrorText(err)), {
      tag: 'portal.orders.pending_returns',
      level: 'warning',
    });
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
