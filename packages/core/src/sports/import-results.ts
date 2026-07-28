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
 * The line columns whose value could only have come from a SPORTS field
 * mapping (migration 0301). `serial_hint` is in the list because a serial
 * column is one of the meanings a bare "Number" header can turn out to have.
 */
export const SPORTS_MAPPED_LINE_FIELDS = [
  'variant_size',
  'variant_size_original',
  'variant_size_system',
  'variant_width',
  'variant_fit',
  'variant_color',
  'jersey_number',
  'player_name',
  'group_hint',
  'serial_hint',
] as const;

export type SportsMappedLineField = (typeof SPORTS_MAPPED_LINE_FIELDS)[number];

/** Human label per mapped field, so a review screen can NAME what it is
 *  showing instead of printing a column identifier. Display only. */
export const SPORTS_MAPPED_LINE_FIELD_LABELS: Record<SportsMappedLineField, string> = {
  variant_size: 'Size',
  variant_size_original: 'Size as printed',
  variant_size_system: 'Size system',
  variant_width: 'Width',
  variant_fit: 'Fit',
  variant_color: 'Colour',
  jersey_number: 'Jersey / uniform number',
  player_name: 'Player name',
  group_hint: 'Style / product',
  serial_hint: 'Serial number',
};

/**
 * The sports values the extractor actually put on this line, field by field.
 *
 * ONE definition of "what is on the table in the confirmation step", shared by
 * the modal that RENDERS the values and the service that CLEARS them. They used
 * to disagree: the predicate below flags a line on ANY of the ten fields while
 * the modal showed `jersey_number` alone and the write touched `jersey_number`
 * alone — so a low-confidence size, colour or style-hint was invisible to the
 * reviewer AND survived an explicit "Ignore this column" at mapping_confidence
 * 1, i.e. was silently applied. A decision has to be able to name everything it
 * decides about.
 *
 * Order follows SPORTS_MAPPED_LINE_FIELDS so the modal reads the same way every
 * time. Blank strings are not values (see `lineCarriesSportsMapping`).
 */
export function flaggedSportsMappings(
  line: Partial<Record<SportsMappedLineField, string | null>>,
): Array<{ field: SportsMappedLineField; label: string; value: string }> {
  const out: Array<{ field: SportsMappedLineField; label: string; value: string }> = [];
  for (const field of SPORTS_MAPPED_LINE_FIELDS) {
    const v = line[field];
    if (typeof v === 'string' && v.trim().length > 0) {
      out.push({ field, label: SPORTS_MAPPED_LINE_FIELD_LABELS[field], value: v });
    }
  }
  return out;
}

/** True when the extractor actually put a value in a sports field on this line. */
export function lineCarriesSportsMapping(
  line: Partial<Record<SportsMappedLineField, string | null>>,
): boolean {
  return SPORTS_MAPPED_LINE_FIELDS.some((f) => {
    const v = line[f];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

/**
 * THE predicate for "this line's column mapping must be confirmed by a human".
 *
 * ONE definition, shared by the resolver, `approve()`, the web review screen
 * and the Expo screen, so a line the server refuses is always a line the UI
 * offered a control for — and vice versa.
 *
 * SCOPED TO SPORTS MAPPINGS (review fix). A bare confidence test blocked
 * approval on EVERY AI-scanned import, sports or not: the extractor emits
 * `mappingConfidence` for every line it reads, so an ordinary non-sports PO
 * with one awkward column header became unapprovable — a regression on a
 * chassis that has been in production since long before the sports program.
 *
 * The gate exists to stop a MIS-MAPPED value from becoming permanent identity
 * (a "Number" column silently becoming a jersey number). When the extractor
 * mapped nothing into any sports field, there is no such value on the line and
 * nothing for a human to confirm, so the line behaves exactly as it did before
 * sports existed. A low confidence with a sports value present still blocks.
 */
export function lineNeedsMappingConfirmation(
  line: {
    mapping_confidence: number | null;
  } & Partial<Record<(typeof SPORTS_MAPPED_LINE_FIELDS)[number], string | null>>,
): boolean {
  if (line.mapping_confidence == null) return false;
  if (line.mapping_confidence >= IMPORT_MAPPING_CONFIDENCE_THRESHOLD) return false;
  return lineCarriesSportsMapping(line);
}

/**
 * What an ambiguous source column may turn out to mean.
 *
 * A bare "Number" column is the canonical case — it could be a jersey number,
 * a quantity, a serial, a style number, or a PO line number. The human picks;
 * nothing here is ever chosen automatically.
 *
 * `confirm` and `ignore` are the two answers that apply to the WHOLE line
 * rather than to a number column: a line flagged only on its size or colour has
 * no "Number" to reinterpret, and before `confirm` existed the step offered it
 * nothing truthful to say. `ignore` CLEARS every flagged value on the line
 * (`flaggedSportsMappings`); `confirm` keeps them. Neither ever writes a value
 * the document did not print.
 */
export const AMBIGUOUS_COLUMN_MEANINGS = [
  'jersey_number',
  'quantity',
  'serial',
  'style_number',
  'line_number',
  'confirm',
  'ignore',
] as const;
export type AmbiguousColumnMeaning = (typeof AMBIGUOUS_COLUMN_MEANINGS)[number];

export const AMBIGUOUS_COLUMN_MEANING_LABELS: Record<AmbiguousColumnMeaning, string> = {
  jersey_number: 'Jersey / uniform number',
  quantity: 'Quantity',
  serial: 'Serial number',
  style_number: 'Style / model number',
  line_number: 'PO line number',
  confirm: 'These values are right as read',
  ignore: 'Ignore — clear these values',
};

/**
 * The meanings that KEEP the line's flagged values. Everything not in here
 * clears them, which is what makes "never silently apply an unconfirmed AI
 * mapping" enforceable in one place instead of at three call sites.
 */
export function meaningKeepsFlaggedValues(meaning: AmbiguousColumnMeaning): boolean {
  return meaning !== 'ignore';
}
