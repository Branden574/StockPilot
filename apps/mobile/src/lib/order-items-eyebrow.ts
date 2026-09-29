/**
 * The order screen's ITEMS eyebrow: "ITEMS · 2 LINES · 5 UNITS", each word
 * singular for exactly one ("ITEMS · 1 LINE · 1 UNIT"; it said "1 UNITS").
 * The unit total is shown as it comes (a part of a unit stays as it is).
 */
export function orderItemsEyebrow(lineCount: number, units: number): string {
  return `ITEMS · ${lineCount} LINE${lineCount === 1 ? '' : 'S'} · ${units} UNIT${units === 1 ? '' : 'S'}`;
}
