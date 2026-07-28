import 'server-only';

import {
  buildGroupKey,
  buildVariantKey,
  lineNeedsMappingConfirmation,
  SIZE_SYSTEMS,
  type GroupKeyParts,
  type LineResult,
  type SizeSystem,
  type SportsErrorCode,
} from '@stockpilot/core';

import type { ServiceContext } from './context';
import type { ProductGroupsService } from './product-groups';
import type { ResolvedTrackingProfile } from './sports-profiles';

export type { LineResult };

/**
 * Narrow a free-text size system to the shared vocabulary, or to NULL.
 *
 * `po_import_lines.variant_size_system` and `inventory_items
 * .variant_size_system` are plain TEXT, and the scan extractor writes whatever
 * the document said — deliberately, because the requirements demand the source
 * value be preserved. Normalizing on READ rather than on write is what lets
 * both be true at once: the row keeps "us mens", and an unrecognized system
 * reads as MISSING, so the size-system gate fires instead of a junk value
 * riding into a permanent identity key.
 */
export function asSizeSystem(v: string | null | undefined): SizeSystem | null {
  if (v == null) return null;
  const up = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (SIZE_SYSTEMS as readonly string[]).includes(up) ? (up as SizeSystem) : null;
}

/**
 * The subset of a `po_import_lines` row the resolver reads.
 *
 * Declared structurally rather than as `PoImportLineRow` so the batch review
 * path, the create path and the tests can all hand it the same shape, and so a
 * future column can be added here without widening the whole row type.
 */
export interface PoImportVariantLine {
  id: string;
  line_number: number;
  description: string | null;
  qty_ordered_original: number | null;
  vendor_product_number: string | null;
  variant_size: string | null;
  variant_size_system: string | null;
  variant_width: string | null;
  variant_fit: string | null;
  variant_color: string | null;
  jersey_number: string | null;
  player_name: string | null;
  group_hint: string | null;
  mapping_confidence: number | null;
  /**
   * The serial the DOCUMENT printed for this line, or null (migration 0301).
   *
   * A serial reaching a COUNTED variant, and a SERIALIZED product arriving
   * with no serial at all, are both failures the requirements single out, so
   * both are verdicts here. The column is populated three ways — the scan
   * extractor copying a printed serial, the CSV/parsed path, and a reviewer
   * declaring an ambiguous column to BE a serial in the confirmation step —
   * which is what makes the `serial_required` verdict settleable rather than a
   * dead end. Nothing ever fabricates a value: missing stays missing, and the
   * line stays blocked.
   */
  serial_hint: string | null;
  /** No `brand_hint` column exists in 0301; callers that have one may pass it. */
  brand_hint?: string | null;
}

/**
 * The GROUP identity parts for one line. Exported because the create path has
 * to build the same identity the resolver matched on: the resolver decides
 * "no existing group — create one", and `InventoryService.create` then
 * find-or-creates it. If the two derived their parts independently they would
 * eventually disagree, and a size run would fan out into one group per size
 * (which is exactly what R2 forbids). One function, two callers, no drift.
 */
export function groupPartsForLine(
  line: PoImportVariantLine,
  profile: ResolvedTrackingProfile,
): GroupKeyParts {
  return {
    subcategoryKey: profile.subcategoryKey ?? 'other_sports_equipment',
    brand: line.brand_hint ?? null,
    model: line.group_hint ?? null,
    styleNumber: line.vendor_product_number ?? null,
    colorway: line.variant_color ?? null,
    name: line.group_hint ?? line.description ?? null,
  };
}

/**
 * Narrow a raw `po_import_lines` row to what the resolver reads, NORMALIZING
 * the size system on the way through.
 *
 * The review path and the create path used to build this shape separately, and
 * only the create path ran `asSizeSystem`. A document that printed "us mens"
 * therefore resolved as HAVING a size system in review and as MISSING one at
 * creation — the review screen said "ready" and the create call threw. One
 * boundary, one normalization, and the two verdicts cannot diverge.
 */
export function toVariantLine(
  row: Record<string, unknown>,
  overrides: {
    size?: string | null;
    sizeSystem?: string | null;
    jerseyNumber?: string | null;
  } = {},
): PoImportVariantLine {
  const str = (v: unknown) => (v as string | null | undefined) ?? null;
  return {
    id: row.id as string,
    line_number: row.line_number as number,
    description: str(row.description),
    qty_ordered_original: (row.qty_ordered_original as number | null) ?? null,
    vendor_product_number: str(row.vendor_product_number),
    // The reviewer's on-screen fix wins over what the document said; the
    // document's own text is preserved in variant_size_original.
    variant_size: overrides.size ?? str(row.variant_size),
    // Normalized at the point of USE, never at the point of storage: the
    // column keeps whatever the document said (requirements: "preserve source
    // values"), and an unrecognized system reads as MISSING here so the
    // size-system gate fires instead of a junk value riding into an identity
    // key.
    variant_size_system: asSizeSystem(overrides.sizeSystem ?? str(row.variant_size_system)),
    variant_width: str(row.variant_width),
    variant_fit: str(row.variant_fit),
    variant_color: str(row.variant_color),
    jersey_number: overrides.jerseyNumber ?? str(row.jersey_number),
    player_name: str(row.player_name),
    group_hint: str(row.group_hint),
    serial_hint: str(row.serial_hint),
    mapping_confidence: (row.mapping_confidence as number | null) ?? null,
  };
}

export interface LineResolution {
  result: LineResult;
  groupId: string | null;
  /**
   * Display name of `groupId`. The review table has to be able to say WHICH
   * group a line landed on — "every decision visible in review" is unmeetable
   * with a bare uuid — and the resolver already holds the row.
   */
  groupName: string | null;
  /** More than one -> ambiguous, and the user must choose. */
  groupCandidates: Array<{ id: string; name: string }>;
  variantItemId: string | null;
  variantCandidates: Array<{ id: string; name: string; sku: string }>;
  variantKey: string | null;
  message: string | null;
  errorCode: SportsErrorCode | null;
}

export interface ResolveLineVariantDeps {
  /** Org-filtered, module-gated group reads. Exact key first, candidates second. */
  groups: Pick<ProductGroupsService, 'findByKey' | 'candidates' | 'variantsByKey'>;
  supabase: ServiceContext['supabase'];
  organizationId: string;
  /**
   * Whether the `sports` module is on for this org. Every `ProductGroupsService`
   * read asserts the module, so a category left carrying a sports subcategory
   * after the module was switched off would otherwise turn a routine import into
   * a hard `module_disabled` failure. With sports off the line resolves exactly
   * as it did before the sports program existed.
   */
  sportsEnabled: boolean;
}

/**
 * Resolve one import line to a group and a variant.
 *
 * ORDER MATTERS and is deliberate:
 *   1. Mapping confidence gate — an ambiguous column blocks before anything
 *      is matched, so a mis-mapped "Number" never becomes a jersey number.
 *   2. Serial sanity, on `tracking_type` alone, so it also covers the
 *      non-sports categories R1 protects (Electronics stays serial-required).
 *   3. GROUP FIRST, by exact deterministic key. Several size lines sharing a
 *      groupHint collapse onto one group here — that is the whole point.
 *   4. If the exact key misses, look for CANDIDATES. Zero -> create new. One
 *      -> still a suggestion, never a link. Two or more -> ambiguous, review.
 *   5. Required attributes, so the message names the group it belongs to.
 *   6. VARIANT within the resolved group, by exact variant key.
 *
 * Nothing in here ever merges on a name string alone, and nothing auto-links.
 */
export async function resolveLineVariant(
  deps: ResolveLineVariantDeps,
  line: PoImportVariantLine,
  profile: ResolvedTrackingProfile,
): Promise<LineResolution> {
  const empty: LineResolution = {
    result: 'ready',
    groupId: null,
    groupName: null,
    groupCandidates: [],
    variantItemId: null,
    variantCandidates: [],
    variantKey: null,
    message: null,
    errorCode: null,
  };

  // 1. Mapping confidence gate. SCOPED to lines that actually carry a sports
  // field mapping (see `lineNeedsMappingConfirmation`) — a bare confidence
  // test made every AI-scanned non-sports PO unapprovable.
  if (lineNeedsMappingConfirmation(line)) {
    return {
      ...empty,
      result: 'mapping_review_required',
      errorCode: 'IMPORT_MAPPING_REVIEW_REQUIRED',
      message: 'Confirm what the ambiguous column on this line means before importing.',
    };
  }

  // 2. Serial sanity. A quantity variant must never carry a serial, and a
  // serialized product must never arrive without one. Refuse rather than
  // dropping it silently, so a mis-mapped serial column is visible.
  //
  // This sits BEFORE the sports gate on purpose: `tracking_type` is the one
  // enforcement seam every category shares, so an Electronics category that is
  // explicitly SERIALIZED blocks here exactly as a serialized sports category
  // does (R1, at import time). Categories with no tracking mode — which is
  // every category in every org today — resolve to 'none' with no serial, so
  // neither branch can fire and nothing regresses.
  //
  // BOTH branches are SETTLEABLE, which is what makes blocking legitimate
  // rather than a dead end: `serial_hint` is a real 0301 column fed by the
  // scan extractor, the CSV path and the mapping-confirmation step, and the
  // line's category can be changed in review. Receipt-time enforcement in
  // post_receipt_v2 is untouched and remains the authority on what arrives.
  if (line.serial_hint && profile.trackingType === 'none') {
    return {
      ...empty,
      result: 'serial_required',
      errorCode: 'SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT',
      message:
        'This product is counted, not serialized. Re-map the serial column in the confirmation step, or file the line under a serialized category.',
    };
  }
  if (
    !line.serial_hint &&
    profile.trackingType === 'serial' &&
    Number(line.qty_ordered_original ?? 0) > 0
  ) {
    return {
      ...empty,
      result: 'serial_required',
      errorCode: 'SERIAL_NUMBER_REQUIRED',
      message:
        'This product is serialized and the document printed no serial for this line. Confirm which column holds the serial, or file the line under a counted category.',
    };
  }

  if (!profile.isSports || !deps.sportsEnabled) return empty;

  // 3. Group by exact deterministic key.
  const parts = groupPartsForLine(line, profile);
  const key = buildGroupKey(parts);
  const group = await deps.groups.findByKey(key);

  // 4. No exact hit -> candidates.
  let groupCandidates: Array<{ id: string; name: string }> = [];
  if (!group) {
    const cands = await deps.groups.candidates(parts);
    groupCandidates = cands.map((c) => ({ id: c.id, name: c.name }));
    if (groupCandidates.length > 1) {
      return {
        ...empty,
        result: 'ambiguous_variant_match',
        groupCandidates,
        errorCode: 'AMBIGUOUS_VARIANT_MATCH',
        message: 'Several existing product groups match this line. Pick one.',
      };
    }
    if (groupCandidates.length === 1) {
      // A SUGGESTION, not a link. The line stays in review until accepted.
      return {
        ...empty,
        result: 'possible_duplicate',
        groupCandidates,
        errorCode: 'POSSIBLE_PRODUCT_GROUP_DUPLICATE',
        message: 'An existing group looks like this one. Link it, or confirm a new group.',
      };
    }
  }

  // 5. Required attributes.
  const size = line.variant_size ?? null;
  if (profile.profile?.requiredAttributes.includes('size') && !size) {
    return {
      ...empty,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      result: 'missing_required_attribute',
      errorCode: 'SHOE_SIZE_REQUIRED',
      message: 'This line has no size, and this product is tracked per size.',
    };
  }
  if (
    profile.profile?.requiredAttributes.includes('size_system') &&
    !line.variant_size_system
  ) {
    return {
      ...empty,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      result: 'missing_required_attribute',
      errorCode: 'SHOE_SIZE_SYSTEM_REQUIRED',
      message: `A size of "${String(size)}" needs a size system (US Men, UK, EU).`,
    };
  }

  // 6. Variant within the group, by exact key.
  const variantKey = buildVariantKey({
    size,
    sizeSystem: line.variant_size_system,
    width: line.variant_width,
    fit: line.variant_fit,
    color: line.variant_color,
    jerseyNumber: line.jersey_number,
  });
  if (!group) {
    return { ...empty, result: 'create_new_group', variantKey, groupCandidates };
  }
  const variants = await deps.groups.variantsByKey(group.id, variantKey);
  if (variants.length > 1) {
    return {
      ...empty,
      groupId: group.id,
      groupName: group.name,
      variantKey,
      variantCandidates: variants,
      // The GROUP is not in doubt here — it was an exact key hit — and the
      // review UI only renders a group control when this list is non-empty.
      // Leaving it empty made the verdict unsettleable: the row was flagged
      // as blocking with no way to answer it. Offering the matched group is
      // also what lets "a new variant in this same group" be expressed
      // without inventing a second group for a product that already exists.
      groupCandidates: [{ id: group.id, name: group.name }],
      result: 'ambiguous_variant_match',
      errorCode: 'AMBIGUOUS_VARIANT_MATCH',
      message:
        'More than one existing variant matches. Pick the right one, or add a new variant to this group.',
    };
  }
  const onlyVariant = variants[0];
  if (variants.length === 1 && onlyVariant) {
    return {
      ...empty,
      groupId: group.id,
      groupName: group.name,
      variantKey,
      variantItemId: onlyVariant.id,
      result: 'receive_into_existing_variant',
    };
  }
  return {
    ...empty,
    groupId: group.id,
    groupName: group.name,
    variantKey,
    result: 'add_new_variant',
  };
}

/**
 * Resolve a whole review screen's worth of lines.
 *
 * The per-line profile is resolved by the caller (categories differ line by
 * line once lines are mapped to items), so this is a plain fan-out that keeps
 * the ORDER of `lines` and never lets one line's failure hide the others.
 */
export async function resolveLinesForReview(
  deps: ResolveLineVariantDeps,
  lines: Array<{ line: PoImportVariantLine; profile: ResolvedTrackingProfile }>,
): Promise<Record<string, LineResolution>> {
  const out: Record<string, LineResolution> = {};
  for (const { line, profile } of lines) {
    out[line.id] = await resolveLineVariant(deps, line, profile);
  }
  return out;
}
