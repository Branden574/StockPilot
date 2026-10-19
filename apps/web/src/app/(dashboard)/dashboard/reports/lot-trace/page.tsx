import { PageHeader } from '@/components/patterns/page-header';
import { reportPageGate } from '@/lib/reports/report-page-gate';
import { LotTraceSearch } from '@/components/reports/lot-trace-search';

export const dynamic = 'force-dynamic';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function LotTraceReportPage() {
  const blocked = await reportPageGate('lot-trace');
  if (blocked) return blocked;

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        title="Recall / lot trace"
        subline="Enter a lot number to see every receipt it came in on and every order it was picked into."
      />
      <LotTraceSearch />
    </div>
  );
}
