import {
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_INTERNAL_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_PHONE_AAL2_COPY,
  isFinalOrderCatalogRefusal,
  orderCatalogManageQueryString,
  orderItemsRefusalCopy,
  type OrderCatalogFamilyAnswer,
  type OrderCatalogManageListAnswer,
  type OrderCatalogManageQuery,
  type OrderCatalogManageRow,
  type OrderCatalogRefusal,
  type OrderCatalogVisibilityWriteAnswer,
  type OrderCatalogVisibilityWriteBody,
} from '@stockpilot/core';

import { ORDER_ITEMS_PHONE_RATE_LIMITED_COPY, ORDER_ITEMS_PHONE_SIGN_IN_COPY } from './words';

/**
 * MANAGE ORDER ITEMS ON THE PHONE: THE THREE CALLS (ordering visibility,
 * 0413; design 4.3, 8.6). The same routes and service the web page uses:
 *
 *   GET  /api/v1/orders/catalog-visibility?q&visibility&type&warehouseId&categoryId&page
 *   GET  /api/v1/orders/catalog-visibility/family/[groupId]
 *   POST /api/v1/orders/catalog-visibility { itemIds, visible, operationId }
 *
 * THE RULES THIS MODULE KEEPS:
 *
 *   1. Every call names the organization it is FOR (X-Organization-Id) and
 *      the only account that may send it (api()'s asUserId): a workspace
 *      switch or a sign-out between building a request and sending it never
 *      sends it as anyone else (the api() rule, lib/api.ts).
 *   2. Answers are read field by field, never trusted or spread: a page with
 *      a row this build cannot read fails as a whole (never a silent gap), an
 *      answer for another organization is dropped, a picture is kept only
 *      when it is an http(s) URL, and no cost or stock figure is carried.
 *   3. A write's answer must account for exactly the ids sent, for the same
 *      operation and the same state; anything else is not claimed as saved.
 *   4. A failure is read from the status and details.reason only, never from
 *      the message (pattern #28), and said in core's words.
 *
 * Pure apart from the injected `call` (api() in the app), so vitest drives it.
 */

export const ORDER_CATALOG_MANAGE_PATH = '/api/v1/orders/catalog-visibility';

/** The api() options this module uses. */
export interface ManageApiOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  orgId: string;
  asUserId: string;
  signal?: AbortSignal;
}

export type ManageApiCall = (path: string, opts: ManageApiOptions) => Promise<unknown>;

/** Whose call this is. */
export interface ManageCallScope {
  orgId: string;
  userId: string;
}

export class ManageShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManageShapeError';
  }
}

/** An answer for another organization than the one the call was for. */
export class ManageAnswerForAnotherOrganization extends Error {
  constructor() {
    super('The answer was for another organization.');
    this.name = 'ManageAnswerForAnotherOrganization';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** One page of the list, in core's query words (only what differs from the
 *  defaults, so the first page is the bare path). */
export function manageListPath(query: OrderCatalogManageQuery): string {
  const qs = orderCatalogManageQueryString(query);
  return qs === '' ? ORDER_CATALOG_MANAGE_PATH : `${ORDER_CATALOG_MANAGE_PATH}?${qs}`;
}

/** One family's records, or null for anything that is not a uuid (never asked). */
export function manageFamilyPath(groupId: string): string | null {
  const id = (groupId ?? '').trim();
  if (!UUID_RE.test(id)) return null;
  return `${ORDER_CATALOG_MANAGE_PATH}/family/${id.toLowerCase()}`;
}

// ── Reading the answers ─────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, where: string): string {
  if (typeof v !== 'string' || v === '') throw new ManageShapeError(`${where} is missing`);
  return v;
}

function textOrNull(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new ManageShapeError(`${where} is not text`);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new ManageShapeError(`${where} is not true or false`);
  return v;
}

function wholeNumber(v: unknown, where: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ManageShapeError(`${where} is not a whole number`);
  }
  return v;
}

function uuid(v: unknown, where: string): string {
  const s = text(v, where);
  if (!UUID_RE.test(s)) throw new ManageShapeError(`${where} is not an id`);
  return s;
}

/** An http(s) picture or none: a URL of any other scheme is never handed to
 *  the image view. */
function pictureOrNull(v: unknown): string | null {
  return typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null;
}

function parseRow(raw: unknown, where: string): OrderCatalogManageRow {
  if (!isRecord(raw)) throw new ManageShapeError(`${where} is not an object`);
  const itemType = raw.itemType;
  if (itemType !== 'item' && itemType !== 'book') throw new ManageShapeError(`${where}.itemType is unknown`);
  const familyId = textOrNull(raw.familyId, `${where}.familyId`);
  return {
    id: uuid(raw.id, `${where}.id`),
    name: typeof raw.name === 'string' ? raw.name : '',
    sku: typeof raw.sku === 'string' ? raw.sku : '',
    identifier: textOrNull(raw.identifier, `${where}.identifier`),
    itemType,
    sizeOrEdition: textOrNull(raw.sizeOrEdition, `${where}.sizeOrEdition`),
    warehouseId: text(raw.warehouseId, `${where}.warehouseId`),
    warehouseName: textOrNull(raw.warehouseName, `${where}.warehouseName`),
    categoryName: textOrNull(raw.categoryName, `${where}.categoryName`),
    // A family id this build cannot use offers no "Select family".
    familyId: familyId !== null && UUID_RE.test(familyId) ? familyId : null,
    familyName: textOrNull(raw.familyName, `${where}.familyName`),
    expected: bool(raw.expected, `${where}.expected`),
    visible: bool(raw.visible, `${where}.visible`),
    hiddenSince: textOrNull(raw.hiddenSince, `${where}.hiddenSince`),
    thumbUrl: pictureOrNull(raw.thumbUrl),
  };
}

function parseRows(raw: unknown): OrderCatalogManageRow[] {
  if (!Array.isArray(raw)) throw new ManageShapeError('rows is not a list');
  return raw.map((r, i) => parseRow(r, `rows[${i}]`));
}

/** GET /api/v1/orders/catalog-visibility's answer. */
export function parseManageListAnswer(raw: unknown): OrderCatalogManageListAnswer {
  if (!isRecord(raw)) throw new ManageShapeError('the answer is not an object');
  if (!isRecord(raw.viewer) || raw.viewer.canManage !== true) {
    throw new ManageShapeError('viewer.canManage is not true');
  }
  return {
    organizationId: text(raw.organizationId, 'organizationId'),
    viewer: { canManage: true },
    page: wholeNumber(raw.page, 'page', 1),
    pageSize: wholeNumber(raw.pageSize, 'pageSize', 1),
    total: wholeNumber(raw.total, 'total', 0),
    rows: parseRows(raw.rows),
  };
}

/** GET /api/v1/orders/catalog-visibility/family/[groupId]'s answer. */
export function parseFamilyAnswer(raw: unknown): OrderCatalogFamilyAnswer {
  if (!isRecord(raw)) throw new ManageShapeError('the answer is not an object');
  return {
    organizationId: text(raw.organizationId, 'organizationId'),
    familyId: uuid(raw.familyId, 'familyId'),
    familyName: textOrNull(raw.familyName, 'familyName'),
    rows: parseRows(raw.rows),
    truncated: raw.truncated === true,
  };
}

function idList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) throw new ManageShapeError(`${where} is not a list`);
  return v.map((id, i) => uuid(id, `${where}[${i}]`).toLowerCase());
}

/** POST /api/v1/orders/catalog-visibility's answer, ids lower-cased. */
export function parseWriteAnswer(raw: unknown): OrderCatalogVisibilityWriteAnswer {
  if (!isRecord(raw)) throw new ManageShapeError('the answer is not an object');
  return {
    organizationId: text(raw.organizationId, 'organizationId'),
    operationId: uuid(raw.operationId, 'operationId').toLowerCase(),
    visible: bool(raw.visible, 'visible'),
    changed: idList(raw.changed, 'changed'),
    unchanged: idList(raw.unchanged, 'unchanged'),
  };
}

/** The write answer accounts for exactly the ids sent, once each. */
function accountsForExactly(answer: OrderCatalogVisibilityWriteAnswer, sent: readonly string[]): boolean {
  const want = new Set(sent.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  for (const id of [...answer.changed, ...answer.unchanged]) {
    if (!want.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return seen.size === want.size;
}

// ── The calls ───────────────────────────────────────────────────────────────

export interface OrderCatalogManageApi {
  /** One page. Throws on any failure (manageFailure says what it was). */
  list(scope: ManageCallScope, query: OrderCatalogManageQuery, signal?: AbortSignal): Promise<OrderCatalogManageListAnswer>;
  /** One family's records the caller can read. Throws on any failure. */
  family(scope: ManageCallScope, groupId: string, signal?: AbortSignal): Promise<OrderCatalogFamilyAnswer>;
  /** Show or Hide exactly `body.itemIds`, all or nothing. Throws on any
   *  failure, including an answer that does not account for the ids sent. */
  write(scope: ManageCallScope, body: OrderCatalogVisibilityWriteBody): Promise<OrderCatalogVisibilityWriteAnswer>;
}

export function createOrderCatalogManageApi(call: ManageApiCall): OrderCatalogManageApi {
  return {
    async list(scope, query, signal) {
      const answer = parseManageListAnswer(
        await call(manageListPath(query), { orgId: scope.orgId, asUserId: scope.userId, signal }),
      );
      if (!sameId(answer.organizationId, scope.orgId)) throw new ManageAnswerForAnotherOrganization();
      return answer;
    },
    async family(scope, groupId, signal) {
      const path = manageFamilyPath(groupId);
      if (path === null) throw new ManageShapeError('not a family id');
      const answer = parseFamilyAnswer(await call(path, { orgId: scope.orgId, asUserId: scope.userId, signal }));
      if (!sameId(answer.organizationId, scope.orgId)) throw new ManageAnswerForAnotherOrganization();
      if (!sameId(answer.familyId, groupId.trim())) throw new ManageShapeError('another family');
      return answer;
    },
    async write(scope, body) {
      const answer = parseWriteAnswer(
        await call(ORDER_CATALOG_MANAGE_PATH, { method: 'POST', body, orgId: scope.orgId, asUserId: scope.userId }),
      );
      if (!sameId(answer.organizationId, scope.orgId)) throw new ManageAnswerForAnotherOrganization();
      if (!sameId(answer.operationId, body.operationId) || answer.visible !== body.visible) {
        throw new ManageShapeError('another operation');
      }
      if (!accountsForExactly(answer, body.itemIds)) throw new ManageShapeError('the ids do not match');
      return answer;
    },
  };
}

// ── What a failure means ────────────────────────────────────────────────────

export type ManageFailureReason =
  | OrderCatalogRefusal
  | 'unauthenticated'
  | 'rate_limited'
  | 'no_answer'
  | 'other_organization';

export interface ManageFailure {
  reason: ManageFailureReason;
  /** Locks the screen: every control off, the list kept readable, the
   *  capability read again (design 3.7). No repeated failed clicks. */
  final: boolean;
  /** What to say ('' for a dropped answer, which says nothing). */
  message: string;
  /** items_unavailable: the ids to deselect (only ids the caller sent). */
  itemIds: string[];
  /** The SAME body, with the same operationId, may be sent again: if the
   *  first one did land, the retry answers every id as unchanged. */
  retrySame: boolean;
}

const KNOWN_REFUSALS: ReadonlySet<string> = new Set([
  'forbidden',
  'feature_disabled',
  'module_disabled',
  'mfa_required',
  'aal2_required',
  'items_unavailable',
  'invalid',
  'busy',
]);

/** The parts of a thrown api() error read here (ApiError's shape). */
function errorShape(e: unknown): { status: number; reason: string | null; details: Record<string, unknown> | null; ours: boolean } | null {
  if (typeof e !== 'object' || e === null) return null;
  const { status, code, details } = e as { status?: unknown; code?: unknown; details?: unknown };
  if (typeof status !== 'number') return null;
  const d = isRecord(details) ? details : null;
  const reason = d && typeof d.reason === 'string' ? d.reason : null;
  return { status, reason, details: d, ours: (typeof code === 'string' && code !== '') || details !== undefined };
}

function refusal(reason: OrderCatalogRefusal, itemIds: string[] = []): ManageFailure {
  return {
    reason,
    final: isFinalOrderCatalogRefusal(reason),
    // The phone has no in-place step-up: it says how to get a verified
    // session (the storefront's words).
    message: reason === 'aal2_required' ? ORDER_PHONE_AAL2_COPY : orderItemsRefusalCopy(reason),
    itemIds,
    retrySame: reason === 'busy' || reason === 'aal2_required',
  };
}

function fault(kind: 'read' | 'write', reason: 'internal' | 'no_answer'): ManageFailure {
  return {
    reason,
    final: false,
    // A write with no readable answer is never claimed either way.
    message: kind === 'read' ? ORDER_ITEMS_LOAD_FAILED_COPY : ORDER_ITEMS_INTERNAL_COPY,
    itemIds: [],
    retrySame: reason === 'no_answer',
  };
}

/** A failed list, family or write call, in core's words. */
export function manageFailure(e: unknown, kind: 'read' | 'write'): ManageFailure {
  if (e instanceof ManageAnswerForAnotherOrganization || (e instanceof Error && e.name === 'OutboxSessionChangedError')) {
    return { reason: 'other_organization', final: false, message: '', itemIds: [], retrySame: false };
  }
  if (e instanceof ManageShapeError) return fault(kind, 'internal');
  const s = errorShape(e);
  if (!s) return fault(kind, 'no_answer');
  if (s.status === 401) {
    return { reason: 'unauthenticated', final: false, message: ORDER_ITEMS_PHONE_SIGN_IN_COPY, itemIds: [], retrySame: false };
  }
  if (s.status === 429) {
    return { reason: 'rate_limited', final: false, message: ORDER_ITEMS_PHONE_RATE_LIMITED_COPY, itemIds: [], retrySame: true };
  }
  // A server with no such route (a web rollback): the feature is not there.
  if (s.status === 404 && !s.ours) {
    return { ...refusal('feature_disabled'), message: ORDER_ITEMS_FEATURE_DISABLED_COPY };
  }
  if (s.reason && KNOWN_REFUSALS.has(s.reason)) {
    const reason = s.reason as OrderCatalogRefusal;
    if (reason === 'items_unavailable') {
      const raw = Array.isArray(s.details?.itemIds) ? (s.details.itemIds as unknown[]) : [];
      const ids = raw.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase());
      return refusal('items_unavailable', [...new Set(ids)]);
    }
    return refusal(reason);
  }
  if (s.status === 403) return refusal('forbidden');
  if (s.status === 400) return refusal('invalid');
  return fault(kind, 'internal');
}
