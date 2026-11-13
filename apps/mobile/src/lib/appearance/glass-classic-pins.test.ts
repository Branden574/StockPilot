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
  // Re-pinned for S75 (Classic is meant to change: the count is read only for a member who may
  // see cycle counts, and the not-available state leaves out the catching-up sentence). Before
  // S75 the projection was 225237c6...e731e, the pin it had.
  'app/cycle-count/[id].tsx': 'e75dc5d0a99b4b703ab4af4beae1c90454209cd8a8105e7b6048d0945cd709a4',
  'app/item/[id].tsx': '0e3f35aa258543d2c2beebcab5a0e4bdebe877f0b93226183bc29ac1922da3fa',
  // Re-pinned for F14 (Classic is meant to change: the RETURN REQUEST section
  // under each of the requester's own open requests). Before F14 the
  // projection was fe0632b2…04ce6f, the pin it had; the difference is that
  // section and its read, nothing else.
  'app/order/[id].tsx': 'f7b165096c9d4fc39093b1d99f19c9c7a53926906bb95ebeaba1a8802bd9cb90',
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
  // prettier-ignore
  'app/(auth)/sign-in.tsx':
    '19ab14bb04aea77af8fc63bb2d8e4e448ec81e6d8a11f9bd43b8a38598ccefd6',
  // prettier-ignore
  'app/(auth)/welcome.tsx':
    '84d2fa5ad3c05268760c3d9f1e111abf5b23053a875f31e2a72b45f1696ab93c',
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
  // Re-pinned for S75 (Classic is meant to change: the counts downloaded to this phone are shown
  // only to a member who may see cycle counts, never in place of the server's refusal). Before
  // S75 the projection was 1c00180e...c412, the pin it had.
  'app/(drawer)/(tabs)/cycle-counts.tsx':
    'b7905f8a4fcb0c6010f24f2f8052abfc4a742a2d9ed4f147a6d8ab5b5ace152b',
  // The order storefront (native-core). checkout.tsx and catalog-screen.tsx
  // are pinned to main's own files at 778b42231 (Add all, #494, merged in
  // 2026-11-10): Classic changed on main, and the pin follows main's code.
  'app/order/new/checkout.tsx': '46e51a5768f765dac95b1a8928fe6b19a74ed2bdd04d197036fc82995be47118',
  'app/order/new/placed.tsx': '38c0ca856081d4cd2035d7ed5c45a0eb1cc8783fb18cfdba8dd84e672130a959',
  'src/components/order-storefront/catalog-screen.tsx':
    'cdc151c4f22e468f461588518543bd45bcd564eb99abf6ddd75ce2cfb2ad0e23',
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
  'src/components/onboarding/mobile-tour.tsx':
    'a101da670e5a3d31fbff28e763e95c0bc9f0cf3cae61d716a5d43efe3abbb2f2',
  // ---- Stage 4, native-ops lane (lg/s4-native-ops): the operations screens. ----
  'app/(drawer)/exceptions.tsx': 'ab2fd7042ee896ac2f2c8a7cf478de3a708cb04fb38867043098fa5a5f94ea6d',
  'app/(drawer)/maintenance.tsx':
    '9bf1602fce0e5569a335be53b7ac8d4933078975bc2d1fd02d54479376301557',
  'app/(drawer)/returns.tsx': '2e39381f23762d920821d12cf8479f364de946d901331fafd9cc012005f416ec',
  'app/(drawer)/staging.tsx': '52122f436736abaf6fe696759a1be6b32620d2361b8c3df5500c12eac86834d3',
  'app/bundles/[id].tsx': '2cd32b5020886e99d1cee8a46797d998dd9cab20c1c96a931d1ec4024249e1c9',
  'app/bundles/index.tsx': 'edbf916d7a856984cad1b751d6e399f89c0e653b333de65541892bcd31ea8aff',
  'app/exceptions/[id].tsx': '7562d38c59ec2f655fabac8cf198bfabb9b367a436b0720a80c5916d62b0fa11',
  'app/group-selected.tsx': 'a3ad2b67aa7b4e857c16754a3634884672a50b47bb92e7ab819992be635d9832',
  'app/location/[id].tsx': '9d56b6be06f47593d91058575d22894a50a7f6a43e7147e684ac3ad67409f13a',
  'app/maintenance/[id].tsx': 'e6e53b7e9c5fad8c5943664d05ae6013ca318498aafe7c288fc874887327fc47',
  'app/maintenance/new.tsx': 'e98d670b7b43b465ef0f8498459097af3f8b4e54c0a863b3c75abbb2cc315f67',
  'app/po-import/[id].tsx': 'da091d8135b45a9f1a473a91e0ee5fdb90802e9ab9dce5a333cdf862553edb5d',
  'app/rentals/[id].tsx': 'a69061a23d69073e18b32c3c0b9d42b599e2fc817c2fe826cbf5e0d292e9b10c',
  'app/rentals/new.tsx': 'e2dca591e7f9432b719cb9b3108d2fde791a675544faa9965addafe3c3056f65',
  'app/reports/book-order-totals/[itemId].tsx':
    'a8aadefce0a01a268c630eed737ba80d36164f256e1fb25175659f99fff7021d',
  'app/reports/book-order-totals/index.tsx':
    '26885e242c8250d3de4999fb83a40a2f52644e9fde5fdd387e9b09ecf7495257',
  'app/returns/[id].tsx': '92e9db95b722388ef09f399cd2e85ca79ce850905d81b076fbc699143e4c0a3a',
  'app/schedule/new.tsx': '835390cf0c1e4b6cd8d2b1cab591885008998a4d8bfceea475a14e99c5884058',
  'app/ungroup-selected.tsx': 'ebec938e80f5851340755c07883217b4e3649672a3ad0cf8cff67354b75ed16e',
  'src/components/book-order-charter-sheet.tsx':
    '2b80357d987c5079ee2b3bd616ea59ada33b62c8288fa389364bfaa1d02ffeae',
  'src/components/book-order-dates-sheet.tsx':
    'd9e062eaf4d3ef5a02bb07ece9b198442e49ccacfbc826a259c6f0553df72511',
  'src/components/book-order-export-sheet.tsx':
    '960312aa5df81a417ce8ad2bd712e98a1fab8a6ece08a0cbaa6ddea96dfb6b63',
  'src/components/book-order-filters-sheet.tsx':
    'aa4cd670daebe13e14d7d96da4ea8b81d54912ad536bf93401dba68b9e40f1bb',
  'src/components/book-order-sheet-parts.tsx':
    'b6d2df1287549fc24fb6e6d4fb96db5e9ee7faf8a0cd42cc40a4223e79da9fbd',
  'src/components/exception-evidence-section.tsx':
    'fad393616ee434964bd68e49d49de87b95a9026ba48f9309d098d6ebf9a9d72f',
  'src/components/exception-evidence-sheets.tsx':
    'e9a6c4972a61660387bbafd72ac1fa42ebe66805f15dcd1d5d628adf62b4f016',
  'src/components/exception-note-sheet.tsx':
    '795e9cb2b8d3d5ab74ae4b8cf9221a5483b3d130f28861834406a3742eaf767d',
  'src/components/exception-recount-sheet.tsx':
    'f924ad9ab523b3639683cd64203819de09d8033cdc561e0acef2b7adcb997b41',
  'src/components/release-replacement-sheet.tsx':
    '3362738fd397318103cbc206abd417a888f9505b3bfbfbf31aa7838dd83a1569',
  'src/components/return-action-sheet.tsx':
    '56f1685cf889104f4adbb856c15c02e5c80dd647fdd6c2d847a4cb0b6b7ef0a4',
  // Re-pinned for F14 (Classic is meant to change: the RETURN REQUEST section
  // and Report a problem above History). Before F14 the projection was
  // f8b2d3c8…b3932e, the pin it had.
  'src/components/return-workbench-view.tsx':
    '8e20550ba2815eb5d2b893f8b26716c42a0c5809dfda6d7334ea51208774c908',
  'src/screens/categories.tsx': '3c31c776ea56b481cb1619c33088457d8ef01a64c121b896aaecf27f55baa9d6',
  'src/screens/locations.tsx': '1555608ee36096b69974e2e8d4267699bdb2736337cd36bc0f294ff8f9d21389',
  'src/screens/movements.tsx': '432d5df04a0e1e16e12d774f5385bee77b1ea15830fbb80fb98bd6d665524a52',
  'src/screens/po-imports.tsx': '109f59e68d08223f885bc75e859feb002eecbb42f26f74499848ef656a243d4e',
  'src/screens/purchase-orders.tsx':
    '4430bcc012491aeccacf7dbbb6cc87b912162b73d406ed288417e7e3361f05c6',
  'src/screens/rentals.tsx': 'a9b4f8ac55497379cbcfbdc1dcf11542586119945845d22499019565f2db0559',
  'src/screens/reports.tsx': 'd0f88aacf47a52b6cccda08c287e3d26ee4ff690e42a52cc19b77fac12b13074',
  'src/screens/suppliers.tsx': 'eb440f4872ee08a3d7639ae4896efb7dc63f23727824b632983fbb3021c46ad6',
  // ---- end native-ops lane ----
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
