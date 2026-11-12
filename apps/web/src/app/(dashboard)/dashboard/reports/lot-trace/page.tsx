import { PageHeader } from '@/components/patterns/page-header';
import { reportPageGate } from '@/lib/reports/report-page-gate';
import { LotTraceSearch } from '@/components/reports/lot-trace-search';

// The Liquid Glass insights composition (stage 4: pages/insights.css, the
// lane's shared frame): every rule is scoped to this page's
// [data-glass-page] root and to glass, so Classic never matches it
// (styles/liquid-glass/glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/insights.css';

export const dynamic = 'force-dynamic';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function LotTraceReportPage() {
  const blocked = await reportPageGate('lot-trace');
  if (blocked) return blocked;

  return (
    <div
      className={REPORT_PAGE_CLASS}
      data-glass-page="insights"
      data-glass-view="report"
      data-glass-width="wide"
    >
      <PageHeader
        title="Recall / lot trace"
        subline="Enter a lot number to see every receipt it came in on and every order it was picked into."
      />
      <LotTraceSearch />
    </div>
  );
}
