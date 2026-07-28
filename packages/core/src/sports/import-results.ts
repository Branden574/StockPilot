/**
 * The PO-import review vocabulary.
 *
 * A review row never says just "Valid" / "Invalid". It says WHAT will happen —
 * a new group, a new variant under an existing group, a receipt into a variant
 * that already exists — or WHY it cannot happen yet. Requirements: "ambiguous
 * -> review, never auto-merge", and "every decision visible in review".
 *
 * This module is pure and platform-free on purpose: the server resolver
 * (`po-imports-variants.ts`) produces these values, the web review table and
 * the Expo screen render them, and the two can never drift into different
 * label sets or different ideas about what blocks an approval.
 */

/** The review-table verdict for one line. Not just Valid/Invalid. */
export const LINE_RESULTS = [
  'create_new_group',
  'add_new_variant',
  'receive_into_existing_variant',
  'create_serialized_units',
  'possible_duplicate',
  'missing_required_attribute',
  'ambiguous_category',
  'ambiguous_variant_match',
  'serial_required',
  'mapping_review_required',
  'ready',
] as const;
export type LineResult = (typeof LINE_RESULTS)[number];

/** Human label for the Result cell. Display only — never a decision input. */
export const LINE_RESULT_LABELS: Record<LineResult, string> = {
  create_new_group: 'New product group',
  add_new_variant: 'New variant',
  receive_into_existing_variant: 'Existing variant',
  create_serialized_units: 'New serialized units',
  possible_duplicate: 'Possible duplicate',
  missing_required_attribute: 'Missing attribute',
  ambiguous_category: 'Ambiguous category',
  ambiguous_variant_match: 'Ambiguous match',
  serial_required: 'Serial mismatch',
  mapping_review_required: 'Confirm mapping',
  ready: 'Ready',
};

/**
 * Results that BLOCK approval until a human resolves them.
 *
 * Every one of these means the import does not know what the line is, and the
 * requirements forbid guessing: "ambiguous -> review, never auto-merge
 * uncertain matches" and "block import until required mappings resolved".
 *
 * `create_new_group` / `add_new_variant` / `receive_into_existing_variant` are
 * NOT blocking — those are decided outcomes, not open questions.
 */
export const BLOCKING_LINE_RESULTS = new Set<LineResult>([
  'possible_duplicate',
  'missing_required_attribute',
  'ambiguous_category',
  'ambiguous_variant_match',
  'serial_required',
  'mapping_review_required',
]);

export function lineResultBlocksApproval(result: LineResult): boolean {
  return BLOCKING_LINE_RESULTS.has(result);
}

/**
 * Below this, the AI's own FIELD-MAPPING confidence is too low to act on and
 * the line goes to the confirmation step first. Separate from extraction
 * confidence (how well the characters were read) on purpose — a perfectly
 * legible column headed "Number" is still ambiguous.
 */
export const IMPORT_MAPPING_CONFIDENCE_THRESHOLD = 0.7;

/**
 * What an ambiguous source column may turn out to mean.
 *
 * A bare "Number" column is the canonical case — it could be a jersey number,
 * a quantity, a serial, a style number, or a PO line number. The human picks;
 * nothing here is ever chosen automatically.
 */
export const AMBIGUOUS_COLUMN_MEANINGS = [
  'jersey_number',
  'quantity',
  'serial',
  'style_number',
  'line_number',
  'ignore',
] as const;
export type AmbiguousColumnMeaning = (typeof AMBIGUOUS_COLUMN_MEANINGS)[number];

export const AMBIGUOUS_COLUMN_MEANING_LABELS: Record<AmbiguousColumnMeaning, string> = {
  jersey_number: 'Jersey / uniform number',
  quantity: 'Quantity',
  serial: 'Serial number',
  style_number: 'Style / model number',
  line_number: 'PO line number',
  ignore: 'Ignore this column',
};
