import { z } from 'zod';

import { AMBIGUOUS_COLUMN_MEANINGS } from '../sports/import-results';

export const poImportLineTypeSchema = z.enum([
  'inventory',
  'tax',
  'freight',
  'service',
  'fee',
  'discount',
  'unknown',
]);
export type PoImportLineType = z.infer<typeof poImportLineTypeSchema>;

export const poImportMatchStatusSchema = z.enum([
  'exact_match',
  'mapped',
  'suggested',
  'needs_review',
  'rejected',
  'non_inventory',
]);
export type PoImportMatchStatus = z.infer<typeof poImportMatchStatusSchema>;

export const poImportStatusSchema = z.enum([
  'uploaded',
  'parsing',
  'parsed',
  'needs_review',
  'approved',
  'failed',
  'duplicate',
  'canceled',
]);
export type PoImportStatus = z.infer<typeof poImportStatusSchema>;

/**
 * Ceiling for po_imports.display_name — the SAME number the column's CHECK
 * enforces (`length(display_name) between 1 and 160`, migration 0332). Kept as
 * a constant so the UI's counter, the zod bound and the DB guard can only ever
 * be changed together.
 */
export const PO_IMPORT_DISPLAY_NAME_MAX = 160;

/**
 * Characters an import name may not contain: the ASCII control range plus DEL,
 * plus the Unicode bidirectional overrides/isolates.
 *
 * This is the SAME class `sanitizeName` uses in
 * apps/web/src/server/actions/profile.ts:24-25 — deliberately reused rather
 * than re-derived, because two slightly different "unsafe name character"
 * definitions in one codebase is how one of them ends up wrong. The bidi
 * codepoints are the interesting half: U+202A..U+202E and U+2066..U+2069 let a
 * name render right-to-left and visually reorder everything after it in a table
 * row, so an import can be made to LOOK like a different import.
 *
 * NOT global (no /g): a global regex carries `lastIndex` across `.test()` calls
 * and would alternate pass/fail on the same input.
 */
export const UNSAFE_DISPLAY_NAME_CHARS = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

/**
 * THE normalizer every writer runs before validating or persisting an import
 * name. Trim only — no case folding, no whitespace collapsing, no character
 * stripping: a name with an embedded control character must be REFUSED by
 * `poImportDisplayNameError` below, and silently collapsing one into a space
 * here would launder exactly the input the refusal exists for.
 *
 * Returns null for "no name", which is what the nullable column stores.
 */
export function normalizePoImportDisplayName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The single authoritative rule set for an import name, expressed once as a
 * plain function so both zod schemas below (and any non-zod caller) share it.
 * Returns a user-facing message, or null when the name is acceptable.
 *
 * Ordinary punctuation is PRESERVED on purpose — `-`, `_`, `&`, `'`, `(`, `)`,
 * `#`, `.`, `,`, `/` and friends all survive, because real import names read
 * "August DC4 Book Order (Follett) #2" and an allowlist that mangled them
 * would push users straight back to living with `image.jpg`.
 *
 * Expects an ALREADY-normalized value (see normalizePoImportDisplayName).
 */
export function poImportDisplayNameError(value: string): string | null {
  if (value.length === 0) return 'Enter a name for this import.';
  if (UNSAFE_DISPLAY_NAME_CHARS.test(value)) {
    return 'Remove control and text-direction characters from the name.';
  }
  if (value.length > PO_IMPORT_DISPLAY_NAME_MAX) {
    return `Name is too long (${PO_IMPORT_DISPLAY_NAME_MAX} characters max).`;
  }
  return null;
}

/** A REQUIRED import name (the rename flow). Trims, then applies the rules. */
export const poImportDisplayNameSchema = z
  .string()
  .transform((s) => normalizePoImportDisplayName(s) ?? '')
  .superRefine((value, ctx) => {
    const message = poImportDisplayNameError(value);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

/**
 * An OPTIONAL import name (every create path). Absent, null and blank all mean
 * the same thing — "no name, fall back to file_name" — so they all normalize to
 * null instead of erroring, which is what keeps an older client that sends no
 * name at all working unchanged. A name that IS supplied gets the full rules.
 */
export const optionalPoImportDisplayNameSchema = z
  .string()
  .nullish()
  .transform((s) => normalizePoImportDisplayName(s))
  .superRefine((value, ctx) => {
    if (value === null) return;
    const message = poImportDisplayNameError(value);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

/** Input to the rename action/service method. */
export const renamePoImportSchema = z.object({
  poImportId: z.string().uuid(),
  displayName: poImportDisplayNameSchema,
});
export type RenamePoImportInput = z.infer<typeof renamePoImportSchema>;

/**
 * Canonical parsed-line shape produced by the parser; mirrors the
 * po_import_lines columns. Numbers are JS-side numbers; nulls are the
 * canonical "missing" value.
 */
export const canonicalPoLineSchema = z.object({
  lineNumber: z.number().int().positive(),
  lineType: poImportLineTypeSchema,
  qtyOrderedOriginal: z.number().nonnegative().nullable(),
  uomOriginal: z.string().max(16).nullable(),
  description: z.string().max(500).nullable(),
  unitCost: z.number().nonnegative().nullable(),
  lineTotal: z.number().nullable(),
  vendorItemNumber: z.string().max(64).nullable(),
  vendorProductNumber: z.string().max(64).nullable(),
  auxiliaryNumber: z.string().max(64).nullable(),
  coaCode: z.string().max(32).nullable(),

  // ── Sports variant fields (migration 0301) ────────────────────────────────
  // Every one is optional AND nullable, so the deterministic CSV/PDF parsers
  // that predate sports keep type-checking untouched and a non-sports PO
  // stays byte-identical to what it was.
  //
  // These carry what the DOCUMENT said, NOT a normalized form: no trimming,
  // no case folding, no size-system inference. Normalization and group
  // matching happen later (Task 14) against the ORIGINAL, which is why
  // variantSizeOriginal exists alongside variantSize. Requirements: "preserve
  // source values", "AI may SUGGEST but never invent ... missing stays
  // missing".
  variantSize: z.string().max(64).nullable().optional(),
  variantSizeOriginal: z.string().max(256).nullable().optional(),
  variantSizeSystem: z.string().max(32).nullable().optional(),
  variantWidth: z.string().max(32).nullable().optional(),
  variantFit: z.string().max(32).nullable().optional(),
  variantColor: z.string().max(64).nullable().optional(),
  /**
   * TEXT, always. '0', '00' and '07' are three different uniform numbers and
   * a number type collapses all of them — so this schema REFUSES a numeric
   * value rather than coercing one. Deliberately NOT jerseyNumberSchema: this
   * is the raw source value ("#12", "12A"), and a document that prints
   * something odd must still import and go to review, not fail the parse.
   */
  jerseyNumber: z.string().max(32).nullable().optional(),
  playerName: z.string().max(120).nullable().optional(),
  /** Free-text style/product identity read off the document. */
  groupHint: z.string().max(256).nullable().optional(),
  /**
   * The serial the document PRINTED for this line, verbatim, or null.
   *
   * COPIED, never invented — the extractor is instructed to leave this empty
   * rather than guess, and no code path fabricates a placeholder. A serialized
   * product whose document printed no serial keeps this null and stays blocked
   * in review, which is the point: the value has to come from the document or
   * from a human, never from the importer.
   */
  serialHint: z.string().max(128).nullable().optional(),
  /**
   * How confident the extractor is that each value landed in the RIGHT FIELD
   * — separate from extraction confidence (reading the characters). Bounded
   * 0..1 here; the DB column is numeric(4,3).
   */
  mappingConfidence: z.number().min(0).max(1).nullable().optional(),
});
export type CanonicalPoLine = z.infer<typeof canonicalPoLineSchema>;

export const canonicalPoSchema = z.object({
  poNumber: z.string().max(64).nullable(),
  vendorName: z.string().max(255).nullable(),
  poDate: z.string().max(32).nullable(),
  description: z.string().max(500).nullable(),
  preparedBy: z.string().max(120).nullable(),
  workflow: z.string().max(120).nullable(),
  reason: z.string().max(500).nullable(),
  comments: z.string().max(2000).nullable(),
  shippingAddress: z.string().max(500).nullable(),
  contactName: z.string().max(120).nullable(),
  contactPhone: z.string().max(40).nullable(),
  totalAmount: z.number().nullable(),
  lines: z.array(canonicalPoLineSchema),
});
export type CanonicalPo = z.infer<typeof canonicalPoSchema>;

export const upsertVendorItemMappingSchema = z.object({
  vendorId: z.string().uuid(),
  itemId: z.string().uuid(),
  vendorItemNumber: z.string().max(64).optional().nullable(),
  vendorProductNumber: z.string().max(64).optional().nullable(),
  auxiliaryNumber: z.string().max(64).optional().nullable(),
  vendorDescription: z.string().max(500).optional().nullable(),
  vendorUom: z.string().max(16).optional().nullable(),
  packQty: z.number().nonnegative().optional().nullable(),
  conversionFactor: z.number().nonnegative().optional().nullable(),
});
export type UpsertVendorItemMappingInput = z.infer<typeof upsertVendorItemMappingSchema>;

export const approvePoImportSchema = z.object({
  poImportId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  vendorId: z.string().uuid(),
  /**
   * REQUIRED destination location within the warehouse the created PO
   * receives against. The server never auto-picks or auto-creates a
   * location — a missing/foreign id is rejected, not silently substituted.
   */
  locationId: z
    .string({ required_error: 'Pick a destination location for this warehouse.' })
    .uuid('Pick a destination location for this warehouse.'),
  /**
   * BILLING ONLY. The bill-to charter for the created PO — written to
   * purchase_orders.charter_id and read by exactly one consumer, the PO PDF's
   * "Bill to" block. It must NEVER influence operational placement: not the
   * receiving warehouse, not the destination location, not which charter owns
   * the stock, not list placement, not access. Verified against the org
   * server-side (a cross-tenant id is dropped, never substituted).
   */
  charterId: z.string().uuid().nullable().optional(),
  /**
   * OPERATIONAL. The item-OWNERSHIP charter — the same value passed to
   * createItemsFromPoLines. This is the ONLY input to approve() that may
   * affect inventory_items.charter_id.
   *
   * Tri-state on purpose (owner rule B3 — no silent fallback):
   *   • absent (undefined) → LEAVE EVERY ITEM'S OWNERSHIP EXACTLY AS IT IS.
   *     approve() skips re-chartering, sibling lookup, sibling creation and
   *     line remap entirely. This is also what an older mobile build sends,
   *     so shipping the server first is non-destructive.
   *   • null → an explicit choice: Generic (no charter).
   *   • uuid → an explicit choice of that charter.
   *
   * Deliberately has NO default derived from `charterId` — deriving one would
   * reintroduce exactly the billing→placement conflation this field exists to
   * end.
   */
  itemCharterId: z.string().uuid().nullable().optional(),
  /**
   * Optional expected delivery date for the created PO (ISO datetime). Prefilled
   * from the AI-extracted ship/delivery date when present; user can override.
   */
  expectedAt: z.string().datetime().nullable().optional(),
  /** Per-line overrides; caller can change line item / classification before approval. */
  lineOverrides: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        itemId: z.string().uuid().nullable().optional(),
        lineType: poImportLineTypeSchema.optional(),
        skip: z.boolean().optional(),
      }),
    )
    .default([]),
});
export type ApprovePoImportInput = z.infer<typeof approvePoImportSchema>;

/**
 * The reviewer's answer to an ambiguous COLUMN mapping (Task 14).
 *
 * Shared, not server-only, because the confirmation step ships on web and
 * Expo: both must offer exactly the meanings the server will accept, and a
 * picker that offers a seventh option the server rejects is the drift this
 * package exists to prevent.
 *
 * Every flagged line needs an EXPLICIT meaning. There is no default and no
 * "leave it as the AI guessed" — that is the whole point of the step.
 */
export const confirmLineMappingsSchema = z.object({
  poImportId: z.string().uuid(),
  decisions: z
    .record(z.string().uuid(), z.enum(AMBIGUOUS_COLUMN_MEANINGS))
    .refine((d) => Object.keys(d).length > 0, 'Confirm at least one column mapping.'),
});
export type ConfirmLineMappingsInput = z.infer<typeof confirmLineMappingsSchema>;
