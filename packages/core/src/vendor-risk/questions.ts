/**
 * VENDOR RISK REVIEWS, the fixed parts: the three data levels, the answers,
 * the four groups and the fourteen questions an organization admin answers
 * about one supplier (the app's word for a vendor), each with its words.
 *
 * The database holds the same list (migration 0481, the block between the
 * vendor-risk-questions markers in _supplier_risk_questions) and refuses an
 * answer whose key or value is not on it; vendor-risk.parity.test.ts holds the
 * two lists equal, field by field. The rules are versioned: every review stores
 * the rules version it was judged under (VENDOR_RISK_RULES_VERSION), and a
 * stored review keeps it. Once a review is finished anywhere, a change here is
 * a change there under a new rules version, with the old version's list and
 * rules kept beside it (the database holds every stored final to its own
 * version's rules).
 *
 * Every question is put so that Yes is the safe answer, and Yes means the
 * admin has SEEN it (a document, a contract clause, a report). A vendor's
 * claim is not Yes. "Not shown to us" is a finding, never a pass.
 *
 * Pure: no I/O, no clock.
 */

/** The rule set a review is judged by. The database stores it on every review. */
export const VENDOR_RISK_RULES_VERSION = 1 as const;

/** What the vendor holds of ours, least to most. */
export const VENDOR_RISK_DATA_LEVELS = ['none', 'staff', 'student'] as const;
export type VendorRiskDataLevel = (typeof VENDOR_RISK_DATA_LEVELS)[number];

export const VENDOR_RISK_DATA_LEVEL_WORDS: Readonly<
  Record<VendorRiskDataLevel, { label: string; description: string }>
> = {
  none: {
    label: 'No data of ours',
    description:
      'They keep none of our data: for example, we order from them on paper and pay by check.',
  },
  staff: {
    label: 'Staff contact details',
    description:
      'Names, work emails or phone numbers of our staff, for example from our purchase orders.',
  },
  student: {
    label: 'Student data',
    description: 'Anything about a student: a name, a grade, a record, a photo or a sign-in.',
  },
};

/** The three answers every question takes. */
export const VENDOR_RISK_ANSWERS = ['yes', 'no', 'not_shown'] as const;
export type VendorRiskAnswer = (typeof VENDOR_RISK_ANSWERS)[number];

export const VENDOR_RISK_ANSWER_WORDS: Readonly<Record<VendorRiskAnswer, string>> = {
  yes: 'Yes',
  no: 'No',
  not_shown: 'Not shown to us',
};

/**
 * The answer an item records: No, Not shown to us, or Out of date (a Yes whose
 * report or certificate is dated too long before the review: it counts as Not
 * shown to us).
 */
export const VENDOR_RISK_ITEM_ANSWERS = ['no', 'not_shown', 'out_of_date'] as const;
export type VendorRiskItemAnswer = (typeof VENDOR_RISK_ITEM_ANSWERS)[number];

export const VENDOR_RISK_ITEM_ANSWER_WORDS: Readonly<Record<VendorRiskItemAnswer, string>> = {
  no: 'No',
  not_shown: 'Not shown to us',
  out_of_date: 'Out of date (counted as not shown to us)',
};

/** The four groups, in the order the form shows them. */
export const VENDOR_RISK_GROUPS = ['holds', 'paper', 'proof', 'student'] as const;
export type VendorRiskGroup = (typeof VENDOR_RISK_GROUPS)[number];

export const VENDOR_RISK_GROUP_WORDS: Readonly<
  Record<VendorRiskGroup, { title: string; description: string }>
> = {
  holds: {
    title: 'What they hold',
    description: 'Which of our data they keep, and how it gets to them.',
  },
  paper: { title: 'Paper', description: 'What the contract and the data agreement say.' },
  proof: { title: 'Proof', description: 'Reports and certificates we have seen ourselves.' },
  student: {
    title: 'Student data',
    description:
      'Only when they hold student data: the conditions for sharing it with them, and what they may not do with it.',
  },
};

/** How serious one gap is. */
export const VENDOR_RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type VendorRiskSeverity = (typeof VENDOR_RISK_SEVERITIES)[number];

export const VENDOR_RISK_SEVERITY_WORDS: Readonly<Record<VendorRiskSeverity, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/**
 * The rules that override the sum: any one of them makes the result "Do not
 * use". Each is a No to one question, and applies only with student data (the
 * design lists "no breach notice" with no condition; here every hard stop needs
 * student data, so a vendor that holds only staff contact details is never
 * stopped by one).
 */
export const VENDOR_RISK_HARD_STOPS = [
  'student_data_no_agreement',
  'student_data_no_breach_notice',
  'student_data_no_direct_control',
  'student_data_no_purpose_limit',
  'student_data_redisclosure',
  'student_data_sale_or_ads',
  'student_data_ai_training',
] as const;
export type VendorRiskHardStop = (typeof VENDOR_RISK_HARD_STOPS)[number];

export const VENDOR_RISK_HARD_STOP_WORDS: Readonly<Record<VendorRiskHardStop, string>> = {
  student_data_no_agreement: 'They hold student data and there is no signed data agreement.',
  student_data_no_breach_notice:
    'They hold student data and the contract does not say how soon they must tell us about a breach.',
  student_data_no_direct_control:
    'The contract does not keep their use and keeping of student data under our direct control.',
  student_data_no_purpose_limit:
    'The contract does not limit their use of student data to the service we buy.',
  student_data_redisclosure:
    'The contract does not forbid them passing student data on without our written permission.',
  student_data_sale_or_ads:
    'The contract does not forbid selling student data or using it for advertising.',
  student_data_ai_training: 'The contract does not forbid using student data to train AI.',
};

export const VENDOR_RISK_QUESTION_KEYS = [
  'data_listed',
  'data_we_send',
  'hosting_known',
  'data_agreement',
  'breach_notice',
  'return_or_delete',
  'subvendors_named',
  'security_report',
  'insurance',
  'direct_control',
  'purpose_only',
  'no_redisclosure',
  'no_sale_or_ads',
  'no_ai_training',
] as const;
export type VendorRiskQuestionKey = (typeof VENDOR_RISK_QUESTION_KEYS)[number];

export interface VendorRiskQuestion {
  key: VendorRiskQuestionKey;
  group: VendorRiskGroup;
  /** The question, put so that Yes is the safe answer. */
  text: string;
  /** What counts as Yes. */
  help: string;
  /**
   * A date the form asks for beside the answer (never invented), or null when
   * none applies. maxAgeMonths: the date is judged. A Yes then NEEDS its date
   * (the date on the document: a finished review without it is refused,
   * answer_date_missing), the date may not be later than tomorrow in UTC
   * (answer_date_in_future, whatever the answer), and a Yes dated more than
   * this many months before the review counts as Not shown to us (out of
   * date). null: the date is kept, optional and not judged.
   */
  date: { label: string; maxAgeMonths: number | null } | null;
  /**
   * Asked only when they hold student data. Every question needs some data of
   * ours: with the level "No data of ours" none is asked.
   */
  studentDataOnly: boolean;
  /** One of the key papers: Not shown makes the evidence "not enough to judge", No makes it weak. */
  keyEvidence: boolean;
  /** The hard stop a No makes when they hold student data, or null. */
  hardStop: VendorRiskHardStop | null;
  /** The severity of the item a No or Not shown makes, by level (null where the question is not asked). */
  severity: { staff: VendorRiskSeverity | null; student: VendorRiskSeverity };
  /** The item's finding, for each answer that makes one (out_of_date only where a date is judged). */
  finding: { no: string; not_shown: string; out_of_date?: string };
  /** What to do, suggested for the item (the admin may change it). */
  action: string;
  /** The question to put to the vendor, for the list to paste into an email. */
  followUp: string;
}

export const VENDOR_RISK_QUESTIONS: readonly VendorRiskQuestion[] = [
  {
    key: 'data_listed',
    group: 'holds',
    text: 'Have they told us in writing which of our data they keep?',
    help: 'Yes when we have it in writing: a data agreement, a privacy notice for this product, or a letter or email from them.',
    date: null,
    studentDataOnly: false,
    keyEvidence: false,
    hardStop: null,
    severity: { staff: 'low', student: 'medium' },
    finding: {
      no: 'They will not say in writing which of our data they keep.',
      not_shown: 'We have not seen in writing which of our data they keep.',
    },
    action: 'Ask them for a written list of the data of ours they keep.',
    followUp:
      'Please send us, in writing, a list of the data of ours that you keep for this product.',
  },
  {
    key: 'data_we_send',
    group: 'holds',
    text: 'Does our data reach them only in ways we set up (we send it, or we type it in)?',
    help: 'No when they collect it themselves, or copy it from one of our systems in a way we did not set up.',
    date: null,
    studentDataOnly: false,
    keyEvidence: false,
    hardStop: null,
    severity: { staff: 'low', student: 'medium' },
    finding: {
      no: 'Our data reaches them in ways we did not set up.',
      not_shown: 'We do not know every way our data reaches them.',
    },
    action: 'Find out every way our data reaches them, and stop any way we did not choose.',
    followUp:
      'Please tell us every way data of ours reaches you: what we send, what you collect yourselves, and any link to our other systems.',
  },
  {
    key: 'hosting_known',
    group: 'holds',
    text: 'Do we know where they keep our data (which country, and which hosting company)?',
    help: 'Yes when they have told us both, in writing.',
    date: null,
    studentDataOnly: false,
    keyEvidence: false,
    hardStop: null,
    severity: { staff: 'low', student: 'medium' },
    finding: {
      no: 'They will not say where they keep our data.',
      not_shown: 'We do not know where they keep our data.',
    },
    action: 'Ask them which country, and which hosting company, hold our data.',
    followUp:
      'Please tell us in which country our data is kept, and which hosting company holds it.',
  },
  {
    key: 'data_agreement',
    group: 'paper',
    text: 'Is a data agreement signed with them?',
    help: 'Yes only when it is signed by both sides. One offered but not signed is No.',
    date: { label: 'Date signed', maxAgeMonths: null },
    studentDataOnly: false,
    keyEvidence: true,
    hardStop: 'student_data_no_agreement',
    severity: { staff: 'medium', student: 'critical' },
    finding: {
      no: 'There is no signed data agreement.',
      not_shown: 'We have not seen a signed data agreement.',
    },
    action: 'Sign a data agreement with them before more of our data is sent.',
    followUp:
      'Please send us a copy of the data agreement signed by both sides, or tell us when you can sign ours.',
  },
  {
    key: 'breach_notice',
    group: 'paper',
    text: 'Does the contract say how soon they must tell us about a breach of our data?',
    help: 'Yes when the contract names a time, for example 72 hours.',
    date: null,
    studentDataOnly: false,
    keyEvidence: true,
    hardStop: 'student_data_no_breach_notice',
    severity: { staff: 'medium', student: 'critical' },
    finding: {
      no: 'The contract does not say how soon they must tell us about a breach.',
      not_shown: 'We have not seen how soon they must tell us about a breach.',
    },
    action: 'Add a time for telling us about a breach to the contract (for example 72 hours).',
    followUp:
      'How soon after finding a breach of our data will you tell us? Please show us where the contract says so.',
  },
  {
    key: 'return_or_delete',
    group: 'paper',
    text: 'Does the contract say our data is returned or deleted when we stop using them?',
    help: 'Yes when the contract says so, and says how they confirm it.',
    date: null,
    studentDataOnly: false,
    keyEvidence: false,
    hardStop: null,
    severity: { staff: 'low', student: 'high' },
    finding: {
      no: 'The contract does not say our data is returned or deleted at the end.',
      not_shown: 'We have not seen what happens to our data when we stop using them.',
    },
    action:
      'Agree in writing that our data is returned or deleted when the contract ends, and how they confirm it.',
    followUp:
      'When we stop using you, what happens to our data? Please show us where the contract says it is returned or deleted, and how you confirm it.',
  },
  {
    key: 'subvendors_named',
    group: 'paper',
    text: 'Have they named the other companies that handle our data for them?',
    help: 'Yes when we have the list, and they tell customers before it changes.',
    date: null,
    studentDataOnly: false,
    keyEvidence: false,
    hardStop: null,
    severity: { staff: 'low', student: 'high' },
    finding: {
      no: 'They will not name the other companies that handle our data.',
      not_shown: 'We have not seen a list of the other companies that handle our data.',
    },
    action:
      'Ask for the list of other companies that handle our data, and to be told before it changes.',
    followUp:
      'Please send us the list of other companies that handle our data for you, and tell us how you let customers know before it changes.',
  },
  {
    key: 'security_report',
    group: 'proof',
    text: 'Have they shown us a SOC 2 Type II or ISO 27001 report that covers this product?',
    help: 'Yes only for the report itself, and only when it covers the product we use. A badge, a claim on their website or a report on another product is No. Give the date its period ended: a report whose period ended more than 12 months before the review counts as Not shown to us.',
    date: { label: 'Report period end', maxAgeMonths: 12 },
    studentDataOnly: false,
    keyEvidence: true,
    hardStop: null,
    severity: { staff: 'medium', student: 'high' },
    finding: {
      no: 'They have no SOC 2 Type II or ISO 27001 report that covers this product.',
      not_shown: 'We have not seen a SOC 2 Type II or ISO 27001 report that covers this product.',
      out_of_date:
        'The report we have seen is out of date: its period ended more than 12 months before this review.',
    },
    action:
      'Ask for a current SOC 2 Type II or ISO 27001 report that covers this product, or for their answers to a security questionnaire.',
    followUp:
      'Please send us your latest SOC 2 Type II report, or your ISO 27001 certificate with its scope, that covers this product, with the date its period ends.',
  },
  {
    key: 'insurance',
    group: 'proof',
    text: 'Have they shown us proof of cyber insurance?',
    help: 'Yes when we have seen a certificate of insurance; give the date on it. One dated more than 12 months before the review counts as Not shown to us.',
    date: { label: 'Date on the certificate', maxAgeMonths: 12 },
    studentDataOnly: false,
    keyEvidence: false,
    hardStop: null,
    severity: { staff: 'low', student: 'medium' },
    finding: {
      no: 'They have no cyber insurance.',
      not_shown: 'We have not seen proof of cyber insurance.',
      out_of_date:
        'The proof of cyber insurance we have seen is out of date: dated more than 12 months before this review.',
    },
    action: 'Ask for a certificate of their cyber insurance.',
    followUp:
      'Please send us a certificate of your cyber insurance, dated within the last 12 months.',
  },
  {
    key: 'direct_control',
    group: 'student',
    text: 'Does the contract keep their use and keeping of student data under our direct control?',
    help: 'One of the conditions for sharing student records with a vendor as a school official (FERPA). With student data, a No is Do not use.',
    date: null,
    studentDataOnly: true,
    keyEvidence: false,
    hardStop: 'student_data_no_direct_control',
    severity: { staff: null, student: 'critical' },
    finding: {
      no: 'The contract does not keep student data under our direct control.',
      not_shown: 'We have not seen terms that keep student data under our direct control.',
    },
    action:
      'Send no student data until the contract has terms that keep their use and keeping of student data under our direct control.',
    followUp:
      'Please show us where the contract says that your use and keeping of student data is under our direct control.',
  },
  {
    key: 'purpose_only',
    group: 'student',
    text: 'Does the contract limit their use of student data to the service we buy?',
    help: 'One of the conditions for sharing student records with a vendor as a school official (FERPA). With student data, a No is Do not use.',
    date: null,
    studentDataOnly: true,
    keyEvidence: false,
    hardStop: 'student_data_no_purpose_limit',
    severity: { staff: null, student: 'critical' },
    finding: {
      no: 'The contract does not limit their use of student data to the service we buy.',
      not_shown:
        'We have not seen terms that limit their use of student data to the service we buy.',
    },
    action:
      'Send no student data until the contract has terms that limit their use of student data to the service we buy.',
    followUp:
      'Please show us where the contract limits your use of student data to the service we buy.',
  },
  {
    key: 'no_redisclosure',
    group: 'student',
    text: 'Does the contract forbid them passing student data on without our written permission?',
    help: 'One of the conditions for sharing student records with a vendor as a school official (FERPA). With student data, a No is Do not use.',
    date: null,
    studentDataOnly: true,
    keyEvidence: false,
    hardStop: 'student_data_redisclosure',
    severity: { staff: null, student: 'critical' },
    finding: {
      no: 'The contract does not forbid passing student data on without our permission.',
      not_shown:
        'We have not seen terms that forbid passing student data on without our permission.',
    },
    action:
      'Send no student data until the contract has terms that forbid passing student data on without our written permission.',
    followUp:
      'Please show us where the contract forbids you passing student data to anyone else without our written permission.',
  },
  {
    key: 'no_sale_or_ads',
    group: 'student',
    text: 'Does the contract forbid selling student data or using it for advertising?',
    help: 'Yes only when the contract says so in its own words, targeted advertising included.',
    date: null,
    studentDataOnly: true,
    keyEvidence: false,
    hardStop: 'student_data_sale_or_ads',
    severity: { staff: null, student: 'critical' },
    finding: {
      no: 'The contract does not forbid selling student data or using it for advertising.',
      not_shown:
        'We have not seen terms that forbid selling student data or using it for advertising.',
    },
    action:
      'Send no student data until the contract forbids selling it or using it for advertising.',
    followUp:
      'Please show us where the contract forbids selling student data or using it for advertising, targeted advertising included.',
  },
  {
    key: 'no_ai_training',
    group: 'student',
    text: 'Does the contract forbid using student data to train AI?',
    help: "Yes only when the contract says so in its own words, for their AI and anyone else's.",
    date: null,
    studentDataOnly: true,
    keyEvidence: false,
    hardStop: 'student_data_ai_training',
    severity: { staff: null, student: 'critical' },
    finding: {
      no: 'The contract does not forbid using student data to train AI.',
      not_shown: 'We have not seen terms that forbid using student data to train AI.',
    },
    action: 'Send no student data until the contract forbids using it to train AI.',
    followUp:
      "Please show us where the contract forbids using student data to train AI, yours or anyone else's.",
  },
];

const QUESTION_BY_KEY: ReadonlyMap<string, VendorRiskQuestion> = new Map(
  VENDOR_RISK_QUESTIONS.map((q) => [q.key, q]),
);

/** The question with this key, or null for a key that is not on the list. */
export function vendorRiskQuestion(key: string): VendorRiskQuestion | null {
  return QUESTION_BY_KEY.get(key) ?? null;
}

export function isVendorRiskDataLevel(v: unknown): v is VendorRiskDataLevel {
  return typeof v === 'string' && (VENDOR_RISK_DATA_LEVELS as readonly string[]).includes(v);
}

export function isVendorRiskAnswer(v: unknown): v is VendorRiskAnswer {
  return typeof v === 'string' && (VENDOR_RISK_ANSWERS as readonly string[]).includes(v);
}

/** Is this question asked at this level? None is asked with "No data of ours". */
export function vendorRiskQuestionApplies(
  q: VendorRiskQuestion,
  level: VendorRiskDataLevel,
): boolean {
  if (level === 'none') return false;
  return !q.studentDataOnly || level === 'student';
}

/** The questions asked at this level, in the form's order. */
export function vendorRiskQuestionsFor(level: VendorRiskDataLevel): VendorRiskQuestion[] {
  return VENDOR_RISK_QUESTIONS.filter((q) => vendorRiskQuestionApplies(q, level));
}
