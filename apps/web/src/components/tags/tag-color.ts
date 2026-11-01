import { safeHexColor } from '@stockpilot/core';

/** The grey a tag with no colour has always drawn. */
export const TAG_DEFAULT_COLOR = '#94a3b8';

/**
 * A tag's stored colour to draw: the `#rrggbb` form the app writes, else the
 * default grey. The column is plain text a manager can also write through
 * the Data API, and a style value reaches the server HTML as given, so
 * anything else is never drawn (docket T14). Used by the Tags page, the item
 * form's tag chips and Add tags in the bulk bar.
 */
export function tagColor(color: string | null | undefined): string {
  return safeHexColor(color) ?? TAG_DEFAULT_COLOR;
}
