import 'server-only';

import { z } from 'zod';

import {
  lineResultBlocksApproval,
  type CountingUnit,
  type CreateProductGroupInput,
} from '@stockpilot/core';

import { audit } from './audit';
import { ServiceError, type ServiceContext } from './context';
import type { InventoryService } from './inventory';
import {
  asSizeSystem,
  groupPartsForLine,
  resolveLineVariant,
  toVariantLine,
  type LineResolution,
  type PoImportVariantLine,
  type ResolveLineVariantDeps,
} from './po-imports-variants';
import { ProductGroupsService } from './product-groups';
import { resolveTrackingProfile, type TrackingProfileCache } from './sports-profiles';
import type { VendorItemMappingsService } from './vendor-item-mappings';
import { extractIsbnsFromText } from '@/lib/books/isbn-extract';
import { isbnVariants } from '@/lib/books/isbn-variants';
import { generateSku } from '@/lib/utils';

/**
 * Shared PO-import LINE workflows: duplicate detection and create-items.
 *
 * This logic used to live inline in the server actions
 * (`findDuplicatesForPoLinesAction` / `createItemsFromPoLinesAction`), which
 * made it unreachable from the Bearer-token mobile API (`requireOrgContext`
 * is cookie-session-bound and throws NEXT_REDIRECT under /api — recurring
 * pattern #23). It was moved here VERBATIM so that:
 *
 *   - the web actions keep their exact call shape (they build the deps from
 *     requireOrgContext + createClient + Service.forCurrentUser, unchanged),
 *   - `PoImportsService.findDuplicatesForLines` / `.createItemsFromLines`
 *     wrap the SAME implementation for the /api/v1 Bearer routes (with the
 *     service's module + permission asserts on top),
 *
 * so web and mobile can never drift.
 *
 * Functions here throw ServiceError; the actions' catch blocks convert those
 * to ActionResult errors exactly as before.
 */

/** Dependencies for the read-only duplicate lookup. */
export interface PoImportLinesDeps {
  supabase: ServiceContext['supabase'];
  organizationId: string;
}

/** Dependencies for create-items (adds the two writing services). */
export interface CreateItemsFromPoLinesDeps extends PoImportLinesDeps {
  inventorySvc: Pick<InventoryService, 'create'>;
  mappingsSvc: Pick<VendorItemMappingsService, 'upsert'>;
  /**
   * The caller's service context. REQUIRED rather than optional so the web
   * action and the Bearer route cannot drift into one resolving sports
   * identity and the other not — the whole reason this module exists.
   * Used to resolve the category's tracking profile, to read the org's
   * product groups, and to read whether the `sports` module is on at all.
   */
  ctx: ServiceContext;
}

const lineDecisionSchema = z.object({
  mode: z.enum(['create', 'use_existing', 'skip']),
  /** Required when mode === 'use_existing'. */
  itemId: z.string().uuid().optional(),
});

/**
 * The human's answer to an ambiguous or suggested group match.
 *
 * 'new' confirms a brand-new group despite the suggestion; 'link' accepts one
 * specific candidate. There is no third option and no default — the 0233
 * discipline extended to groups: a suggestion never becomes a link without
 * this.
 */
const groupDecisionSchema = z.object({
  mode: z.enum(['new', 'link']),
  /** Required when mode === 'link'. Verified to belong to the caller's org. */
  groupId: z.string().uuid().optional(),
});

export const createItemsFromPoLinesSchema = z.object({
  poImportId: z.string().uuid(),
  lineIds: z.array(z.string().uuid()).min(1).max(200),
  /**
   * Vendor (supplier) the new items will be tagged with — also drives the
   * vendor_item_mappings rows we create alongside, so future POs from the
   * same vendor with the same vendor_item_number auto-match.
   */
  vendorId: z.string().uuid(),
  /** Destination warehouse the new items will be created at. */
  warehouseId: z.string().uuid().nullable(),
  /** Optional charter the new items belong to (sets inventory_items.charter_id). */
  charterId: z.string().uuid().nullable().optional(),
  /** Optional specific location within the warehouse for the new items. */
  locationId: z.string().uuid().nullable().optional(),
  /**
   * Whether to create the new items as regular products (default) or as books
   * (item_type='book' → they appear on the Books tab). Applies to the whole
   * import — a "book PO" creates books, a supply PO creates products.
   */
  itemType: z.enum(['product', 'book']).optional(),
  /**
   * Optional per-line name overrides. Keyed by line id. When present we
   * use the user's edited name; when missing/empty we fall back to the
   * cleaned PO line description.
   */
  nameOverrides: z.record(z.string().uuid(), z.string().min(1).max(200)).optional(),
  /**
   * Per-line decision: create a new item (default), link the PO line to
   * an existing item (no creation), or skip the line entirely. Modal
   * uses these when a duplicate match is detected.
   */
  decisions: z.record(z.string().uuid(), lineDecisionSchema).optional(),
  /**
   * Category the new items are filed under. This is what decides the tracking
   * profile, and therefore whether a line resolves to a sports group/variant
   * at all — a category with no Sports subcategory behaves exactly as before.
   */
  categoryId: z.string().uuid().nullable().optional(),
  /**
   * Per-line answers to a `possible_duplicate` / `ambiguous_variant_match`
   * verdict. Keyed by line id. A blocking line with no answer here is REFUSED,
   * never auto-resolved.
   */
  groupDecisions: z.record(z.string().uuid(), groupDecisionSchema).optional(),
  /**
   * Per-line variant attributes the reviewer supplied on the spot, so a
   * missing required attribute can be fixed without leaving the screen. These
   * do NOT overwrite the line's stored source values — they are applied to the
   * item being created and to the identity key, and the document's own text
   * stays in `variant_size_original`.
   */
  variantOverrides: z
    .record(
      z.string().uuid(),
      z.object({
        size: z.string().max(40).nullable().optional(),
        sizeSystem: z.string().max(40).nullable().optional(),
        jerseyNumber: z.string().max(4).nullable().optional(),
      }),
    )
    .optional(),
});
export type CreateItemsFromPoLinesInput = z.infer<typeof createItemsFromPoLinesSchema>;

export const findDuplicatesForPoLinesSchema = z.object({
  poImportId: z.string().uuid(),
  lineIds: z.array(z.string().uuid()).min(1).max(200),
});

export interface DuplicateCandidate {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  quantityOnHand: number;
  matchType: 'barcode' | 'name';
}

/**
 * Looks up existing inventory items that may already represent each PO
 * line — by exact barcode match against vendor_item_number (highest
 * confidence) or case-insensitive name match against the cleaned PO
 * description (lower confidence). Used by the create-items modal (web)
 * and the mobile line-matches endpoint to warn before creating dupes.
 *
 * `lineIds` omitted = all lines of the import (capped at 200 — the same
 * ceiling the explicit-ids schema enforces).
 */
export async function findDuplicatesForPoLines(
  deps: PoImportLinesDeps,
  input: { poImportId: string; lineIds?: string[] },
): Promise<{ matches: Record<string, DuplicateCandidate[]> }> {
  // Confirm the import belongs to the ACTIVE org before matching against it.
  // RLS on po_import_lines only proves the caller is a member of the import's
  // org — a multi-org user could otherwise pass another of their orgs' import
  // id while the active context is org A. Fails closed (not_found).
  const { data: importHeader } = await deps.supabase
    .from('po_imports')
    .select('id')
    .eq('organization_id', deps.organizationId)
    .eq('id', input.poImportId)
    .maybeSingle();
  if (!importHeader) throw new ServiceError('not_found', 'PO import not found');

  let linesQuery = deps.supabase
    .from('po_import_lines')
    .select('id, description, vendor_item_number, vendor_product_number, auxiliary_number')
    .eq('po_import_id', input.poImportId);
  linesQuery =
    input.lineIds && input.lineIds.length > 0
      ? linesQuery.in('id', input.lineIds)
      : linesQuery.limit(200);
  const { data: lines, error: lErr } = await linesQuery;
  if (lErr) throw new ServiceError('internal_error', lErr.message);

  const matches: Record<string, DuplicateCandidate[]> = {};
  for (const l of lines ?? []) {
    const lineId = l.id as string;
    const description = (l.description as string | null)?.trim();
    const vendorNumbers = [
      l.vendor_item_number,
      l.vendor_product_number,
      l.auxiliary_number,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    const candidates = new Map<string, DuplicateCandidate>();

    // Barcode match: high confidence. Exact match against any of the
    // vendor numbers — vendor_item_number gets stored as `barcode` when
    // we create from a PO, so that's the primary hit.
    if (vendorNumbers.length > 0) {
      const { data: byBarcode } = await deps.supabase
        .from('inventory_items')
        .select('id, name, sku, barcode, quantity_on_hand')
        .eq('organization_id', deps.organizationId)
        .is('deleted_at', null)
        .in('barcode', vendorNumbers);
      for (const r of byBarcode ?? []) {
        candidates.set(r.id as string, {
          id: r.id as string,
          name: r.name as string,
          sku: r.sku as string,
          barcode: (r.barcode as string | null) ?? null,
          quantityOnHand: Number(r.quantity_on_hand ?? 0) || 0,
          matchType: 'barcode',
        });
      }
    }

    // Name match: lower confidence. Case-insensitive equal on the
    // cleaned description (strip trailing parentheses) — broad ILIKE
    // would be noisy for short generic names.
    if (description) {
      const cleaned = description.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (cleaned.length >= 4) {
        const { data: byName } = await deps.supabase
          .from('inventory_items')
          .select('id, name, sku, barcode, quantity_on_hand')
          .eq('organization_id', deps.organizationId)
          .is('deleted_at', null)
          .ilike('name', cleaned);
        for (const r of byName ?? []) {
          if (candidates.has(r.id as string)) continue; // barcode wins
          candidates.set(r.id as string, {
            id: r.id as string,
            name: r.name as string,
            sku: r.sku as string,
            barcode: (r.barcode as string | null) ?? null,
            quantityOnHand: Number(r.quantity_on_hand ?? 0) || 0,
            matchType: 'name',
          });
        }
      }
    }

    const list = [...candidates.values()];
    if (list.length > 0) matches[lineId] = list;
  }

  return { matches };
}

/**
 * The two verdicts a human can settle by choosing a product group. The other
 * blocking verdicts — a confidence gate, a missing size, a serial mismatch —
 * are NOT group questions and can never be waved through with one.
 */
const GROUP_RESOLVABLE_RESULTS = new Set(['possible_duplicate', 'ambiguous_variant_match']);

/**
 * Apply the reviewer's answer to a blocked line, or refuse the line.
 *
 * This is where "AI suggests, the human links" is enforced for GROUPS. A
 * `possible_duplicate` is a suggestion and stays one until an explicit
 * decision arrives here; an unanswered blocking verdict throws, so an import
 * can never quietly merge two products or invent a missing attribute.
 *
 * Returns the group id the line should be created under (null = a brand-new
 * group, which `InventoryService.create` derives from the category profile).
 */
async function settleGroupDecision(
  ctx: ServiceContext,
  resolution: LineResolution,
  line: PoImportVariantLine,
  decision: { mode: 'new' | 'link'; groupId?: string } | undefined,
): Promise<string | null> {
  if (!lineResultBlocksApproval(resolution.result)) return resolution.groupId;

  const settleable = GROUP_RESOLVABLE_RESULTS.has(resolution.result);
  if (!settleable || !decision) {
    throw new ServiceError(
      'validation_error',
      `Line ${line.line_number}: ${resolution.message ?? 'This line needs review before it can be imported.'}`,
      resolution.errorCode ? { code: resolution.errorCode } : undefined,
    );
  }

  // 'new' means "do not link me to one of these candidates". It does NOT mean
  // "forget the group this line already resolved to": an
  // `ambiguous_variant_match` on an EXACTLY-matched group is asking which
  // VARIANT, and answering "a new one" must keep the group. Returning null
  // here dropped that group on the floor and created an orphan variant of a
  // product the org already has. Where no group was matched (a
  // `possible_duplicate` suggestion), `resolution.groupId` is null and 'new'
  // still means a brand-new group, exactly as before.
  let chosen: string | null = decision.mode === 'new' ? resolution.groupId : null;
  if (decision.mode === 'link') {
    if (!decision.groupId) {
      throw new ServiceError(
        'validation_error',
        `Line ${line.line_number} was set to link an existing product group, but none was picked.`,
      );
    }
    // Only a group the resolver actually offered may be linked. The candidate
    // list came from an org-scoped read, so this also pins the group to the
    // caller's organization without a second query.
    if (!resolution.groupCandidates.some((c) => c.id === decision.groupId)) {
      throw new ServiceError(
        'validation_error',
        `Line ${line.line_number}: that product group was not one of this line's candidates.`,
      );
    }
    chosen = decision.groupId;
  }

  await audit(
    {
      event: 'sports.import.match_overridden',
      entityType: 'po_import_line',
      entityId: line.id,
      before: {
        result: resolution.result,
        candidates: resolution.groupCandidates.map((c) => c.id),
      },
      after: { linkedGroupId: chosen, mode: decision.mode },
    },
    ctx,
  );
  return chosen;
}

/**
 * Creates (or links) inventory items for the given PO-import lines and maps
 * each line + saves vendor_item_mappings. Moved verbatim from
 * `createItemsFromPoLinesAction`; see that action for the calling web UI.
 * Charter semantics: SELECTED CHARTER WINS (owner decision 2026-07-09) —
 * barcode/ISBN matches are advisory only, never auto-linked.
 */
export async function createItemsFromPoLines(
  deps: CreateItemsFromPoLinesDeps,
  input: CreateItemsFromPoLinesInput,
): Promise<{ created: number; mapped: number; linked: number; skipped: number }> {
  const { supabase, organizationId, inventorySvc, mappingsSvc, ctx } = deps;

  // ── Sports identity resolution (Task 14) ──────────────────────────────────
  // Resolved ONCE per import: the category is import-wide, so the tracking
  // profile is too. For every org that has never configured a Sports
  // subcategory this is QUANTITY / 'none' and every branch below is inert.
  const sportsEnabled = ctx.enabledModules.has('sports');
  const profileCache: TrackingProfileCache = new Map();
  const importProfile = await resolveTrackingProfile(
    ctx,
    input.categoryId ?? null,
    profileCache,
  );
  const variantDeps: ResolveLineVariantDeps = {
    groups: new ProductGroupsService(ctx),
    supabase,
    organizationId,
    sportsEnabled,
  };

  // Resolve a primary_location_id for the new items. Prefer the location the
  // user explicitly chose (verified to belong to this org + the destination
  // warehouse); otherwise fall back to any location in the warehouse.
  // Cosmetic only — the receive flow uses the PO's destination_location_id.
  let primaryLocationId: string | null = null;
  if (input.locationId && input.warehouseId) {
    const { data: chosen } = await supabase
      .from('locations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('id', input.locationId)
      .eq('warehouse_id', input.warehouseId)
      .is('deleted_at', null)
      .maybeSingle();
    primaryLocationId = (chosen?.id as string | undefined) ?? null;
  }
  if (!primaryLocationId && input.warehouseId) {
    const { data: loc } = await supabase
      .from('locations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('warehouse_id', input.warehouseId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    primaryLocationId = (loc?.id as string | undefined) ?? null;
  }

  // Ownership charter is TRI-STATE, and collapsing it to a boolean is
  // destructive. `undefined` means the caller stated no ownership intent (the
  // review form's "Keep each item's current charter" default); `null` means an
  // explicit Generic. Only the second is an instruction. Treating "keep" as
  // Generic made the DEFAULT choice re-point a use_existing line onto a freshly
  // spawned Generic sibling — the opposite of what the option promises.
  const charterIntent = input.charterId !== undefined;
  let charterId: string | null = null;
  if (input.charterId) {
    const { data: charter, error: chErr } = await supabase
      .from('charters')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('id', input.charterId)
      .maybeSingle();
    if (chErr) throw new ServiceError('internal_error', chErr.message);
    // A STATED charter that does not resolve must not degrade to null — null is
    // the explicit Generic instruction, so that would silently re-charter every
    // line to Generic on a typo or a stale id.
    if (!charter) {
      throw new ServiceError(
        'validation_error',
        'That charter for items is not in this organization. Pick one from the list.',
      );
    }
    charterId = charter.id as string;
  }

  // Confirm the import belongs to the ACTIVE org before creating items in it.
  // RLS on po_import_lines only proves the caller is a member of the import's
  // org — a multi-org user could otherwise pass another of their orgs' import
  // id while the active context is org A, creating org-A items against org-B
  // lines (cross-tenant pollution). This explicit guard fails closed.
  const { data: importHeader } = await supabase
    .from('po_imports')
    .select('id, status')
    .eq('organization_id', organizationId)
    .eq('id', input.poImportId)
    .maybeSingle();
  if (!importHeader) throw new ServiceError('not_found', 'PO import not found');
  // Terminal-status gate (mirrors approve() / parseImport()): creating items from
  // a finished import would spawn orphan inventory unrelated to its already-made
  // PO. The web review UI hides the Create buttons on approved/canceled imports;
  // this guards the SHARED service + the Bearer /api/v1/po-imports/[id]/create-items
  // route (mobile) too, so neither path can mutate a closed import.
  if (importHeader.status === 'approved' || importHeader.status === 'canceled') {
    throw new ServiceError(
      'conflict',
      `This import is ${importHeader.status} and can no longer have items created from it.`,
    );
  }

  // Pull just the lines we're creating items for. RLS guarantees the
  // import belongs to the caller's org.
  const { data: lines, error: lErr } = await supabase
    .from('po_import_lines')
    // Hand-written column list: the create path cannot see a column that is
    // not named here, so the 0301 variant columns are named explicitly —
    // Task 14's group-first matching reads them off exactly this row, and a
    // missing name would fail silently. `mapping_confidence` was the one 0301
    // column Task 13 left out; without it the confidence gate below reads
    // undefined and never fires.
    .select(
      'id, po_import_id, line_number, line_type, description, qty_ordered_original, uom_original, unit_cost, vendor_item_number, vendor_product_number, auxiliary_number, item_id, variant_size, variant_size_original, variant_size_system, variant_width, variant_fit, variant_color, jersey_number, player_name, group_hint, serial_hint, suggested_group_id, mapping_confidence',
    )
    .eq('po_import_id', input.poImportId)
    .in('id', input.lineIds);
  if (lErr) throw new ServiceError('internal_error', lErr.message);

  let created = 0;
  let mapped = 0;
  let linked = 0;
  let skipped = 0;
  for (const l of lines ?? []) {
    // Skip lines that aren't inventory or already have an item — caller
    // shouldn't pass them but be defensive.
    if (l.line_type !== 'inventory') continue;
    if (l.item_id) continue;
    const description = (l.description as string | null)?.trim();
    if (!description) continue;

    const vendorItemNumber = (l.vendor_item_number as string | null) ?? null;
    const vendorProductNumber = (l.vendor_product_number as string | null) ?? null;
    const auxiliaryNumber = (l.auxiliary_number as string | null) ?? null;

    let decision: { mode: 'create' | 'use_existing' | 'skip'; itemId?: string } =
      input.decisions?.[l.id as string] ?? { mode: 'create' };

    if (decision.mode === 'skip') {
      skipped++;
      continue;
    }

    // ── Group-first, deterministic identity resolution ──────────────────────
    // Only for lines that will CREATE an item. A `use_existing` line points at
    // an item whose identity a human already settled, and resolving it against
    // THIS import's category would block a perfectly good link on an attribute
    // the existing item already carries. An unconfirmed column mapping on such
    // a line is still refused — by approve(), which every path funnels through.
    // Non-sports lines resolve to 'ready' and change nothing either way.
    const overrides = input.variantOverrides?.[l.id as string];
    // ONE mapper, shared with the review path, so a verdict shown on screen
    // and the verdict enforced here are computed from the same normalized row.
    const variantLine: PoImportVariantLine = toVariantLine(l as Record<string, unknown>, {
      size: overrides?.size ?? undefined,
      sizeSystem: overrides?.sizeSystem ?? undefined,
      jerseyNumber: overrides?.jerseyNumber ?? undefined,
    });
    let resolvedGroupId: string | null = null;
    // Set only when this line must FIND-OR-CREATE its group. `create()` needs
    // the group's identity attributes, not just the (absent) id — see below.
    let newGroupInput: CreateProductGroupInput | null = null;
    if (decision.mode === 'create') {
      const resolution = await resolveLineVariant(variantDeps, variantLine, importProfile);
      resolvedGroupId = await settleGroupDecision(
        ctx,
        resolution,
        variantLine,
        input.groupDecisions?.[l.id as string],
      );

      // NO GROUP RESOLVED, BUT THE LINE IS A SPORTS LINE → this is the
      // create-a-group case, and the group has to actually be created.
      //
      // Passing `groupId: null` alone was silently a no-op: `create()` only
      // find-or-creates when `productGroup` is present, so every
      // `create_new_group` line landed `group_id = NULL` — no group, no
      // roll-up, and the next import matched nothing and created another set.
      // The parts come from the SAME helper the resolver keyed on, so three
      // size lines off one PO converge on one row (R2): line 1 inserts it,
      // lines 2 and 3 find it by exact key.
      if (resolvedGroupId == null && importProfile.isSports && sportsEnabled) {
        const parts = groupPartsForLine(variantLine, importProfile);
        const groupName = (parts.name ?? description).slice(0, 200);
        newGroupInput = {
          name: groupName,
          categoryId: input.categoryId ?? null,
          subcategoryKey: parts.subcategoryKey,
          brand: parts.brand ?? null,
          model: parts.model ?? null,
          styleNumber: parts.styleNumber ?? null,
          colorway: parts.colorway ?? null,
          defaultCountingUnit: importProfile.countingUnit as CountingUnit,
        };
      }

      // An EXACT variant-key hit inside an already-resolved group is not a
      // guess — it is the same product, and creating a second row for it would
      // leave two variants sharing one key (the ambiguity the resolver refuses
      // later). Route it through the use_existing branch so the charter rules
      // still apply.
      if (resolution.result === 'receive_into_existing_variant' && resolution.variantItemId) {
        decision = { mode: 'use_existing', itemId: resolution.variantItemId };
      }
    }

    let resolvedItemId: string;

    // Book ISBN match: for a book import, pull the ISBN off the line
    // (vendor numbers or the description) and look for an existing book whose
    // barcode is that ISBN (in either ISBN-10/13 form). This is ADVISORY
    // ONLY — a hit is recorded as suggested_item_id below for a human to
    // review; it never auto-links the line (matching must never override
    // the charter the user chose for this import).
    let bookIsbn: string | null = null;
    let isbnMatchItemId: string | null = null;
    if (input.itemType === 'book') {
      const haystack = [vendorItemNumber, vendorProductNumber, auxiliaryNumber, description]
        .filter(Boolean)
        .join(' ');
      bookIsbn = extractIsbnsFromText(haystack)[0] ?? null;
      if (bookIsbn) {
        const variants = isbnVariants(bookIsbn);
        if (variants.length > 0) {
          const { data: candidates, error: isbnErr } = await supabase
            .from('inventory_items')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('item_type', 'book')
            .in('barcode', variants)
            .is('deleted_at', null)
            .limit(1);
          if (isbnErr) {
            // Fail-closed: fall through to create a new book. Log so a transient
            // DB error doesn't silently spawn duplicate books with no trace.
            console.error(
              'po-imports: ISBN candidate lookup failed; creating new book instead of linking',
              { error: isbnErr.message },
            );
          }
          isbnMatchItemId = (candidates?.[0]?.id as string | undefined) ?? null;
        }
      }
    }

    // Product barcode match: the same courtesy the ISBN block gives books.
    // When the user didn't explicitly decide (mode === 'create') and the
    // line carries vendor numbers, look for an existing item whose barcode
    // EXACTLY matches one of them — vendor_item_number is stored as
    // `barcode` when we create from a PO. ADVISORY ONLY (see decision
    // block below): a hit is recorded as suggested_item_id, never
    // auto-linked, so a re-ordered product still gets its own instance
    // under the chosen charter. NAME matches also never auto-link (same
    // false-positive risk) — those only surface via
    // findDuplicatesForPoLines.
    let barcodeMatchItemId: string | null = null;
    if (input.itemType !== 'book' && decision.mode === 'create') {
      const vendorNumbers = [vendorItemNumber, vendorProductNumber, auxiliaryNumber].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (vendorNumbers.length > 0) {
        const { data: byBarcode, error: barcodeErr } = await supabase
          .from('inventory_items')
          .select('id')
          .eq('organization_id', organizationId)
          .in('barcode', vendorNumbers)
          .is('deleted_at', null)
          .limit(1);
        if (barcodeErr) {
          // Fail-closed: fall through to create a new item. Log so a transient
          // DB error doesn't silently spawn duplicate items with no trace.
          console.error(
            'po-imports: barcode candidate lookup failed; creating new item instead of linking',
            { error: barcodeErr.message },
          );
        }
        barcodeMatchItemId = (byBarcode?.[0]?.id as string | undefined) ?? null;
      }
    }

    // Whether THIS line created a brand-new inventory_items row (vs linking an
    // existing one) — drives `item_created` below so cancel-cleanup only
    // archives items the import actually spawned.
    let didCreate = false;

    if (decision.mode === 'use_existing') {
      if (!decision.itemId) {
        throw new ServiceError(
          'validation_error',
          `Line ${l.line_number} marked use_existing but no itemId provided`,
        );
      }
      // Confirm the chosen item belongs to the caller's org, and read its
      // charter + identity so we can honor the SELECTED charter (below).
      const { data: existing, error: chkErr } = await supabase
        .from('inventory_items')
        // A charter sibling is the SAME product under a different owner, so it
        // must carry the same identity: the group and variant columns are named
        // here too, or the copy reads undefined and the sibling lands ungrouped
        // — invisible to the roll-up and to the next import's matcher. One
        // literal, never a concatenation: PostgREST's typing reads the string.
        .select(
          'id, sku, name, barcode, charter_id, unit_cost, retail_price, category_id, supplier_id, warehouse_id, unit_of_measure, item_type, tracking_type, group_id, variant_size, variant_size_original, variant_size_system, variant_width, variant_fit, variant_color, jersey_number, player_name',
        )
        .eq('organization_id', organizationId)
        .eq('id', decision.itemId)
        .is('deleted_at', null)
        .maybeSingle();
      if (chkErr) throw new ServiceError('internal_error', chkErr.message);
      if (!existing) {
        throw new ServiceError('not_found', `Existing item for line ${l.line_number} not found`);
      }

      const existingCharter = (existing.charter_id as string | null) ?? null;
      // No stated ownership intent: link the item exactly as it is. Without
      // this, "keep each item's current charter" fell into the branch below and
      // spawned a Generic sibling instead of keeping anything.
      if (!charterIntent || existingCharter === charterId) {
        // Same charter (both-generic/null counts as same) → link the item.
        resolvedItemId = existing.id as string;
        linked++;
      } else {
        // SELECTED CHARTER WINS (owner decision 2026-07-09): never reuse or
        // re-charter an item under a DIFFERENT charter. Resolve to the
        // same-SKU instance under the SELECTED charter — find it, or create a
        // separate instance, leaving the chosen item untouched. 0234's
        // charter-aware SKU uniqueness makes (org, sku, selectedCharter, null)
        // its own row, so e.g. KVA and CVW stock stay separate.
        const existingSku = existing.sku as string;
        let sibQuery = supabase
          .from('inventory_items')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('sku', existingSku)
          .is('bin_location', null)
          .is('deleted_at', null);
        sibQuery =
          charterId === null
            ? sibQuery.is('charter_id', null)
            : sibQuery.eq('charter_id', charterId);
        const { data: sibling, error: sibErr } = await sibQuery.maybeSingle();
        if (sibErr) throw new ServiceError('internal_error', sibErr.message);

        if (sibling) {
          resolvedItemId = sibling.id as string;
          linked++;
        } else {
          const siblingItem = await inventorySvc.create(
            {
            name: existing.name as string,
            sku: existingSku,
            barcode: (existing.barcode as string | null) ?? undefined,
            unitCost: Number(existing.unit_cost ?? 0) || 0,
            retailPrice: Number(existing.retail_price ?? 0) || 0,
            quantityOnHand: 0,
            reorderPoint: 0,
            reorderQuantity: 0,
            unitOfMeasure: (existing.unit_of_measure as string | null) ?? 'unit',
            supplierId: (existing.supplier_id as string | null) ?? input.vendorId,
            warehouseId: (existing.warehouse_id as string | null) ?? input.warehouseId,
            charterId,
            categoryId: (existing.category_id as string | null) ?? null,
            primaryLocationId,
            trackingType: (existing.tracking_type as 'none' | 'lot' | 'serial' | 'serial_optional' | null) ?? 'none',
            itemType:
              (existing.item_type as 'product' | 'book' | 'asset' | 'consumable' | null) ??
              input.itemType ??
              'product',
            customFields: {},
            status: 'active',
            // Identity travels with the sibling. `variant_key` is deliberately
            // NOT copied — InventoryService.create recomputes it from these
            // attributes, so the key can only ever be server-derived.
            groupId: (existing.group_id as string | null) ?? null,
            variantSize: (existing.variant_size as string | null) ?? null,
            variantSizeOriginal: (existing.variant_size_original as string | null) ?? null,
            variantSizeSystem: asSizeSystem(existing.variant_size_system as string | null),
            variantWidth: (existing.variant_width as string | null) ?? null,
            variantFit: (existing.variant_fit as string | null) ?? null,
            variantColor: (existing.variant_color as string | null) ?? null,
            jerseyNumber: (existing.jersey_number as string | null) ?? null,
            playerName: (existing.player_name as string | null) ?? null,
            },
            // Born from an inbound PO at qty 0 → hidden ("Expected") until
            // the first receipt clears the flag (migration 0277 trigger).
            { awaitingFirstReceipt: true },
          );
          resolvedItemId = siblingItem.id as string;
          created++;
          didCreate = true;
        }
      }
    } else {
      // DEFAULT: create a new instance under the CHOSEN charter. A
      // barcode/ISBN hit does NOT link here — matching is advisory only
      // (owner decision: a KVA import must never land on an existing CVW
      // item just because a barcode/ISBN happens to match). The match is
      // recorded as a suggestion on the line below instead, for a human
      // to review later; it never changes what gets created here.
      // Prefer the user-edited name from the modal; otherwise auto-clean
      // by stripping the trailing "(SOMETHING)" part of the PO description
      // since the manufacturer's part number already lives in `barcode`.
      const overrideName = input.nameOverrides?.[l.id as string]?.trim();
      const cleanedName = description.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const finalName = (
        overrideName && overrideName.length > 0 ? overrideName : cleanedName || description
      ).slice(0, 200);

      const item = await inventorySvc.create(
        {
        name: finalName,
        sku: generateSku(),
        // For books, store the ISBN as the barcode so a future book PO with
        // the same ISBN matches this one. Otherwise use the vendor's item
        // number so scanning the physical packaging finds it later.
        barcode: bookIsbn ?? vendorItemNumber ?? vendorProductNumber ?? undefined,
        unitCost: Number(l.unit_cost ?? 0) || 0,
        retailPrice: 0,
        quantityOnHand: 0,
        reorderPoint: 0,
        reorderQuantity: 0,
        unitOfMeasure: (l.uom_original as string | null)?.toLowerCase() ?? 'unit',
        supplierId: input.vendorId,
        warehouseId: input.warehouseId,
        charterId,
        categoryId: input.categoryId ?? null,
        primaryLocationId,
        // The category profile stamps the real value server-side; 'none' is
        // only the pre-sports default for a category with no mode.
        trackingType: 'none',
        itemType: input.itemType ?? 'product',
        customFields: {},
        status: 'active',
        // Phase 5: variant identity resolved above. groupId is only ever set
        // from an EXACT key hit or an explicitly accepted candidate, and
        // variant_key is recomputed inside create() — never passed in.
        groupId: resolvedGroupId,
        // ...and when nothing was resolved, the group's IDENTITY, so create()
        // can find-or-create it. Only ever present for a sports line whose
        // verdict said "new group" (or whose reviewer confirmed one), never as
        // a way to link an existing group — that still requires an explicit
        // decision through settleGroupDecision above.
        ...(newGroupInput ? { productGroup: newGroupInput } : {}),
        variantSize: variantLine.variant_size,
        variantSizeOriginal:
          (l.variant_size_original as string | null) ??
          (l.variant_size as string | null) ??
          variantLine.variant_size,
        variantSizeSystem: asSizeSystem(variantLine.variant_size_system),
        variantWidth: variantLine.variant_width,
        variantFit: variantLine.variant_fit,
        variantColor: variantLine.variant_color,
        jerseyNumber: variantLine.jersey_number,
        playerName: variantLine.player_name,
        },
        // Born from an inbound PO at qty 0 → hidden ("Expected") until
        // the first receipt clears the flag (migration 0277 trigger).
        { awaitingFirstReceipt: true },
      );
      created++;
      didCreate = true;
      resolvedItemId = item.id as string;
    }
    // Barcode/ISBN match is advisory only — surfaced for a human to review,
    // never used to change what the line resolved to above.
    const suggestedItemId = barcodeMatchItemId ?? isbnMatchItemId ?? null;

    // Map the line (whether newly created or linked to an explicitly-chosen
    // existing item). Record whether WE created the item (vs linking an
    // existing one) so a later cancel can clean up only the items the
    // import spawned.
    const { error: updErr } = await supabase
      .from('po_import_lines')
      .update({
        item_id: resolvedItemId,
        suggested_item_id: suggestedItemId,
        match_status: 'mapped',
        exception_reason: null,
        // Flag item_created only when WE actually created a new inventory row
        // (the create branch, OR a use_existing line whose selected charter
        // forced a new same-SKU instance). Linking a pre-existing item stays
        // false so cancel-cleanup never archives it.
        item_created: didCreate,
      })
      .eq('id', l.id as string);
    if (updErr) throw new ServiceError('internal_error', updErr.message);

    // Save a vendor_item_mapping so future POs from the same vendor
    // with the same item number auto-match without manual mapping.
    // Best-effort: a mapping failure shouldn't undo the item we just
    // created. Applies whether we created a new item or linked to an
    // existing one — the next PO from this vendor will auto-match.
    if (vendorItemNumber || vendorProductNumber || auxiliaryNumber) {
      try {
        await mappingsSvc.upsert({
          vendorId: input.vendorId,
          itemId: resolvedItemId,
          vendorItemNumber,
          vendorProductNumber,
          auxiliaryNumber,
          vendorDescription: description,
          vendorUom: (l.uom_original as string | null) ?? null,
          packQty: null,
          conversionFactor: null,
        });
        mapped++;
      } catch (e) {
        console.error('vendor mapping upsert failed', {
          itemId: resolvedItemId,
          vendorItemNumber,
          error: e instanceof Error ? e.message : e,
        });
      }
    }
  }

  return { created, mapped, linked, skipped };
}
