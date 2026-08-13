import { describe, expect, it } from 'vitest';

import { placementWarningMessage } from './placement-warning';

describe('placementWarningMessage', () => {
  it('names the rack, so the operator knows which shelf to check', () => {
    const msg = placementWarningMessage('Item created', { rackName: '28-A', count: 1 });
    expect(msg).toContain('28-A');
  });

  it('leads with the success clause verbatim — the create is NOT an error', () => {
    // The single most damaging misread of this message is "the item failed to
    // save", because the operator's fix for that is to enter it AGAIN and the
    // warehouse ends up with duplicate stock. The lead is emitted untouched so
    // the sentence opens on what succeeded.
    const msg = placementWarningMessage('Created 8 variants', { rackName: '12-B', count: 3 });
    expect(msg.startsWith('Created 8 variants,')).toBe(true);
    expect(msg).not.toMatch(/\b(failed to create|error|could not create)\b/i);
  });

  it('says where the stock actually IS, not merely that something went wrong', () => {
    // "Placement failed" tells nobody what to do. "It is still where it
    // started" is the half that resolves the picker's confusion when the rack
    // is empty.
    const msg = placementWarningMessage('Item created', { rackName: '28-A', count: 1 });
    expect(msg).toContain('still where it started');
  });

  it('a single item says "its stock"; several say how many', () => {
    expect(placementWarningMessage('Item created', { rackName: '1-A', count: 1 })).toContain(
      'its stock could not be placed',
    );
    const many = placementWarningMessage('Created 8 variants', { rackName: '1-A', count: 3 });
    expect(many).toContain('the stock for 3 of them could not be placed');
    // The count is the FAILED count, never the created count — an operator who
    // reads "8" here would think the whole run is misplaced when 5 of them are
    // fine, and would restack shelves that were never wrong.
    expect(many).not.toContain('8 of them');
  });

  it('renders one whole sentence for any count, with no leftover placeholder', () => {
    for (const count of [1, 2, 11, 500]) {
      const msg = placementWarningMessage('Item created', { rackName: '3-C', count });
      expect(msg).not.toMatch(/undefined|NaN|\{\}|\$\{/);
      expect(msg.endsWith('Check before picking.')).toBe(true);
    }
  });
});
