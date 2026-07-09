/**
 * Per-org ORDER STATUS presentation overrides.
 *
 * A SOFT override of how an order status is LABELED + COLORED in the UI. It
 * NEVER touches the order_requests.status CHECK constraint nor the transition
 * state machine — the canonical 13-value status union is fixed elsewhere. This
 * module only decides what text + badge color a given status renders with.
 *
 * Pure types + a pure resolver — no React, no platform imports — so the web
 * badge, the settings editor, and the server action that persists the config
 * all merge overrides over the canonical defaults the exact same way.
 *
 * `resolveOrderStatusConfig` is the SINGLE source of truth: it merges a per-org
 * override map over `ORDER_STATUS_META`, ignoring unknown status keys and
 * unknown color tokens, and falls back to the canonical defaults on null/
 * garbage. The badge can therefore always render — never blank, never throw.
 */

// ---------------------------------------------------------------------------
// Canonical status keys + badge color tokens
// ---------------------------------------------------------------------------

/**
 * The canonical order status keys. MUST stay in lockstep with the
 * OrderRequestStatus union in apps/web/src/server/services/order-requests.ts
 * and the order_requests.status CHECK constraint. This is presentation-only —
 * adding/removing a real status is a DB + state-machine change, not here.
 */
export const ORDER_STATUS_KEYS = [
  'pending_confirmation',
  'pending_approval',
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'backordered',
  'completed',
  'denied',
  'cancelled',
] as const;

export type OrderStatusKey = (typeof ORDER_STATUS_KEYS)[number];

const ORDER_STATUS_KEY_SET: ReadonlySet<string> = new Set<string>(ORDER_STATUS_KEYS);

/** True if `key` is one of the canonical order status keys. */
export function isOrderStatusKey(key: unknown): key is OrderStatusKey {
  return typeof key === 'string' && ORDER_STATUS_KEY_SET.has(key);
}

/**
 * Allowed badge color tokens. Each MUST match a `variant` of the web Badge
 * component (apps/web/src/components/ui/badge.tsx). Keeping the token set here
 * lets the editor offer a fixed palette and the action reject anything else,
 * so a crafted config can never inject an arbitrary className.
 */
export const ORDER_STATUS_COLORS = [
  'default',
  'secondary',
  'destructive',
  'success',
  'warning',
  'outline',
] as const;

export type OrderStatusColor = (typeof ORDER_STATUS_COLORS)[number];

const ORDER_STATUS_COLOR_SET: ReadonlySet<string> = new Set<string>(ORDER_STATUS_COLORS);

/** True if `color` is one of the allowed badge color tokens. */
export function isOrderStatusColor(color: unknown): color is OrderStatusColor {
  return typeof color === 'string' && ORDER_STATUS_COLOR_SET.has(color);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved presentation metadata for one order status. Always fully defined. */
export interface OrderStatusMeta {
  label: string;
  color: OrderStatusColor;
  sortOrder: number;
}

/**
 * A per-org override map. Each key is an order status; each value may override
 * any subset of { label, color, sortOrder }. Missing keys / fields inherit the
 * canonical `ORDER_STATUS_META`. Unknown keys + unknown colors are ignored.
 */
export type OrderStatusConfig = {
  [K in OrderStatusKey]?: {
    label?: string;
    color?: OrderStatusColor;
    sortOrder?: number;
  };
};

/** The fully-resolved meta for every canonical status. */
export type ResolvedOrderStatusMeta = Record<OrderStatusKey, OrderStatusMeta>;

// ---------------------------------------------------------------------------
// Canonical defaults — extracted verbatim from status-badge.tsx's switch.
// (label + Badge variant) per status, plus a sortOrder following the canonical
// lifecycle order in ORDER_STATUS_KEYS.
// ---------------------------------------------------------------------------

export const ORDER_STATUS_META: ResolvedOrderStatusMeta = {
  pending_confirmation: { label: 'Awaiting confirmation', color: 'outline', sortOrder: 0 },
  pending_approval: { label: 'Pending', color: 'warning', sortOrder: 1 },
  approved: { label: 'Approved', color: 'default', sortOrder: 2 },
  pick_slip_generated: { label: 'Pick slip', color: 'secondary', sortOrder: 3 },
  picking_in_progress: { label: 'Picking', color: 'secondary', sortOrder: 4 },
  picking_complete: { label: 'Picked', color: 'secondary', sortOrder: 5 },
  packing_slip_generated: { label: 'Packaging', color: 'secondary', sortOrder: 6 },
  staged_for_pickup: { label: 'Staged (pickup)', color: 'secondary', sortOrder: 7 },
  staged_for_delivery: { label: 'Ready', color: 'secondary', sortOrder: 8 },
  in_transit: { label: 'In transit', color: 'secondary', sortOrder: 9 },
  backordered: { label: 'Backordered', color: 'warning', sortOrder: 10 },
  completed: { label: 'Delivered', color: 'success', sortOrder: 11 },
  denied: { label: 'Denied', color: 'destructive', sortOrder: 12 },
  cancelled: { label: 'Cancelled', color: 'outline', sortOrder: 13 },
};

/** Max label length the resolver accepts before falling back to the default. */
export const ORDER_STATUS_LABEL_MAX = 60;

// ---------------------------------------------------------------------------
// resolveOrderStatusConfig — pure merge of overrides over canonical defaults
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge a per-org `OrderStatusConfig` over `ORDER_STATUS_META`, returning fully
 * resolved meta for EVERY canonical status. Rules:
 *
 *  - null / garbage `overrides` -> the canonical defaults unchanged.
 *  - unknown status keys in `overrides` are ignored.
 *  - per status, each of { label, color, sortOrder } overrides only when valid:
 *      • label:     a non-empty string, <= ORDER_STATUS_LABEL_MAX (trimmed);
 *                   anything else keeps the default label.
 *      • color:     must be an allowed token; anything else keeps the default.
 *      • sortOrder: a finite number (coerced to int); anything else keeps the
 *                   default.
 *
 * Fail-closed everywhere: a malformed field falls back to the canonical value,
 * so the result is always a complete, render-safe map. NEVER throws.
 */
export function resolveOrderStatusConfig(
  overrides: OrderStatusConfig | null | undefined,
): ResolvedOrderStatusMeta {
  // Start from a fresh copy of the canonical defaults so callers can't mutate
  // the shared constant through the returned object.
  const out = {} as ResolvedOrderStatusMeta;
  for (const key of ORDER_STATUS_KEYS) {
    out[key] = { ...ORDER_STATUS_META[key] };
  }

  if (!isPlainObject(overrides)) return out;

  for (const key of ORDER_STATUS_KEYS) {
    const ov = (overrides as Record<string, unknown>)[key];
    if (!isPlainObject(ov)) continue;

    const label = ov.label;
    if (typeof label === 'string') {
      const trimmed = label.trim();
      if (trimmed.length > 0 && trimmed.length <= ORDER_STATUS_LABEL_MAX) {
        out[key].label = trimmed;
      }
    }

    if (isOrderStatusColor(ov.color)) {
      out[key].color = ov.color;
    }

    const sortOrder = ov.sortOrder;
    if (typeof sortOrder === 'number' && Number.isFinite(sortOrder)) {
      out[key].sortOrder = Math.trunc(sortOrder);
    }
  }

  return out;
}
