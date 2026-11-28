import {
  VENDOR_RISK_ANSWER_WORDS,
  VENDOR_RISK_DATA_LEVEL_WORDS,
  VENDOR_RISK_GROUP_WORDS,
  VENDOR_RISK_GROUPS,
  vendorRiskQuestionsFor,
  type VendorRiskAnswers,
  type VendorRiskDataLevel,
} from '@stockpilot/core';

import { DetailSection } from '@/components/patterns/detail-section';
import { supplierRiskDay } from '@/lib/supplier-risk/words';

/**
 * A version's answers, read-only, in the form's four groups (the Student data
 * group only when they hold student data). A note is shown exactly as
 * written, as text. An unanswered question says so: it counts as Not shown
 * to us, never as a pass.
 */
export function SupplierRiskAnswersList({
  title,
  dataLevel,
  answers,
}: {
  title: string;
  dataLevel: VendorRiskDataLevel | null;
  answers: VendorRiskAnswers;
}) {
  if (!dataLevel) {
    return (
      <DetailSection title={title} headingLevel={2}>
        <p className="text-muted-foreground text-[13px]">What they hold was not chosen yet.</p>
      </DetailSection>
    );
  }
  const asked = vendorRiskQuestionsFor(dataLevel);
  return (
    <DetailSection title={title} headingLevel={2} data-slot="supplier-risk-answers">
      <p className="text-ink-2 mb-3 text-[13px]">
        What they hold: {VENDOR_RISK_DATA_LEVEL_WORDS[dataLevel].label}.{' '}
        {asked.length === 0 ? 'No question is asked for this.' : null}
      </p>
      {VENDOR_RISK_GROUPS.map((group) => {
        const questions = asked.filter((q) => q.group === group);
        if (questions.length === 0) return null;
        return (
          <div key={group} className="mb-4 last:mb-0">
            <h3 className="text-foreground mb-1 text-[13px] font-medium">
              {VENDOR_RISK_GROUP_WORDS[group].title}
            </h3>
            <dl className="divide-border divide-y text-[13px] leading-5">
              {questions.map((q) => {
                const entry = answers[q.key];
                return (
                  <div key={q.key} className="py-2">
                    <dt className="text-ink-2">{q.text}</dt>
                    <dd className="text-foreground mt-0.5">
                      {entry
                        ? VENDOR_RISK_ANSWER_WORDS[entry.answer]
                        : 'Not answered (counts as Not shown to us)'}
                      {q.date && entry?.date
                        ? ` · ${q.date.label}: ${supplierRiskDay(entry.date)}`
                        : null}
                      {entry?.note ? (
                        <span
                          className="text-muted-foreground mt-0.5 block whitespace-pre-wrap [overflow-wrap:anywhere]"
                          dir="auto"
                        >
                          {entry.note}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        );
      })}
    </DetailSection>
  );
}
