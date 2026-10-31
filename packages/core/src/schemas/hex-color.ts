import { z } from 'zod';

/**
 * The one colour form the app writes for a category, a tag or a procedure
 * category: `#` and six hex digits. The colour pickers, the preset swatches
 * and the seeded procedure categories all write it.
 */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Save side: the colour a create or update action accepts. */
export const hexColorSchema = z.string().regex(HEX_COLOR_PATTERN, 'Use a hex color like #6366f1');

/**
 * Draw side: a stored colour, only when it is the form the app writes; null
 * otherwise, so the caller draws its default colour.
 *
 * The colour columns are plain text that a manager can also write through
 * the Data API (row-level security allows it, and no CHECK constrains them),
 * and React's server renderer copies a style value into the page as given:
 * it escapes HTML, not CSS. So a stored `#000;position:fixed;inset:0` added
 * its own declarations to every member's page (docket T14). Every style and
 * CSS variable that draws a stored colour, on the web and on the phone, goes
 * through this check.
 */
export function safeHexColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value : null;
}
