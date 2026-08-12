import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for PO import naming on the mobile scan screen (mig 0333).
 *
 * WHY SOURCE-LEVEL: app/scan-po/index.tsx is a screen, and the mobile vitest
 * config deliberately excludes app/ from collection (native modules at top
 * level). buildDisplayNames' own unit tests prove the ARRAY is right; nothing
 * else can prove the screen still USES it. Without these, a refactor that drops
 * the field — or rebuilds the array from the captured frames instead of the
 * sent ones — ships silently: the scan still succeeds, the imports are just
 * unnamed again, or worse, named with each other's names.
 *
 * Same idiom as multipart-screens-wiring.test.ts and
 * expected-exclusion-screens.test.ts: read the real source, assert the property.
 */

const src = readFileSync(
  path.resolve(__dirname, '../../app/scan-po/index.tsx'),
  'utf8',
);

describe('mobile PO scan — display-name wiring', () => {
  it('builds the array through the shared helper, not inline in the screen', () => {
    expect(src).toMatch(/from '@\/lib\/po-scan-display-names'/);
    expect(src).toContain('buildDisplayNames(');
  });

  it('appends displayNames as a single multipart field holding JSON', () => {
    expect(src).toMatch(/name: 'displayNames', value: JSON\.stringify\(displayNames\)/);
  });

  it('omits the field entirely when nothing was named', () => {
    // The helper returns null for "no names"; the screen must spread nothing
    // rather than send an array of nulls, so an unnamed scan is byte-identical
    // to the request that predates naming.
    expect(src).toMatch(/\.\.\.\(displayNames\s*\n?\s*\?\s*\[\{ name: 'displayNames'/);
  });

  it('feeds the helper the files ACTUALLY SENT, not the frames captured', () => {
    // sentIndices is appended in the SAME loop that pushes a file part, i.e.
    // after the resize/drop decision — the alignment the whole feature rests on.
    expect(src).toContain('const sentIndices: number[] = [];');
    expect(src).toMatch(/fileParts\.push\(\{[^}]*\}\);\s*\n\s*sentIndices\.push\(frameIndex\);/);
    expect(src).toMatch(/buildDisplayNames\(\{ names, sentIndices, mode \}\)/);
  });

  it('sends the SAME mode value to the helper and to the wire', () => {
    // A helper told "separate" while the wire says "combined" produces an array
    // of the wrong length, which the route answers with a 400.
    expect(src).toContain(
      "const mode = frames.length > 1 && separate ? 'separate' : 'combined';",
    );
    expect(src).toContain("{ name: 'mode', value: mode }");
  });

  it('removes a photo and its name at the SAME index', () => {
    expect(src).toContain("const idx = frames.findIndex((f) => f.uri === uri);");
    expect(src).toContain('setFrames((cur) => cur.filter((_, i) => i !== idx));');
    expect(src).toContain('setNames((cur) => cur.filter((_, i) => i !== idx));');
  });

  it('clears the typed names after a successful scan', () => {
    // Both success paths (separate → imports list, combined → review screen)
    // reset through the one helper, so a stale name cannot attach itself to the
    // next scan's first page.
    expect(src).toMatch(/function resetCaptures\(\)\s*\{\s*setFrames\(\[\]\);\s*setNames\(\[\]\);/);
    expect(src.match(/resetCaptures\(\);/g) ?? []).toHaveLength(2);
    // ...and no success path resets frames without the names.
    expect(src).not.toContain('setFrames([]);\n      Alert');
  });

  it('renders a name input before the extract action, with the shared max length', () => {
    expect(src).toMatch(/from '@stockpilot\/core'/);
    expect(src).toContain('maxLength={PO_IMPORT_DISPLAY_NAME_MAX}');
    expect(src).toContain('Example: August DC4 Book Order');
    // Separate mode names each PO individually (web parity) — never one base
    // name numbered 1/2/3.
    expect(src).toContain('const perFileNames = frames.length > 1 && separate;');
    expect(src).toContain('PO {i + 1} name');
  });
});
