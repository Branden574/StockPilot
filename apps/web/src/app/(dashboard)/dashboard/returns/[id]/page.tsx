import { notFound, redirect } from 'next/navigation';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { ReturnWorkbench, type WorkbenchReturnLabel } from '@/components/returns/return-workbench';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgEmailRouting } from '@/lib/dashboard/cached-org';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { returnRequestReturnLink } from '@/lib/returns/return-request-link';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { ServiceError } from '@/server/services/context';
import { returnRequestRecipientsDto } from '@/server/services/return-request-email';
import { RMAService } from '@/server/services/returns';
import { ShippingService } from '@/server/services/shipping';

import { can, canSendReturnRequest, type OrgEmailRoutingReadState } from '@stockpilot/core';

// The Liquid Glass operations composition (stage 4: pages/ops.css, the
// shared frame, and the board's own file where there is one): every rule is
// scoped to this page's [data-glass-page] root and to glass, so Classic never
// matches it (styles/liquid-glass/glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/ops.css';
import '@/styles/liquid-glass/pages/returns.css';

/**
 * The RMA workbench (returns RX-1). returns:read or returns:manage can view;
 * the actions in it come from core's availableReturnActions, fed by the
 * server-computed viewer booleans (returns:manage, the module, write access
 * to the order's warehouse), and every one is re-checked by its database
 * function. The workbench payload is one service call (the RMA, its lines
 * with photos and inbound states, the destination options, the decision log
 * and the chain). The reverse shipping label stays here, gated on the
 * shipping module and shipping:manage.
 *
 * F14: the header also carries "Send return request" (a prefilled draft
 * about this return to the organization's saved delivery-request mailboxes,
 * for every viewer this page opens for; hidden when the mailboxes are not
 * set or invalid, exactly as "Send delivery request" is) and "Report a
 * problem" (the order page's button and gates: the maintenance module on and
 * maintenance_requests:submit). Both are decided here, on the server.
 */
export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id (a mistyped or cut-off link) is Page not found before
  // anything is read with it, ahead of the gates below (B63).
  notFoundUnlessUuid(id);

  const moduleAccess = await checkModuleAccess('returns');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="returns" access={moduleAccess} />;
  }
  const ctx = await requireOrgContext();
  if (!can(ctx, 'returns:read') && !can(ctx, 'returns:manage')) {
    redirect('/dashboard');
  }

  const svc = await RMAService.forCurrentUser();
  const shippingAccess = await checkModuleAccess('shipping');
  const canManageShipping = shippingAccess.enabled && can(ctx, 'shipping:manage');

  // F14. The maintenance module is asked only for a viewer who could submit
  // a request (the order page's rule). A failed routing read is 'unset': the
  // button hides, the page still opens.
  const maintenanceGate = can(ctx, 'maintenance_requests:submit');
  const [workbenchResult, returnLabel, deliveryRouting, maintenanceAccess] = await Promise.all([
    svc.workbench(id).then(
      (w) => ({ ok: true as const, w }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    shippingAccess.enabled
      ? ShippingService.forCurrentUser()
          .then((s) => s.getReturnLabel(id))
          .catch(() => null)
      : Promise.resolve(null),
    getOrgEmailRouting(ctx.organizationId, 'delivery_request').catch(
      (): OrgEmailRoutingReadState => ({ state: 'unset' }),
    ),
    maintenanceGate ? checkModuleAccess('maintenance_requests') : Promise.resolve(null),
  ]);
  if (!workbenchResult.ok) {
    if (workbenchResult.e instanceof ServiceError && workbenchResult.e.code !== 'internal_error')
      notFound();
    throw workbenchResult.e;
  }

  const label: WorkbenchReturnLabel | null = returnLabel
    ? {
        status: returnLabel.status,
        carrier: returnLabel.carrier,
        service: returnLabel.service,
        rate_cents: returnLabel.rate_cents,
        currency: returnLabel.currency,
        tracking_code: returnLabel.tracking_code,
        tracking_url: returnLabel.tracking_url,
        label_url: returnLabel.label_url,
      }
    : null;

  // The fallback matrix of the delivery request (core
  // deliveryRecipientsForRouting, through the helper the phone's routes share):
  // the stored pair when valid, nothing when unset or invalid, as plain
  // strings for the client, which re-validates them at its own seam. Only
  // while the return is open with a number (core canSendReturnRequest, the
  // header button's own rule): the workbench is a client component, so a
  // closed, denied or cancelled return's page would otherwise carry the
  // mailboxes in its HTML with no button to use them.
  const returnRequestRecipients = canSendReturnRequest(
    workbenchResult.w.return.status,
    workbenchResult.w.return.returnNumber,
  )
    ? returnRequestRecipientsDto(deliveryRouting)
    : null;

  // The page box every redesigned page shares (DESIGN-SPEC 4 and 5.3), its
  // left edge level with the other pages'; the workbench keeps one column at
  // most 1040 px wide, so a returning card and its replacement sit side by
  // side at a readable width.
  return (
    <div
      className="mx-auto flex w-full max-w-[1320px] flex-col px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      data-glass-page="ops"
      data-glass-view="return"
    >
      <div className="w-full max-w-[1040px]">
        <ReturnWorkbench
          workbench={workbenchResult.w}
          canManageShipping={canManageShipping}
          returnLabel={label}
          returnRequest={{
            recipients: returnRequestRecipients,
            link: returnRequestReturnLink(id),
            showRoutingHint: can(ctx, 'organization:update'),
          }}
          reportProblem={{
            moduleEnabled: maintenanceAccess?.enabled ?? false,
            canSubmit: maintenanceGate,
          }}
        />
      </div>
    </div>
  );
}
