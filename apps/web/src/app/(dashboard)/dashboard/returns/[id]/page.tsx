import { notFound, redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ReturnWorkbench, type WorkbenchReturnLabel } from '@/components/returns/return-workbench';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ServiceError } from '@/server/services/context';
import { RMAService } from '@/server/services/returns';
import { ShippingService } from '@/server/services/shipping';

import { can } from '@stockpilot/core';

/**
 * The RMA workbench (returns RX-1). returns:read or returns:manage can view;
 * the actions in it come from core's availableReturnActions, fed by the
 * server-computed viewer booleans (returns:manage, the module, write access
 * to the order's warehouse), and every one is re-checked by its database
 * function. The workbench payload is one service call (the RMA, its lines
 * with photos and inbound states, the destination options, the decision log
 * and the chain). The reverse shipping label stays here, gated on the
 * shipping module and shipping:manage.
 */
export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const moduleAccess = await checkModuleAccess('returns');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="returns" canManage={moduleAccess.canManage} />;
  }
  const ctx = await requireOrgContext();
  if (!can(ctx, 'returns:read') && !can(ctx, 'returns:manage')) {
    redirect('/dashboard');
  }

  const svc = await RMAService.forCurrentUser();
  const shippingAccess = await checkModuleAccess('shipping');
  const canManageShipping = shippingAccess.enabled && can(ctx, 'shipping:manage');

  const [workbenchResult, returnLabel] = await Promise.all([
    svc.workbench(id).then(
      (w) => ({ ok: true as const, w }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    shippingAccess.enabled
      ? ShippingService.forCurrentUser()
          .then((s) => s.getReturnLabel(id))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!workbenchResult.ok) {
    if (workbenchResult.e instanceof ServiceError && workbenchResult.e.code !== 'internal_error') notFound();
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

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <ReturnWorkbench workbench={workbenchResult.w} canManageShipping={canManageShipping} returnLabel={label} />
    </div>
  );
}
