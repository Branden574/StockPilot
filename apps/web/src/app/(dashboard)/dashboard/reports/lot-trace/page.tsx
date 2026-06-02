import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { LotTraceSearch } from '@/components/reports/lot-trace-search';

export const dynamic = 'force-dynamic';

export default async function LotTraceReportPage() {
  const access = await checkModuleAccess('lot_serial');
  if (!access.enabled) return <ModuleNotEnabled moduleId="lot_serial" canManage={access.canManage} />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="font-display text-2xl">Recall / lot trace</h1>
      <p className="text-muted-foreground mt-1 mb-4 text-sm">
        Enter a lot number to see every receipt it came in on and every order it was picked into.
      </p>
      <LotTraceSearch />
    </div>
  );
}
