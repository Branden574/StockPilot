import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import {
  BookOrderTotalsBody,
  type BookReportSearchParams,
} from '@/components/reports/book-order-totals/report-body';
import { ReportBodySkeleton } from '@/components/reports/report-body-skeleton';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';

import { BOOK_REPORT_CARD_DESCRIPTION, BOOK_REPORT_TITLE, can } from '@stockpilot/core';

export const dynamic = 'force-dynamic';

/**
 * /dashboard/reports/book-order-totals: which books people asked for
 * through Orders, how many copies, and the orders behind each total.
 *
 * Checked here before any read, not only by the reports layout (a layout's
 * check does not stop its page from rendering): reports:read, then the
 * Orders and Books modules. The service checks again (reports:read with the
 * MFA step-up, and both modules), and so does the database function.
 *
 * The header paints at once; the body (one statement for every number)
 * streams in behind a skeleton.
 */
export default async function BookOrderTotalsPage({
  searchParams,
}: {
  searchParams: Promise<BookReportSearchParams>;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'reports:read')) redirect('/dashboard');
  const [orders, books] = await Promise.all([
    checkModuleAccess('orders'),
    checkModuleAccess('books'),
  ]);
  if (!orders.enabled) return <ModuleNotEnabled moduleId="orders" canManage={orders.canManage} />;
  if (!books.enabled) return <ModuleNotEnabled moduleId="books" canManage={books.canManage} />;

  return (
    // The page area every redesigned list shares (DESIGN-SPEC 4 and 5.3):
    // 1320 wide at most, a 16 px gutter on a phone.
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title={BOOK_REPORT_TITLE}
        subline={BOOK_REPORT_CARD_DESCRIPTION}
      />

      <Suspense fallback={<ReportBodySkeleton />}>
        <BookOrderTotalsBody
          searchParams={searchParams}
          organizationId={ctx.organizationId}
          userId={ctx.userId}
          canExport={can(ctx, 'reports:export')}
          hasWarehouseView={ctx.role === 'owner' || ctx.role === 'admin' || ctx.role === 'manager'}
        />
      </Suspense>
    </div>
  );
}
