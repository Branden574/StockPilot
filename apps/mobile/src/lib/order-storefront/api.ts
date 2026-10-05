import {
  ORDER_MFA_REQUIRED_COPY,
  ORDER_MODULE_DISABLED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PHONE_AAL2_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  ORDER_PHONE_UNAVAILABLE_COPY,
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_STOREFRONT_SIGN_IN_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
  type AisleSummary,
  type CharterAddress,
  type KitComponent,
  type KitOffer,
  type KitsResult,
  type OrderCallResult,
  type OrderCatalogAnswer,
  type OrderCatalogItem,
  type OrderCatalogPhotosAnswer,
  type OrderCatalogSite,
  type OrderCreateRequestInput,
  type OrderRecentRequester,
  type OrderRecentRequestersPart,
  type OrderStorefrontAnswer,
  type OrderStorefrontDeliveryRecipients,
  type OrderStorefrontViewer,
  type Role,
} from '@stockpilot/core';

/**
 * THE PHONE STOREFRONT'S SIX CALLS (phone ordering PO-4, plan 3.1): the three
 * reads PO-3 added (storefront, catalog, photos) and the three submission
 * calls PO-2 added (place, status, withdraw).
 *
 * Every call names the organization it is FOR (`orgId`, the X-Organization-Id
 * header) and the account that may send it (`asUserId`): api() refuses to
 * send under any other session, so a workspace switch or a sign-out between
 * building a request and sending it can never send it as someone else
 * (api.ts asUserId). The create call also passes `onSend`, the moment the
 * request is handed to fetch.
 *
 * Answers are read here, never trusted: a read answer whose shape is not the
 * documented one throws (OrderStorefrontShapeError), and one that names
 * another organization throws OrderAnswerForAnotherOrganization (the Rentals
 * rule: an answer for a workspace the phone has left is dropped). The three
 * submission calls never throw: they hand back core's OrderCallResult, which
 * core classifies (orderCallResultForOrganization drops an answer for
 * another organization before it can settle a key).
 *
 * Pure apart from the injected `call` (api() in the app), so vitest drives it.
 */

/** The api() options this module uses. */
export interface OrderApiOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  orgId: string;
  asUserId: string;
  onSend?: () => void;
  timeoutMs?: number;
}

export type OrderApiCall = (path: string, opts: OrderApiOptions) => Promise<unknown>;

/** Whose call this is. */
export interface OrderCallScope {
  orgId: string;
  userId: string;
}

export class OrderStorefrontShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderStorefrontShapeError';
  }
}

/** An answer for another organization than the one the call was for. */
export class OrderAnswerForAnotherOrganization extends Error {
  constructor() {
    super('The answer was for another organization.');
    this.name = 'OrderAnswerForAnotherOrganization';
  }
}

// ── Reading the answers ─────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, where: string): string {
  if (typeof v !== 'string' || v === '') throw new OrderStorefrontShapeError(`${where} is missing`);
  return v;
}

function textOrNull(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new OrderStorefrontShapeError(`${where} is not text`);
  return v;
}

function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new OrderStorefrontShapeError(`${where} is not a number`);
  }
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new OrderStorefrontShapeError(`${where} is not true or false`);
  return v;
}

const ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'manager', 'staff', 'viewer']);

function parseViewer(raw: unknown): OrderStorefrontViewer {
  if (!isRecord(raw)) throw new OrderStorefrontShapeError('viewer is not an object');
  const role = text(raw.role, 'viewer.role');
  if (!ROLES.has(role)) throw new OrderStorefrontShapeError('viewer.role is not a role');
  return {
    userId: text(raw.userId, 'viewer.userId'),
    role: role as Role,
    name: textOrNull(raw.name, 'viewer.name'),
    email: textOrNull(raw.email, 'viewer.email'),
    canOrderOnBehalf: bool(raw.canOrderOnBehalf, 'viewer.canOrderOnBehalf'),
    canApproveOrders: bool(raw.canApproveOrders, 'viewer.canApproveOrders'),
  };
}

/** The routing as the server resolved it, or null (the email action hides).
 *  A part this build cannot read hides the action too: fail closed. */
function parseRecipients(raw: unknown): OrderStorefrontDeliveryRecipients | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.to !== 'string' || typeof raw.cc !== 'string') return null;
  if (raw.to.trim() === '' || raw.cc.trim() === '') return null;
  const name = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return { to: raw.to, cc: raw.cc, toName: name(raw.toName), ccName: name(raw.ccName) };
}

function parseRequester(raw: unknown): OrderRecentRequester | null {
  if (!isRecord(raw) || typeof raw.email !== 'string' || raw.email.trim() === '') return null;
  const method = raw.lastFulfillment;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : null,
    email: raw.email,
    lastOrderedAt: typeof raw.lastOrderedAt === 'string' ? raw.lastOrderedAt : '',
    orders: typeof raw.orders === 'number' && Number.isFinite(raw.orders) ? raw.orders : 0,
    lastFulfillment: method === 'pickup' || method === 'delivery' ? method : null,
    lastSiteId: typeof raw.lastSiteId === 'string' ? raw.lastSiteId : null,
  };
}

/** null stays null (the caller cannot order on behalf). A list this build
 *  cannot read is a failed part, never "nobody". */
function parseRequesters(raw: unknown): OrderRecentRequestersPart {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || raw.status !== 'ok' || !Array.isArray(raw.people)) return { status: 'error' };
  return {
    status: 'ok',
    people: raw.people.flatMap((p) => {
      const r = parseRequester(p);
      return r ? [r] : [];
    }),
  };
}

/** GET /api/v1/orders/storefront's answer. Extra keys are ignored. */
export function parseStorefrontAnswer(raw: unknown): OrderStorefrontAnswer {
  if (!isRecord(raw)) throw new OrderStorefrontShapeError('the answer is not an object');
  const organizationId = text(raw.organizationId, 'organizationId');
  const serverNow = text(raw.serverNow, 'serverNow');
  if (raw.enabled === false) {
    return {
      organizationId,
      enabled: false,
      message: typeof raw.message === 'string' && raw.message !== '' ? raw.message : ORDER_PHONE_TURNED_OFF_COPY,
      serverNow,
    };
  }
  if (raw.enabled !== true) throw new OrderStorefrontShapeError('enabled is not true or false');
  if (!Array.isArray(raw.warehouses)) throw new OrderStorefrontShapeError('warehouses is not a list');
  return {
    organizationId,
    enabled: true,
    serverNow,
    warehouses: raw.warehouses.map((w, i) => {
      if (!isRecord(w)) throw new OrderStorefrontShapeError(`warehouses[${i}] is not an object`);
      return { id: text(w.id, `warehouses[${i}].id`), name: text(w.name, `warehouses[${i}].name`) };
    }),
    viewer: parseViewer(raw.viewer),
    kitsEnabled: raw.kitsEnabled === true,
    orgTimezone: typeof raw.orgTimezone === 'string' && raw.orgTimezone !== '' ? raw.orgTimezone : null,
    deliveryRecipients: parseRecipients(raw.deliveryRecipients),
    recentRequesters: parseRequesters(raw.recentRequesters),
  };
}

function parseItem(raw: unknown, i: number): OrderCatalogItem {
  if (!isRecord(raw)) throw new OrderStorefrontShapeError(`items[${i}] is not an object`);
  const at = `items[${i}]`;
  return {
    id: text(raw.id, `${at}.id`),
    sku: typeof raw.sku === 'string' ? raw.sku : '',
    name: text(raw.name, `${at}.name`),
    categoryId: textOrNull(raw.categoryId, `${at}.categoryId`),
    charterId: textOrNull(raw.charterId, `${at}.charterId`),
    rackLabel: textOrNull(raw.rackLabel, `${at}.rackLabel`),
    quantityOnHand: num(raw.quantityOnHand, `${at}.quantityOnHand`),
    reservedQuantity: num(raw.reservedQuantity, `${at}.reservedQuantity`),
    reorderPoint: num(raw.reorderPoint, `${at}.reorderPoint`),
  };
}

function parseAisle(raw: unknown, i: number): AisleSummary {
  if (!isRecord(raw)) throw new OrderStorefrontShapeError(`aisles[${i}] is not an object`);
  return {
    id: textOrNull(raw.id, `aisles[${i}].id`),
    name: text(raw.name, `aisles[${i}].name`),
    itemCount: num(raw.itemCount, `aisles[${i}].itemCount`),
  };
}

function parseAddress(raw: unknown): CharterAddress | null {
  if (!isRecord(raw)) return null;
  const out: CharterAddress = {};
  for (const k of ['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const) {
    const v = raw[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function parseSites(raw: unknown): OrderCatalogAnswer['sites'] {
  if (!isRecord(raw) || raw.status !== 'ok' || !Array.isArray(raw.sites)) return { status: 'error' };
  const sites: OrderCatalogSite[] = [];
  for (const s of raw.sites) {
    if (!isRecord(s) || typeof s.id !== 'string' || typeof s.name !== 'string') return { status: 'error' };
    sites.push({
      id: s.id,
      name: s.name,
      code: typeof s.code === 'string' && s.code !== '' ? s.code : null,
      address: parseAddress(s.address),
    });
  }
  return { status: 'ok', sites };
}

function parseKitComponent(raw: unknown): KitComponent | null {
  if (!isRecord(raw) || typeof raw.anchorItemId !== 'string' || !Array.isArray(raw.itemIds)) return null;
  const itemIds = raw.itemIds.filter((id): id is string => typeof id === 'string' && id !== '');
  const perKit = raw.perKit;
  if (itemIds.length === 0 || typeof perKit !== 'number' || !Number.isInteger(perKit) || perKit < 1) {
    return null;
  }
  return { anchorItemId: raw.anchorItemId, itemIds, perKit };
}

function parseKits(raw: unknown): KitsResult {
  if (!isRecord(raw) || raw.status !== 'ok' || !Array.isArray(raw.kits)) return { status: 'error' };
  const kits: KitOffer[] = [];
  for (const k of raw.kits) {
    if (!isRecord(k) || typeof k.bundleId !== 'string' || typeof k.name !== 'string') return { status: 'error' };
    if (!Array.isArray(k.components) || k.components.length === 0) return { status: 'error' };
    const components: KitComponent[] = [];
    for (const c of k.components) {
      const parsed = parseKitComponent(c);
      if (!parsed) return { status: 'error' };
      components.push(parsed);
    }
    kits.push({ bundleId: k.bundleId, name: k.name, sku: typeof k.sku === 'string' ? k.sku : null, components });
  }
  return { status: 'ok', kits };
}

function parseFrequent(raw: unknown): OrderCatalogAnswer['frequentlyOrdered'] {
  if (!isRecord(raw) || raw.status !== 'ok' || !Array.isArray(raw.items)) return { status: 'error' };
  const items: { itemId: string; orders: number }[] = [];
  for (const it of raw.items) {
    if (!isRecord(it) || typeof it.itemId !== 'string' || typeof it.orders !== 'number') {
      return { status: 'error' };
    }
    items.push({ itemId: it.itemId, orders: it.orders });
  }
  return { status: 'ok', items };
}

/** GET /api/v1/orders/catalog's answer. The catalog itself must read whole
 *  (a row this build cannot read throws: hiding it would be a silent cap,
 *  pattern #7); an optional part it cannot read is a failed part. */
export function parseCatalogAnswer(raw: unknown): OrderCatalogAnswer {
  if (!isRecord(raw)) throw new OrderStorefrontShapeError('the answer is not an object');
  if (!Array.isArray(raw.items)) throw new OrderStorefrontShapeError('items is not a list');
  const charters: OrderCatalogAnswer['charters'] = {};
  if (isRecord(raw.charters)) {
    for (const [id, c] of Object.entries(raw.charters)) {
      if (isRecord(c) && typeof c.name === 'string') {
        charters[id] = { name: c.name, code: typeof c.code === 'string' && c.code !== '' ? c.code : null };
      }
    }
  }
  return {
    organizationId: text(raw.organizationId, 'organizationId'),
    warehouseId: text(raw.warehouseId, 'warehouseId'),
    generatedAt: text(raw.generatedAt, 'generatedAt'),
    staleAfterSeconds: typeof raw.staleAfterSeconds === 'number' ? raw.staleAfterSeconds : 60,
    rowCeiling: typeof raw.rowCeiling === 'number' ? raw.rowCeiling : 10_000,
    truncated: raw.truncated === true,
    items: raw.items.map(parseItem),
    aisles: Array.isArray(raw.aisles) ? raw.aisles.map(parseAisle) : [],
    charters,
    sites: parseSites(raw.sites),
    kits: parseKits(raw.kits),
    frequentlyOrdered: parseFrequent(raw.frequentlyOrdered),
  };
}

/** GET /api/v1/orders/catalog/photos' answer. Only https URLs are kept. */
export function parsePhotosAnswer(raw: unknown): OrderCatalogPhotosAnswer {
  if (!isRecord(raw)) throw new OrderStorefrontShapeError('the answer is not an object');
  const photos: Record<string, string> = {};
  if (!isRecord(raw.photos)) throw new OrderStorefrontShapeError('photos is not an object');
  for (const [id, url] of Object.entries(raw.photos)) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) photos[id] = url;
  }
  return {
    organizationId: text(raw.organizationId, 'organizationId'),
    warehouseId: text(raw.warehouseId, 'warehouseId'),
    photos,
    signedAt: text(raw.signedAt, 'signedAt'),
    expiresAt: text(raw.expiresAt, 'expiresAt'),
  };
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ── What a failed read says ─────────────────────────────────────────────────

/** The parts of a thrown api() error this module reads (ApiError's shape). */
function errorShape(e: unknown): { status: number; code: string | null; reason: string | null; ours: boolean } | null {
  if (typeof e !== 'object' || e === null) return null;
  const { status, code, details } = e as { status?: unknown; code?: unknown; details?: unknown };
  if (typeof status !== 'number') return null;
  const reason = isRecord(details) && typeof details.reason === 'string' ? details.reason : null;
  const c = typeof code === 'string' && code !== '' ? code : null;
  return { status, code: c, reason, ours: c !== null || details !== undefined };
}

/** What kind of failure a storefront read was. */
export type StorefrontReadFailure =
  /** Nothing to show from the server: say why, offer nothing to submit. */
  | { kind: 'refused'; message: string }
  /** The kill switch: placing orders from the app is off. */
  | { kind: 'turned_off'; message: string }
  /** An old server with no such route (or the routes reverted). */
  | { kind: 'unavailable'; message: string }
  /** No answer, a fault, a rate limit: what was loaded before stays shown. */
  | { kind: 'failed'; message: string }
  /** An answer for another workspace: dropped, nothing said. */
  | { kind: 'other_organization' };

/**
 * A failed storefront, catalog or photo read, in core's words. Read from the
 * status and `details.reason` only, never the message text (pattern #28).
 */
export function storefrontReadFailure(e: unknown): StorefrontReadFailure {
  if (e instanceof OrderAnswerForAnotherOrganization) return { kind: 'other_organization' };
  const s = errorShape(e);
  if (!s) return { kind: 'failed', message: ORDER_STOREFRONT_LOAD_FAILED_COPY };
  if (s.status === 401) return { kind: 'refused', message: ORDER_STOREFRONT_SIGN_IN_COPY };
  if (s.status === 429) return { kind: 'failed', message: ORDER_STOREFRONT_RATE_LIMITED_COPY };
  if (s.reason === 'turned_off') return { kind: 'turned_off', message: ORDER_PHONE_TURNED_OFF_COPY };
  if (s.status === 404 && !s.ours) return { kind: 'unavailable', message: ORDER_PHONE_UNAVAILABLE_COPY };
  if (s.status === 404 && s.reason === 'warehouse_not_available') {
    return { kind: 'refused', message: ORDER_WAREHOUSE_NOT_AVAILABLE_COPY };
  }
  if (s.status === 403) {
    switch (s.reason) {
      case 'module_disabled':
        return { kind: 'refused', message: ORDER_MODULE_DISABLED_COPY };
      case 'aal2_required':
        return { kind: 'refused', message: ORDER_PHONE_AAL2_COPY };
      case 'mfa_required':
        return { kind: 'refused', message: ORDER_MFA_REQUIRED_COPY };
      case 'permission':
        return { kind: 'refused', message: ORDER_PERMISSION_COPY };
      default:
        return { kind: 'refused', message: ORDER_PERMISSION_COPY };
    }
  }
  return { kind: 'failed', message: ORDER_STOREFRONT_LOAD_FAILED_COPY };
}

// ── The calls ───────────────────────────────────────────────────────────────

export interface OrderStorefrontApi {
  storefront(scope: OrderCallScope): Promise<OrderStorefrontAnswer>;
  catalog(scope: OrderCallScope, warehouseId: string): Promise<OrderCatalogAnswer>;
  photos(scope: OrderCallScope, warehouseId: string): Promise<OrderCatalogPhotosAnswer>;
  /** POST /api/v1/orders. Never throws. */
  place(scope: OrderCallScope, body: OrderCreateRequestInput, onSend: () => void): Promise<OrderCallResult>;
  /** GET /api/v1/orders/submissions/{key}?placerUserId=. Never throws. */
  status(scope: OrderCallScope, key: string): Promise<OrderCallResult>;
  /** POST /api/v1/orders/submissions/{key}/withdraw { placerUserId }. Never throws. */
  withdraw(scope: OrderCallScope, key: string): Promise<OrderCallResult>;
}

async function asCallResult(run: () => Promise<unknown>): Promise<OrderCallResult> {
  try {
    return { ok: true, status: 200, body: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function createOrderStorefrontApi(call: OrderApiCall): OrderStorefrontApi {
  const scoped = (scope: OrderCallScope) => ({ orgId: scope.orgId, asUserId: scope.userId });
  return {
    async storefront(scope) {
      const answer = parseStorefrontAnswer(await call('/api/v1/orders/storefront', scoped(scope)));
      if (!sameId(answer.organizationId, scope.orgId)) throw new OrderAnswerForAnotherOrganization();
      return answer;
    },
    async catalog(scope, warehouseId) {
      const answer = parseCatalogAnswer(
        await call(`/api/v1/orders/catalog?warehouseId=${encodeURIComponent(warehouseId)}`, scoped(scope)),
      );
      if (!sameId(answer.organizationId, scope.orgId)) throw new OrderAnswerForAnotherOrganization();
      if (!sameId(answer.warehouseId, warehouseId)) throw new OrderStorefrontShapeError('another warehouse');
      return answer;
    },
    async photos(scope, warehouseId) {
      const answer = parsePhotosAnswer(
        await call(`/api/v1/orders/catalog/photos?warehouseId=${encodeURIComponent(warehouseId)}`, scoped(scope)),
      );
      if (!sameId(answer.organizationId, scope.orgId)) throw new OrderAnswerForAnotherOrganization();
      if (!sameId(answer.warehouseId, warehouseId)) throw new OrderStorefrontShapeError('another warehouse');
      return answer;
    },
    place(scope, body, onSend) {
      return asCallResult(() =>
        call('/api/v1/orders', { method: 'POST', body, ...scoped(scope), onSend }),
      );
    },
    status(scope, key) {
      return asCallResult(() =>
        call(
          `/api/v1/orders/submissions/${encodeURIComponent(key)}?placerUserId=${encodeURIComponent(scope.userId)}`,
          scoped(scope),
        ),
      );
    },
    withdraw(scope, key) {
      return asCallResult(() =>
        call(`/api/v1/orders/submissions/${encodeURIComponent(key)}/withdraw`, {
          method: 'POST',
          body: { placerUserId: scope.userId },
          ...scoped(scope),
        }),
      );
    },
  };
}
