// ORDERING VISIBILITY (owner brief 2026-10-26, migration 0413): which items and
// books appear in Place an Order, and who may choose. The names, bounds, words
// and the God Admin access preview that the web server, the web pages, the
// platform console and the phone share. Pure: types, literals and functions.
//
// ═══ IMPORTING THIS MODULE RUNS NOTHING ═══
//
// Core's index re-exports this file and Metro does not tree-shake, so the
// phone evaluates its top level at start-up: declarations and literals only.
//
// ═══ THE WORDS RULES ═══
//
// "Ordering visibility", "Shown in Orders", "Hidden from Orders": never
// "available" for this state (that word is stock), never "public" (that is
// public_visibility, a different control). No uuid, no snake_case token, never
// "book" for a quantity, no emojis.

import {
  effectivePermissions,
  type Permission,
  type PermissionOverride,
} from '../constants/permissions';
import type { Role } from '../constants/roles';
import { isManagerOrAbove } from '../constants/terminology';

// ── Names the database and every surface share ─────────────────────────────

/** The capability (platform-managed: only StockPilot support sets a member's
 *  exception). */
export const ORDER_CATALOG_VISIBILITY_PERMISSION = 'orders:manage_catalog_visibility' satisfies Permission;

/** inventory_items: true = shown in Orders (the default), false = hidden from
 *  new ordering. Every requester surface composes its own eligibility rules
 *  AND this column. */
export const ORDER_CATALOG_VISIBLE_COLUMN = 'order_catalog_visible' as const;
/** inventory_items: when the visibility last changed (null until the first
 *  change; stamped by the database). */
export const ORDER_CATALOG_VISIBILITY_CHANGED_AT_COLUMN = 'order_catalog_visibility_changed_at' as const;
/** organizations: when a hide last changed at least one record (null until
 *  the first hide); carried by get_request_context(). */
export const ORDER_CATALOG_LAST_HIDE_AT_COLUMN = 'order_catalog_last_hide_at' as const;

/** set_order_catalog_visibility takes 1 to this many distinct ids. */
export const ORDER_CATALOG_VISIBILITY_MAX_ITEMS = 500;
/** Manage order items lists 25 records a page (the established list size). */
export const ORDER_CATALOG_MANAGE_PAGE_SIZE = 25;
/** The family disclosure lists at most this many records. */
export const ORDER_CATALOG_FAMILY_MAX = 200;
/** The highest page number a query may ask for (a bound, not a promise). */
export const ORDER_CATALOG_MANAGE_MAX_PAGE = 100_000;
/** Search text beyond this many characters is cut. */
export const ORDER_CATALOG_MANAGE_MAX_QUERY = 200;

/** Where a visibility change was made (audit metadata.surface). */
export type OrderCatalogVisibilitySurface = 'web' | 'app';

export const ORDER_CATALOG_VISIBILITY_FILTERS = ['all', 'shown', 'hidden'] as const;
export type OrderCatalogVisibilityFilter = (typeof ORDER_CATALOG_VISIBILITY_FILTERS)[number];
export const ORDER_CATALOG_TYPE_FILTERS = ['all', 'items', 'books'] as const;
export type OrderCatalogTypeFilter = (typeof ORDER_CATALOG_TYPE_FILTERS)[number];

// ── The management list query ──────────────────────────────────────────────

export interface OrderCatalogManageQuery {
  /** Name, SKU, barcode or ISBN; '' for none. */
  q: string;
  visibility: OrderCatalogVisibilityFilter;
  type: OrderCatalogTypeFilter;
  /** One of the caller's warehouses, or null for all of them. */
  warehouseId: string | null;
  categoryId: string | null;
  /** 1-based. */
  page: number;
}

type QueryInput =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | null | undefined>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstValue(input: QueryInput, key: string): string | null {
  if (input instanceof URLSearchParams) return input.get(key);
  const v = input[key];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function uuidOrNull(value: string | null): string | null {
  const v = value?.trim() ?? '';
  return UUID_RE.test(v) ? v.toLowerCase() : null;
}

/**
 * The page's URL, the API route's query string and the phone's request all
 * use this one reading. Anything malformed falls back to its default, never
 * to an error and never to a wider value.
 */
export function parseOrderCatalogManageQuery(input: QueryInput): OrderCatalogManageQuery {
  const q = (firstValue(input, 'q') ?? '').trim().slice(0, ORDER_CATALOG_MANAGE_MAX_QUERY);
  const rawPage = Number.parseInt(firstValue(input, 'page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, ORDER_CATALOG_MANAGE_MAX_PAGE) : 1;
  return {
    q,
    visibility: oneOf(firstValue(input, 'visibility'), ORDER_CATALOG_VISIBILITY_FILTERS, 'all'),
    type: oneOf(firstValue(input, 'type'), ORDER_CATALOG_TYPE_FILTERS, 'all'),
    warehouseId: uuidOrNull(firstValue(input, 'warehouseId')),
    categoryId: uuidOrNull(firstValue(input, 'categoryId')),
    page,
  };
}

/** The query string for `filters`, with only the fields that differ from the
 *  defaults (so the plain page has a plain URL). No leading '?'. */
export function orderCatalogManageQueryString(filters: OrderCatalogManageQuery): string {
  const p = new URLSearchParams();
  if (filters.q.trim() !== '') p.set('q', filters.q.trim());
  if (filters.visibility !== 'all') p.set('visibility', filters.visibility);
  if (filters.type !== 'all') p.set('type', filters.type);
  if (filters.warehouseId) p.set('warehouseId', filters.warehouseId);
  if (filters.categoryId) p.set('categoryId', filters.categoryId);
  if (filters.page > 1) p.set('page', String(filters.page));
  return p.toString();
}

// ── Refusals of a management call ──────────────────────────────────────────

/**
 * Why a list or Show/Hide call was refused, as the web action and the phone
 * route report it in `details.reason`:
 *   forbidden          no capability (never had it, denied, or removed). Final.
 *   feature_disabled   Manage order items is not switched on for this
 *                      organization yet (ORDER_ITEMS_MANAGE_ORGS). Final.
 *   module_disabled    the Orders module is off. Final.
 *   mfa_required       the organization requires MFA and none is enrolled.
 *   aal2_required      step up, then send the SAME operationId again.
 *   items_unavailable  some ids are missing, foreign, out of read scope or
 *                      not manageable; nothing was changed.
 *   invalid            the request itself was malformed (1 to 500 ids).
 *   busy               another change holds the rows; nothing was changed;
 *                      retry with the same operationId.
 *   internal           anything else; nothing is claimed.
 */
export const ORDER_CATALOG_REFUSALS = [
  'forbidden',
  'feature_disabled',
  'module_disabled',
  'mfa_required',
  'aal2_required',
  'items_unavailable',
  'invalid',
  'busy',
  'internal',
] as const;
export type OrderCatalogRefusal = (typeof ORDER_CATALOG_REFUSALS)[number];

/** A final refusal locks the management screen (no repeated failed clicks);
 *  the screen refreshes its capability instead. */
export function isFinalOrderCatalogRefusal(reason: OrderCatalogRefusal): boolean {
  return reason === 'forbidden' || reason === 'feature_disabled' || reason === 'module_disabled';
}

// ── The management words ───────────────────────────────────────────────────

export const ORDER_ITEMS_MANAGE_BUTTON_COPY = 'Manage order items';
export const ORDER_ITEMS_MANAGE_SUBLINE_COPY =
  'Choose which items and books appear in Place an Order. Hidden items stay in Inventory, existing orders and reports.';
export const ORDER_ITEMS_KITS_NOTE_COPY =
  'Kits appear in Place an Order only while every part can be ordered. If an item has other shown records with the same SKU, a kit can still use them.';
export const ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY = 'Search name, SKU, barcode or ISBN';

export const ORDER_ITEMS_STATE_SHOWN_COPY = 'Shown in Orders';
export const ORDER_ITEMS_STATE_HIDDEN_COPY = 'Hidden from Orders';
/** Not received yet: orderable on its first receipt, so it may be pre-hidden. */
export const ORDER_ITEMS_STATE_EXPECTED_COPY = 'Expected';

export const ORDER_ITEMS_VISIBILITY_FILTER_LABELS: Readonly<Record<OrderCatalogVisibilityFilter, string>> = {
  all: 'All',
  shown: ORDER_ITEMS_STATE_SHOWN_COPY,
  hidden: ORDER_ITEMS_STATE_HIDDEN_COPY,
};
export const ORDER_ITEMS_TYPE_FILTER_LABELS: Readonly<Record<OrderCatalogTypeFilter, string>> = {
  all: 'All types',
  items: 'Items',
  books: 'Books',
};

export const ORDER_ITEMS_HIDE_ACTION_COPY = 'Hide from Orders';
export const ORDER_ITEMS_SHOW_ACTION_COPY = 'Show in Orders';
export const ORDER_ITEMS_HIDE_SELECTED_COPY = 'Hide selected';
export const ORDER_ITEMS_SHOW_SELECTED_COPY = 'Show selected';
export const ORDER_ITEMS_REVIEW_SELECTION_COPY = 'Review selection';
export const ORDER_ITEMS_CLEAR_SELECTION_COPY = 'Clear';
export const ORDER_ITEMS_SELECT_FAMILY_COPY = 'Select family';
export const ORDER_ITEMS_SELECTION_CAP_COPY = `Select up to ${ORDER_CATALOG_VISIBILITY_MAX_ITEMS} items at a time.`;

/** The per-row control's accessible name: the action for THIS record. The
 *  visible label is ORDER_ITEMS_HIDE_ACTION_COPY or ..._SHOW_... (web) or
 *  "Hide" / "Show" (phone). */
export function orderItemsRowActionLabel(currentlyVisible: boolean, name: string): string {
  const n = name.trim();
  if (n === '') return currentlyVisible ? ORDER_ITEMS_HIDE_ACTION_COPY : ORDER_ITEMS_SHOW_ACTION_COPY;
  return currentlyVisible ? `Hide ${n} from Orders` : `Show ${n} in Orders`;
}

const itemsCount = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'item' : 'items'}`;

/** "12 selected". */
export function orderItemsSelectedCopy(count: number): string {
  return `${count.toLocaleString('en-US')} selected`;
}

/** "Hidden since Oct 26, 2026" (the caller formats the date in the
 *  organization's zone). */
export function orderItemsHiddenSinceCopy(dateLabel: string): string {
  return `Hidden since ${dateLabel}`;
}

/** "Hide 12 items from Orders?" */
export function orderItemsHideConfirmTitle(count: number): string {
  return `Hide ${itemsCount(count)} from Orders?`;
}
/** The owner's sentence, verbatim. */
export const ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY =
  'These items will no longer be available for new orders. Existing orders and inventory will remain unchanged.';

/** "Show 3 items in Orders?" */
export function orderItemsShowConfirmTitle(count: number): string {
  return `Show ${itemsCount(count)} in Orders?`;
}
export const ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY =
  "They return only where they were already allowed; this does not make them public or change anyone's access.";

/** The saved state: exactly what this call changed, never "all updated".
 *  "Hidden 12 items. 3 were already hidden." */
export function orderItemsSavedCopy(input: { visible: boolean; changed: number; unchanged: number }): string {
  const verb = input.visible ? 'Shown' : 'Hidden';
  const state = input.visible ? 'shown' : 'hidden';
  if (input.changed === 0) {
    return input.unchanged === 1
      ? `That item was already ${state}.`
      : `All ${input.unchanged.toLocaleString('en-US')} items were already ${state}.`;
  }
  const head = `${verb} ${itemsCount(input.changed)}.`;
  if (input.unchanged === 0) return head;
  return `${head} ${input.unchanged.toLocaleString('en-US')} ${input.unchanged === 1 ? 'was' : 'were'} already ${state}.`;
}

export const ORDER_ITEMS_LOAD_FAILED_COPY = "Couldn't load items. Try again.";

/** The empty list, said for the filter that emptied it. */
export function orderItemsEmptyCopy(input: { visibility: OrderCatalogVisibilityFilter; hasQuery: boolean }): string {
  if (input.hasQuery) return 'No items match your search.';
  switch (input.visibility) {
    case 'shown':
      return 'No items are shown in Orders.';
    case 'hidden':
      return 'No items are hidden from Orders.';
    default:
      return 'No items or books can be managed here yet.';
  }
}

export const ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY =
  'Some selected items are no longer available to you. Nothing was changed.';
export const ORDER_ITEMS_BUSY_COPY = 'These items are being changed by someone else. Try again.';
/** The final locked state (an open screen after a revocation). */
export const ORDER_ITEMS_FORBIDDEN_COPY =
  'You no longer have access to manage order items. Ask StockPilot support if this is unexpected.';
/** The page for someone who never had the capability. */
export const ORDER_ITEMS_NO_ACCESS_COPY = "You don't have access to manage order items.";
export const ORDER_ITEMS_FEATURE_DISABLED_COPY =
  "Manage order items isn't turned on for your organization yet.";
export const ORDER_ITEMS_MODULE_DISABLED_COPY = 'Ordering is turned off for your organization.';
export const ORDER_ITEMS_INVALID_COPY = `That change couldn't be sent. Select between 1 and ${ORDER_CATALOG_VISIBILITY_MAX_ITEMS} items and try again.`;
export const ORDER_ITEMS_MFA_REQUIRED_COPY =
  'Your organization requires multi-factor authentication. Set it up before changing what appears in Orders.';
export const ORDER_ITEMS_AAL2_REQUIRED_COPY =
  'Confirm it is you with your authenticator, then the change is sent again.';
export const ORDER_ITEMS_INTERNAL_COPY =
  "That change couldn't be confirmed. Reload the list to see what is shown and hidden now.";
/** The phone's Confirm while offline: a change is never queued. */
export const ORDER_ITEMS_OFFLINE_COPY = "You're offline. Connect to show or hide items in Orders.";

/** The words for a refused management call. */
export function orderItemsRefusalCopy(reason: OrderCatalogRefusal): string {
  switch (reason) {
    case 'forbidden':
      return ORDER_ITEMS_FORBIDDEN_COPY;
    case 'feature_disabled':
      return ORDER_ITEMS_FEATURE_DISABLED_COPY;
    case 'module_disabled':
      return ORDER_ITEMS_MODULE_DISABLED_COPY;
    case 'mfa_required':
      return ORDER_ITEMS_MFA_REQUIRED_COPY;
    case 'aal2_required':
      return ORDER_ITEMS_AAL2_REQUIRED_COPY;
    case 'items_unavailable':
      return ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY;
    case 'invalid':
      return ORDER_ITEMS_INVALID_COPY;
    case 'busy':
      return ORDER_ITEMS_BUSY_COPY;
    default:
      return ORDER_ITEMS_INTERNAL_COPY;
  }
}

/** The Roles page note beside the locked key (org editors cannot change it). */
export const ORDER_ITEMS_ROLES_LOCK_NOTE_COPY =
  'Managed by StockPilot support. Managers, admins and owners have it by default.';

/** audit_logs item.order_visibility_changed, in activity lists. */
export const ORDER_VISIBILITY_AUDIT_LABEL = 'Ordering visibility changed';
/** platform_admin_audit permission_exception_changed, on the platform audit page. */
export const ORDER_ITEMS_ACCESS_AUDIT_LABEL = 'Order items access changed';

// ── The platform exception (God Admin) ─────────────────────────────────────

/**
 * One member's platform exception for a platform-managed key:
 *   default  no user_permission_overrides row (follow the role default)
 *   allow    granted = true
 *   deny     granted = false (holds for managers, admins and owners too)
 */
export const PERMISSION_EXCEPTION_STATES = ['default', 'allow', 'deny'] as const;
export type PermissionExceptionState = (typeof PERMISSION_EXCEPTION_STATES)[number];

export function permissionExceptionFromGranted(granted: boolean | null | undefined): PermissionExceptionState {
  if (granted === true) return 'allow';
  if (granted === false) return 'deny';
  return 'default';
}

/** The user override rows a state stands for, as effectivePermissions reads them. */
export function permissionExceptionOverrides(
  state: PermissionExceptionState,
  permission: Permission = ORDER_CATALOG_VISIBILITY_PERMISSION,
): PermissionOverride[] {
  if (state === 'default') return [];
  return [{ permission, granted: state === 'allow' }];
}

/**
 * Whether a member holds orders:request (role default, then the
 * organization's role row, then their own row). Only the phone ENTRY depends
 * on it: Place an Order needs it, Manage order items does not.
 */
export function memberCanRequestOrders(input: {
  role: Role;
  roleOverride?: boolean | null;
  userOverride?: boolean | null;
}): boolean {
  const row = (granted: boolean | null | undefined): PermissionOverride[] =>
    typeof granted === 'boolean' ? [{ permission: 'orders:request', granted }] : [];
  return effectivePermissions(input.role, row(input.roleOverride), row(input.userOverride)).has('orders:request');
}

export interface OrderCatalogAccessPreviewInput {
  role: Role;
  /** The exception as it is, or as the console is about to save it. */
  exception: PermissionExceptionState;
  /** user_profiles.disabled_at is set. */
  disabled: boolean;
  /** The organization's Orders module is on. */
  ordersModuleEnabled: boolean;
  /** The member's effective orders:request. */
  canRequestOrders: boolean;
}

export type OrderCatalogAccessSource = 'role_default' | 'allowed_by_stockpilot' | 'denied_by_stockpilot';
export type OrderCatalogAccessBlocker = 'account_disabled' | 'orders_module_off';

export interface OrderCatalogAccessPreview {
  /** What the role alone gives. */
  roleDefault: boolean;
  /** The capability after the exception (can_manage_order_catalog for an
   *  active member). */
  capability: boolean;
  /** Whether they can actually use Manage order items: the capability, an
   *  active account and the Orders module on. The console's chip. */
  effective: boolean;
  source: OrderCatalogAccessSource;
  /** What stands between the capability and its use, never granted here. */
  blockers: OrderCatalogAccessBlocker[];
  /** They can manage but cannot place orders: on the phone the entry is the
   *  Orders list, not Place an Order. */
  phoneEntryFromOrdersListOnly: boolean;
}

/** The God Admin preview, on the same effectivePermissions every gate uses.
 *  Prerequisites are explained, never expanded. */
export function orderCatalogAccessPreview(input: OrderCatalogAccessPreviewInput): OrderCatalogAccessPreview {
  const roleDefault = effectivePermissions(input.role).has(ORDER_CATALOG_VISIBILITY_PERMISSION);
  const capability = effectivePermissions(input.role, [], permissionExceptionOverrides(input.exception)).has(
    ORDER_CATALOG_VISIBILITY_PERMISSION,
  );
  const blockers: OrderCatalogAccessBlocker[] = [];
  if (input.disabled) blockers.push('account_disabled');
  if (!input.ordersModuleEnabled) blockers.push('orders_module_off');
  return {
    roleDefault,
    capability,
    effective: capability && blockers.length === 0,
    source:
      input.exception === 'allow'
        ? 'allowed_by_stockpilot'
        : input.exception === 'deny'
          ? 'denied_by_stockpilot'
          : 'role_default',
    blockers,
    phoneEntryFromOrdersListOnly: capability && !input.canRequestOrders,
  };
}

/** The console's effective-access chip. */
export function orderCatalogAccessChipCopy(effective: boolean): string {
  return effective ? 'Allowed' : 'Not allowed';
}

const SOURCE_COPY: Readonly<Record<OrderCatalogAccessSource, string>> = {
  role_default: 'Role default',
  allowed_by_stockpilot: 'Allowed by StockPilot',
  denied_by_stockpilot: 'Denied by StockPilot',
};

/** The console's source line under the chip. */
export function orderCatalogAccessSourceCopy(source: OrderCatalogAccessSource): string {
  return SOURCE_COPY[source];
}

export const ORDER_ITEMS_ACCESS_STATE_LABELS: Readonly<Record<PermissionExceptionState, string>> = {
  default: 'Follow role default',
  allow: 'Allow',
  deny: 'Deny',
};

export const ORDER_ITEMS_ACCESS_ROLE_DEFAULT_COPY =
  'Managers, admins and owners have this by default. Staff and viewers do not.';
export const ORDER_ITEMS_ACCESS_STAYS_COPY =
  'This stays until StockPilot changes it, even if their role changes.';
export const ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY =
  'A manager, admin or owner needs Deny to lose their default access; Reset returns them to it.';
export const ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY =
  'Allow gives only this capability. They still need access to the warehouses and categories they will manage; it does not grant stock edits, order approval or permission to give this to others.';
export const ORDER_ITEMS_ACCESS_MODULE_OFF_COPY =
  'The Orders module is off for this organization, so nobody can manage order items until it is turned on.';
export const ORDER_ITEMS_ACCESS_PHONE_ENTRY_COPY =
  "They can't place orders, so on the phone they open Manage order items from the Orders list, not from Place an Order.";
export const ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY =
  'This choice stays if they are removed from the organization and invited again.';
export const ORDER_ITEMS_ACCESS_DISABLED_COPY =
  'Their account is disabled, so they have no access until it is re-enabled.';
/** A lost compare-and-set: someone changed the row first. Never "not authorized". */
export const ORDER_ITEMS_ACCESS_CHANGED_COPY =
  "This member's order items access changed while you were working. Reload the page and try again.";
export const ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY =
  'That person is not a member of this organization anymore. Reload the page.';
/** Another save for the same member and key held the row past the lock wait. */
export const ORDER_ITEMS_ACCESS_BUSY_COPY =
  "Another change to this member's order items access is still saving. Try again in a moment.";
/** A malformed request (the dialog only sends the three states). */
export const ORDER_ITEMS_ACCESS_INVALID_COPY = "That change couldn't be sent. Reload the page and try again.";
/** An unexpected failure: nothing is claimed about what was saved. */
export const ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY =
  "Order items access couldn't be saved. Reload the page to see what it is now, then try again.";

const BLOCKER_REASON: Readonly<Record<OrderCatalogAccessBlocker, string>> = {
  account_disabled: 'their account is disabled',
  orders_module_off: 'the Orders module is off',
};

/** "After saving: Not allowed (denied by StockPilot). This stays until
 *  StockPilot changes it, even if their role changes." */
export function orderCatalogAccessAfterSavingCopy(preview: OrderCatalogAccessPreview): string {
  const why =
    preview.capability && preview.blockers.length > 0
      ? BLOCKER_REASON[preview.blockers[0]!]
      : SOURCE_COPY[preview.source].replace(/^./, (c) => c.toLowerCase());
  const head = `After saving: ${orderCatalogAccessChipCopy(preview.effective)} (${why}).`;
  return preview.source === 'role_default' ? head : `${head} ${ORDER_ITEMS_ACCESS_STAYS_COPY}`;
}

/** The explanations that apply to this member and this choice, in order. */
export function orderCatalogAccessExplanations(
  preview: OrderCatalogAccessPreview,
  input: Pick<OrderCatalogAccessPreviewInput, 'role' | 'exception'>,
): string[] {
  const out: string[] = [];
  if (preview.blockers.includes('account_disabled')) out.push(ORDER_ITEMS_ACCESS_DISABLED_COPY);
  if (preview.blockers.includes('orders_module_off')) out.push(ORDER_ITEMS_ACCESS_MODULE_OFF_COPY);
  if (isManagerOrAbove(input.role)) out.push(ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY);
  if (input.exception === 'allow') out.push(ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY);
  if (preview.phoneEntryFromOrdersListOnly) out.push(ORDER_ITEMS_ACCESS_PHONE_ENTRY_COPY);
  if (input.exception !== 'default') out.push(ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY);
  return out;
}
