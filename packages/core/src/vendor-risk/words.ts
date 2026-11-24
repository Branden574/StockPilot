/**
 * VENDOR RISK REVIEWS, the words the pages show beside the rules: the results,
 * the evidence and risk levels, the item statuses, the rules in plain words,
 * the honest limits, and the database's refusals.
 *
 * Plain text only. No speaker, company or product is named here.
 */

import type {
  VendorRiskAnswerProblem,
  VendorRiskEvidence,
  VendorRiskItemStatus,
  VendorRiskResult,
  VendorRiskRiskLevel,
} from './rules';

export const VENDOR_RISK_RESULT_WORDS: Readonly<Record<VendorRiskResult, string>> = {
  approve: 'Approve',
  approve_with_conditions: 'Approve with conditions',
  more_information: 'More information needed',
  do_not_use: 'Do not use',
};

export const VENDOR_RISK_EVIDENCE_WORDS: Readonly<
  Record<VendorRiskEvidence, { label: string; description: string }>
> = {
  not_needed: {
    label: 'Not needed',
    description: 'They keep none of our data, so there is nothing to show.',
  },
  strong: { label: 'Strong', description: 'Every answer is Yes.' },
  adequate: { label: 'Adequate', description: 'One or two gaps, none of them a key paper.' },
  weak: { label: 'Weak', description: 'Three gaps or more, or a key paper they do not have.' },
  insufficient: {
    label: 'Not enough to judge',
    description:
      'A key paper was not shown to us, or more than half the answers were not shown to us.',
  },
};

export const VENDOR_RISK_RISK_WORDS: Readonly<Record<VendorRiskRiskLevel, string>> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
};

export const VENDOR_RISK_ITEM_STATUS_WORDS: Readonly<Record<VendorRiskItemStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  accepted: 'Risk accepted',
};

/** The key papers, named as the evidence rule names them. */
export const VENDOR_RISK_KEY_PAPERS_WORDS =
  'the signed data agreement, the time for telling us about a breach, and the security report';

/** The rules, in the order they apply, for the page to show beside the result (never hidden). */
export const VENDOR_RISK_RULES_TEXT: readonly string[] = [
  'The questions asked depend on what they hold: none with no data of ours, nine with staff contact details, all fourteen with student data.',
  'A gap is a question answered No or Not shown to us. Not shown to us is never counted as Yes.',
  'Starting risk comes from what they hold: Low with no data of ours, Moderate with staff contact details, High with student data.',
  `Evidence is Not enough to judge when a key paper (${VENDOR_RISK_KEY_PAPERS_WORDS}) was not shown to us, or more than half the answers were not shown to us; Weak when a key paper is No or there are three gaps or more; Adequate with one or two gaps; Strong with none.`,
  'With student data, four answers stop the review on their own: no signed data agreement; no time for telling us about a breach; a contract that does not forbid selling student data or using it for advertising; a contract that does not forbid using it to train AI.',
  'Risk left is High when one of those applies; Low when the evidence is Strong; one step below the starting risk when it is Adequate; the starting risk otherwise.',
  'The result is Do not use when one of those four applies; More information needed when one of them was not shown to us, or the evidence is Not enough to judge; Approve with no gap; Approve with conditions otherwise, and the items are the conditions.',
  'You can set a different result. Write down why: the reason is kept with the review.',
];

/** The honest limits, written on the page. */
export const VENDOR_RISK_LIMITS: readonly string[] = [
  'This review records your own reading of what the vendor showed you.',
  'Not shown to us is a finding, not a pass.',
  "A vendor's claim is not a report: answer Yes only for a document you have seen.",
  'StockPilot does not check a vendor, read their documents or give legal advice.',
];

/**
 * The database's refusals (0481), by the code it gives as the message and the
 * hint, in words for the page. The not-allowed and second-step refusals
 * (supplier_risk_not_allowed, mfa_required, aal2_required) are the app's
 * usual ones and are not repeated here.
 */
export type VendorRiskRefusal =
  | VendorRiskAnswerProblem
  | 'supplier_not_found'
  | 'supplier_archived'
  | 'bad_next_review_on'
  | 'bad_override'
  | 'bad_override_reason'
  | 'items_not_an_array'
  | 'bad_item'
  | 'bad_item_text'
  | 'items_do_not_match_answers'
  | 'item_owner_not_a_member'
  | 'bad_item_due_on'
  | 'bad_item_status'
  | 'item_not_found'
  | 'item_not_current';

export const VENDOR_RISK_REFUSAL_WORDS: Readonly<Record<VendorRiskRefusal, string>> = {
  bad_data_level: 'Choose what they hold of ours.',
  answers_not_an_object: 'The answers could not be read. Reload the page and try again.',
  answer_unknown_question:
    'One answer is for a question this review does not have. Reload the page and try again.',
  answer_not_applicable:
    'One answer is for a question that is not asked for what they hold. Clear it and try again.',
  answer_bad_shape: 'One answer could not be read. Reload the page and try again.',
  answer_bad_value: 'Answer each question Yes, No or Not shown to us.',
  answer_bad_note: 'A note must be 1 to 1,000 characters of plain text.',
  answer_date_not_allowed: 'One answer has a date where the question takes none.',
  answer_bad_date: 'A date must be a real date between 2000 and 2100.',
  answers_incomplete: 'Answer every question before you finish the review.',
  supplier_not_found: 'This supplier was not found in this workspace.',
  supplier_archived: 'This supplier is archived. Restore it to review it.',
  bad_next_review_on: 'The next review must be after today and within three years.',
  bad_override: 'Choose a different result from the one the rules give, or none.',
  bad_override_reason:
    'Write why you set a different result: 10 to 2,000 characters of plain text.',
  items_not_an_array: 'The items could not be read. Reload the page and try again.',
  bad_item: 'One item could not be read. Reload the page and try again.',
  bad_item_text: 'A finding must be 1 to 500 characters and an action 1 to 1,000, in plain text.',
  items_do_not_match_answers: 'The items do not match the answers. Reload the page and try again.',
  item_owner_not_a_member: 'An item owner must be a current member of this workspace.',
  bad_item_due_on: 'A due date must be today or later, and within three years.',
  bad_item_status: 'Choose Open, In progress, Done or Risk accepted.',
  item_not_found: 'This item was not found in this workspace.',
  item_not_current:
    "This item belongs to an earlier review. Only the current review's items can be changed.",
};
