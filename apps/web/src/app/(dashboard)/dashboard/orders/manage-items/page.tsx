import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_ITEMS_MANAGE_BUTTON_COPY,
  ORDER_ITEMS_MANAGE_SUBLINE_COPY,
  ORDER_ITEMS_MFA_REQUIRED_COPY,
  ORDER_ITEMS_NO_ACCESS_COPY,
  orderCatalogManageQueryString,
  parseOrderCatalogManageQuery,
  type OrderCatalogManageListAnswer,
} from '@stockpilot/core';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { ManageOrderItems } from '@/components/orders/manage-items/manage-order-items';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';
import { rethrowControlFlow } from '@/lib/control-flow';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { CategoriesService } from '@/server/services/categories';
import { ServiceError, withContext } from '@/server/services/context';
import { OrderCatalogVisibilityService } from '@/server/services/order-catalog-visibility';

export const metadata: Metadata = { title: ORDER_ITEMS_MANAGE_BUTTON_COPY };

const PAGE_PATH = '/dashboard/orders/manage-items';

/** The redesign's page box (the Orders list's). */
const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** Why the list was not shown. */
type Refusal = 'no_access' | 'feature_disabled' | 'mfa_required' | 'aal2_required' | 'failed';

/** An enrolled session that lost its second factor (rare: the dashboard
 *  layout already sends an AAL1 session with a factor to the challenge). */
const AAL2_READ_COPY = 'Confirm it is you with your authenticator to manage order items.';

function refusalOf(error: unknown): Refusal {
  if (error instanceof ServiceError && error.code === 'forbidden') {
    const reason = error.details?.reason;
    if (reason === 'feature_disabled') return 'feature_disabled';
    if (reason === 'mfa_required') return 'mfa_required';
    if (reason === 'aal2_required') return 'aal2_required';
    return 'no_access';
  }
  if (error instanceof ServiceError && error.code === 'module_disabled') return 'no_access';
  return 'failed';
}

/**
 * MANAGE ORDER ITEMS (ordering visibility, migration 0413; design 8.2): which
 * items and books appear in Place an Order, over the caller's whole readable
 * catalog, hidden records included so they can be shown again.
 *
 * A full page, not a dialog, so router.refresh() re-gates it after a
 * revocation (design 3.7). The service gates every read (the Orders module,
 * the rollout switch, MFA, the effective orders:manage_catalog_visibility)
 * and reads with the caller's own client, so RLS is the scope. A member
 * without the capability gets a plain explanation, not a 404. A failed read
 * is never shown as an empty list.
 *
 * No loading.tsx, on purpose: like the Orders list it relies on the late
 * skeleton (lib/navigation/route-skeletons.ts, 'table-8' for every
 * /dashboard/orders route but the storefront), which avoids React's 300 ms
 * fallback hold for a page whose data is usually ready sooner.
 */
export default async function ManageOrderItemsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Started beside the module gate (the Orders list's chain): the gate still
  // answers before anything is read.
  const contextStarted = withContext();
  contextStarted.catch(() => {});
  const [moduleAccess, params] = await Promise.all([checkModuleAccess('orders'), searchParams]);
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="orders" access={moduleAccess} />;
  }
  const ctx = await contextStarted;
  const filters = parseOrderCatalogManageQuery(params);

  // The list gates first and reads nothing when refused; the lookups for the
  // filters are the caller's own reads (RLS), started alongside.
  const [listResult, warehousesResult, categoriesResult, timezoneResult] = await Promise.allSettled(
    [
      new OrderCatalogVisibilityService(ctx).list(filters),
      getWarehousesForRequest(ctx.organizationId),
      new CategoriesService(ctx).list(),
      getCachedOrgTimezone(ctx.organizationId),
    ],
  );

  let answer: OrderCatalogManageListAnswer | null = null;
  let refusal: Refusal | null = null;
  if (listResult.status === 'fulfilled') {
    answer = listResult.value;
  } else {
    rethrowControlFlow(listResult.reason);
    refusal = refusalOf(listResult.reason);
    if (refusal === 'failed') {
      console.error('[dashboard/orders/manage-items] list failed', {
        message:
          listResult.reason instanceof ServiceError
            ? (listResult.reason.internalDetail ?? listResult.reason.message)
            : listResult.reason instanceof Error
              ? listResult.reason.message
              : String(listResult.reason),
      });
    }
  }

  const qs = orderCatalogManageQueryString(filters);
  const selfHref = qs ? `${PAGE_PATH}?${qs}` : PAGE_PATH;

  return (
    <div className={PAGE_BOX}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/orders">← Back to orders</PageHeaderBackLink>}
        title={ORDER_ITEMS_MANAGE_BUTTON_COPY}
        titleId="manage-order-items-title"
        subline={ORDER_ITEMS_MANAGE_SUBLINE_COPY}
      />
      {answer ? (
        <ManageOrderItems
          organizationId={ctx.organizationId}
          userId={ctx.userId}
          answer={answer}
          filters={filters}
          warehouses={
            warehousesResult.status === 'fulfilled'
              ? warehousesResult.value.map((w) => ({ id: w.id, name: w.name }))
              : []
          }
          categories={
            categoriesResult.status === 'fulfilled'
              ? categoriesResult.value.map((c) => ({ id: c.id, name: c.name }))
              : []
          }
          orgTimezone={timezoneResult.status === 'fulfilled' ? timezoneResult.value : 'UTC'}
        />
      ) : refusal === 'feature_disabled' ? (
        <StatePanel kind="module-off" title={ORDER_ITEMS_FEATURE_DISABLED_COPY} />
      ) : refusal === 'mfa_required' ? (
        <StatePanel
          kind="forbidden"
          title={ORDER_ITEMS_MFA_REQUIRED_COPY}
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/settings/security">Set up multi-factor authentication</Link>
            </Button>
          }
        />
      ) : refusal === 'aal2_required' ? (
        <StatePanel
          kind="forbidden"
          title={AAL2_READ_COPY}
          action={
            <Button asChild variant="outline">
              <Link href={`/signin/mfa?redirect=${encodeURIComponent(selfHref)}`}>
                Confirm it is you
              </Link>
            </Button>
          }
        />
      ) : refusal === 'failed' ? (
        <StatePanel
          kind="failed"
          title={ORDER_ITEMS_LOAD_FAILED_COPY}
          action={
            <Button asChild variant="outline">
              <Link href={selfHref}>Try again</Link>
            </Button>
          }
        />
      ) : (
        <StatePanel
          kind="forbidden"
          title={ORDER_ITEMS_NO_ACCESS_COPY}
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/orders">Back to orders</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}
