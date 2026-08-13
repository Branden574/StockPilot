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
  groupKeyUsesColor,
  placementWarningMessage,
  DEFAULT_SUBCATEGORY_PROFILES,
  type BulkCreateSizedVariantsInput,
  type CountingUnit,
  type CreateItemInput,
  type SportsAttribute,
  type SportsSubcategoryKey,
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
 * The category attributes the Add Item screen reads out of `categories`, i.e.
 * everything the sports decision below needs. Every field is nullable: an
 * environment that has not applied 0294 has none of these columns, and the
 * screen falls back to the narrow select.
 */
export interface SportsCategoryFacts {
  /** `categories.sports_subcategory_key` — the ONLY thing that makes a create sports-shaped. */
  subcategoryKey: string | null;
  /** `categories.default_unit_of_measure`, then the parent's. */
  defaultUnitOfMeasure: string | null;
  parentDefaultUnitOfMeasure?: string | null;
}

/**
 * The GROUP-IDENTITY attributes the Add Item screen collects. The exact field
 * set web's `SportsGroupFieldValues` carries (sports-fields.tsx), because these
 * are the slots `buildGroupKey` reads:
 *
 *   shoes    -> brand, model, styleNumber, colorway
 *   jerseys  -> team, league, season, homeAway, brand, styleNumber, color
 *
 * These are IDENTITY, not decoration. A shoe style created on web with
 * brand/model keys as `shoes|nike|vaporfly 3||`; the same style created on a
 * phone with only a name keys as `shoes|name:...`, and `findOrCreate` is
 * exact-key, so the two never meet and one product silently becomes two groups
 * with the stock split between them. Collecting them on BOTH surfaces is what
 * makes the identity cross-platform — and the spec asks for these fields on
 * Expo in the same breath as web ("web + Expo, shared rules").
 */
export interface SportsGroupFieldValues {
  brand: string;
  model: string;
  styleNumber: string;
  colorway: string;
  team: string;
  league: string;
  season: string;
  homeAway: '' | 'home' | 'away' | 'alternate';
  /** Only collected when the subcategory's GROUP key carries a colour slot. */
  color: string;
}

export const EMPTY_SPORTS_GROUP_FIELDS: SportsGroupFieldValues = {
  brand: '',
  model: '',
  styleNumber: '',
  colorway: '',
  team: '',
  league: '',
  season: '',
  homeAway: '',
  color: '',
};

/**
 * Which group-identity inputs a subcategory shows, bound to the profile's
 * `supportedAttributes` exactly as web's `SportsFields` binds them — no
 * `if (subcategory === 'shoes')` anywhere, so a custom subcategory listing the
 * same attributes gets the same inputs for free.
 *
 * `color` is the one attribute that means two different things. It is a GROUP
 * slot for jerseys/uniforms and a per-item VARIANT slot everywhere else
 * (`groupKeyUsesColor`, shared from @stockpilot/core), and this screen collects
 * only the group one.
 */
export function sportsGroupFieldsFor(
  subcategoryKey: string | null,
): { key: keyof SportsGroupFieldValues; label: string; placeholder: string }[] {
  const profile = subcategoryKey
    ? (DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as SportsSubcategoryKey] ?? null)
    : null;
  if (!profile) return [];
  const has = (attr: SportsAttribute) => profile.supportedAttributes.includes(attr);
  const fields: { key: keyof SportsGroupFieldValues; label: string; placeholder: string }[] = [];
  if (has('brand')) fields.push({ key: 'brand', label: 'BRAND', placeholder: 'Nike' });
  if (has('model')) fields.push({ key: 'model', label: 'MODEL', placeholder: 'Pegasus 41' });
  if (has('style_number'))
    fields.push({ key: 'styleNumber', label: 'STYLE NUMBER', placeholder: 'DZ4494-001' });
  if (has('colorway'))
    fields.push({ key: 'colorway', label: 'COLORWAY', placeholder: 'Black/White' });
  if (has('team')) fields.push({ key: 'team', label: 'TEAM', placeholder: 'Wildcats' });
  if (has('league'))
    fields.push({ key: 'league', label: 'LEAGUE / PROGRAM', placeholder: 'Varsity' });
  if (has('season')) fields.push({ key: 'season', label: 'SEASON', placeholder: '2026-27' });
  if (has('color') && groupKeyUsesColor(subcategoryKey))
    fields.push({ key: 'color', label: 'COLOR', placeholder: 'Navy' });
  return fields;
}

/** True when this subcategory shows the home / away picker. */
export function sportsShowsHomeAway(subcategoryKey: string | null): boolean {
  const profile = subcategoryKey
    ? (DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as SportsSubcategoryKey] ?? null)
    : null;
  return profile?.supportedAttributes.includes('home_away') ?? false;
}

/** The subcategory's display name ('Shoes'), for the section heading. */
export function sportsProfileLabelFor(subcategoryKey: string | null): string {
  const profile = subcategoryKey
    ? (DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as SportsSubcategoryKey] ?? null)
    : null;
  return profile?.label ?? '';
}

/**
 * The sports payload for a create, computed exactly as the web item form
 * computes its `sportsGroupPayload` (item-form.tsx).
 *
 * Two things decide it and nothing else:
 *
 *   1. The CATEGORY. A category with no `sports_subcategory_key` — every
 *      category in every non-sports org, and plain apparel in a sports one —
 *      returns `{}`, so the request is byte-identical to what mobile sent
 *      before. This mirrors the server's own `profile.isSports`
 *      (`resolveTrackingProfile` → a known subcategory profile), so the client
 *      cannot promise a group the server would refuse to create, or stay quiet
 *      when the server would have made one.
 *   2. An explicitly chosen group wins. `groupId` names an existing identity;
 *      sending `productGroup` alongside it would be two answers to one
 *      question, and the server prefers `groupId` anyway.
 *
 * `name` defaults to the item's own name, exactly as on web: there is no
 * separate "product group name" input on Add Item, so the first variant names
 * its group after itself. Renaming and merging groups is the product-groups
 * admin surface, not a create form.
 *
 * `defaultCountingUnit` is resolved here rather than left out because
 * `createProductGroupSchema` defaults it to 'each' — an omitted unit is
 * therefore NOT "ask the server", it is a literal 'each' that would beat the
 * shoe category's 'pair'. The precedence is the server's own
 * (`resolveTrackingProfile.countingUnit`): the category, then its parent, then
 * the subcategory profile, then 'unit'.
 *
 * Every KEY is still the server's: `group_key` is rebuilt by
 * `ProductGroupsService.findOrCreate` from the parsed attributes and a
 * client-supplied one is never read (a forged key silently merges two products
 * and their stock), and `variant_key` is rebuilt per row.
 */
export function buildSportsGroupPayload(input: {
  itemName: string;
  categoryId: string | null;
  category: SportsCategoryFacts | null;
  groupFields?: SportsGroupFieldValues;
  groupId?: string | null;
}): { groupId?: string | null; productGroup?: CreateItemInput['productGroup'] } {
  if (input.groupId) return { groupId: input.groupId };
  const key = input.category?.subcategoryKey ?? null;
  const profile = key
    ? (DEFAULT_SUBCATEGORY_PROFILES[key as SportsSubcategoryKey] ?? null)
    : null;
  if (!profile) return {};
  const name = input.itemName.trim();
  // The group is named after the item, so a nameless item has no group to name.
  // The shared schema refuses the empty name anyway (createProductGroupSchema
  // requires it) — returning {} here keeps that refusal on the ITEM's own name
  // field, where the user has a box to fix, instead of on `productGroup.name`.
  if (name.length === 0) return {};
  const countingUnit = (input.category?.defaultUnitOfMeasure ??
    input.category?.parentDefaultUnitOfMeasure ??
    profile.defaultCountingUnit ??
    'unit') as CountingUnit;
  const g = input.groupFields ?? EMPTY_SPORTS_GROUP_FIELDS;
  const text = (v: string) => v.trim() || undefined;
  return {
    productGroup: {
      name,
      categoryId: input.categoryId,
      // EVERY attribute is forwarded, not just the ones this subcategory
      // renders — byte-for-byte the web form's object. The unrendered ones are
      // '' and collapse to undefined here, exactly as they do on web, so the
      // two platforms hand `buildGroupKey` the same tuple.
      brand: text(g.brand),
      model: text(g.model),
      styleNumber: text(g.styleNumber),
      colorway: text(g.colorway),
      team: text(g.team),
      league: text(g.league),
      season: text(g.season),
      homeAway: g.homeAway || undefined,
      color: text(g.color),
      defaultCountingUnit: countingUnit,
    },
  };
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
  // `productGroup` is forwarded on THIS path too, not just the single-item one.
  // The server only find-or-creates a group under
  // `profile.isSports && !groupId && input.productGroup`, so omitting it here
  // meant every sized SPORTS create from a phone — a shoe style, the canonical
  // case — landed as loose variants with group_id = NULL and no product_groups
  // row at all: no roll-up on the Items tab, invisible to the size-count group
  // picker, and unorderable as a size run. The web form has always sent it
  // (item-form.tsx, `sportsGroupPayload` spread into both create paths);
  // buildCreateItemInput has always sent it; this builder alone dropped it.
  // Verified against production on 2026-07-28.
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
    productGroup: form.productGroup,
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

/**
 * Present when the operator typed a rack and the created stock did not reach
 * it. OPTIONAL on both create responses: the server omits it entirely when
 * everything placed, so a build that predates this field is unaffected and a
 * build that carries it degrades to "no warning" against an older server
 * rather than crashing on a missing key.
 */
export interface PlacementFailedPayload {
  rackName: string;
  count: number;
}

/**
 * Whether the create screen must interrupt, and with what.
 *
 * THIS LIVES HERE AND NOT IN THE SCREEN ON PURPOSE. The mobile vitest config
 * scopes `include` to `src/**` + `.test.ts`, so nothing under `app/` and no
 * `.tsx` is reachable by a test. A `placementFailed ? Alert.alert(...)` written
 * inline in `app/item/new.tsx` could therefore be deleted, inverted, or handed
 * the wrong string and the whole suite would stay green — which is precisely
 * how a shipped rack regression survived every test earlier this week. The
 * decision and the wording are values here; the screen only renders them.
 *
 * Returns null when there is nothing to warn about, so the caller's check is
 * the presence of a result rather than a re-implementation of the condition.
 */
export function placementAlertFor(
  lead: string,
  placementFailed: PlacementFailedPayload | undefined,
): { title: string; body: string } | null {
  if (!placementFailed) return null;
  return {
    // "created" leads the title too: an operator who reads only the bold line
    // must not conclude the item failed to save and enter it a second time.
    title: `${lead.startsWith('Item') ? 'Item' : 'Variants'} created — check the rack`,
    body: placementWarningMessage(lead, placementFailed),
  };
}

/** POST one validated item. The server owns every remaining guard. */
export async function submitCreateItem(
  input: CreateItemInput,
): Promise<{ id: string; placementFailed?: PlacementFailedPayload }> {
  return api<{ id: string; placementFailed?: PlacementFailedPayload }>('/api/v1/items', {
    method: 'POST',
    body: input,
  });
}

/** POST a validated size run. One request, one server-side fan-out. */
export async function submitSizedVariants(
  input: BulkCreateSizedVariantsInput,
): Promise<{ created: number; ids: string[]; placementFailed?: PlacementFailedPayload }> {
  return api<{ created: number; ids: string[]; placementFailed?: PlacementFailedPayload }>(
    '/api/v1/items/sized-variants',
    {
      method: 'POST',
      body: input,
    },
  );
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

/**
 * "Retail price: Enter 0 or more." — the label says WHICH box, the shared
 * schema's message says what to do.
 *
 * The label is dropped when the message already opens with it. The shared
 * schema now names its own field where that reads better ('Name is required.'),
 * and prefixing produced "Name: Name is required.". Presentation only; the
 * failure itself is unchanged.
 */
export function describeFailure(failure: BuildFailure): string {
  if (!failure.field) return failure.message;
  const head = failure.field.split('.')[0] ?? failure.field;
  const label = FIELD_LABELS[head];
  if (!label) return failure.message;
  if (failure.message.toLowerCase().startsWith(label.toLowerCase())) return failure.message;
  return `${label}: ${failure.message}`;
}
