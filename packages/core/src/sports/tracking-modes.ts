/**
 * Sports tracking-mode vocabulary — the ONE definition shared by web, Expo and
 * the server. Modes describe a CATEGORY's policy; `tracking_type` on an item is
 * the stamped consequence (see `trackingTypeForMode`). Keeping the two separate
 * is what lets post_receipt_v2's proven enforcement seam stay untouched: the RPC
 * still only ever reads inventory_items.tracking_type.
 */

/** Category-level policy. Requirements doc, "Tracking modes". */
export const TRACKING_MODES = [
  'QUANTITY',
  'QUANTITY_BY_VARIANT',
  'NUMBERED_VARIANT',
  'SERIALIZED',
  'OPTIONAL_SERIALIZED',
  'INDIVIDUALLY_TAGGED',
  'LOT_TRACKED',
] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

/** The per-item column values. 'serial_optional' is added by migration 0295. */
export const TRACKING_TYPE_VALUES = ['none', 'lot', 'serial', 'serial_optional'] as const;
export type TrackingTypeValue = (typeof TRACKING_TYPE_VALUES)[number];

/**
 * Category mode -> per-item tracking_type. This is the ONLY mapping; the server
 * stamps items with it at creation and nothing downstream re-derives it.
 *
 * INDIVIDUALLY_TAGGED maps to 'serial' on purpose: a tagged helmet is a unit
 * with a mandatory identifier, and the asset tag rides serial_registry.
 */
const MODE_TO_TRACKING_TYPE: Record<TrackingMode, TrackingTypeValue> = {
  QUANTITY: 'none',
  QUANTITY_BY_VARIANT: 'none',
  NUMBERED_VARIANT: 'none',
  SERIALIZED: 'serial',
  OPTIONAL_SERIALIZED: 'serial_optional',
  INDIVIDUALLY_TAGGED: 'serial',
  LOT_TRACKED: 'lot',
};

export function trackingTypeForMode(mode: TrackingMode): TrackingTypeValue {
  return MODE_TO_TRACKING_TYPE[mode];
}

/**
 * Human display label for a tracking mode. UI-only — never used for a
 * decision, so a copy tweak here can never change enforcement (that lives in
 * `MODE_TO_TRACKING_TYPE` / `trackingTypeForMode` above).
 */
export const TRACKING_MODE_LABELS: Record<TrackingMode, string> = {
  QUANTITY: 'Quantity',
  QUANTITY_BY_VARIANT: 'Quantity by variant',
  NUMBERED_VARIANT: 'Numbered variant',
  SERIALIZED: 'Serialized',
  OPTIONAL_SERIALIZED: 'Optional serial',
  INDIVIDUALLY_TAGGED: 'Individually tagged',
  LOT_TRACKED: 'Lot tracked',
};

/** True when the mode expects more than one variant row under one group. */
export function modeHasVariants(mode: TrackingMode): boolean {
  return mode === 'QUANTITY_BY_VARIANT' || mode === 'NUMBERED_VARIANT';
}

/** Counting unit. PAIR is a DISPLAY convention — never a conversion factor. */
export const COUNTING_UNITS = ['each', 'pair', 'set', 'case', 'unit'] as const;
export type CountingUnit = (typeof COUNTING_UNITS)[number];

/** Plural display label for a counting unit ("12 pairs"). */
export function countingUnitLabel(unit: CountingUnit, quantity: number): string {
  if (unit === 'each') return 'each';
  return quantity === 1 ? unit : `${unit}s`;
}

/** The initial Sports subcategory set. Admins may add more (Task 12). */
export const SPORTS_SUBCATEGORIES = [
  'shoes',
  'jerseys',
  'uniforms',
  'sports_apparel',
  'protective_equipment',
  'balls',
  'training_equipment',
  'other_sports_equipment',
] as const;
export type SportsSubcategoryKey = (typeof SPORTS_SUBCATEGORIES)[number];

/**
 * A full tracking profile. A CUSTOM subcategory must carry all of these too
 * (requirements: "custom subcategory MUST carry a full tracking profile").
 */
export interface SubcategoryTrackingProfile {
  key: string;
  label: string;
  defaultMode: TrackingMode;
  /** Modes an authorized user may override to for this subcategory. */
  allowedModes: TrackingMode[];
  /** Attributes the UI offers. */
  supportedAttributes: SportsAttribute[];
  /** Attributes the SERVER rejects a create without. */
  requiredAttributes: SportsAttribute[];
  defaultCountingUnit: CountingUnit;
  supportsNumbers: boolean;
  supportsSizes: boolean;
  supportsColors: boolean;
  /** Whether an org may escalate this subcategory to INDIVIDUALLY_TAGGED. */
  individualTrackingAllowed: boolean;
}

export const SPORTS_ATTRIBUTES = [
  'brand',
  'model',
  'style_number',
  'colorway',
  'size',
  'size_system',
  'width',
  'fit',
  'jersey_number',
  'player_name',
  'team',
  'league',
  'season',
  'home_away',
  'color',
] as const;
export type SportsAttribute = (typeof SPORTS_ATTRIBUTES)[number];

export const DEFAULT_SUBCATEGORY_PROFILES: Record<
  SportsSubcategoryKey,
  SubcategoryTrackingProfile
> = {
  shoes: {
    key: 'shoes',
    label: 'Shoes',
    defaultMode: 'QUANTITY_BY_VARIANT',
    allowedModes: ['QUANTITY_BY_VARIANT', 'QUANTITY', 'OPTIONAL_SERIALIZED'],
    supportedAttributes: [
      'brand', 'model', 'style_number', 'colorway',
      'size', 'size_system', 'width', 'fit',
    ],
    requiredAttributes: ['size', 'size_system'],
    defaultCountingUnit: 'pair',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  jerseys: {
    key: 'jerseys',
    label: 'Jerseys',
    defaultMode: 'NUMBERED_VARIANT',
    allowedModes: ['NUMBERED_VARIANT', 'QUANTITY_BY_VARIANT', 'INDIVIDUALLY_TAGGED'],
    supportedAttributes: [
      'team', 'league', 'season', 'home_away', 'brand', 'style_number',
      'jersey_number', 'player_name', 'size', 'size_system', 'fit', 'color',
    ],
    requiredAttributes: ['size'],
    defaultCountingUnit: 'each',
    supportsNumbers: true,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
  uniforms: {
    key: 'uniforms',
    label: 'Uniforms',
    defaultMode: 'QUANTITY_BY_VARIANT',
    allowedModes: ['QUANTITY_BY_VARIANT', 'NUMBERED_VARIANT', 'QUANTITY'],
    supportedAttributes: [
      'team', 'league', 'season', 'brand', 'style_number',
      'size', 'size_system', 'fit', 'color',
    ],
    requiredAttributes: ['size'],
    defaultCountingUnit: 'set',
    supportsNumbers: true,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  sports_apparel: {
    key: 'sports_apparel',
    label: 'Sports apparel',
    defaultMode: 'QUANTITY_BY_VARIANT',
    allowedModes: ['QUANTITY_BY_VARIANT', 'QUANTITY'],
    supportedAttributes: ['brand', 'model', 'style_number', 'size', 'size_system', 'fit', 'color'],
    requiredAttributes: ['size'],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  protective_equipment: {
    key: 'protective_equipment',
    label: 'Protective equipment',
    defaultMode: 'OPTIONAL_SERIALIZED',
    allowedModes: ['OPTIONAL_SERIALIZED', 'INDIVIDUALLY_TAGGED', 'QUANTITY_BY_VARIANT', 'QUANTITY'],
    supportedAttributes: ['brand', 'model', 'style_number', 'size', 'size_system', 'color'],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
  balls: {
    key: 'balls',
    label: 'Balls',
    defaultMode: 'QUANTITY',
    allowedModes: ['QUANTITY', 'OPTIONAL_SERIALIZED', 'QUANTITY_BY_VARIANT'],
    supportedAttributes: ['brand', 'model', 'style_number', 'size', 'color'],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  training_equipment: {
    key: 'training_equipment',
    label: 'Training equipment',
    defaultMode: 'OPTIONAL_SERIALIZED',
    allowedModes: ['OPTIONAL_SERIALIZED', 'QUANTITY', 'INDIVIDUALLY_TAGGED'],
    supportedAttributes: ['brand', 'model', 'style_number', 'color'],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: false,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
  other_sports_equipment: {
    key: 'other_sports_equipment',
    label: 'Other sports equipment',
    // "Other=org-configurable" — QUANTITY is the safe floor; every mode is
    // reachable by an authorized override.
    defaultMode: 'QUANTITY',
    allowedModes: [...TRACKING_MODES],
    supportedAttributes: [...SPORTS_ATTRIBUTES],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: true,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
};

/** Error codes mapped to user title/explanation/action/severity in the UI. */
export const SPORTS_ERROR_CODES = [
  'SPORTS_SUBCATEGORY_REQUIRED',
  'TRACKING_MODE_NOT_ALLOWED',
  'SERIAL_NUMBER_REQUIRED',
  'SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT',
  'JERSEY_NUMBER_INVALID',
  'SHOE_SIZE_REQUIRED',
  'SHOE_SIZE_SYSTEM_REQUIRED',
  'COUNTING_UNIT_REQUIRED',
  'VARIANT_ALREADY_EXISTS',
  'POSSIBLE_PRODUCT_GROUP_DUPLICATE',
  'AMBIGUOUS_VARIANT_MATCH',
  'IMPORT_MAPPING_REVIEW_REQUIRED',
  'TRACKING_MODE_CHANGE_REQUIRES_MIGRATION',
] as const;
export type SportsErrorCode = (typeof SPORTS_ERROR_CODES)[number];

export interface SportsErrorMeta {
  title: string;
  explanation: string;
  action: string;
  severity: 'error' | 'warning' | 'info';
}

export const SPORTS_ERROR_META: Record<SportsErrorCode, SportsErrorMeta> = {
  SPORTS_SUBCATEGORY_REQUIRED: {
    title: 'Pick a Sports subcategory',
    explanation: 'Sports items are grouped by subcategory (Shoes, Jerseys, and so on).',
    action: 'Choose a subcategory, then continue.',
    severity: 'error',
  },
  TRACKING_MODE_NOT_ALLOWED: {
    title: 'That tracking mode is not allowed here',
    explanation: 'This subcategory does not permit the selected mode.',
    action: 'Pick a mode this subcategory allows, or change the subcategory.',
    severity: 'error',
  },
  SERIAL_NUMBER_REQUIRED: {
    title: 'Serial number required',
    explanation: 'This item is serialized, so every unit needs its own serial.',
    action: 'Enter one serial per unit received.',
    severity: 'error',
  },
  SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT: {
    title: 'Serials are not used for this product',
    explanation: 'Quantity variants are counted, not serialized. Placeholder serials are never accepted.',
    action: 'Remove the serial column, or change the tracking mode.',
    severity: 'error',
  },
  JERSEY_NUMBER_INVALID: {
    title: 'Check the jersey number',
    explanation: 'A jersey number is 1-4 characters, digits only, and keeps leading zeroes.',
    action: 'Correct the number, or leave it blank.',
    severity: 'error',
  },
  SHOE_SIZE_REQUIRED: {
    title: 'Size required',
    explanation: 'Shoes are tracked per size, so each variant needs its own size.',
    action: 'Enter a size for every variant.',
    severity: 'error',
  },
  SHOE_SIZE_SYSTEM_REQUIRED: {
    title: 'Size system required',
    explanation: 'A size of 9 means nothing without knowing whether it is US Men, UK or EU.',
    action: 'Pick the size system this run is printed in.',
    severity: 'error',
  },
  COUNTING_UNIT_REQUIRED: {
    title: 'Counting unit required',
    explanation: 'The unit decides whether a quantity reads as pairs, each, sets or cases.',
    action: 'Pick a counting unit.',
    severity: 'error',
  },
  VARIANT_ALREADY_EXISTS: {
    title: 'That variant already exists',
    explanation: 'This group already has a variant with these attributes.',
    action: 'Receive into the existing variant instead of creating a second one.',
    severity: 'warning',
  },
  POSSIBLE_PRODUCT_GROUP_DUPLICATE: {
    title: 'Possible duplicate product group',
    explanation: 'An existing group looks very close to this one.',
    action: 'Review the candidates and either link or confirm a new group.',
    severity: 'warning',
  },
  AMBIGUOUS_VARIANT_MATCH: {
    title: 'More than one variant matches',
    explanation: 'The attributes on this row match several existing variants.',
    action: 'Pick the right variant. Nothing is merged automatically.',
    severity: 'warning',
  },
  IMPORT_MAPPING_REVIEW_REQUIRED: {
    title: 'Confirm the column mapping',
    explanation: 'A column such as "Number" could be a jersey number, a quantity, a serial or a style.',
    action: 'Confirm what each flagged column means, then re-run the import.',
    severity: 'warning',
  },
  TRACKING_MODE_CHANGE_REQUIRES_MIGRATION: {
    title: 'Changing how this is tracked needs a migration',
    explanation:
      'This product already has stock movements, so the units already counted were received under the current rules. Changing them in place would leave that history describing a contract the product no longer has.',
    // NO WIZARD. There is no guided tracking-mode migration in the product and
    // pointing a user at one they cannot find is worse than saying who to ask.
    action:
      'Contact support to migrate this product, or create a new product with the tracking you need.',
    severity: 'error',
  },
};
