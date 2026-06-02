import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { LotsService } from '@/server/services/lots';

export const dynamic = 'force-dynamic';

const BUCKET_LABEL: Record<string, string> = {
  expired: 'Expired',
  le7: '≤ 7 days',
  le30: '≤ 30 days',
  le90: '≤ 90 days',
  ok: '> 90 days',
  unknown: 'No date',
};
const BUCKET_ORDER = ['expired', 'le7', 'le30', 'le90', 'ok', 'unknown'] as const;

export default async function LotExpiryReportPage() {
  const access = await checkModuleAccess('lot_serial');
  if (!access.enabled) return <ModuleNotEnabled moduleId="lot_serial" canManage={access.canManage} />;

  const svc = await LotsService.forCurrentUser();
  const rows = await svc.getAgingInventory();
  const counts = BUCKET_ORDER.map((b) => ({
    bucket: b,
    label: BUCKET_LABEL[b],
    count: rows.filter((r) => r.bucket === b).length,
  })).filter((c) => c.count > 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="font-display text-2xl">Aging &amp; expiry</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Lots with remaining quantity, earliest expiry first. Remaining nets recorded FEFO picks
        out of received quantity.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {counts.map((c) => (
          <span key={c.bucket} className="bg-muted rounded-full px-3 py-1 text-xs">
            {c.label}: <strong>{c.count}</strong>
          </span>
        ))}
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-left">Lot #</th>
              <th className="px-3 py-2 text-left">Expiry</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="text-muted-foreground px-3 py-6 text-center">No lots on hand.</td></tr>
            )}
            {rows.map((r) => (
              <tr
                key={`${r.itemId}-${r.lotNumber}`}
                className={`border-t ${r.bucket === 'expired' ? 'bg-destructive/5' : r.bucket === 'le7' ? 'bg-amber-50/50 dark:bg-amber-950/10' : ''}`}
              >
                <td className="px-3 py-2">
                  <div>{r.itemName}</div>
                  <div className="text-muted-foreground font-mono text-xs">{r.sku ?? '—'}</div>
                </td>
                <td className="px-3 py-2 font-mono">{r.lotNumber}</td>
                <td className="px-3 py-2">{r.effectiveExpiry ? r.effectiveExpiry.slice(0, 10) : '—'}</td>
                <td className="px-3 py-2">{BUCKET_LABEL[r.bucket]}</td>
                <td className="px-3 py-2 text-right">{r.remaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
