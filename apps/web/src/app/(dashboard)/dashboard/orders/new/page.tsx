import { redirect } from 'next/navigation';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { OrdersStorefront } from '@/components/orders/storefront/orders-storefront';
import { can, deliveryRecipientsForRouting, STOREFRONT_TITLE_COPY } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { getCachedOrgTimezone, getOrgEmailRouting } from '@/lib/dashboard/cached-org';
import { getModulesForRequest, getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { loadFrequentlyOrdered } from '@/server/loaders/orders-frequently-ordered';
import { loadOrderKits } from '@/server/loaders/orders-kits';
import {
  loadCatalogBundle,
  loadChartersForWarehouse,
} from '@/server/loaders/orders-new-catalog';
import { canManageOrderItems } from '@/server/services/order-catalog-visibility';

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
  // The Orders module gate, as /dashboard/orders has it (L96): with Orders off
  // nothing else is read. Cheap on the shell path: it reads the module set
  // requireOrgContext already resolved (request-cached), no extra round trip.
  const moduleAccess = await checkModuleAccess('orders');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="orders" access={moduleAccess} />;
  }

  // SHELL-PATH AUDIT: everything awaited before returning JSX must be
  // cheap or cached, because it gates the first flush:
  //   - requireOrgContext: React.cache()d, shared with the layout.
  //   - checkModuleAccess('orders') (above): reads the request-cached module
  //     set from the same context bundle, no extra round trip.
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
  //   - modules: getModulesForRequest, request-cached and read off the same
  //     context bundle requireOrgContext resolved (the dashboard layout reads
  //     it too), so no extra round trip on the normal path. Decides whether
  //     the Kits row keeps its place while the kits stream in, and (with the
  //     rollout switch and the effective permission) whether the header
  //     offers Manage order items.
  // Anything only the CATALOG needs (items, media map, and the
  // access-key queries that build the catalog cache key) runs inside
  // catalogPromise, which is never awaited here.
  const [params, warehouseRows, orgTimezoneRaw, deliveryRouting, modules] = await Promise.all([
    searchParams,
    getWarehousesForRequest(ctx.organizationId),
    getCachedOrgTimezone(ctx.organizationId),
    // Per-org delivery-request email routing (migration 0337): decides
    // whether the success overlay offers the compose action at all, and to
    // which mailboxes. One cheap single-row read, batched with the rest of
    // the shell path.
    getOrgEmailRouting(ctx.organizationId, 'delivery_request'),
    // A failed module read keeps no place for the Kits row (the kits loader
    // makes the same read and then says the kits could not be loaded) and
    // offers no Manage order items: fail closed.
    getModulesForRequest(ctx.organizationId).then(
      (set) => set,
      () => null,
    ),
  ]);
  const kitsEnabled = modules?.has('bundles') ?? false;
  // Ordering visibility (design 8.1): the Orders module, the rollout switch
  // and the EFFECTIVE orders:manage_catalog_visibility (an explicit deny from
  // StockPilot holds for a manager or the owner). The management page and its
  // action check it again on every call.
  const manageOrderItems =
    modules !== null &&
    canManageOrderItems({
      organizationId: ctx.organizationId,
      enabledModules: modules,
      role: ctx.role,
      permissions: ctx.permissions,
    });
  // Used as-is. getCachedOrgTimezone resolves its own fallback through core's
  // `resolveOrgTimezone` and never returns null or '', so a second
  // `|| ORG_TIMEZONE_DEFAULT` here would be dead code — and, worse, would
  // silently swap a legitimately STORED 'UTC' org (the column's DB default) for
  // America/Los_Angeles. Re-defaulting an already-defaulted value is precisely
  // how web and mobile ended up naming two different needed-by times for one
  // order: the surface that substitutes first destroys the information the
  // shared resolver needs.
  const orgTimezone = orgTimezoneRaw;
  // The whole fallback matrix lives in core: compiled constants ONLY for the
  // pre-migration 'fallback' state, the stored pair for 'valid', null
  // (action hidden, fail closed) for 'unset'/'invalid'. Flattened to plain
  // strings for the RSC boundary; the client re-brands at its seam.
  const deliveryRecipientsValue = deliveryRecipientsForRouting(deliveryRouting);
  const deliveryRecipients = deliveryRecipientsValue
    ? {
        to: deliveryRecipientsValue.to,
        cc: deliveryRecipientsValue.cc,
        toName: deliveryRecipientsValue.toName,
        ccName: deliveryRecipientsValue.ccName,
      }
    : null;
  const warehouses = warehouseRows.map((w) => ({
    id: w.id,
    name: w.name,
  }));

  if (warehouses.length === 0) {
    // The redesign's page frame: the shared page header and the shared empty
    // state, with the words this state has always had.
    return (
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
        <PageHeader
          back={<PageHeaderBackLink href="/dashboard/orders">← Back to orders</PageHeaderBackLink>}
          title={STOREFRONT_TITLE_COPY}
        />
        <StatePanel
          kind="empty"
          size="sm"
          title="No active warehouses are configured."
          description="Ask an admin to add one before placing an order request."
        />
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
  // The context carries the role the catalog scope starts from (see
  // resolveCatalogScopeKey): owner/admin/manager need no extra read.
  const catalogPromise = loadCatalogBundle(ctx, warehouseId);
  // Same treatment for the "Frequently ordered" strip, the first row of photos
  // on the page: started now, in parallel with the catalog, never awaited, and
  // it never rejects. It was a browser fetch that could only begin after
  // hydration (see the loader's header for the measurement).
  const frequentlyOrderedPromise = loadFrequentlyOrdered(warehouseId, catalogPromise);
  // The kits (bundles) this person can order here: the same treatment. Started
  // now, matched against the same catalog, never awaited, never rejects. With
  // the Bundles module off it reads nothing.
  const kitsPromise = loadOrderKits(ctx.organizationId, warehouseId, catalogPromise);
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
      frequentlyOrderedPromise={frequentlyOrderedPromise}
      kitsPromise={kitsPromise}
      kitsEnabled={kitsEnabled}
      chartersForWarehouse={chartersForWarehouse}
      canActOnBehalf={can(ctx, 'orders:approve')}
      viewerName={ctx.fullName}
      viewerEmail={ctx.email}
      orgTimezone={orgTimezone}
      deliveryRecipients={deliveryRecipients}
      // Phone ordering PO-2: the cart draft and the pending send belong to
      // this account in this organization (judge X-1), and the create body
      // names this user as the placer.
      viewerUserId={ctx.userId}
      organizationId={ctx.organizationId}
      // The order page's approve gate (security slice D): the effective
      // orders:approve, never for a viewer.
      canApproveOrders={can(ctx, 'orders:approve') && ctx.role !== 'viewer'}
      canManageOrderItems={manageOrderItems}
    />
  );
}
