import { describe, expect, it } from 'vitest';

import { cycleCountStartedMessage } from './start-summary';

describe('cycleCountStartedMessage', () => {
  it('says how many lines the count started with', () => {
    expect(cycleCountStartedMessage(3, 0)).toBe('Cycle count started · 3 items.');
    expect(cycleCountStartedMessage(1, 0)).toBe('Cycle count started · 1 item.');
  });

  // 0369 (D8): rentals and kits are dropped at start. The old copy blamed
  // every drop on "archived or removed", which is wrong for them.
  it('says why picked items were left out, rentals and kits included', () => {
    expect(cycleCountStartedMessage(3, 2)).toBe(
      'Started with 3 items; 2 were left out. Archived or removed items, rental equipment and kits are not counted.',
    );
    expect(cycleCountStartedMessage(1, 1)).toContain('1 was left out');
  });
});
