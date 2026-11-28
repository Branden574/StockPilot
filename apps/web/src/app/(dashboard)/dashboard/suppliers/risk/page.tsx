import type { Metadata } from 'next';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { RegisterCsvButton } from '@/components/suppliers/risk/register-csv-button';
import { SupplierRiskRegisterTable } from '@/components/suppliers/risk/register-table';
import { SupplierRiskLimits } from '@/components/suppliers/risk/rules-and-limits';
import { Button } from '@/components/ui/button';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { sendSupplierRiskRefusalAway } from '@/lib/supplier-risk/page-gate';
import { sortSupplierRiskRegister } from '@/lib/supplier-risk/words';
import { withContext } from '@/server/services/context';
import {
  assertMayUseSupplierRisk,
  SUPPLIER_RISK_COULD_NOT_CHECK,
  SupplierRiskService,
  type SupplierRiskRead,
  type SupplierRiskRegisterRow,
} from '@/server/services/supplier-risk';

// The Liquid Glass operations composition (every page under suppliers draws
// the shared frame's root; glass-scope.guard.test.ts reads the folder).
import '@/styles/liquid-glass/pages/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Vendor risk register' };

const THIS_PAGE = '/dashboard/suppliers/risk';
/** The page area (DESIGN-SPEC 5.3 and 4): max 1320, 16 px gutters on a phone. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/**
 * THE VENDOR RISK REGISTER (part 7 of the security tools), for owners and
 * admins: every active supplier (and every archived or deleted one that has a
 * review) with its result, what is left of the risk, its open items and when
 * its next review is due, overdue first; CSV download.
 *
 * Asked in this order before anything is read: the Suppliers module (off: the
 * module card), then the service's gate (assertMayUseSupplierRisk: the module,
 * the authenticator step, the role). A member who is not an owner or admin
 * gets Page not found; one who owes the authenticator step is sent to it.
 * A register that could not be read says so: it is never shown as empty.
 */
export default async function SupplierRiskRegisterPage() {
  const moduleAccess = await checkModuleAccess('suppliers');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="suppliers" access={moduleAccess} />;
  }
  const ctx = await withContext();
  try {
    assertMayUseSupplierRisk(ctx);
  } catch (e) {
    sendSupplierRiskRefusalAway(e, THIS_PAGE);
  }

  let read: SupplierRiskRead<SupplierRiskRegisterRow[]>;
  try {
    read = await new SupplierRiskService(ctx).register();
  } catch (e) {
    sendSupplierRiskRefusalAway(e, THIS_PAGE);
  }
  const rows = read.state === 'ok' ? sortSupplierRiskRegister(read.value) : [];

  return (
    <div className={PAGE} data-glass-page="ops" data-glass-view="suppliers">
      <PageHeader
        title="Vendor risk register"
        titleId="supplier-risk-register-title"
        subline="Every supplier's vendor review: the result, the risk left, the open items and when the next review is due. Overdue first."
        back={<PageHeaderBackLink href="/dashboard/suppliers">← Suppliers</PageHeaderBackLink>}
        actions={read.state === 'ok' ? <RegisterCsvButton rows={rows} /> : null}
      />

      {read.state === 'could_not_check' ? (
        <StatePanel
          kind="failed"
          live="polite"
          title={SUPPLIER_RISK_COULD_NOT_CHECK}
          description="This is not the same as no reviews: nothing was read."
          action={
            <Button asChild variant="outline" size="sm">
              <a href={THIS_PAGE}>Try again</a>
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <StatePanel
          kind="empty"
          title="No suppliers to review yet"
          description="Add a supplier on the Suppliers page, then review it from there."
        />
      ) : (
        <DetailSection
          title={`${rows.length} ${rows.length === 1 ? 'supplier' : 'suppliers'}`}
          headingId="supplier-risk-register-heading"
          flush
        >
          <SupplierRiskRegisterTable rows={rows} headingId="supplier-risk-register-heading" />
        </DetailSection>
      )}

      <SupplierRiskLimits />
    </div>
  );
}
