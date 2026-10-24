import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the stored-file links and the photo caches. The mobile
 * suite has no React Native renderer, so the screens are read as source; the
 * rules themselves are tested in stored-file-link.test.ts and
 * photo-cache-wipe.test.ts.
 *
 *   1. The order screen's proof of delivery and the purchase order card open
 *      a file through linkToOpen, which signs an expired link again at the
 *      tap. Before, both opened the link their list had signed for one hour,
 *      however long ago.
 *   2. Both sign their lists for STORED_FILE_LINK_SECONDS and record when.
 *   3. The purchase order card no longer tells anyone to pull to refresh: its
 *      screen has no pull to refresh.
 *   4. A sign-out and an account eviction clear the photo caches after the
 *      SQLite wipe.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');
/** The code without comments, on one line, so formatting cannot fail a pin. */
const flat = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

const ORDER = flat(read('app/order/[id].tsx'));
const PO_CARD = flat(read('src/components/po-attachments.tsx'));
const AUTH = flat(read('src/lib/auth-context.tsx'));
const GATE = flat(read('src/lib/use-account-gate.ts'));

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, start).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  expect(b, end).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('the order screen opens proof of delivery through a fresh link', () => {
  it('asks linkToOpen, signing the one file in the attachments bucket', () => {
    const open = between(ORDER, 'async function openAttachment(a: Attachment) {', 'return ( <View');
    expect(open).toContain(
      'const link = await linkToOpen( { url: a.url, signedAt: a.signedAt }, signerFor(supabase.storage, BUCKET, a.storagePath), );',
    );
    // A new link is kept for the next tap and the tile.
    expect(open).toMatch(/if \(link\?\.resigned\) \{ setAttachments\(/);
    // The viewer and the browser get the link it answered, never the held one
    // directly (a photo falls back to its old link only when signing failed,
    // for the image cache offline).
    expect(open).toContain('const url = link?.url ?? (isImage ? a.url : null);');
    expect(open).toContain('setViewerUrl(url);');
    expect(open).toContain('Linking.openURL(url)');
    expect(open).not.toMatch(/setViewerUrl\(a\.url\)|Linking\.openURL\(a\.url\)/);
  });

  it('the tile awaits it, and the list records when it signed', () => {
    expect(ORDER).toContain('onPress={() => void openAttachment(a)}');
    const load = between(ORDER, 'const loadAttachments = React.useCallback(', '}, [orgId, id]);');
    expect(load).toContain('const signedAt = Date.now();');
    expect(load.indexOf('const signedAt = Date.now();')).toBeLessThan(
      load.indexOf('.createSignedUrls('),
    );
    expect(load).toContain('.createSignedUrls(paths, STORED_FILE_LINK_SECONDS)');
    expect(load).toContain('signedAt: url ? signedAt : null,');
    expect(ORDER).not.toContain('createSignedUrls(paths, 60 * 60)');
  });
});

describe('the purchase order card opens files through a fresh link', () => {
  it('asks linkToOpen at the tap and keeps a new link', () => {
    const open = between(
      PO_CARD,
      'async function openFile(row: AttachmentRow) {',
      'async function uploadToPo(',
    );
    expect(open).toContain(
      'const link = await linkToOpen( { url: row.url, signedAt: row.signedAt }, signerFor(supabase.storage, BUCKET, row.storage_path), );',
    );
    expect(open).toMatch(/if \(link\.resigned\) \{ setItems\(/);
    expect(open).toContain('void Linking.openURL(link.url);');
    expect(PO_CARD).toContain('onPress={() => void openFile(row)}');
    expect(PO_CARD).not.toContain('Linking.openURL(row.url)');
  });

  it('signs its list for the same hour, records when, and never says pull to refresh', () => {
    const load = between(PO_CARD, 'const load = React.useCallback(async () => {', '}, [poId]);');
    expect(load).toContain('const signedAt = Date.now();');
    expect(load).toContain('STORED_FILE_LINK_SECONDS, );');
    expect(load).toContain('signedAt: url ? signedAt : null,');
    expect(read('src/components/po-attachments.tsx')).not.toContain(
      'Pull to refresh and try again',
    );
  });
});

describe('the photo caches go when the account leaves the device', () => {
  // Mutation caught: a sign-out or an eviction that wipes SQLite and leaves
  // the photo caches.
  it('sign-out: after the SQLite wipe, in the cache wipe that runs once the session is gone', () => {
    const signOut = between(
      AUTH,
      "const signOut: AuthState['signOut']",
      "const signOutToFallback: AuthState['signOutToFallback']",
    );
    expect(signOut).toContain(
      'wipeCache: async () => { await wipeForSignOut(); await clearPhotoCaches(); },',
    );
  });

  it('eviction: after the eviction wipe', () => {
    const clearCaches = between(GATE, 'clearCaches: async', 'clearAccountStorage:');
    const wipe = clearCaches.indexOf('await wipeForEviction(evictedUserId);');
    const photos = clearCaches.indexOf('await clearPhotoCaches();');
    expect(wipe).toBeGreaterThan(-1);
    expect(photos).toBeGreaterThan(wipe);
  });
});
