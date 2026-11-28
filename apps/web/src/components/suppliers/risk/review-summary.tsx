import {
  VENDOR_RISK_DATA_LEVEL_WORDS,
  VENDOR_RISK_EVIDENCE_WORDS,
  VENDOR_RISK_RISK_WORDS,
} from '@stockpilot/core';

import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { Badge } from '@/components/ui/badge';
import {
  SUPPLIER_RISK_DUE_REMINDER_NOT_SENT,
  SUPPLIER_RISK_REVIEW_DUE_WORDS,
  supplierRiskDay,
  supplierRiskHardStopWords,
  supplierRiskResultTone,
  supplierRiskResultWords,
  supplierRiskWhen,
} from '@/lib/supplier-risk/words';
import type { SupplierDueReminder, SupplierRiskReview } from '@/server/services/supplier-risk';

import type { VendorRiskReviewDue } from '@stockpilot/core';

/**
 * One finished review: the result in force, and beside it every reason the
 * rules gave (what they hold and the starting risk, the evidence and what it
 * means, the risk left, the hard stops by name), and an override as "Set by
 * <name>: <reason>" next to what the rules gave. Names sit in <bdi>; a reason
 * is shown exactly as written, as text.
 */
export function SupplierRiskReviewSummary({
  review,
  title,
  reviewDue,
  dueReminder,
  reviewerAccountDeleted = false,
}: {
  review: SupplierRiskReview;
  title: string;
  reviewDue?: VendorRiskReviewDue | null;
  dueReminder?: SupplierDueReminder | null;
  reviewerAccountDeleted?: boolean;
}) {
  const level = review.dataLevel ? VENDOR_RISK_DATA_LEVEL_WORDS[review.dataLevel] : null;
  const evidence = review.evidence ? VENDOR_RISK_EVIDENCE_WORDS[review.evidence] : null;
  const overridden = review.overrideResult !== null;
  return (
    <DetailSection
      title={title}
      headingLevel={2}
      aside={<span className="text-muted-foreground text-[12px]">Version {review.version}</span>}
      flush
      data-slot="supplier-risk-summary"
    >
      <div className="space-y-3 px-[18px] pb-1 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-[13px]">Result</span>
          <Badge variant={supplierRiskResultTone(review.result)} data-slot="supplier-risk-result">
            {supplierRiskResultWords(review.result)}
          </Badge>
        </div>
        {overridden ? (
          <div
            className="text-ink-2 space-y-1 text-[13px] leading-5"
            data-slot="supplier-risk-override"
          >
            <p>
              The rules gave:{' '}
              <strong className="text-foreground font-medium">
                {supplierRiskResultWords(review.computedResult)}
              </strong>
              .
            </p>
            <p>
              Set by <bdi>{review.reviewerName ?? 'Unknown'}</bdi>:{' '}
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {review.overrideReason ?? ''}
              </span>
            </p>
          </div>
        ) : null}
        {review.hardStops.length > 0 ? (
          <div data-slot="supplier-risk-hard-stops">
            <p className="text-foreground text-[13px] font-medium">
              Hard stops (each one alone means Do not use)
            </p>
            <ul className="text-ink-2 mt-1 list-disc space-y-0.5 pl-5 text-[13px] leading-5">
              {review.hardStops.map((stop) => (
                <li key={stop}>{supplierRiskHardStopWords(stop)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground text-[13px]">No hard stop applies.</p>
        )}
      </div>
      <KeyValueList>
        <KeyValueRow label="What they hold">{level?.label ?? '—'}</KeyValueRow>
        <KeyValueRow label="Starting risk">
          {review.startingRisk ? VENDOR_RISK_RISK_WORDS[review.startingRisk] : '—'}
        </KeyValueRow>
        <KeyValueRow label="Evidence">
          {evidence ? `${evidence.label}: ${evidence.description}` : '—'}
        </KeyValueRow>
        <KeyValueRow label="Risk left">
          {review.residualRisk ? VENDOR_RISK_RISK_WORDS[review.residualRisk] : '—'}
        </KeyValueRow>
        <KeyValueRow label="Reviewed">
          {supplierRiskWhen(review.reviewedAt)}
          {review.reviewerName ? (
            <>
              {' by '}
              <bdi>{review.reviewerName}</bdi>
              {reviewerAccountDeleted ? ' (account deleted)' : ''}
            </>
          ) : null}
        </KeyValueRow>
        <KeyValueRow label="Next review">
          {supplierRiskDay(review.nextReviewOn)}
          {reviewDue && reviewDue !== 'scheduled' && reviewDue !== 'not_reviewed'
            ? ` (${SUPPLIER_RISK_REVIEW_DUE_WORDS[reviewDue]})`
            : ''}
        </KeyValueRow>
        {dueReminder === 'not_sent' ? (
          <KeyValueRow label="Due reminder">{SUPPLIER_RISK_DUE_REMINDER_NOT_SENT}</KeyValueRow>
        ) : null}
        <KeyValueRow label="Rules version">{review.rulesVersion ?? '—'}</KeyValueRow>
      </KeyValueList>
    </DetailSection>
  );
}
