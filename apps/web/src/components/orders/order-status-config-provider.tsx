'use client';

import * as React from 'react';

import {
  resolveOrderStatusConfig,
  type OrderStatusKey,
  type OrderStatusMeta,
  type ResolvedOrderStatusMeta,
} from '@stockpilot/core';

/**
 * Per-org order status presentation, resolved once at the dashboard shell and
 * exposed to every <OrderStatusBadge>. The value is the FULLY-RESOLVED meta
 * map (`resolveOrderStatusConfig` already merged the org override over the
 * canonical defaults) so every consumer reads a complete, render-safe map.
 *
 * Default is `null` so a badge rendered OUTSIDE the provider (e.g. a future
 * surface that forgets to mount it) still falls back to the core defaults
 * inside `useOrderStatusMeta` — never blank, never throws.
 */
const OrderStatusConfigContext = React.createContext<ResolvedOrderStatusMeta | null>(null);

export function OrderStatusConfigProvider({
  /** Raw `organizations.order_status_config` jsonb. Untrusted — resolved here. */
  config,
  children,
}: {
  config: unknown;
  children: React.ReactNode;
}) {
  // Resolve once per config value. The resolver is pure + fail-closed, so a
  // null/garbage config yields the canonical defaults.
  const resolved = React.useMemo(
    () => resolveOrderStatusConfig(config as Parameters<typeof resolveOrderStatusConfig>[0]),
    [config],
  );
  return (
    <OrderStatusConfigContext.Provider value={resolved}>
      {children}
    </OrderStatusConfigContext.Provider>
  );
}

/**
 * Resolved presentation meta for a single order status. Falls back to the core
 * defaults when no provider is mounted (context value is null) — guarantees the
 * badge always has a label + color.
 */
export function useOrderStatusMeta(status: OrderStatusKey | string): OrderStatusMeta {
  const ctx = React.useContext(OrderStatusConfigContext);
  // No provider → resolve canonical defaults on the fly (cheap, fail-closed).
  const map = ctx ?? resolveOrderStatusConfig(null);
  const meta = (map as Record<string, OrderStatusMeta | undefined>)[status];
  // Unknown status (shouldn't happen for canonical keys) → a safe outline badge
  // showing the raw status, matching the badge's prior `default` switch arm.
  return meta ?? { label: status, color: 'outline', sortOrder: Number.MAX_SAFE_INTEGER };
}
