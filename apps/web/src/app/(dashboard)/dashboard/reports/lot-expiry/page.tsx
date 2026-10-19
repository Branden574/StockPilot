import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';
import { LotsService } from '@/server/services/lots';

export const dynamic = 'force-dynamic';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

const BUCKET_LABEL: Record<string, string> = {
  expired: 'Expired',
  le7: '≤ 7 days',
  le30: '≤ 30 days',
  le90: '≤ 90 days',
  ok: '> 90 days',
  unknown: 'No date',
};
const BUCKET_ORDER = ['expired', 'le7', 'le30', 'le90', 'ok', 'unknown'] as const;

/**
 * Expired lots on the danger wash, lots within 7 days on the caution wash
 * (they were a fixed red and amber tint). The bucket words stay in the Status
 * column and on the count chips, so the tint is never the only cue.
 */
const ROW_TINT: Record<string, string> = {
  expired: 'bg-destructive-wash hover:bg-destructive-wash',
  le7: 'bg-warning-wash hover:bg-warning-wash',
};
const CHIP_VARIANT: Record<string, 'destructive' | 'warning' | 'secondary'> = {
  expired: 'destructive',
  le7: 'warning',
};
const STATUS_TONE: Record<string, string> = {
  expired: 'text-destructive font-medium',
  le7: 'text-warning font-medium',
};

export default async function LotExpiryReportPage() {
  const blocked = await reportPageGate('lot-expiry');
  if (blocked) return blocked;

  const svc = await LotsService.forCurrentUser();
  const rows = await svc.agingReport();
  const counts = BUCKET_ORDER.map((b) => ({
    bucket: b,
    label: BUCKET_LABEL[b],
    count: rows.filter((r) => r.bucket === b).length,
  })).filter((c) => c.count > 0);

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        title="Aging & expiry"
        subline="Lots with remaining quantity, earliest expiry first. Remaining nets recorded FEFO picks out of received quantity."
      />
      {counts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {counts.map((c) => (
            <Badge
              key={c.bucket}
              data-bucket={c.bucket}
              variant={CHIP_VARIANT[c.bucket] ?? 'secondary'}
              className="px-2.5"
            >
              {c.label}: <strong className="font-semibold tabular-nums">{c.count}</strong>
            </Badge>
          ))}
        </div>
      )}
      <DetailSection flush>
        <Table className="min-w-[620px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead>Lot #</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={5}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No lots on hand.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow
                key={`${r.itemId}-${r.lotNumber}`}
                data-bucket={r.bucket}
                className={cn(ROW_TINT[r.bucket])}
              >
                <TableCell>
                  <div className="font-medium">{r.itemName}</div>
                  <div className="text-muted-foreground font-mono text-[11.5px]">
                    {r.sku ?? '—'}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-[12.5px]">{r.lotNumber}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {r.effectiveExpiry ? r.effectiveExpiry.slice(0, 10) : '—'}
                </TableCell>
                <TableCell className={cn('whitespace-nowrap', STATUS_TONE[r.bucket])}>
                  {BUCKET_LABEL[r.bucket]}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.remaining}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>
    </div>
  );
}
