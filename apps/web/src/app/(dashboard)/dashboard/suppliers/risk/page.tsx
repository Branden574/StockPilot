import type { Metadata } from 'next';
import Link from 'next/link';

import { resolveOrgTimezone } from '@stockpilot/core';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { RegisterCsvButton } from '@/components/suppliers/risk/register-csv-button';
import { SupplierRiskRegisterTable } from '@/components/suppliers/risk/register-table';
import { SupplierRiskLimits } from '@/components/suppliers/risk/rules-and-limits';
import { Button } from '@/components/ui/button';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { sendSupplierRiskRefusalAway } from '@/lib/supplier-risk/page-gate';
import { sortSupplierRiskRegister } from '@/lib/supplier-risk/words';
import { withContext } from '@/server/services/context';
import {
  assertMayUseSupplierRisk,
  SUPPLIER_RISK_COULD_NOT_CHECK,
  SupplierRiskService,
  type SupplierRiskRegisterRead,
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

  let read: SupplierRiskRegisterRead;
  let timezone: string | null | undefined;
  try {
    let org;
    [read, org] = await Promise.all([
      new SupplierRiskService(ctx).register(),
      // The organization's zone, for the CSV's "Reviewed on" (already read
      // for this request by the context; a failed read falls back to core's
      // documented default zone rather than failing the register).
      getOrgRowForRequest(ctx.organizationId).catch(() => null),
    ]);
    timezone = org?.timezone;
  } catch (e) {
    sendSupplierRiskRefusalAway(e, THIS_PAGE);
  }
  const timeZone = resolveOrgTimezone(timezone);
  const rows = read.state === 'ok' ? sortSupplierRiskRegister(read.value) : [];

  return (
    <div className={PAGE} data-glass-page="ops" data-glass-view="suppliers">
      <PageHeader
        title="Vendor risk register"
        titleId="supplier-risk-register-title"
        subline="Every supplier's vendor review: the result, the risk left, the open items and when the next review is due. Overdue first."
        back={<PageHeaderBackLink href="/dashboard/suppliers">← Suppliers</PageHeaderBackLink>}
        actions={
          read.state === 'ok' ? (
            <RegisterCsvButton rows={rows} timeZone={timeZone} complete={read.complete} />
          ) : null
        }
      />

      {read.state === 'ok' && !read.complete ? (
        // Past the pages the server reads: said, never cut without a word.
        <p
          role="status"
          className="border-warning/40 bg-warning-wash text-foreground rounded-md border px-3 py-2 text-[13px]"
          data-slot="supplier-risk-register-incomplete"
        >
          Showing the first {rows.length.toLocaleString('en-US')} suppliers. The register holds more
          than this page can read at once, so the others are not shown here or in the CSV (its first
          line says so). Find a supplier on the{' '}
          <Link href="/dashboard/suppliers" className="text-accent underline-offset-4 hover:underline">
            Suppliers list
          </Link>{' '}
          and open its review from there.
        </p>
      ) : null}

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
