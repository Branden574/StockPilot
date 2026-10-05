import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { accountEpoch, endAccountEpoch } from './account-epoch';

describe('account epoch', () => {
  it('only ever moves forward', () => {
    const before = accountEpoch();
    endAccountEpoch();
    expect(accountEpoch()).toBe(before + 1);
  });

  it('the account eviction ends it before it clears the stored keys', () => {
    // use-account-gate.ts imports React Native modules, so its wiring is pinned
    // by source: a workspace load or switch still running must see the ended
    // epoch before the workspace key is removed, or it could save one back.
    const gate = readFileSync(path.join(__dirname, 'use-account-gate.ts'), 'utf8');
    // The order requests' hold step (PO-4 review) runs between the two, after
    // the epoch has ended, so no storefront write can land while it reads.
    expect(gate).toMatch(
      /clearAccountStorage: async \(\) => \{[\s\S]{0,300}?endAccountEpoch\(\);[\s\S]{0,700}?const keys = accountScopedStorageKeys\(await AsyncStorage\.getAllKeys\(\)\);/,
    );
    const body = gate.slice(gate.indexOf('clearAccountStorage: async () => {'));
    expect(body.indexOf('endAccountEpoch();')).toBeLessThan(body.indexOf('AsyncStorage.multiRemove(keys)'));
    expect(body.slice(0, body.indexOf('endAccountEpoch();'))).not.toMatch(/multiRemove|holdDeviceOrderSends/);
  });
});
