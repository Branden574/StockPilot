import { safeHexColor } from '@stockpilot/core';

import { ServiceError } from '../context';

/**
 * Refuse a colour that is not the `#rrggbb` form the app writes, before
 * anything is saved (docket T14). The actions check it first; this keeps any
 * other server path into the category, tag and procedure-category services
 * from saving a colour a page would then draw. Null clears the colour and
 * undefined leaves it alone; both pass.
 */
export function assertStoredColor(color: string | null | undefined): void {
  if (color == null) return;
  if (safeHexColor(color) === null) {
    throw new ServiceError('validation_error', 'Use a hex color like #6366f1');
  }
}
