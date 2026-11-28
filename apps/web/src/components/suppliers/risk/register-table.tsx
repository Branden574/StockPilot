import Link from 'next/link';

import {
  VENDOR_RISK_DATA_LEVEL_WORDS,
  VENDOR_RISK_RISK_WORDS,
  VENDOR_RISK_SEVERITY_WORDS,
} from '@stockpilot/core';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  SUPPLIER_RISK_DUE_REMINDER_NOT_SENT,
  SUPPLIER_RISK_NOT_REVIEWED,
  SUPPLIER_RISK_REVIEW_DUE_WORDS,
  SUPPLIER_RISK_SUPPLIER_STATE_WORDS,
  supplierRiskDay,
  supplierRiskHardStopWords,
  supplierRiskResultTone,
  supplierRiskResultWords,
} from '@/lib/supplier-risk/words';
import { supplierNameAsText } from '@/lib/supplier-risk/reminder-words';
import type { SupplierRiskRegisterRow } from '@/server/services/supplier-risk';

const DUE_TONE = {
  overdue: 'destructive',
  due_today: 'warning',
  due_soon: 'warning',
  not_reviewed: 'outline',
  scheduled: 'secondary',
} as const;

/**
 * The vendor risk register: one row per supplier, in the order the page gives
 * (overdue first). Every name is text inside <bdi> (a manager typed it); a
 * renamed supplier says "Reviewed as" the name its review holds; an archived
 * or deleted one says so. An overridden result names what the rules gave, and
 * the hard stops are listed, never hidden.
 */
export function SupplierRiskRegisterTable({
  rows,
  headingId,
}: {
  rows: SupplierRiskRegisterRow[];
  headingId: string;
}) {
  return (
    <Table scrollLabelledBy={headingId} className="min-w-[860px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Supplier</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Risk left</TableHead>
          <TableHead>Open items</TableHead>
          <TableHead>Next review</TableHead>
          <TableHead className="w-24 text-right">Review</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.supplierId} data-supplier-id={row.supplierId}>
            <TableCell className="align-top">
              <bdi className="text-foreground font-medium [overflow-wrap:anywhere]">
                {row.supplierName}
              </bdi>
              {row.nameChanged && row.reviewedAsName ? (
                <span className="text-muted-foreground block text-[12px]">
                  Reviewed as <bdi>{row.reviewedAsName}</bdi>
                </span>
              ) : null}
              {row.supplierState !== 'active' ? (
                <Badge variant="outline" className="mt-1">
                  {SUPPLIER_RISK_SUPPLIER_STATE_WORDS[row.supplierState]}
                </Badge>
              ) : null}
              {row.draftReviewId ? (
                <span className="text-muted-foreground block text-[12px]">
                  A draft review is open.
                </span>
              ) : null}
            </TableCell>
            <TableCell className="align-top">
              {row.result ? (
                <>
                  <Badge variant={supplierRiskResultTone(row.result)}>
                    {supplierRiskResultWords(row.result)}
                  </Badge>
                  {row.overridden ? (
                    <span className="text-muted-foreground block text-[12px]">
                      Set by an admin. The rules gave: {supplierRiskResultWords(row.computedResult)}
                      .
                    </span>
                  ) : null}
                  {row.hardStops.length > 0 ? (
                    <ul className="text-muted-foreground mt-1 list-disc pl-4 text-[12px] leading-4">
                      {row.hardStops.map((stop) => (
                        <li key={stop}>{supplierRiskHardStopWords(stop)}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">{SUPPLIER_RISK_NOT_REVIEWED}</span>
              )}
            </TableCell>
            <TableCell className="align-top">
              {row.residualRisk ? VENDOR_RISK_RISK_WORDS[row.residualRisk] : '—'}
              {row.dataLevel ? (
                <span className="text-muted-foreground block text-[12px]">
                  {VENDOR_RISK_DATA_LEVEL_WORDS[row.dataLevel].label}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="align-top tabular-nums">
              {row.result ? row.openItems : '—'}
              {row.topOpenSeverity ? (
                <span className="text-muted-foreground block text-[12px]">
                  Most severe: {VENDOR_RISK_SEVERITY_WORDS[row.topOpenSeverity]}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="align-top">
              <span className="whitespace-nowrap">{supplierRiskDay(row.nextReviewOn)}</span>
              <Badge variant={DUE_TONE[row.reviewDue]} className="mt-1">
                {SUPPLIER_RISK_REVIEW_DUE_WORDS[row.reviewDue]}
              </Badge>
              {row.dueReminder === 'not_sent' ? (
                <span className="text-destructive block text-[12px]">
                  {SUPPLIER_RISK_DUE_REMINDER_NOT_SENT}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="text-right align-top">
              <Link
                href={`/dashboard/suppliers/${row.supplierId}/risk`}
                className="text-accent hover:text-foreground underline-offset-4 hover:underline"
                aria-label={`Open the vendor review of ${supplierNameAsText(row.supplierName) || 'a supplier'}`}
              >
                Open
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
