import { MOVEMENT_TYPE_OPTIONS } from '@/lib/movements-filters';

import { movementTitle } from '@stockpilot/core';

/**
 * A movement type's words and tone, for every page that names or colours a
 * type: the Movements table (movements-table.tsx, which re-exports these) and
 * the Overview's activity rows and 30-day breakdown (recent-activity.tsx and
 * dashboard/page.tsx).
 *
 * This module imports no component. The Overview used to read these from
 * movements-table.tsx, which also imports the table's client islands (the
 * note editor and LocalDateTime), so the Overview's page bundle carried the
 * Movements note editor it never draws. Keep it free of client imports.
 */

/** The type's words: the same labels the type filter offers (Receive PO, ...). */
const TYPE_LABEL = new Map<string, string>(MOVEMENT_TYPE_OPTIONS.map((o) => [o.value, o.label]));

/**
 * The words for a type: the filter's label for the 10 real types, and for any
 * other code the ledger holds (the database also allows bundle_assembly,
 * bundle_distribution and bundle_shortage, which the filter does not offer)
 * core's own fallback, the code title-cased ("Bundle assembly"), so a row never
 * prints a raw code or nothing. These used to print as the raw code in capitals.
 *
 * A deliberate word change, recorded for the integrator and the owner: DESIGN-SPEC
 * 6.10 names these filter labels as the movement type's words, and the row now
 * reads the same as the chip that is pressed. The page's Export CSV keeps the
 * raw code (movement_type), as the stock movement report keeps its codes in its
 * CSV and PDF (CONFLICTS RP9), so the screen and the file use different words.
 */
export function movementTypeLabel(type: string): string {
  return TYPE_LABEL.get(type) ?? movementTitle(type);
}

/**
 * A movement type's tone (DESIGN-SPEC 6.10, the reference's coloured type with
 * a dot): stock coming in reads in the accent, adjustments in caution,
 * write-offs in danger, and moves, removals and opening counts in the
 * secondary ink. The words are always printed, so colour is never the only cue.
 *
 * One map for every page that colours a type: the Movements table and the
 * Overview's activity rows (recent-activity.tsx) both read it, so a type cannot
 * read one colour on one page and another on the other. The Overview used to
 * colour the type by the sign of the change, so Correction read in the accent
 * there and in caution on Movements, and Loss and Damage read grey there and
 * red on Movements (FX5).
 */
export type MovementTypeTone = 'accent' | 'warning' | 'destructive' | 'muted';

export const MOVEMENT_TYPE_TONE: Readonly<Record<string, MovementTypeTone>> = {
  add: 'accent',
  receive_po: 'accent',
  return: 'accent',
  adjust: 'warning',
  correction: 'warning',
  damage: 'destructive',
  loss: 'destructive',
  remove: 'muted',
  transfer: 'muted',
  initial: 'muted',
};

/** The tone for a type; any other code the ledger holds is in ink 2. */
export function movementTypeTone(type: string): MovementTypeTone {
  return Object.hasOwn(MOVEMENT_TYPE_TONE, type) ? MOVEMENT_TYPE_TONE[type]! : 'muted';
}
