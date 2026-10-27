/**
 * What the phone's count screens say when count boxes hold something that is
 * not a number (core countFromText: a lone minus sign, a second point, a
 * comma). Such a box saves nothing, so the count screen's Post and the AI
 * shelf-scan review's Confirm name those boxes and wait, rather than apply or
 * drop a number the box does not show.
 */

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function namedItems(itemNames: readonly string[]): string {
  const shown = itemNames.slice(0, 3);
  const more = itemNames.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length > 1) return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return shown[0] ?? '';
}

/** What the count screen's Post says. An emptied box leaves its line uncounted there. */
export function notACountMessage(itemNames: readonly string[]): string {
  const named = namedItems(itemNames);
  return itemNames.length === 1
    ? `The count box for ${named} does not hold a number. Type the count, or empty the box to leave the line uncounted.`
    : `The count boxes for ${named} do not hold a number. Type each count, or empty a box to leave its line uncounted.`;
}

/**
 * What the AI review's Confirm says. An emptied box there writes nothing for
 * its line (never the AI's count, never a 0), so the line keeps the count it
 * had.
 */
export function reviewNotACountMessage(itemNames: readonly string[]): string {
  const named = namedItems(itemNames);
  return itemNames.length === 1
    ? `The count box for ${named} does not hold a number. Type the count, or empty the box to save nothing for that line.`
    : `The count boxes for ${named} do not hold a number. Type each count, or empty a box to save nothing for its line.`;
}
