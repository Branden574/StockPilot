/**
 * Which variant attributes a Sports category REQUIRES, and how to say so.
 *
 * ONE rule, shared by the server and every client. Before this module the
 * server enforced a subcategory's `requiredAttributes` while the web item form
 * labelled every sports field "(optional)" and checked nothing, so the first
 * place a person learned that a Jersey needs a size was a toast after Save
 * (L4L, 2026-09-29: three failed creates in a row). The web form, the phone's
 * New Item screen and the PO-import review now ask this module the same
 * question the server asks, with the same inputs, so the label, the inline
 * error and the server's refusal cannot disagree.
 *
 * The server stays the authority: it calls `requiredAttributeProblems` itself
 * (sports-profiles.ts) and refuses a create the clients let through.
 */

import {
  DEFAULT_SUBCATEGORY_PROFILES,
  type SportsAttribute,
  type SportsErrorCode,
  type SubcategoryTrackingProfile,
} from './tracking-modes';

function isProfileShaped(value: unknown): value is SubcategoryTrackingProfile {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<SubcategoryTrackingProfile>;
  return (
    typeof v.label === 'string' &&
    Array.isArray(v.requiredAttributes) &&
    Array.isArray(v.supportedAttributes)
  );
}

/**
 * The profile a category resolves to: the BUILT-IN profile for its
 * `sports_subcategory_key`, else the category's own `tracking_profile` jsonb
 * (a custom subcategory must carry a full one), else none.
 *
 * This is `resolveTrackingProfile`'s rule (apps/web sports-profiles.ts), moved
 * here so the clients stop reading the built-in table alone — a custom
 * subcategory used to show no sports fields at all while the server enforced
 * its required attributes.
 *
 * An own-property check, not a bare index: a key such as "__proto__" or
 * "toString" would otherwise resolve to an inherited object and pass for a
 * profile. (`hasOwnProperty.call` rather than `Object.hasOwn` so the phone's JS
 * engine never depends on the newer builtin.)
 */
export function resolveSubcategoryProfile(
  subcategoryKey: string | null | undefined,
  customProfile: unknown,
): SubcategoryTrackingProfile | null {
  const builtIn =
    subcategoryKey &&
    Object.prototype.hasOwnProperty.call(DEFAULT_SUBCATEGORY_PROFILES, subcategoryKey)
      ? DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as keyof typeof DEFAULT_SUBCATEGORY_PROFILES]
      : null;
  if (builtIn) return builtIn;
  return isProfileShaped(customProfile) ? customProfile : null;
}

/** True when the profile refuses a create without this attribute. */
export function isAttributeRequired(
  profile: SubcategoryTrackingProfile | null | undefined,
  attribute: SportsAttribute,
): boolean {
  return profile?.requiredAttributes.includes(attribute) ?? false;
}

/**
 * Whether the PERSON must give this attribute for a single-item create: the
 * question a field label answers ("Size" versus "Size (optional)").
 *
 * The same inputs `requiredAttributeProblems` checks, so a label can never call
 * a field required that the save goes through without, or the reverse:
 *
 *   - only size, size system and jersey number can be required. A custom
 *     profile may list brand, team, color and others in requiredAttributes,
 *     but the server enforces nothing else, so they stay optional;
 *   - a size system is required only when the category's size scale does not
 *     set one (the server fills an omitted system from the scale). A scale the
 *     page could not read (`scaleSystemKnown: false`) is left to the server,
 *     exactly as the check leaves it.
 */
export function attributeInputRequired(
  profile: SubcategoryTrackingProfile | null | undefined,
  attribute: SportsAttribute,
  opts: { scaleSizeSystem?: string | null; scaleSystemKnown?: boolean } = {},
): boolean {
  if (!isAttributeRequired(profile, attribute)) return false;
  if (attribute === 'size' || attribute === 'jersey_number') return true;
  if (attribute === 'size_system') {
    return opts.scaleSystemKnown !== false && text(opts.scaleSizeSystem).length === 0;
  }
  return false;
}

/** The three attributes a create can be refused for, and the form field each one is typed into. */
export const REQUIRED_ATTRIBUTE_FIELDS = {
  size: 'variantSize',
  size_system: 'variantSizeSystem',
  jersey_number: 'jerseyNumber',
} as const;
export type RequiredVariantAttribute = keyof typeof REQUIRED_ATTRIBUTE_FIELDS;
export type RequiredAttributeField = (typeof REQUIRED_ATTRIBUTE_FIELDS)[RequiredVariantAttribute];

export function isRequiredAttributeField(value: unknown): value is RequiredAttributeField {
  return value === 'variantSize' || value === 'variantSizeSystem' || value === 'jerseyNumber';
}

export interface RequiredAttributeProblem {
  attribute: RequiredVariantAttribute;
  /** The form field to point at (web RHF name, phone form key, API details.field). */
  field: RequiredAttributeField;
  code: SportsErrorCode;
  /** The whole sentence: names the field and the product type. Server and alerts use it. */
  message: string;
  /** What to do, for the inline error under the field itself. */
  hint: string;
}

export interface RequiredAttributeValues {
  variantSize?: string | null;
  variantSizeSystem?: string | null;
  jerseyNumber?: string | null;
}

export interface RequiredAttributeOptions {
  /**
   * The system of the category's size scale (the category's own, else its
   * parent's). The server fills an omitted size system from it once a size is
   * given, and a size run takes its system from nowhere else.
   */
  scaleSizeSystem?: string | null;
  /** A size run: every row carries its own size and the run cannot carry a size system. */
  sizeRun?: boolean;
  /**
   * Whether this surface offers size chips to pick a run from. Wording only:
   * `false` drops "or pick sizes" from the sentence, unset keeps it.
   */
  sizeRunAvailable?: boolean;
  /**
   * Whether this surface can add ONE item with a typed size and a picked size
   * system. Wording only, for a size run whose scale sets no system: `false`
   * (the phone, where a sized category always takes the run path) says to ask
   * an admin or use the web instead of "add the sizes one at a time". Unset
   * keeps the web wording.
   */
  singleSizeAvailable?: boolean;
}

function text(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Mirrors `jerseyNumberSchema`'s preprocessing: a bare "#" is no number. */
function jerseyText(v: string | null | undefined): string {
  return text(v).replace(/^#+/, '').trim();
}

/**
 * Every required attribute this create would be refused for, in the profile's
 * own order (the server throws the first).
 *
 * The size system mirrors `InventoryService.create()`: a typed system wins, and
 * the category's scale fills an omission ONLY once a size is given (the server
 * reads the scale only then). A size run takes the scale's system and nothing
 * else — `bulkCreateSizedVariantsSchema` has no size-system field.
 */
export function requiredAttributeProblems(
  profile: SubcategoryTrackingProfile | null | undefined,
  values: RequiredAttributeValues,
  opts: RequiredAttributeOptions = {},
): RequiredAttributeProblem[] {
  if (!profile) return [];
  const label = profile.label;
  const sizeRun = opts.sizeRun === true;
  const scaleSystem = text(opts.scaleSizeSystem);
  const hasSize = sizeRun || text(values.variantSize).length > 0;
  const system = sizeRun
    ? scaleSystem
    : text(values.variantSizeSystem) || (hasSize ? scaleSystem : '');

  const problems: RequiredAttributeProblem[] = [];
  for (const attribute of profile.requiredAttributes) {
    if (attribute === 'size' && !hasSize) {
      problems.push({
        attribute,
        field: 'variantSize',
        code: 'SHOE_SIZE_REQUIRED',
        // Offers the size chips unless the caller knows there are none (the
        // phone's single-item path). The server does not know the surface and
        // leaves `sizeRunAvailable` unset, so its sentence names both ways.
        message:
          opts.sizeRunAvailable === false
            ? `Size is required for ${label}: enter a size.`
            : `Size is required for ${label}: enter a size, or pick sizes to add one item per size.`,
        hint:
          opts.sizeRunAvailable === true
            ? 'Enter a size, or pick sizes above to add one item per size.'
            : 'Enter a size.',
      });
    } else if (attribute === 'size_system' && !system) {
      const noSingle = opts.singleSizeAvailable === false;
      problems.push({
        attribute,
        field: 'variantSizeSystem',
        code: 'SHOE_SIZE_SYSTEM_REQUIRED',
        message: !sizeRun
          ? `Size system is required for ${label}: pick the system the size is printed in, such as US Men's, UK or EU.`
          : noSingle
            ? `Size system is required for ${label}, and this category's size scale does not set one. Ask an admin to set a size system on the size scale, or add these items on the web.`
            : `Size system is required for ${label}, and this category's size scale does not set one. Add the sizes one at a time and pick a size system for each.`,
        hint: !sizeRun
          ? "Pick a size system, such as US Men's, UK or EU."
          : noSingle
            ? "This category's size scale sets no size system. Ask an admin to set one, or add these items on the web."
            : "This category's size scale sets no size system. Add the sizes one at a time and pick a system for each.",
      });
    } else if (attribute === 'jersey_number' && !jerseyText(values.jerseyNumber)) {
      problems.push({
        attribute,
        field: 'jerseyNumber',
        code: 'JERSEY_NUMBER_INVALID',
        message: `Jersey number is required for ${label}: enter the number, 1 to 4 digits.`,
        hint: 'Enter a jersey number, 1 to 4 digits.',
      });
    }
  }
  return problems;
}

const SHOE_SIZE_EXAMPLE: Record<string, string> = {
  US_MENS: '10.5',
  US_WOMENS: '8.5',
  US_YOUTH: '5',
  UK: '9.5',
  EU: '44',
  CM: '27',
};

/**
 * An example size for a size input's placeholder, fitting the category.
 *
 * The item form used to say "10.5" for every sports category. On Jerseys
 * (a letter scale, XS..6XL) that is not even a size the server accepts. Order:
 * the category's own scale (M, then 10.5, then its middle value), then the
 * size system, then the subcategory, then M.
 */
export function sizePlaceholder(input: {
  profile?: SubcategoryTrackingProfile | null;
  sizeSystem?: string | null;
  scaleValues?: readonly string[] | null;
}): string {
  const values = (input.scaleValues ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
  if (values.length > 0) {
    const upper = values.map((v) => v.toUpperCase());
    if (upper.includes('M')) return 'M';
    if (values.includes('10.5')) return '10.5';
    return values[Math.floor((values.length - 1) / 2)] ?? values[0]!;
  }
  const system = text(input.sizeSystem).toUpperCase();
  if (system === 'ALPHA') return 'M';
  const shoe = SHOE_SIZE_EXAMPLE[system];
  if (shoe) return shoe;
  if (input.profile?.key === 'shoes') return '10.5';
  if (input.profile?.key === 'balls') return '5';
  return 'M';
}
