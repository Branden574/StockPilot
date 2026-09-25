/**
 * What a person is told after starting a cycle count from a selection (web
 * selection-confirm and the phone's new-count screen say the same thing).
 *
 * `skipped` is how many picked items the start left out. Since 0369 (owner
 * default D8) that is not only archived or deleted items: rental equipment
 * and kit phantoms are never counted either, so a counter who ticked a rental
 * canopy or a kit is told why it is not on the count instead of looking for a
 * line that does not exist.
 */
export function cycleCountStartedMessage(lineCount: number, skipped: number): string {
  const items = `${lineCount} item${lineCount === 1 ? '' : 's'}`;
  if (skipped <= 0) return `Cycle count started · ${items}.`;
  const verb = skipped === 1 ? 'was' : 'were';
  return `Started with ${items}; ${skipped} ${verb} left out. Archived or removed items, rental equipment and kits are not counted.`;
}
