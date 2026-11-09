import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { classicHash, projectionLeaks } from '../__fixtures__/classic-projection';

/**
 * CLASSIC IS UNCHANGED WHERE LIQUID GLASS DRAWS SOMETHING ELSE (stage 4).
 *
 * Every phone file that draws a Liquid Glass difference reads the look once
 * as `const lg = useGlass();` and writes each difference as a branch on it.
 * For each such file, this pins the hash of its CLASSIC PROJECTION (every
 * `lg` branch folded to Classic; lib/__fixtures__/classic-projection.ts, with
 * its own tests in lib/classic-projection.test.ts) to the hash of the same
 * file before Liquid Glass, at b64bd37cc (feat/liquid-glass, stage 3 merged,
 * where this lane started). Equal hashes mean the code Classic runs is that
 * very code: the same elements, props, styles, strings and order, so Classic
 * (the Classic design under the rollout's default, and every phone under
 * EXPO_PUBLIC_LIQUID_GLASS=off) draws as it did.
 *
 * A pin changes only when Classic itself is meant to change (a fix that
 * lands on main and is merged here): recompute it then, with the reason in
 * the commit. Never to make a glass change pass.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');

/** File (from apps/mobile) -> classic-projection SHA-256 of that file at b64bd37cc. */
export const CLASSIC_PINS: Readonly<Record<string, string>> = {
  'app/(drawer)/(tabs)/index.tsx':
    'c7144f5a0865d66f458dd685ecea28ac618b126f43cd2828a53e0e999e710f51',
  'app/(drawer)/(tabs)/inventory.tsx':
    '42d3d7a1d8a26a6355eb062ae63537bd64e44208d7facb712190217ccd319750',
  'app/(drawer)/(tabs)/receive.tsx':
    '6d32450d4607d50dfe274dc2c06b9fc3d655c40dbe673efa8f546910de3b43f6',
  'app/(drawer)/(tabs)/scan.tsx':
    '99ebd17a73d80075bd405bf5b141343ea2541701b3f011610af9d6620bc450da',
  'app/cycle-count/[id].tsx': '225237c617095b0e9b0857ca262bbefdb109bc9524436b38f1d34309b31e731e',
  'app/item/[id].tsx': '0e3f35aa258543d2c2beebcab5a0e4bdebe877f0b93226183bc29ac1922da3fa',
  'app/order/[id].tsx': 'fe0632b2ab978336d25fd87fcca26c0b30931d8cef06edd4216aeda13304ce6f',
  'app/po/[id].tsx': 'ae76a1de33a4ed14e77b401349006835bb401d9c8f8c77f036f384a989496e74',
  'src/components/biometric-optin-sheet.tsx':
    '2a1823f24f727ab701e3f4383bd35b5be640ee2076cb8f683d8ea2dcb902b30e',
  'src/components/data-list-screen.tsx':
    '63de1a324372f8bb67d3d9e8bf097c5cafa83e976fcb5bd51337b13f7d892058',
  'src/components/digital-pick.tsx':
    'dddd6f275d2176dcd34675cd1aa2b3caac84d241718575451e5af72502eab656',
  'src/components/filter-sheet.tsx':
    '9c7be38b2ee7fe64a52b2928ef53f717683cfc2515fe7f08a95888018ceb29ce',
  'src/components/item-history-sheet.tsx':
    'f45c312e1ae17412cc7ae710614d90bfb53ec2e5e4ad4a9a67ba5d7e6482d239',
  'src/components/move-stock-modal.tsx':
    '442d384a7e794906c762f077534015fe4e25ec9ef64a4e22c5f13b7c26c392f2',
  'src/components/remove-from-rack-modal.tsx':
    '2dcc3e3ea4adda35b9d57f7f08ae469e87e80141bb06f2400202a7bff5f5ee6a',
  'src/components/workspace-switcher.tsx':
    '1c57753f88c7a6fb973ff9e842cd2267bbafb742df4233fbbc5d6cd072f8fcbb',
  'src/components/AddBookCard.tsx':
    '9264f450228d533b6b939f22fc0115baed0ba832cbf2d981fbb80965acd8e372',
  'src/components/AddItemCard.tsx':
    '302328f53fa9f62117bf2c1d103336872622802ed06d13aa5e9a19b8fb8ba22f',
  'src/components/SyncStatusBadge.tsx':
    '53583f6d432ac34382392a6a245bd86c1656130570935e7d37b1db3241031547',
  'src/components/ui/button.tsx':
    'd1936a64984533be2a5de3a9349c3c9e6f6f3ea2957dc35c13feb0afff95552a',
  'src/components/ui/card.tsx': 'f7bf1fb3df499eb495654304861a7369dba3ad1e2a9d5420b7a8028debd0f482',
  'src/components/ui/checkbox.tsx':
    '669b366ab3016eb0eef7ef4d9d384690ad64ee3e39a4fae068a0c0ab28d47c29',
  'src/components/ui/chip.tsx': '493ad4c5d9bbae50305e3f459bbdf3a8a85b80bb335ebb0907797f27e1272807',
  'src/components/ui/field.tsx': 'e599499010052ccf0a8fbc136f9287dd3049b5fdb16a1e9b6c73e932b2d189f7',
  'src/components/ui/pill.tsx': 'b2ca71fad4c7075e8b947cc598425e621c399cb48483b2eee0a118509f74427b',
  'src/components/ui/row.tsx': '8dcbe2c6f6ba5f7aebad5699c14dcd874012da27a075fd5fb5351d5a28a3afa9',
  'src/components/ui/stat-card.tsx':
    '025911e6aecd5bd96cb55761bb3a0d40503cfe80d521406b802a47768eb82deb',
  'src/components/ui/text.tsx': '334e3569741e110ad6d5ba6e2e1bf3a931c2677fa4a8a83a6c6901de9c3d43bc',
  'src/components/ui/thumb.tsx': 'f4d2621d886f4d549cb2cf539e5cbaad27d3cc8959a5e0cc0092a68892c617ae',
  'src/components/ui/toggle.tsx':
    '0f94a5d9eef3cc588556141111590fb16586e13b31dde062d0bb1b1b42aa2786',
  // Stage 4, native-admin lane (admin, AI, notifications, settings, support,
  // team, Zendesk): each pinned to its file at b64bd37cc.
  'app/(drawer)/admin/audit.tsx':
    '983e3696acaac9e4e8f6501d97390001a5bc65b3f1fb7876f210cd684e87b18f',
  'app/(drawer)/admin/bins.tsx': '38b016049c29d882aa27b051e8558470fe353248f7cb90fdd3f160c6c77b23a0',
  'app/(drawer)/admin/charters.tsx':
    'd71f88437c13a5e0ddc900fbe6f9d50bd0705696807b6b44f7da74d4aff55524',
  'app/(drawer)/admin/index.tsx':
    '812d807e0efd520dcb2e150a1f4b086d2b20d4524cce49da22e7bd0a70bb31cd',
  'app/(drawer)/admin/uom-conversions.tsx':
    '8ee431a8368e292fcd40c570f5bcf81f30cc7dc67aeca08e5f22f13206fef564',
  'app/(drawer)/admin/users.tsx':
    'fa67ffef5600aaa7c640afab7448bbccbf7af0c4e1cb9fa17f2f56ddaa8ff540',
  'app/(drawer)/admin/vendor-mappings.tsx':
    'e2c340ced7072d8312586d2ee85e592e8e19ddbc68116908a5d14beb9847a6b3',
  'app/(drawer)/admin/warehouses.tsx':
    '4fa3b12d3e6b909f2b0505a42b3fa4182355a4476ad023a23dbe016079a78a08',
  'app/(drawer)/ai.tsx': '1e1f6b6e86817bb952cd00ddaf5cd0eb32273ef8053b99fd32f15fd79e914371',
  'app/(drawer)/notifications.tsx':
    '9d359357d41c32952be12437de57a44ce4fb26da377a900eb1ed7dfe833b439c',
  'app/(drawer)/settings.tsx': 'ff6897c5b3ab23508af66fd677dc59a3c05d259848a50238b187af36070e9d57',
  'app/(drawer)/settings/appearance.tsx':
    '5be7c846e7321ca0bb6176b29f9374888e0ae3cc101f13c40c2b5a1ff94bafd8',
  'app/(drawer)/settings/change-email.tsx':
    '0b582f2e6ae8bbe851b4292b7ac68b8b94cf4b44eac3025fd4d3cc464dd0bcc0',
  'app/(drawer)/settings/customize-tabs.tsx':
    'a9c807b6b4c6ac952e4acbc4bb669e7bb5f0dfd915f1a658974af35a303295e3',
  'app/(drawer)/settings/integrations.tsx':
    '4e9cfedca6a436d95860e616e57a285d90cbe9d94529a2c1a0065a0f0525d96f',
  'app/(drawer)/settings/rejected-work.tsx':
    '0cab0f20fa2da439c9c09375c7d8aa0bcf12eba91b829a8bae67c6129528139c',
  'app/(drawer)/support.tsx': '6816e88712a54644b3f57f13d490f1eab9fa587554f645e53b64f3a3ca5a847f',
  'app/(drawer)/team.tsx': '5c1cba9c4e9dea371901ea7fd4236944ae365cd9d364b22ea64ff0016041217d',
  'app/(drawer)/zendesk.tsx': '53a784e1a2119769e0669f9da86b2c22a782f4455b20aa04a347950dbb6464be',
  'app/ai/chat.tsx': '112e04c250f2cf054204891311dc633b9c2f889a7f41152824a0f8585ddce1be',
  'app/zendesk/web.tsx': '1d00e40d375eabdb833a1c39f915c14ce8e9eca03e5751f47c4ae608fb06a4e4',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(MOBILE_ROOT, f).split(path.sep).join('/');
const code = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SOURCES = [...walk(path.join(MOBILE_ROOT, 'app')), ...walk(path.join(MOBILE_ROOT, 'src'))]
  .filter((f) => !f.includes(`${path.sep}__fixtures__${path.sep}`))
  .map(rel);

describe('Classic projection pins', () => {
  it('every file that draws a Liquid Glass difference is pinned (none escapes the proof)', () => {
    const drawers = SOURCES.filter((f) => /\buseGlass\(\)/.test(code(path.join(MOBILE_ROOT, f))))
      .filter((f) => f !== 'src/components/ui/glass/use-glass.ts')
      // The glass primitives draw only glass; Classic never renders them.
      .filter((f) => !f.startsWith('src/components/ui/glass/'))
      .sort();
    expect(drawers).toEqual(Object.keys(CLASSIC_PINS).sort());
  });

  it('the look is read one way only: const lg = useGlass()', () => {
    for (const f of Object.keys(CLASSIC_PINS)) {
      const src = code(path.join(MOBILE_ROOT, f));
      const calls = src.match(/\buseGlass\(\)/g) ?? [];
      const bound = src.match(/\bconst lg = useGlass\(\);/g) ?? [];
      expect(bound.length, f).toBe(calls.length);
      expect(calls.length, f).toBeGreaterThan(0);
    }
  });

  for (const [file, pinned] of Object.entries(CLASSIC_PINS)) {
    it(`${file}: Classic is the code it was before Liquid Glass`, () => {
      const src = readFileSync(path.join(MOBILE_ROOT, file), 'utf8');
      expect(projectionLeaks(src, file)).toEqual([]);
      expect(classicHash(src, file)).toBe(pinned);
    });
  }
});
