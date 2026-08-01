import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OrdersStorefront } from '@/components/orders/storefront/orders-storefront';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { env } from '@/lib/env';
import { SITE_URL } from '@/lib/site';
import {
  loadCatalogBundle,
  loadChartersForWarehouse,
} from '@/server/loaders/orders-new-catalog';

// Absolute origin for the order deep link the delivery-request assistant
// mails out (see storefront-overlays ReviewModalProps.orderUrlBase). Must
// NEVER be empty — a bare "/dashboard/orders/<uuid>" isn't clickable from an
// email client. env.NEXT_PUBLIC_APP_URL already strips a trailing slash and
// defaults to a non-empty value; SITE_URL is the belt-and-suspenders fallback
// if that value is ever somehow blank.
const ORDER_URL_BASE = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '') || SITE_URL;

// NOTE (perf plan P3): the cached data loaders deliberately live in
// src/server/loaders/orders-new-catalog.ts, NOT here. unstable_cache's
// implicit key hashes the wrapped closure, so keeping them in this
// frequently-edited file rotated every cache key on every deploy —
// the owner's post-deploy reloads always hit the fully cold path.
// Keep this file UI-thin.

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouseId?: string }>;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'orders:request')) {
    redirect('/dashboard');
  }

  // SHELL-PATH AUDIT: everything awaited before returning JSX must be
  // cheap or cached, because it gates the first flush:
  //   - requireOrgContext: React.cache()d, shared with the layout.
  //   - warehouses: getWarehousesForRequest — the request-cached LIGHT
  //     {id,name} helper shared with the dashboard layout (perf plan
  //     P2). The previous WarehousesService.forCurrentUser().list()
  //     pulled the heavy items/assignments/manager/charters embed
  //     (mean 25ms, max 732ms in prod) plus withContext()'s org row +
  //     MFA factors + modules — all to render two {id,name} pairs.
  //     On hard loads this helper is free (deduped with the layout's
  //     own call); on soft navs it's one tiny query.
  //   - charters: 5-min unstable_cache, needed by the setup bar.
  //   - viewer identity: ctx fields — no extra query.
  // Anything only the CATALOG needs (items, media map, and the
  // access-key queries that build the catalog cache key) runs inside
  // catalogPromise, which is never awaited here.
  const [params, warehouseRows, orgTimezoneRaw] = await Promise.all([
    searchParams,
    getWarehousesForRequest(ctx.organizationId),
    getCachedOrgTimezone(ctx.organizationId),
  ]);
  // getCachedOrgTimezone already falls back to 'UTC' internally and never
  // returns '' — `|| ORG_TIMEZONE_DEFAULT` here was dead code (it can never
  // fire) and, worse, would have silently swapped a legitimate 'UTC' org for
  // 'America/Los_Angeles' had the helper ever returned it. Use the cached
  // value as-is: the delivery-request draft's needed-by line must print the
  // SAME zone the rest of the app already uses for this org.
  const orgTimezone = orgTimezoneRaw;
  const warehouses = warehouseRows.map((w) => ({
    id: w.id,
    name: w.name,
  }));

  if (warehouses.length === 0) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <Link
            href="/dashboard/orders"
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ← Back to orders
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Place an order
          </h1>
        </div>
        <div className="bg-card rounded-xl border p-6 text-sm text-muted-foreground">
          No active warehouses are configured. Ask an admin to add one before
          placing an order request.
        </div>
      </div>
    );
  }

  const requestedId = params.warehouseId;
  const fallbackId = warehouses[0]?.id;
  if (!fallbackId) {
    // Should be unreachable due to the empty-warehouses early return
    // above, but the type system doesn't know that.
    throw new Error('No warehouses available');
  }
  const warehouseId =
    warehouses.find((w) => w.id === requestedId)?.id ?? fallbackId;

  // STREAMING: the catalog bundle is deliberately NOT awaited. The
  // shell (head + setup bar) only needs warehouses/charters/viewer, so
  // it flushes immediately; the client suspends just the grid + cart
  // rail on this promise and React streams the resolved payload in.
  const catalogPromise = loadCatalogBundle(ctx.organizationId, warehouseId, ctx.userId);
  const chartersForWarehouse = await loadChartersForWarehouse(warehouseId);

  // The storefront owns its own page head (back link, H1, flow
  // indicator) and dark-scoped frame — no dashboard container here.
  // Viewer identity for the "Requesting for → Myself" cell comes from
  // requireOrgContext, which already reads user_profiles
  // (full_name/email) in this same request.
  return (
    <OrdersStorefront
      warehouses={warehouses}
      warehouseId={warehouseId}
      catalogPromise={catalogPromise}
      chartersForWarehouse={chartersForWarehouse}
      viewerRole={ctx.role}
      viewerName={ctx.fullName}
      viewerEmail={ctx.email}
      orderUrlBase={ORDER_URL_BASE}
      orgTimezone={orgTimezone}
    />
  );
}
