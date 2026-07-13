// Plain (NON-'use client') module: label sizes + the ?template= validator.
// Lives outside label-sheet.tsx ('use client') on purpose — the labels page is
// a Server Component and calls parseTemplate() during render. Every export of a
// 'use client' module becomes a client REFERENCE, so a function exported from
// there cannot be invoked on the server (it throws "An error occurred in the
// Server Components render"). Keeping this data + validator here lets both the
// server page and the client sheet import it.

export type Template =
  | 'small'
  | 'medium'
  | 'large'
  | 'thermal-40x30'
  | 'thermal-50x30'
  | 'thermal-50x80';

export type LabelFormat = 'barcode' | 'qr';

export interface TemplateDef {
  label: string;
  /** 'sheet' = grid of labels on US-Letter (Avery). 'thermal' = roll printer
   *  (Phomemo M110/M120/M200-class): ONE label per page, @page size = the
   *  label size, zero margins, page-break after every label. */
  kind: 'sheet' | 'thermal';
  widthIn: number;
  heightIn: number;
  perRow: number;
  gapIn: number;
  /** CSS @page size. Sheets print on letter; thermal pages ARE the label. */
  pageSize: string;
}

const MM_PER_IN = 25.4;

export const TEMPLATES: Record<Template, TemplateDef> = {
  // Avery 5160 / Avery J8160 — 30 labels per US Letter sheet (3 x 10).
  small: { label: 'Small (Avery 5160 · 1" × 2 ⅝")', kind: 'sheet', widthIn: 2.625, heightIn: 1, perRow: 3, gapIn: 0.125, pageSize: 'letter' },
  // Avery 5163 — 10 labels per US Letter sheet (2 x 5).
  medium: { label: 'Medium (Avery 5163 · 2" × 4")', kind: 'sheet', widthIn: 4, heightIn: 2, perRow: 2, gapIn: 0.125, pageSize: 'letter' },
  // Avery 5164 — 6 labels per US Letter sheet (2 x 3).
  large: { label: 'Large (Avery 5164 · 3 ⅓" × 4")', kind: 'sheet', widthIn: 4, heightIn: 3.333, perRow: 2, gapIn: 0.125, pageSize: 'letter' },
  // Thermal roll stocks (Phomemo M110/M120/M200/M220 and similar). Sizes are
  // the common die-cut label stocks; pick the one matching the loaded roll.
  'thermal-40x30': { label: 'Thermal roll · 40 × 30 mm (Phomemo)', kind: 'thermal', widthIn: 40 / MM_PER_IN, heightIn: 30 / MM_PER_IN, perRow: 1, gapIn: 0, pageSize: '40mm 30mm' },
  'thermal-50x30': { label: 'Thermal roll · 50 × 30 mm (Phomemo)', kind: 'thermal', widthIn: 50 / MM_PER_IN, heightIn: 30 / MM_PER_IN, perRow: 1, gapIn: 0, pageSize: '50mm 30mm' },
  'thermal-50x80': { label: 'Thermal roll · 50 × 80 mm (Phomemo large)', kind: 'thermal', widthIn: 50 / MM_PER_IN, heightIn: 80 / MM_PER_IN, perRow: 1, gapIn: 0, pageSize: '50mm 80mm' },
};

/** Server-safe template validation for the ?template= URL param. */
export function parseTemplate(raw: string | undefined): Template {
  return raw && raw in TEMPLATES ? (raw as Template) : 'medium';
}
