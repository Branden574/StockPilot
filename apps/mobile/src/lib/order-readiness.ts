/**
 * ORDER READINESS ON THE PHONE (F2-1, migration 0377): the one caller of
 * `order_readiness_facts` on the device, and the decisions the order screen
 * makes from its answer.
 *
 * FACTS IN SQL, JUDGEMENT IN CORE. The phone reads the facts with a direct
 * `supabase.rpc` (phone-to-Supabase calls do not pass through the Vercel
 * entry that stalls, speed-regression note 2026-09-22) and judges them with
 * the SAME core functions the web server runs (`parseOrderReadinessFacts`,
 * `assessOrderReadiness`). The two can never disagree about an order, and the
 * words come from core readiness-copy, so they read the same on both.
 *
 * A FAILED READ IS NEVER AN ANSWER. An error, a rejected request, an answer
 * the parser refuses or an answer about another order resolves
 * `{ state: 'failed' }`, which the screen shows as "Couldn't check readiness"
 * and which disables Approve partial and Resume with the reason. Never an
 * empty panel, never green, never zeros. Nothing here throws.
 *
 * REPLACES lib/order-stock-check.ts (deleted): the phone's own on-hand and
 * reservation reads and its copy of the stock flags. The flags now come from
 * core `readinessStockFlags` (the frozen RPCs' own arithmetic, proven against
 * both old copies in core order-stock-gates.test.ts) and the gates from core
 * `orderStockGates`, the same function the web page uses.
 *
 * OFFLINE: the last view the screen loaded is kept in memory for the app
 * session ("You're offline. This is how the order looked at 2:14 PM."), and
 * every action needs a connection. No SQLite table, no outbox kind, no
 * SCHEMA_VERSION change: readiness is derived on read, never stored.
 *
 * Pure: no React Native import, no Supabase client (the screen passes
 * `supabase`). Do not import ./supabase here; it pulls in expo-secure-store and
 * would put this module out of reach of the node test environment.
 */

import {
  assessOrderReadiness,
  can,
  isManagerOrAbove,
  orderReadinessPhase,
  parseOrderReadinessFacts,
  readinessAudience,
  readinessStockFlags,
  type OrderReadinessResult,
  type OrderStockCheck,
  type Permission,
  type ReadinessAudience,
  type Role,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY } from './connection-copy';

// ── The read ────────────────────────────────────────────────────────────────

/** The slice of the Supabase client the facts read uses. */
export interface ReadinessRpcClient {
  rpc(fn: string, args?: Record<string, unknown>): unknown;
}

/** One RPC answer, as supabase-js resolves it (it does not reject on errors). */
interface RpcResponse {
  data: unknown;
  error: { message?: string | null; code?: string | null; hint?: string | null } | null;
  status?: number | null;
}

/** An order id is a uuid; anything else is not an order (and never reaches
 *  the database as a 22P02). The web service refuses it the same way. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const READINESS_ORDER_NOT_FOUND_COPY = 'Order not found.';
export const READINESS_FORBIDDEN_COPY = 'You are not allowed to check readiness for this order.';
export const READINESS_MODULE_OFF_COPY = 'Orders are turned off for this organization.';
export const READINESS_UNREADABLE_COPY = 'The readiness answer could not be read.';
/** The order screen's header and lines were read a moment apart from the
 *  facts; if the order moved in between, the two would describe different
 *  orders. */
export const READINESS_ORDER_CHANGED_COPY =
  'The order changed while it was being checked. Check again.';
/** A manager's Approve partial and Resume need the check, and it was not made. */
export const READINESS_NOT_CHECKED_COPY = 'Stock was not checked for this order.';

/**
 * The sentence for a refused or failed facts read: the function's own
 * refusals (0377 body gates), and the phone's one sentence for no answer at
 * all (connection-copy.ts). The raw error text is never the sentence.
 */
export function readinessFailureMessage(
  error: RpcResponse['error'],
  status?: number | null,
): string {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (code === 'P0002' || message === 'order_request_not_found')
    return READINESS_ORDER_NOT_FOUND_COPY;
  if (code === '42501') return READINESS_FORBIDDEN_COPY;
  if (error?.hint === 'module_disabled' || message === 'module_disabled')
    return READINESS_MODULE_OFF_COPY;
  // No status (or 0) and no SQLSTATE: the request never got an answer.
  if (!code && !status) return CONNECTION_FAILURE_COPY;
  return "Couldn't check readiness.";
}

function failed(message: string, detail: string): OrderReadinessResult {
  // Not silent: the screen shows "Couldn't check readiness", and the reason
  // goes to the device log for a walk or a crash report.
  console.warn('[order-readiness] readiness could not be checked', detail);
  return { state: 'failed', message };
}

/**
 * One order's readiness: the facts read, parsed and assessed on the device.
 * The order id only; the organization is the order's own, decided inside the
 * function. NEVER THROWS: every failure is `{ state: 'failed' }`.
 */
export async function readOrderReadiness(
  client: ReadinessRpcClient,
  orderId: string,
  now: () => Date = () => new Date(),
): Promise<OrderReadinessResult> {
  if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
    return failed(READINESS_ORDER_NOT_FOUND_COPY, `not an order id: ${String(orderId)}`);
  }
  let res: RpcResponse | null | undefined;
  try {
    res = (await (client.rpc('order_readiness_facts', {
      p_order_id: orderId,
    }) as PromiseLike<RpcResponse>)) as RpcResponse | null | undefined;
  } catch (e) {
    return failed(CONNECTION_FAILURE_COPY, e instanceof Error ? e.message : String(e));
  }
  if (!res) return failed(CONNECTION_FAILURE_COPY, 'no response');
  if (res.error) {
    return failed(
      readinessFailureMessage(res.error, res.status),
      `${res.error.code ?? 'no code'}: ${res.error.message ?? 'no message'}`,
    );
  }
  let facts;
  try {
    facts = parseOrderReadinessFacts(res.data);
  } catch (e) {
    return failed(READINESS_UNREADABLE_COPY, e instanceof Error ? e.message : String(e));
  }
  if (facts.order.id !== orderId) {
    return failed(READINESS_UNREADABLE_COPY, `answered for order ${facts.order.id}`);
  }
  return { state: 'ok', assessment: assessOrderReadiness(facts, { now: now() }) };
}

// ── The organization's time zone (for "Checked at" and PO dates) ────────────

/** The slice of the Supabase client the zone read uses. */
export interface OrgZoneClient {
  from(table: string): unknown;
}

interface OrgZoneChain {
  select(columns: string): OrgZoneChain;
  eq(column: string, value: string): OrgZoneChain;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * `organizations.timezone` (an RLS member read), so "Checked at" and a PO's
 * expected date name the same clock and day on the phone as on the web page.
 * Null when unset or unreadable: core then uses its documented default zone.
 * Never throws.
 */
export async function readOrgTimeZone(
  client: OrgZoneClient,
  orgId: string,
): Promise<string | null> {
  try {
    const res = await (client.from('organizations') as OrgZoneChain)
      .select('timezone')
      .eq('id', orgId)
      .maybeSingle();
    if (!res || res.error) return null;
    const tz = (res.data as { timezone?: unknown } | null)?.timezone;
    return typeof tz === 'string' && tz !== '' ? tz : null;
  } catch {
    return null;
  }
}

// ── Who reads, and who sees ─────────────────────────────────────────────────

/** The three permissions that give the full readiness panel. */
export interface ReadinessPermissions {
  canApproveOrders: boolean;
  canUpdateItems: boolean;
  canManagePurchaseOrders: boolean;
}

/**
 * The viewer's readiness permissions: orders:approve, items:update and
 * purchase_orders:manage. `permissions` is the effective set (overrides
 * applied); while it loads, core `can` falls back to the role's static
 * defaults. An unknown or missing role holds none (the server decides the
 * rest). Three booleans rather than the set itself, so a screen can depend on
 * them: they change only when an override changes what the viewer sees.
 */
export function readinessPermissionsFor(
  role: Role | string | null | undefined,
  permissions: ReadonlySet<Permission> | undefined,
): ReadinessPermissions {
  const r = typeof role === 'string' && role !== '' ? (role as Role) : null;
  const has = (p: Permission): boolean => {
    if (!r) return false;
    try {
      return can({ role: r, permissions }, p);
    } catch {
      return false;
    }
  };
  return {
    canApproveOrders: has('orders:approve'),
    canUpdateItems: has('items:update'),
    canManagePurchaseOrders: has('purchase_orders:manage'),
  };
}

/**
 * Who sees readiness: core `readinessAudience`, the web page's rule. The full
 * panel for anyone who approves orders, picks (items:update) or buys
 * (purchase_orders:manage); one sentence for the requester; nothing for
 * everyone else. An order placed on someone's behalf has no requester id, so
 * nobody is its requester (a null never equals a null).
 */
export function orderReadinessAudience(
  perms: ReadinessPermissions,
  viewerUserId: string | null | undefined,
  requesterUserId: string | null | undefined,
): ReadinessAudience {
  return readinessAudience({
    ...perms,
    isOwnRequest: !!requesterUserId && !!viewerUserId && requesterUserId === viewerUserId,
  });
}

/**
 * Whether the screen reads the facts at all: only at a to_pick status, and
 * only for someone who sees them, or for a manager, whose Approve partial and
 * Resume are gated on them (a manager approves by role, 0348, even with
 * orders:approve revoked). Everyone else: no read. A role this build does not
 * know is not a manager.
 */
export function shouldReadReadiness(input: {
  status: string | null | undefined;
  audience: ReadinessAudience;
  role: Role | string | null | undefined;
}): boolean {
  if (orderReadinessPhase(input.status) !== 'to_pick') return false;
  if (input.audience !== 'none') return true;
  if (typeof input.role !== 'string' || input.role === '') return false;
  try {
    return isManagerOrAbove(input.role as Role);
  } catch {
    return false;
  }
}

/**
 * The facts are read alongside the order's own header and lines, a moment
 * apart. If the order moved in between (another status, a line added or
 * removed), the answer describes a different order than the screen shows: it
 * is `failed`, never a mix of the two.
 */
export function reconcileReadiness(
  result: OrderReadinessResult,
  shown: { status: string; lineIds: readonly (string | null)[] },
): OrderReadinessResult {
  if (result.state === 'failed') return result;
  const a = result.assessment;
  if (a.order.status !== shown.status) {
    return failed(READINESS_ORDER_CHANGED_COPY, `status ${a.order.status}, screen ${shown.status}`);
  }
  if (a.phase === 'closed' || a.linesCapped) return result;
  const theirs = new Set(a.lines.map((l) => l.lineId));
  const ours = new Set(shown.lineIds.filter((x): x is string => typeof x === 'string'));
  const same = theirs.size === ours.size && [...ours].every((id) => theirs.has(id));
  if (!same) {
    return failed(READINESS_ORDER_CHANGED_COPY, `${theirs.size} lines checked, ${ours.size} shown`);
  }
  return result;
}

/**
 * The check behind Approve partial and Resume (core `orderStockGates`), from
 * readiness. Not a stock-dependent status: not needed. Readiness not read:
 * FAILED, never "not needed" or zeros (a manager would otherwise be offered
 * nothing, or the wrong thing, from a read that did not happen).
 */
export function orderStockCheckFor(
  status: string | null | undefined,
  readiness: OrderReadinessResult | null,
): OrderStockCheck {
  if (status !== 'pending_approval' && status !== 'backordered') return { state: 'not_needed' };
  if (!readiness) return { state: 'failed', reason: 'read', message: READINESS_NOT_CHECKED_COPY };
  return readinessStockFlags(readiness);
}

// ── Offline: the last view, in memory for this app session ──────────────────

export interface RememberedOrderView<T> {
  view: T;
  /** When the phone received it (ISO). */
  receivedAt: string;
}

/** How many orders are kept (the newest). */
export const REMEMBERED_ORDER_VIEWS_MAX = 20;

const rememberedOrders = new Map<string, RememberedOrderView<unknown>>();

function orderKey(userId: string, orgId: string, orderId: string): string {
  return `${userId}\u0000${orgId}\u0000${orderId}`;
}

/**
 * Keep the last view this account loaded of this order, in this workspace.
 * Memory only: gone when the app restarts, never written to the device.
 */
export function rememberOrderView<T>(
  userId: string | null | undefined,
  orgId: string | null | undefined,
  orderId: string | null | undefined,
  view: T,
  receivedAt: Date = new Date(),
): void {
  if (!userId || !orgId || !orderId) return;
  const key = orderKey(userId, orgId, orderId);
  // Re-inserted so the Map's order is oldest first.
  rememberedOrders.delete(key);
  rememberedOrders.set(key, { view, receivedAt: receivedAt.toISOString() });
  while (rememberedOrders.size > REMEMBERED_ORDER_VIEWS_MAX) {
    const oldest = rememberedOrders.keys().next().value;
    if (oldest === undefined) break;
    rememberedOrders.delete(oldest);
  }
}

export function recalledOrderView<T>(
  userId: string | null | undefined,
  orgId: string | null | undefined,
  orderId: string | null | undefined,
): RememberedOrderView<T> | null {
  if (!userId || !orgId || !orderId) return null;
  return (rememberedOrders.get(orderKey(userId, orgId, orderId)) as RememberedOrderView<T>) ?? null;
}

/** Test seam: forget every remembered order. */
export function forgetRememberedOrderViews(): void {
  rememberedOrders.clear();
}

/** Offline, with nothing loaded this session: say so, never "Order not found." */
export const ORDER_OFFLINE_NOTHING_LOADED_COPY =
  "You're offline. This order needs a connection to load. Reconnect and try again.";

/**
 * The time the offline banner names: when readiness was checked (the
 * database's clock, the same time "Checked at" shows), else when the phone
 * received the order.
 */
export function orderViewAsOf(readiness: OrderReadinessResult | null, receivedAt: string): string {
  return readiness?.state === 'ok' ? readiness.assessment.observedAt : receivedAt;
}
