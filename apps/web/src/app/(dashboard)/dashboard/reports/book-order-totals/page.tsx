import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
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
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to reports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{BOOK_REPORT_TITLE}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{BOOK_REPORT_CARD_DESCRIPTION}</p>
      </div>

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
