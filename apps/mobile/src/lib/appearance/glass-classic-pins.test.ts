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
  // Sign-in, welcome and the root gates (native-core).
  'app/(auth)/sign-in.tsx': '19ab14bb04aea77af8fc63bb2d8e4e448ec81e6d8a11f9bd43b8a38598ccefd6',
  'app/(auth)/welcome.tsx': '84d2fa5ad3c05268760c3d9f1e111abf5b23053a875f31e2a72b45f1696ab93c',
  'src/components/account-disabled-screen.tsx':
    'f08b00bb93fdc3b740b2d2d6bb63fbe37ecb8fe557e74fe1fde26a3ff1fd483c',
  'src/components/auth/auth-shell.tsx':
    'd44a57161903d76256a79ef57874d896bb69d49319c1d53f4c01f1c2c9d31eb7',
  'src/components/biometric-lock-screen.tsx':
    'd422de3d6bfdeb7990290349cfde176b8f17228707476a98686197816b95bcc1',
  'src/components/mfa-challenge-screen.tsx':
    '636e013c36904f03910de06311115558d58471d4d4e77acb75cc07ecce34b49c',
  // The Books and Counts tabs (native-core).
  'app/(drawer)/(tabs)/books.tsx':
    '19ccb3b83458d0c9fcbc9400c13050eb870f595888a6a07f7525438ac712c46c',
  'app/(drawer)/(tabs)/cycle-counts.tsx':
    '1c00180e509cd5ea6b3d6584451599ad9f3efb178bd4805a6a8d10f1b887c412',
  // The order storefront (native-core).
  'app/order/new/checkout.tsx': 'e2c3eb994cb95dd7590466b09958bd031941c40aba7c370818407c31151d29f1',
  'app/order/new/placed.tsx': '38c0ca856081d4cd2035d7ed5c45a0eb1cc8783fb18cfdba8dd84e672130a959',
  'src/components/order-storefront/catalog-screen.tsx':
    '1ae87bd45b790a7233ed96d7e93c3d7343dfda36fb0f902bf1db758f3f8e5da4',
  'src/components/order-storefront/storefront-state.tsx':
    'f9bee75bc78955389e5f40c9ae4c48ee644748570b7fec73b6b4c4d49a50fd7d',
  // New item, the count flows, Scan PO and Manage items (native-core).
  'app/cycle-count/ai-scan/[id].tsx':
    'ce429361709bc71da56ffdb387155e6b93aa2282d9d3d8dc08d000c569224a5e',
  'app/cycle-count/new.tsx': 'e0f0dcbd01c04afce172de9e1888ab6a482eb3ff1b9b7d332ad8c35000600072',
  'app/cycle-count/scan/[id].tsx':
    '7990871c2db18f31116e0358ce2ac197a5cd1446babf6f3acdd2f523ffb800c2',
  'app/item/new.tsx': '1869d65fdc462f700a7ba369fbc1874a61728d230f32e1ba59584455dd2a7806',
  'app/order/manage-items.tsx': 'b3ce102b118248db26bd598f835ecc7532a00e46e7dcaf16a0812d0cbf427e45',
  'app/scan-po/index.tsx': '30b004eb8c64674aca62d0e528f9156d8175bd96b85a657a40abb3c7c973ee0c',
  // What's New, the scanner tip and the signature pad's frame (native-core).
  'src/components/onboarding/whats-new.tsx':
    '27fa3281710afedf24745193c45f92a0aaf450a89583ad002c8a1e7b98451c8e',
  'src/components/scanner-tip.tsx':
    '0c4a16e89035e02cf49b5016452e5ae4f68ad3459af016025464f9ce6c60f560',
  'src/components/signature-pad-modal.tsx':
    '21f544d9257e4afb823fe7fb80376c32107a4f44c7763cce0ac211a023abdb61',
  'src/components/count-select-bar.tsx':
    '87b37fbb15959b696b5f3eac89e2d0ff1d56d0dd49d0802b9849a984c6777feb',
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
