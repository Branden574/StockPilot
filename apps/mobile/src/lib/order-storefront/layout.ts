import { ROW_STACK_FONT_SCALE } from '../dynamic-type-layout';
import { pickQtyFieldWidthFor } from '../pick-qty-field';

/**
 * THE STOREFRONT'S SHAPE ON IPHONE AND IPAD (phone ordering PO-4, plan "iPad").
 * The app's first width-based layout, so the decision is here, pure and
 * tested, never in a screen (pattern: dynamic-type-layout.ts).
 *
 *   - SPLIT (a catalog and a 360 pt cart column side by side) at a window at
 *     least 700 pt wide AND text at most 1.4x (the app's row-stacking
 *     threshold). Portrait iPads are 744 to 1032 pt wide; every iPhone is
 *     narrower than 700 pt.
 *   - PHONE (one column, a cart bar at the bottom) otherwise, including an
 *     iPad at an accessibility text size: two columns of AX5 text would
 *     leave neither readable.
 *   - Sheets are at most 640 pt wide, and checkout and the success screen
 *     read in a column at most 640 pt wide, centred.
 *   - No grid on the iPad (plan section 7).
 *
 * Point sizes only, never percentages (percentage sizes collapsed layouts
 * under Fabric).
 */

export const SPLIT_MIN_WIDTH = 700;
export const SPLIT_MAX_FONT_SCALE = ROW_STACK_FONT_SCALE;
export const CART_COLUMN_WIDTH = 360;
export const SHEET_MAX_WIDTH = 640;
export const READING_COLUMN_MAX_WIDTH = 640;
/** The screens' side gutter. */
export const STOREFRONT_GUTTER = 20;

export type StorefrontLayoutKind = 'phone' | 'split';

export interface StorefrontLayout {
  kind: StorefrontLayoutKind;
  /** The cart column's width in split, 0 in phone. */
  cartColumnWidth: number;
  /** The catalog's width (the window less the cart column in split). */
  catalogWidth: number;
  /** A sheet's width, centred. */
  sheetWidth: number;
  /** Checkout's and the success screen's reading column, centred. */
  readingWidth: number;
}

function finite(n: number | null | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function storefrontLayoutKind(input: { width: number; fontScale: number }): StorefrontLayoutKind {
  const width = finite(input.width, 0);
  const fontScale = finite(input.fontScale, 1);
  return width >= SPLIT_MIN_WIDTH && fontScale <= SPLIT_MAX_FONT_SCALE ? 'split' : 'phone';
}

export function storefrontLayout(input: { width: number; fontScale: number }): StorefrontLayout {
  const width = finite(input.width, 0);
  const kind = storefrontLayoutKind(input);
  const cartColumnWidth = kind === 'split' ? CART_COLUMN_WIDTH : 0;
  return {
    kind,
    cartColumnWidth,
    catalogWidth: Math.max(0, width - cartColumnWidth),
    sheetWidth: Math.min(width, SHEET_MAX_WIDTH),
    readingWidth: Math.max(0, Math.min(width - 2 * STOREFRONT_GUTTER, READING_COLUMN_MAX_WIDTH)),
  };
}

/** An item row stacks its control under the text past the row threshold, so
 *  a long name keeps the full width (never broken mid-word). */
export function itemRowStacked(fontScale: number): boolean {
  return finite(fontScale, 1) > ROW_STACK_FONT_SCALE;
}

/** The stepper count's box: wide enough for the digits of what is
 *  available at the capped size (the pick field's rule), at least 44 pt. */
export function stepperCountWidth(available: number): number {
  const digits = Math.max(1, String(Math.max(0, Math.trunc(available))).length);
  return Math.max(MIN_TAP, pickQtyFieldWidthFor(Math.min(digits, 5)) - 24);
}

/** The iOS minimum tap target, in points. */
export const MIN_TAP = 44;
