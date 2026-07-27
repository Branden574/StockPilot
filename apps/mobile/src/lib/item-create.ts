/**
 * Native item creation, on the SHARED schema.
 *
 * Before this file, app/item/new.tsx built raw PostgREST inserts with three
 * imperative Alert guards and no zod, which meant mobile silently skipped:
 * every length cap, every numeric bound, the warehouse-required check, the
 * charter/warehouse pairing check, custom-field validation, the plan limit,
 * the permission check, the audit event, the search embedding, and
 * bin_location entirely (so mobile-created items never appeared correctly on
 * pick lists). It also demanded a SKU the web treats as optional, and it ran
 * its OWN sized fan-out with a hardcoded nine-letter apparel list and no cap
 * on how many rows one tap could insert.
 *
 * Everything now goes through the API, exactly as cycle-count recording
 * already does (see src/lib/cycle-count-sync.ts):
 *
 *   single item  -> POST /api/v1/items                (InventoryService.create)
 *   size run     -> POST /api/v1/items/sized-variants (InventoryService.bulkCreateSizedVariants)
 *
 * There is ZERO business rule left in this module or in the screen. What lives
 * here is (a) mapping the screen's string-shaped form state onto the shared
 * zod input, and (b) the derivations the WEB form performs at the same
 * boundary — decomposing the rack label and composing bin_location from it.
 */
import type { ZodError } from 'zod';

import {
  bulkCreateSizedVariantsSchema,
  createItemSchema,
  formatRackLabel,
  isApparelAlphaSize,
  normalizeRackFields,
  type BulkCreateSizedVariantsInput,
  type CreateItemInput,
} from '@stockpilot/core';

import { api } from './api';

export interface ItemFormState {
  name: string;
  sku: string;
  barcode: string;
  modelNumber: string;
  description: string;
  categoryId: string | null;
  supplierId: string | null;
  primaryLocationId: string | null;
  warehouseId: string | null;
  charterId: string | null;
  rackNumber: string;
  rackRow: string;
  unitCost: string;
  retailPrice: string;
  onHand: string;
  reorderPoint: string;
  reorderQuantity: string;
  unitOfMeasure: string;
  itemType: 'product' | 'book';
  /** Per-org custom field values. The rack + author keys are derived, not passed. */
  customFields: Record<string, unknown>;
  // Sports (Task 11 wires the UI; every field is optional and unset today).
  variantSize?: string | null;
  variantSizeOriginal?: string | null;
  variantSizeSystem?: string | null;
  variantWidth?: string | null;
  variantFit?: string | null;
  variantColor?: string | null;
  jerseyNumber?: string | null;
  playerName?: string | null;
  groupId?: string | null;
  productGroup?: CreateItemInput['productGroup'];
}

export interface BuildResult<T> {
  ok: true;
  input: T;
}
export interface BuildFailure {
  ok: false;
  message: string;
  /** Dotted field path so the screen can name the offending input. */
  field: string | null;
}

/** One size chip with the quantity the user tapped in. */
export interface SizedVariantRow {
  size: string;
  quantity: number;
}

/**
 * The rack derivation the web item form performs before it submits.
 *
 * DECOMPOSE through the ONE shared parser: a picker typing the whole shelf
 * label "22-B" into the number box gets ("22","B") stored, not the composite
 * that made items invisible to their own rack filter on 2026-07-23. Then
 * compose bin_location from the parts, because order picking and cycle counting
 * read bin_location, not the custom fields — mobile never wrote it, so every
 * item a warehouse user added from a phone was unplaced on every pick list.
 */
export function deriveRackFields(form: {
  itemType: 'product' | 'book';
  modelNumber: string;
  rackNumber: string;
  rackRow: string;
  customFields: Record<string, unknown>;
}): { customFields: Record<string, unknown>; number: string; row: string; binLocation: string | null } {
  const rack = normalizeRackFields({ number: form.rackNumber, row: form.rackRow });
  const number = rack.number;
  const row = number ? (rack.row ?? '').toUpperCase() : '';
  const customFields: Record<string, unknown> = { ...form.customFields };
  if (form.itemType === 'book') {
    // On books the "model number" input is labelled AUTHOR and has always been
    // stored as custom_fields.author (the web book form's key).
    if (form.modelNumber.trim()) customFields.author = form.modelNumber.trim();
    if (number) customFields.book_rack_number = number;
    if (row) customFields.book_rack_row = row;
  } else {
    if (number) customFields.rack_number = number;
    if (row) customFields.rack_row = row;
  }
  return {
    customFields,
    number,
    row,
    binLocation: number ? formatRackLabel({ number, row }) || null : null,
  };
}

function firstIssue(error: ZodError): BuildFailure {
  const issue = error.issues[0];
  return {
    ok: false,
    message: issue?.message ?? 'Check the form and try again.',
    field: issue?.path.join('.') || null,
  };
}

/**
 * Validate the form with the SAME schema the web uses. Returns a failure
 * rather than throwing so the screen keeps its Alert-based UX.
 *
 * Note SKU is intentionally NOT required here: createItemSchema treats an
 * empty SKU as "auto-generate", which is what the web does. The old native
 * "SKU required" alert was a divergence, not a rule.
 *
 * unitOfMeasure is passed through VERBATIM, empty string included. The shared
 * schema maps empty to undefined, and undefined is the only honest signal for
 * "the caller expressed no preference" — the server then applies the category's
 * counting unit (PAIR for shoes). Substituting 'unit' here would overrule the
 * category on every native create.
 */
export function buildCreateItemInput(form: ItemFormState): BuildResult<CreateItemInput> | BuildFailure {
  const rack = deriveRackFields(form);
  const parsed = createItemSchema.safeParse({
    name: form.name,
    sku: form.sku,
    barcode: form.barcode,
    modelNumber: form.itemType === 'book' ? undefined : form.modelNumber,
    description: form.description.trim() || null,
    categoryId: form.categoryId,
    supplierId: form.supplierId,
    primaryLocationId: form.primaryLocationId,
    warehouseId: form.warehouseId,
    charterId: form.charterId,
    binLocation: rack.binLocation,
    unitCost: form.unitCost || 0,
    retailPrice: form.retailPrice || 0,
    quantityOnHand: form.onHand || 0,
    reorderPoint: form.reorderPoint || 0,
    reorderQuantity: form.reorderQuantity || 0,
    unitOfMeasure: form.unitOfMeasure,
    itemType: form.itemType,
    customFields: rack.customFields,
    status: 'active',
    groupId: form.groupId,
    variantSize: form.variantSize,
    variantSizeOriginal: form.variantSizeOriginal ?? form.variantSize,
    variantSizeSystem: form.variantSizeSystem,
    variantWidth: form.variantWidth,
    variantFit: form.variantFit,
    variantColor: form.variantColor,
    jerseyNumber: form.jerseyNumber,
    playerName: form.playerName,
    productGroup: form.productGroup,
  });
  if (!parsed.success) return firstIssue(parsed.error);
  return { ok: true, input: parsed.data };
}

/**
 * Describe a size RUN. The fan-out itself is the server's
 * (InventoryService.bulkCreateSizedVariants) — this only says which sizes and
 * how many of each. The per-variant name, the per-variant SKU suffix, the size
 * system, the normalized size and variant_key are all derived server-side from
 * the category's size scale, so a phone and a browser cannot disagree about
 * what "size 10.5" means.
 */
export function buildSizedVariantsInput(
  form: ItemFormState,
  variants: SizedVariantRow[],
): BuildResult<BulkCreateSizedVariantsInput> | BuildFailure {
  const rack = deriveRackFields(form);
  // The rack keys belong to the per-variant builder on the server (it stamps
  // rack_number/rack_row onto every row from the structured fields below), so
  // pass only the org's own custom fields here.
  const parsed = bulkCreateSizedVariantsSchema.safeParse({
    baseName: form.name.trim(),
    baseSku: form.sku.trim() || null,
    baseBarcode: form.barcode.trim() || null,
    description: form.description.trim() || null,
    categoryId: form.categoryId,
    supplierId: form.supplierId,
    warehouseId: form.warehouseId,
    charterId: form.charterId,
    primaryLocationId: form.primaryLocationId,
    binLocation: rack.binLocation,
    rackNumber: rack.number || null,
    rackRow: rack.row || null,
    retailPrice: form.retailPrice || 0,
    unitCost: form.unitCost || 0,
    reorderPoint: form.reorderPoint || 0,
    reorderQuantity: form.reorderQuantity || 0,
    unitOfMeasure: form.unitOfMeasure.trim() || undefined,
    customFields: Object.keys(form.customFields).length > 0 ? form.customFields : undefined,
    groupId: form.groupId,
    variants,
  });
  if (!parsed.success) return firstIssue(parsed.error);
  return { ok: true, input: parsed.data };
}

/**
 * The Scan tab's one-tap quick add — the tiny form AddItemCard (UPC) and
 * AddBookCard (ISBN) put in front of a scanned code.
 *
 * It is a SUBSET of the full add-item screen, not a second create path. Both
 * cards used to raw-insert `inventory_items` themselves and guess the org with
 * `organization_members ... .limit(1)`, which is the first membership row, NOT
 * the workspace the user switched into — so a scan in the second org created
 * the item in the first, where RLS happily allowed it. Neither card ran the
 * shared schema, the permission gate, the plan limit, the audit event or the
 * search embedding, and the book card additionally called `adjust_stock` with a
 * null location, routing every ISBN add's opening stock into STAGING instead of
 * Unplaced (the exact bug the item card had already been fixed for).
 *
 * The org now comes from the Bearer context (`X-Organization-Id`, validated
 * server-side against membership) and every rule from `InventoryService`. This
 * function only maps the card's strings onto `ItemFormState`.
 */
export interface QuickAddForm {
  itemType: 'product' | 'book';
  /** Product name / book title, as typed. */
  name: string;
  sku: string;
  /** The scanned UPC/ISBN. Empty (a photo ID with no readable code) means NULL. */
  barcode: string;
  /** Manufacturer model number. Products only — a book card sends ''. */
  modelNumber: string;
  /** Looked-up description; the card shows it read-only. */
  description: string | null;
  /** Opening quantity as typed. The server writes the `initial` movement. */
  quantity: string;
  warehouseId: string | null;
  /** brand (UPC) or author/publisher/book_grade (ISBN) — passed through verbatim. */
  customFields: Record<string, unknown>;
}

export function buildQuickAddInput(
  form: QuickAddForm,
): BuildResult<CreateItemInput> | BuildFailure {
  return buildCreateItemInput({
    name: form.name.trim(),
    sku: form.sku.trim(),
    // A photo ID with no readable code passes '' — the shared schema maps an
    // empty barcode to undefined, so the column stays NULL rather than holding
    // a placeholder that would collide with the next codeless add.
    barcode: form.barcode.trim(),
    // Never routed through the book branch of deriveRackFields: the ISBN card
    // already puts the author in customFields, and sending it twice would be
    // two spellings of one value.
    modelNumber: form.itemType === 'book' ? '' : form.modelNumber,
    // Truncated, not rejected. This text is a LOOKUP result the user never
    // typed (Google Books, upcitemdb, or the AI description fallback) and both
    // cards already sliced it to the column's 5000 before inserting. Letting
    // the shared schema's max(5000) refuse it instead would turn a long
    // publisher blurb into "Description: String must contain at most 5000
    // character(s)" on a one-tap card with no description field to shorten.
    description: (form.description ?? '').slice(0, 5000),
    categoryId: null,
    supplierId: null,
    primaryLocationId: null,
    warehouseId: form.warehouseId,
    charterId: null,
    rackNumber: '',
    rackRow: '',
    unitCost: '',
    retailPrice: '',
    // Floored at zero exactly as both cards did. A quick-add card has no
    // "remove stock" meaning, and a typed '-3' must not open a negative
    // balance the shared numeric bound would otherwise accept.
    onHand: String(Math.max(0, Number(form.quantity) || 0)),
    reorderPoint: '',
    reorderQuantity: '',
    // Blank, so the server stamps the category's counting unit. Same contract
    // as the full screen; a literal 'unit' here would overrule the category.
    unitOfMeasure: '',
    itemType: form.itemType,
    customFields: form.customFields,
  });
}

/** POST one validated item. The server owns every remaining guard. */
export async function submitCreateItem(input: CreateItemInput): Promise<{ id: string }> {
  return api<{ id: string }>('/api/v1/items', { method: 'POST', body: input });
}

/** POST a validated size run. One request, one server-side fan-out. */
export async function submitSizedVariants(
  input: BulkCreateSizedVariantsInput,
): Promise<{ created: number; ids: string[] }> {
  return api<{ created: number; ids: string[] }>('/api/v1/items/sized-variants', {
    method: 'POST',
    body: input,
  });
}

/**
 * One row of a category's size scale (migration 0294). `value` is the size AS
 * PRINTED on the sticker and is never converted between systems.
 */
export interface SizeScaleValueRow {
  value: string;
  sort_order: number;
}

/**
 * Sizes are ORDERED, not alphabetical: 'XS' before 'S', '9.5' before '10'. The
 * scale carries that order, which is exactly why the hardcoded nine-letter
 * array this replaces could not express a shoe run at all.
 */
export function sizeOptionsFromScale(rows: SizeScaleValueRow[]): string[] {
  const seen = new Set<string>();
  return [...rows]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => r.value)
    .filter((v) => {
      const key = v.trim().toUpperCase();
      if (key.length === 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The vocabulary for a category that carries NO size scale of its own — today
 * that is every category, because the 0294 scales are opt-in and nothing has
 * been backfilled. So this is the list nearly every native size run actually
 * renders, which is exactly why it has to match the web.
 *
 * The built-in `apparel_alpha` scale is the UNION of every spelling in the
 * codebase (14 rows: nine canonical letters plus the 2XL/3XL/4XL/5XL aliases
 * and 6XL) so that inbound strings still match. Offered as CHOICES, that union
 * shows XXL and 2XL as two chips for one shirt — tap both and the server
 * happily creates two inventory items, two SKUs and two stock levels for one
 * physical size, while the web form beside it offers nine. Filter the fallback
 * down to the canonical nine (@stockpilot/core, `inventory/apparel-sizes`).
 *
 * This filter applies ONLY to the fallback. A category with its own scale
 * renders that scale verbatim through `sizeOptionsFromScale` — a shoe run is
 * numbers with halves and must never be squeezed through a letter list.
 * Deciding that 'XXL' and '2XL' name the same variant is alias RESOLUTION and
 * belongs to Tasks 17/19; dropping the aliases from a picker is not that.
 */
export function apparelFallbackSizeOptions(rows: SizeScaleValueRow[]): string[] {
  return sizeOptionsFromScale(rows).filter((v) => isApparelAlphaSize(v));
}

/**
 * Turn the per-size quantity map into the request's `variants` array, in scale
 * order, dropping the sizes left at zero. A blank or non-numeric box is zero;
 * the input already strips non-digits, so this is a floor, not a parser.
 */
export function collectSizedVariants(
  sizeOptions: string[],
  quantities: Record<string, string>,
): SizedVariantRow[] {
  const rows: SizedVariantRow[] = [];
  for (const size of sizeOptions) {
    const quantity = Math.max(0, Math.floor(Number(quantities[size]) || 0));
    if (quantity > 0) rows.push({ size, quantity });
  }
  return rows;
}

/**
 * Human labels for the dotted paths the shared schema reports, so a rejected
 * field reads as "Retail price" and not "retailPrice". Presentation only — no
 * rule lives here; an unmapped path falls back to the raw path.
 */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  baseName: 'Name',
  sku: 'SKU',
  baseSku: 'SKU',
  barcode: 'Barcode',
  baseBarcode: 'Barcode',
  modelNumber: 'Model number',
  description: 'Description',
  categoryId: 'Category',
  supplierId: 'Supplier',
  primaryLocationId: 'Primary location',
  warehouseId: 'Warehouse',
  charterId: 'Charter',
  binLocation: 'Rack',
  rackNumber: 'Rack number',
  rackRow: 'Rack row',
  unitCost: 'Unit cost',
  retailPrice: 'Retail price',
  quantityOnHand: 'On hand',
  reorderPoint: 'Reorder at',
  reorderQuantity: 'Reorder qty',
  unitOfMeasure: 'Unit of measure',
  customFields: 'Custom fields',
  variants: 'Sizes',
  variantSize: 'Size',
  jerseyNumber: 'Jersey number',
  playerName: 'Player name',
};

/** "Retail price: Number must be greater than or equal to 0" */
export function describeFailure(failure: BuildFailure): string {
  if (!failure.field) return failure.message;
  const head = failure.field.split('.')[0] ?? failure.field;
  const label = FIELD_LABELS[head];
  return label ? `${label}: ${failure.message}` : failure.message;
}
