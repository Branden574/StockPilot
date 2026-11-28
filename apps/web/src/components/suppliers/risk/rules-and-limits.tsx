import {
  VENDOR_RISK_LIMITS,
  VENDOR_RISK_RULES_TEXT,
  VENDOR_RISK_RULES_VERSION,
} from '@stockpilot/core';

import { DetailSection } from '@/components/patterns/detail-section';

/**
 * The honest limits (core's VENDOR_RISK_LIMITS), written on the page: what a
 * review is and what it is not.
 */
export function SupplierRiskLimits() {
  return (
    <DetailSection
      title="What a review is, and is not"
      headingLevel={2}
      data-slot="supplier-risk-limits"
    >
      <ul className="text-ink-2 list-disc space-y-1 pl-5 text-[13px] leading-5">
        {VENDOR_RISK_LIMITS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </DetailSection>
  );
}

/**
 * The rules in words (core's VENDOR_RISK_RULES_TEXT), shown beside the result
 * and never folded away: the result is never a number the admin cannot
 * follow.
 */
export function SupplierRiskRules() {
  return (
    <DetailSection
      title="How the result is worked out"
      headingLevel={2}
      aside={
        <span className="text-muted-foreground text-[12px]">
          Rules version {VENDOR_RISK_RULES_VERSION}
        </span>
      }
      data-slot="supplier-risk-rules"
    >
      <ol className="text-ink-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-5">
        {VENDOR_RISK_RULES_TEXT.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </DetailSection>
  );
}
