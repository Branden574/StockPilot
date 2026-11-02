import { parse } from 'query-string';
import { describe, expect, it } from 'vitest';

// query-string 7.1.3 is in the phone bundle (expo-router's navigation core
// requires it at load, and the app depends on it directly). It is patched
// (patches/query-string@7.1.3.patch) to take the default export of
// decode-uri-component, which is ESM-only since 0.5.0, and the root
// package.json pins decode-uri-component to 0.5.1 (Dependabot #141,
// GHSA-qr28-fpjm-wq7f). These run the patched module with that decoder in
// Node: a patch that stopped taking `.default` throws a TypeError on every
// decode, and 0.5.0 fails the last case. The iOS export's source map is what
// shows Metro bundles the same pair.
describe('the patched query-string decodes with decode-uri-component 0.5.1', () => {
  it('decodes the query of the new-item deep link (#258)', () => {
    expect(parse('barcode=0123%2045&type=book')).toEqual({ barcode: '0123 45', type: 'book' });
  });

  it('decodes UTF-8', () => {
    expect(parse('barcode=caf%C3%A9').barcode).toBe('café');
  });

  it("keeps a broken sequence as typed: the built-in decoder throws, so the package's own runs", () => {
    expect(parse('barcode=%E0%A4%A').barcode).toBe('%E0%A4%A');
  });

  it('decodes each percent-encoded run once (0.5.0 decoded its own output again)', () => {
    // 0.5.0 turned %25 into % and then read the %C2 that made as U+FFFD.
    expect(parse('q=%25C2%zz').q).toBe('%C2%zz');
  });
});
