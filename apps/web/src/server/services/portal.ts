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
import { ModulesUnavailableError } from '@/lib/modules/module-state';
import { ServiceError } from '@/server/services/context';
import { dispatchEvent } from '@/server/services/integration-events';
import { fetchAllRowsByIds, rawErrorText } from '@/server/services/lib/fetch-by-ids';
import { isOrderBusyError } from '@/server/services/lib/order-busy';
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

/**
 * Resolve the signed-in user's portal context, or null when they are not a
 * portal user. First successful resolution stamps accepted_at. A user invited
 * to several customers gets the most recently invited one (switcher = later).
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
  // lets the redirect out: the page awaits this outside any try, and the
  // portal actions' catch throws control flow again before it answers
  // anything (the action-step-up, page-step-up and action-catch guards hold
  // that they ask this first and never keep the redirect).
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
  //
  // A module state that could not be read is not "off". supabase-js resolves
  // a failed read as `{ data: null, error }`, the shape of "no enabled row",
  // and "not a portal user" is not what happened: the same reasoning as the
  // unreadable account status above, so this throws too
  // (ModulesUnavailableError). The portal page reaches its error state with
  // Try again; a portal action answers the try-again sentence as its result
  // (server/actions/portal.ts portalContextFor). It opens nothing: no context
  // is built on a read that failed.
  const [{ data: moduleRow, error: moduleError }, { data: org }] = await Promise.all([
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
  if (moduleError) {
    // The code only: a message can quote request details.
    console.error('[portal] module state unreadable:', moduleError.code || 'unknown');
    throw new ModulesUnavailableError();
  }
  if (!moduleRow) return null;
  if (
    !planAllowsB2bPortal(((org as OrgBillingState | null) ?? { plan: null }) as OrgBillingState)
  ) {
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

/** A Place order with no submission key, or one that is not a key. */
export const PORTAL_ORDER_KEY_COPY = 'Order could not be submitted. Reload the page and try again.';
/**
 * The key is already held by another submission: another cart, or this
 * account's order under another customer of the organization. It names no
 * order and does not guess which of the two it was.
 */
export const PORTAL_ORDER_CONFLICT_COPY =
  "This order can't be placed as it was sent. Reload the page and check your orders before placing it again.";
/**
 * The keyed write's answer was lost or was not an answer (a dropped
 * connection, a timeout, a 5xx, a lock still held by an earlier send): the
 * order may have been placed. The same cart under the same key finishes it.
 * The portal shop shows the same words.
 */
export const PORTAL_ORDER_UNCONFIRMED_COPY =
  "We couldn't confirm your order went through. Press Place order again to finish it. It won't be placed twice.";
/**
 * The keyed write answered a database error code this service does not
 * recognise. Still unknown (the cart stays as sent, and Place order sends it
 * again under the same key), but a press may not settle it, so the customer
 * is sent to their orders rather than promised a finish.
 */
export const PORTAL_ORDER_UNRECOGNISED_COPY =
  "We couldn't confirm this order. Reload the page and check your orders before placing it again.";
/** The generic sentence for a read that failed before anything was written. */
const PORTAL_ORDER_FAILED_COPY = 'Order could not be submitted. Please try again.';

/**
 * What a Place order refusal means for the cart, in the refusal's details
 * (`outcome`), which the action passes to the portal shop:
 *   - 'refused': definite. Nothing was placed and this cart, as sent, will not
 *     be: the schema, the line ceiling, an item no longer orderable, kit
 *     stock, the warehouses, a key conflict, a missing key, or the account's
 *     portal access. The shop frees the cart so it can be changed.
 *   - 'unknown': the keyed write may have committed. The shop keeps the cart
 *     as sent, read-only, and the key, and Place order sends it again.
 *   - none: a read failed before anything was written (the key, the catalog,
 *     the items). Nothing was placed by this call; the shop changes nothing
 *     else, so an earlier unknown stays unknown.
 */
function refused(code: ServiceError['code'], message: string): ServiceError {
  return new ServiceError(code, message, { outcome: 'refused' });
}

const submitSchema = z.object({
  lines: z
    .array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1).max(100000) }))
    .min(1)
    .max(100),
  notes: z.string().max(2000).optional(),
  // One key per cart submission, minted by the portal shop on the first press
  // and sent again with the same cart on every retry: the database places one
  // order per key (portal_order_submission_status, place_portal_order_request).
  idempotencyKey: z
    .string({ required_error: PORTAL_ORDER_KEY_COPY, invalid_type_error: PORTAL_ORDER_KEY_COPY })
    .uuid(PORTAL_ORDER_KEY_COPY),
});
export type PortalSubmitInput = z.infer<typeof submitSchema>;

/** What a key read or the keyed write answered, read defensively. */
function placedOrderOf(data: unknown): { id: string; replay: boolean } | null {
  const d = data as { outcome?: unknown; replay?: unknown; order_id?: unknown } | null;
  if (d?.outcome !== 'placed' || typeof d.order_id !== 'string') return null;
  return { id: d.order_id, replay: d.replay === true };
}

type RpcFailure = { message?: string | null; code?: string | null; hint?: string | null };

/**
 * A refusal the database RAISED with its own hint: the call's transaction
 * rolled back whole, so nothing was placed by it. Null for any other error.
 * The conflict names no order: a key that answers another cart or another
 * customer is refused, never resolved to that order.
 */
function definiteRefusal(error: RpcFailure, tag: string): ServiceError | null {
  switch (error.hint) {
    case 'order_item_hidden':
      // The ordering-visibility gate (0413): an item hidden after the catalog
      // read. The customer hears what the pre-check says, never why.
      return refused('validation_error', 'One of the items is no longer available to order.');
    case 'order_lines_invalid':
      return refused('validation_error', PORTAL_LINE_TOO_LARGE_COPY);
    case 'idempotency_conflict':
      return refused('conflict', PORTAL_ORDER_CONFLICT_COPY);
    case 'idempotency_key_required':
    case 'idempotency_key_invalid':
      return refused('validation_error', PORTAL_ORDER_KEY_COPY);
    case 'order_request_invalid':
      // A header or lines the service built wrong: a fault here, reported,
      // but refused before anything was written.
      void reportError(new Error(error.message ?? 'order_request_invalid'), { tag });
      return refused('validation_error', PORTAL_ORDER_FAILED_COPY);
    default:
      return null;
  }
}

/**
 * The key READ failed. It writes nothing, so nothing was placed by this call:
 * a raised refusal is definite; anything else is a read to try again, with
 * no outcome (an earlier unknown send stays unknown).
 */
function portalKeyReadError(error: RpcFailure): ServiceError {
  const definite = definiteRefusal(error, 'portal.submit.key');
  if (definite) return definite;
  void reportError(new Error(error.message ?? 'key read failed'), { tag: 'portal.submit.key' });
  return new ServiceError('validation_error', PORTAL_ORDER_FAILED_COPY);
}

/**
 * The keyed WRITE did not answer an order. A refusal the database raised is
 * definite. Everything else may have committed before the answer was lost,
 * and is answered as unknown, never as "nothing placed":
 *   - no SQLSTATE at all (the fetch to the database failed or was cut off);
 *   - a connection error (08xxx), a server or gateway error (PGRST*, 5xx,
 *     XX000);
 *   - 55P03 (the key's lock is held: an earlier send of this key is still
 *     being placed), 57014 (a timeout), 40P01 (a deadlock): reported as busy,
 *     not as faults;
 *   - an answer that names no order.
 * The same cart under the same key settles these: the first order, or one
 * order. A database code this map does not name is unknown too, but a press
 * may answer it again, so its words send the customer to their orders
 * (PORTAL_ORDER_UNRECOGNISED_COPY) instead of promising a finish.
 */
function portalWriteError(error: RpcFailure): ServiceError {
  const definite = definiteRefusal(error, 'portal.submit.write');
  if (definite) return definite;
  if (!isOrderBusyError(error)) {
    void reportError(new Error(error.message ?? 'order write answered no order'), {
      tag: 'portal.submit.write',
    });
  }
  return unknownWriteOutcome(
    isUnrecognisedSqlState(error.code)
      ? PORTAL_ORDER_UNRECOGNISED_COPY
      : PORTAL_ORDER_UNCONFIRMED_COPY,
  );
}

/**
 * A database error code (a 5-character SQLSTATE) this service has no class
 * for: not a connection error (08xxx), the key's lock (55P03), a timeout
 * (57014), a deadlock (40P01) or an internal error (XX000), and not one of
 * the raised refusals mapped above. No code (a lost answer) and PostgREST's
 * own codes (PGRST...) are not database codes, and keep the finish sentence.
 */
function isUnrecognisedSqlState(code: string | null | undefined): boolean {
  const c = (code ?? '').toUpperCase();
  if (!/^[0-9A-Z]{5}$/.test(c)) return false;
  if (c.startsWith('08')) return false;
  return !['55P03', '57014', '40P01', 'XX000'].includes(c);
}

/** The answer for a keyed write that may have committed (see portalWriteError). */
function unknownWriteOutcome(message: string = PORTAL_ORDER_UNCONFIRMED_COPY): ServiceError {
  return new ServiceError('conflict', message, {
    outcome: 'unknown',
    retryable: true,
  });
}

/**
 * Checkout: validates every line against the catalog set above — the
 * customer's own allowlist, org-scoped and orderable — then
 * creates ONE normal order_requests row (source 'portal', pending_approval —
 * the same approval pipeline internal requests use; decided default) with the
 * customer's prices recorded per line. Returns the order id.
 *
 * ONE ORDER PER KEY. The input carries the cart's submission key. Before
 * anything that changes over time (the catalog, the items), the key is read:
 * a key that already placed this cart answers that order (`replay: true`)
 * and nothing else runs, so a resend after a lost answer never orders twice,
 * even when the catalog changed in between. The write itself
 * (place_portal_order_request) reads the key again under its lock, so two
 * sends that cross are decided once. The organization, the customer and the
 * requester come from the context, never from the input, and the key is
 * scoped to them in the database: another customer's key never finds this
 * order.
 */
export async function portalSubmitOrder(
  ctx: PortalContext,
  input: PortalSubmitInput,
): Promise<{ id: string; replay: boolean }> {
  // A cart the schema refuses is the customer's to fix: its first issue's
  // words, as a refusal (the action answers a ServiceError's words and the
  // fixed sentence for anything else, S31).
  const result = submitSchema.safeParse(input);
  if (!result.success) {
    throw refused(
      'validation_error',
      result.error.issues[0]?.message ?? 'Order could not be submitted. Please try again.',
    );
  }
  const parsed = result.data;

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
    throw refused('validation_error', PORTAL_LINE_TOO_LARGE_COPY);
  }

  const admin = createAdminClient();

  // ── The key first, before anything that changes over time ──────────────
  // The cart as the database hashes it: the context's organization, customer
  // and requester, the notes and the summed lines. The keyed write below
  // sends the same values, so a placed key answers here.
  const { data: seen, error: seenErr } = await admin.rpc('portal_order_submission_status', {
    p_header: {
      organization_id: ctx.organizationId,
      customer_id: ctx.customerId,
      requester_user_id: ctx.userId,
      source: 'portal',
      notes: parsed.notes ?? null,
    },
    p_lines: mergedLines.map((l) => ({ item_id: l.itemId, quantity_requested: l.quantity })),
    p_key: parsed.idempotencyKey,
  });
  if (seenErr) throw portalKeyReadError(seenErr);
  const replayed = placedOrderOf(seen);
  if (replayed) return { id: replayed.id, replay: true };
  if ((seen as { outcome?: unknown } | null)?.outcome !== 'none') {
    throw portalKeyReadError({ message: 'key read answered an unknown outcome' });
  }

  const catalog = await portalCatalog(ctx);
  const byId = new Map(catalog.map((c) => [c.itemId, c]));
  for (const line of parsed.lines) {
    if (!byId.has(line.itemId)) {
      throw refused('validation_error', 'One of the items is no longer available to order.');
    }
  }

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
      throw refused(
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
    throw refused('validation_error', 'Could not resolve a warehouse for this order.');
  if (warehouses.size > 1) {
    throw refused(
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

  // The header and its lines in ONE transaction (0413 review fix round), and
  // the key's placed row with them. They used to be two calls with a
  // compensating delete; a hide that won the race refused the lines after the
  // header's notify trigger had already written a "New order request"
  // notification, and a failed delete left the header. Now any refusal rolls
  // all of it back, so there is nothing to clean up.
  //
  // A call that throws instead of answering (the client gave up on the
  // connection) may have committed too: it is answered as unknown, like an
  // error with no SQLSTATE.
  const write = admin.rpc('place_portal_order_request', {
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
    p_key: parsed.idempotencyKey,
  });
  let answer: Awaited<typeof write>;
  try {
    answer = await write;
  } catch (e) {
    void reportError(e, { tag: 'portal.submit.write' });
    throw unknownWriteOutcome();
  }
  const { data: placedData, error: writeErr } = answer;
  if (writeErr) throw portalWriteError(writeErr);
  const placed = placedOrderOf(placedData);
  if (!placed) throw portalWriteError({ message: 'order write answered no order' });
  // Another send of this key placed it while this one waited for the key's
  // lock: the same order, already announced by that send.
  if (placed.replay) return placed;

  // Feed the org's integration/audit surfaces like any other new order.
  void dispatchEvent(ctx.organizationId, 'order.created', {
    id: placed.id,
    orderNumber: placed.id.slice(0, 8).toUpperCase(),
    source: 'portal',
    customerId: ctx.customerId,
  });

  return placed;
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
 *
 * A state that could not be read is not "off": it throws
 * (ModulesUnavailableError), and the portal page reaches its error state with
 * Try again instead of leaving the button out as if returns were switched off.
 */
export async function portalReturnsEnabled(ctx: PortalContext): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'returns')
    .eq('enabled', true)
    .maybeSingle();
  if (error) {
    // The code only: a message can quote request details.
    console.error('[portal] returns module state unreadable:', error.code || 'unknown');
    throw new ModulesUnavailableError();
  }
  return Boolean(data);
}
