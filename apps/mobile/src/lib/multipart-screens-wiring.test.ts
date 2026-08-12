import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the expo/fetch multipart regression (SDK 56+).
 *
 * THE BUG THIS GUARDS: Expo replaced the global `fetch` with expo/fetch, whose
 * FormData serializer refuses React Native's `{ uri, name, type }` file-part
 * convention outright — node_modules/expo/src/winter/fetch/convertFormData.ts
 * says so in a comment ("`uri` is not supported for React Native's FormData")
 * and then throws `Unsupported FormDataPart implementation`. Every mobile
 * screen that uploaded a file this way died: PO scan, size-count capture,
 * cycle-count AI scan, and AI chat photo attach. The fix routes all four
 * through lib/multipart-upload's postMultipart, which builds the body itself.
 *
 * WHY SOURCE-LEVEL PINS: the four call sites live under app/, which the mobile
 * vitest config deliberately excludes from collection, so the helper's own
 * unit tests cannot observe whether a screen actually USES it. Without these,
 * reverting any screen to `new FormData()` — or adding a fifth uploader that
 * does — breaks production without failing a single test. That is the
 * regression CLASS; the helper tests only cover the instance.
 *
 * These follow the established idiom of expected-exclusion-screens.test.ts and
 * staging-screen-wiring.test.ts: read the real source, assert the property.
 */

const APP_DIR = path.resolve(__dirname, '../../app');

const read = (abs: string): string => readFileSync(abs, 'utf8');

/** Every .ts/.tsx file under app/, recursively. */
function appSourceFiles(dir: string = APP_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...appSourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The four screens the regression killed, relative to app/. */
const UPLOAD_SCREENS = [
  'scan-po/index.tsx',
  'size-count/capture.tsx',
  'cycle-count/ai-scan/[id].tsx',
  'ai/chat.tsx',
];

describe('mobile multipart uploads never reconstruct RN FormData (expo/fetch regression)', () => {
  it('no file under app/ constructs a FormData', () => {
    const offenders = appSourceFiles()
      .filter((f) => /new FormData\s*\(/.test(read(f)))
      .map((f) => path.relative(APP_DIR, f));
    expect(
      offenders,
      `these screens build a FormData directly; expo/fetch rejects RN {uri,name,type} parts — use postMultipart from lib/multipart-upload instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it.each(UPLOAD_SCREENS)('%s uploads through postMultipart', (rel) => {
    const src = read(path.join(APP_DIR, rel));
    expect(src).toContain('postMultipart');
    expect(src).toMatch(/from '@\/lib\/multipart-upload'/);
  });

  it('the PO scan drops a frame it could not resize rather than buffering the original', () => {
    // postMultipart buffers the whole body in JS, so sending an un-resized
    // 4-12MB library pick could OOM the device for an upload the server would
    // reject anyway at its 8MB/file cap. The fallback must skip the frame.
    const src = read(path.join(APP_DIR, 'scan-po/index.tsx'));
    expect(src).toContain('droppedFrames');
    expect(src).toMatch(/resize failed, dropping frame/);
    // ...and must tell the user, never silently ship a shorter scan.
    expect(src).toContain('droppedSuffix');
  });
});
