import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS — mobile attachment finalize goes through the SERVER (SP-018).
 *
 * THE BUG: both mobile attachment uploaders PUT the object into Storage and
 * then inserted the metadata row themselves via PostgREST. The web surfaces
 * go through `PoAttachmentsService.add()` / `OrderAttachmentsService.add()`,
 * which run `verifyStoredDocumentOrDelete()` — the phase-2c byte-level magic
 * sniff AND the PDF active-content scan (a genuine PDF carrying
 * `/OpenAction /Launch` passes any client-side magic-byte check, which is
 * exactly why the server scan exists). A file attached from a phone was
 * therefore never scanned, and the `content_type` the row recorded — the one
 * the web panel and `api/purchase-orders/[id]/attachments.zip` both trust —
 * was whatever the client claimed.
 *
 * This is a CLASS guard (recurring pattern #26 — fix every sibling, not the
 * instance): BOTH call sites are swept here from one fixture set, because a
 * fix landed in only one of them would be no fix at all. The screens
 * themselves cannot be imported here (app/ screens load native modules at
 * top level, and the mobile vitest config only collects `src/**`), so these
 * are source-level assertions — the same shape as
 * src/lib/staging-screen-wiring.test.ts.
 *
 * NOT pinned here on purpose: the `authenticated` INSERT policies on
 * po_attachments / order_request_attachments stay in place. Binaries already
 * in the field still insert directly, and dropping the policy before that
 * audience has moved would break attaching for them. That removal is a later
 * migration, not this change.
 */

const CALL_SITES = [
  {
    label: 'src/components/po-attachments.tsx',
    file: path.resolve(__dirname, './po-attachments.tsx'),
    table: 'po_attachments',
    route: '/api/v1/purchase-orders/${poId}/attachments',
  },
  {
    label: 'app/order/[id].tsx',
    file: path.resolve(__dirname, '../../app/order/[id].tsx'),
    table: 'order_request_attachments',
    route: '/api/v1/orders/${id}/attachments',
  },
] as const;

/**
 * Source with comments stripped. Every assertion below is about what the code
 * DOES; each file's prose explains the history (and names the very tables and
 * routes these pins search for), so the prose must not satisfy — or trip —
 * its own pins.
 *
 * The block-comment pattern is anchored to the START OF A LINE on purpose,
 * unlike the naive `/\/\*[\s\S]*?\*\//` used elsewhere. po-attachments.tsx
 * contains the STRING `'image/*'` (expo-document-picker's type filter), whose
 * `/*` the unanchored form reads as the opening of a comment and then eats
 * everything up to the next `*​/` — roughly the whole `pickDocument` body.
 * That silently blanks real code and turns these pins into no-ops.
 */
function codeOnly(src: string): string {
  return src.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('mobile attachment uploads finalize server-side (SP-018)', () => {
  it.each(CALL_SITES.map((s) => [s.label, s] as const))(
    '%s never inserts the attachment row straight into PostgREST',
    (_label, site) => {
      const code = codeOnly(readFileSync(site.file, 'utf8'));
      expect(
        code,
        `${site.label} still writes ${site.table} directly — that row skips verifyStoredDocumentOrDelete()`,
      ).not.toMatch(new RegExp(`from\\(\\s*['"\`]${site.table}['"\`]\\s*\\)\\s*\\.insert`));
    },
  );

  it.each(CALL_SITES.map((s) => [s.label, s] as const))(
    '%s posts the finalize to its Bearer route instead',
    (_label, site) => {
      const code = codeOnly(readFileSync(site.file, 'utf8'));
      expect(code, `${site.label} does not call ${site.route}`).toContain(site.route);
      expect(code).toMatch(/method:\s*'POST'/);
    },
  );

  it.each(CALL_SITES.map((s) => [s.label, s] as const))(
    '%s still rolls the orphaned storage object back when the finalize is refused',
    (_label, site) => {
      const code = codeOnly(readFileSync(site.file, 'utf8'));
      // The server deletes the object itself when the SNIFF fails; this
      // rollback covers every other refusal (permission, wrong path shape,
      // order in a non-attachable status) so a rejected attach never leaves
      // bytes behind in the bucket.
      expect(code, `${site.label} lost its storage rollback`).toMatch(
        /storage\s*\n?\s*\.from\(BUCKET\)\s*\n?\s*\.remove\(\[path\]\)|storage\.from\(BUCKET\)\.remove\(\[path\]\)/,
      );
    },
  );

  it('the PO picker bounds the derived extension, so a server-side finalize cannot refuse a good file for its name alone', () => {
    // Regression guard for the switch itself: the server's positive path
    // shape accepts a 1-10 alphanumeric extension, so `scan.#$%` (empty
    // extension) and `notes.verylongextension` would upload and THEN be
    // refused at finalize. `safeExt` is pinned here rather than unit-tested
    // because the component imports react-native at module load and the
    // mobile vitest project runs under `node`.
    const src = readFileSync(CALL_SITES[0].file, 'utf8');
    expect(src).toMatch(/function safeExt\(/);
    expect(codeOnly(src)).toMatch(/raw\.length > 0 && raw\.length <= 10 \? raw : 'bin'/);
    expect(codeOnly(src)).toContain('safeExt(name)');
  });

  it('vacuity control — both call sites exist and still upload to a bucket', () => {
    for (const site of CALL_SITES) {
      const code = codeOnly(readFileSync(site.file, 'utf8'));
      expect(code, `${site.label} no longer uploads anything`).toContain('uploadFileToBucket');
    }
  });
});
