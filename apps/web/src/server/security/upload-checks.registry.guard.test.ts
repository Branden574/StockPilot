import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant (part 6, stage 6a): EVERY WAY A FILE COMES IN IS LISTED
 * HERE WITH THE CHECK IT CALLS, so a new upload path cannot ship unchecked.
 *
 * THE WALK reads the TypeScript syntax tree of every non-test source file of
 * the website (apps/web/src) and of the phone app (apps/mobile/src and
 * apps/mobile/app) and finds each place that
 *   - mints an upload URL            createSignedUploadUrl(...)
 *   - reads a multipart body         <request>.formData()
 *   - reads a base64 body            Buffer.from(<text>, 'base64')
 *   - reads a stored object          fetchObjectPrefix(...) / fetchObjectWindow(...)
 *   - writes bytes into storage      <bucket>.upload(...)
 *   - calls the upload check         checkUploadBytes / checkUploadPrefix /
 *                                    checkStoredUpload / checkStoredUploadSignature /
 *                                    verifyStoredDocumentOrDelete
 * and fails on any file with such a site that is not in REGISTRY (web) or
 * PHONE (phone) with exactly that many of each. Each listed file says how it
 * is covered: the checks it calls itself (each must be there), the listed
 * file whose check covers it, or why no file comes in at all (a form of text
 * fields; a secret or a cursor that happens to be base64; bytes the server
 * made itself). Phone writes name the web file that finalizes them, or are a
 * KNOWN GAP of stage 6c.
 *
 * THE ORGANIZATION RULE. A refusal is recorded in the organization the CHECK
 * is handed. Every call outside server/security passes it as an object
 * literal with no spread, and the value is one of ALLOWED_ORGANIZATION: the
 * caller's server-built context, or the order a signature token resolved to
 * on the server. Never a value a request carried. verifyStoredDocumentOrDelete
 * takes the context itself: its first argument is `ctx` or `this.ctx`.
 *
 * WHAT THIS IS NOT. It reads that a check is called in the file, not that it
 * runs on every branch before the bytes are used (each path's own test does:
 * the upload-checks.*.test.ts files and the *.upload-checks.test.ts files,
 * with the red checks recorded in the part 6 notes). It reads the name a
 * context is held in, not where that context was built. It does not see a
 * file that comes in some way none of the detectors above describes.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const REPO = path.resolve(WEB_SRC, '../../..');
const MOBILE_ROOTS = [path.join(REPO, 'apps/mobile/src'), path.join(REPO, 'apps/mobile/app')];

type Site =
  | 'mints_upload_url'
  | 'reads_multipart'
  | 'reads_base64'
  | 'reads_stored_object'
  | 'writes_storage';

const CHECK_NAMES = [
  'checkUploadBytes',
  'checkUploadPrefix',
  'checkStoredUpload',
  'checkStoredUploadSignature',
  'verifyStoredDocumentOrDelete',
] as const;
type CheckName = (typeof CHECK_NAMES)[number];

/** The checks whose input object names the organization (verifyStoredDocumentOrDelete takes the context). */
const INPUT_ARG_OF: Readonly<Record<Exclude<CheckName, 'verifyStoredDocumentOrDelete'>, number>> = {
  checkUploadBytes: 1,
  checkUploadPrefix: 1,
  checkStoredUpload: 2,
  checkStoredUploadSignature: 2,
};

const ALLOWED_ORGANIZATION = ['ctx.organizationId', 'this.ctx.organizationId', 'order.organization_id'];
const ALLOWED_CONTEXT = ['ctx', 'this.ctx'];

interface Found {
  sites: Partial<Record<Site, number>>;
  calls: Set<CheckName>;
  /** "line: why" for each call that breaks the organization rule. */
  organizationProblems: string[];
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** The sites, the checks and the organization problems of one file's source. */
export function readSource(source: string, fileName: string, outsideSecurity = true): Found {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Found = { sites: {}, calls: new Set(), organizationProblems: [] };
  const add = (site: Site) => {
    found.sites[site] = (found.sites[site] ?? 0) + 1;
  };
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const e = node.expression;
      if (name === 'createSignedUploadUrl' && ts.isPropertyAccessExpression(e)) add('mints_upload_url');
      if (name === 'formData' && ts.isPropertyAccessExpression(e) && node.arguments.length === 0) add('reads_multipart');
      if (
        name === 'from' &&
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === 'Buffer' &&
        node.arguments[1] &&
        ts.isStringLiteralLike(node.arguments[1]) &&
        node.arguments[1].text === 'base64'
      ) {
        add('reads_base64');
      }
      if ((name === 'fetchObjectPrefix' || name === 'fetchObjectWindow') && ts.isIdentifier(e)) add('reads_stored_object');
      if (name === 'upload' && ts.isPropertyAccessExpression(e)) add('writes_storage');
      if (name && ts.isIdentifier(e) && (CHECK_NAMES as readonly string[]).includes(name)) {
        const check = name as CheckName;
        found.calls.add(check);
        if (outsideSecurity) {
          if (check === 'verifyStoredDocumentOrDelete') {
            const first = node.arguments[0];
            if (!first || !ALLOWED_CONTEXT.includes(first.getText(sf))) {
              found.organizationProblems.push(`${lineOf(node)}: ${check} is not handed ctx or this.ctx`);
            }
          } else {
            const input = node.arguments[INPUT_ARG_OF[check]];
            if (!input || !ts.isObjectLiteralExpression(input)) {
              found.organizationProblems.push(`${lineOf(node)}: ${check}'s input is not an object literal`);
            } else {
              if (input.properties.some((p) => ts.isSpreadAssignment(p))) {
                found.organizationProblems.push(`${lineOf(node)}: ${check}'s input spreads another object`);
              }
              const org = input.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'organizationId',
              );
              const text = org?.initializer.getText(sf) ?? '(missing)';
              if (!ALLOWED_ORGANIZATION.includes(text)) {
                found.organizationProblems.push(`${lineOf(node)}: ${check} is handed organizationId ${text}`);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const full = (dir: string, name: string) => path.join(dir, name);

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    // Test support (fixtures, mocks, helpers) is not a way in.
    if (entry.isDirectory() && (entry.name === '__fixtures__' || entry.name === '__mocks__')) continue;
    if (entry.isDirectory() && full(dir, entry.name) === path.join(WEB_SRC, 'test')) continue;
    const at = full(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(at, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(at);
    }
  }
  return out;
}

const rel = (file: string) => path.relative(REPO, file).split(path.sep).join('/');

interface Entry {
  sites: Partial<Record<Site, number>>;
  /** What comes in here, in a few words. */
  what: string;
  /** The checks this file calls itself; each must be called in it. */
  calls?: readonly CheckName[];
  /** Or the listed file whose check covers these sites. */
  checkedBy?: string;
  /** Or why no file comes in here at all. */
  noFile?: string;
  /** The check itself (the module, and the storage read it is built on). */
  isTheCheck?: true;
}

const W = 'apps/web/src/';

/** Every website file with an upload-shaped site, and how it is covered. */
const REGISTRY: Readonly<Record<string, Entry>> = {
  // ── the check itself ────────────────────────────────────────────────────
  [`${W}server/security/upload-checks.ts`]: {
    sites: { reads_stored_object: 2 },
    what: 'the one upload check: its finalize reads of a stored object',
    isTheCheck: true,
  },
  [`${W}server/services/upload-verification.ts`]: {
    sites: {},
    what: 'the document buckets’ finalize (PO and order attachments, support screenshots)',
    calls: ['checkStoredUpload'],
  },

  // ── upload URLs minted by the server; each finalize checks ──────────────
  [`${W}server/services/item-images.ts`]: {
    sites: { mints_upload_url: 2 },
    what: 'item photo and thumbnail: mint, then the web finalize',
    calls: ['checkStoredUpload'],
  },
  [`${W}server/services/maintenance-attachments.ts`]: {
    sites: { mints_upload_url: 2, reads_stored_object: 1, writes_storage: 2 },
    what: 'maintenance photo: mint, finalize, and the re-encoded copy written back',
    calls: ['checkUploadPrefix', 'checkUploadBytes'],
  },
  [`${W}server/services/exception-evidence.ts`]: {
    sites: { mints_upload_url: 1, writes_storage: 2 },
    what: 'exception evidence photo: mint, finalize, and the re-encoded copy written back',
    calls: ['checkUploadBytes'],
  },
  [`${W}server/services/procedure-videos.ts`]: {
    sites: { mints_upload_url: 2 },
    what: 'procedure video and poster: mint, then the finalize',
    calls: ['checkStoredUploadSignature', 'checkStoredUpload'],
  },
  [`${W}server/services/po-imports.ts`]: {
    sites: { mints_upload_url: 1, writes_storage: 1 },
    what: 'PO import file (mint, checked at parse) and PO scan frames (checked, then stored)',
    calls: ['checkUploadBytes'],
  },

  // ── finalizes of client-direct writes ───────────────────────────────────
  [`${W}server/services/po-attachments.ts`]: {
    sites: {},
    what: 'PO attachment finalize',
    calls: ['verifyStoredDocumentOrDelete'],
  },
  [`${W}server/services/order-attachments.ts`]: {
    sites: {},
    what: 'order attachment finalize',
    calls: ['verifyStoredDocumentOrDelete'],
  },
  [`${W}server/actions/profile.ts`]: {
    sites: {},
    what: 'avatar and organization logo finalize',
    calls: ['checkStoredUpload'],
  },
  [`${W}server/actions/support-tickets.ts`]: {
    sites: {},
    what: 'support screenshot finalize (web)',
    calls: ['verifyStoredDocumentOrDelete'],
  },
  [`${W}app/api/v1/support/route.ts`]: {
    sites: {},
    what: 'support screenshot finalize (phone)',
    calls: ['verifyStoredDocumentOrDelete'],
  },

  // ── bytes that pass through the server ──────────────────────────────────
  [`${W}app/api/cycle-counts/[id]/ai-scan/route.ts`]: {
    sites: { reads_multipart: 1, writes_storage: 1 },
    what: 'cycle-count shelf scan photo: checked, then stored and sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/v1/size-counts/[id]/scan/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'size-count scan photo: checked, then sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/v1/size-counts/training/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'size-count training photo (multipart)',
    checkedBy: `${W}server/services/size-counts.ts`,
  },
  [`${W}server/services/size-counts.ts`]: {
    sites: { writes_storage: 1 },
    what: 'size-count training photo: checked, then stored',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/v1/ai/identify-from-photo/route.ts`]: {
    sites: { reads_multipart: 1, reads_base64: 1 },
    what: 'identify-from-photo (multipart or base64): checked, then sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/po-imports/scan/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'PO scan frames (multipart)',
    checkedBy: `${W}server/services/po-imports.ts`,
  },
  [`${W}app/api/books/extract-isbns/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'ISBN file, text pass: checked, then parsed',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/books/extract-isbns-ai/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'ISBN file, AI pass: checked, then parsed or sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/orders/sign/route.ts`]: {
    sites: { reads_base64: 1 },
    what: 'order signature picture (a base64 data URL): decoded and checked before it is recorded',
    calls: ['checkUploadBytes'],
  },
  [`${W}server/services/books-import.ts`]: {
    sites: { writes_storage: 1 },
    what: 'book cover fetched from a cover host: checked (type from its bytes), then stored',
    calls: ['checkUploadBytes'],
  },

  // ── client-direct writes from the website (each finalized above) ─────────
  [`${W}components/settings/avatar-uploader.tsx`]: {
    sites: { writes_storage: 1 },
    what: 'avatar, written by the browser',
    checkedBy: `${W}server/actions/profile.ts`,
  },
  [`${W}components/settings/org-logo-uploader.tsx`]: {
    sites: { writes_storage: 1 },
    what: 'organization logo, written by the browser',
    checkedBy: `${W}server/actions/profile.ts`,
  },
  [`${W}components/po/po-attachments-panel.tsx`]: {
    sites: { writes_storage: 1 },
    what: 'PO attachment, written by the browser',
    checkedBy: `${W}server/services/po-attachments.ts`,
  },
  [`${W}components/orders/order-attachments-panel.tsx`]: {
    sites: { writes_storage: 1 },
    what: 'order attachment, written by the browser',
    checkedBy: `${W}server/services/order-attachments.ts`,
  },
  [`${W}components/support/support-ticket-form.tsx`]: {
    sites: { writes_storage: 1 },
    what: 'support screenshot, written by the browser',
    checkedBy: `${W}server/actions/support-tickets.ts`,
  },

  // ── no file comes in ─────────────────────────────────────────────────────
  [`${W}app/auth/confirm/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'the email confirmation form',
    noFile: 'text fields only (a token and a type); a file part is never read',
  },
  [`${W}app/r/confirm/submit/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'the returns confirmation form',
    noFile: 'text fields only; a file part is never read',
  },
  [`${W}app/sign-in-alert/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'the "this was not me" sign-in alert form',
    noFile: 'text fields only; a file part is never read',
  },
  [`${W}app/unsubscribe/route.ts`]: {
    sites: { reads_multipart: 1 },
    what: 'the one-click unsubscribe form',
    noFile: 'text fields only; a file part is never read',
  },
  [`${W}app/ingest/[...path]/route.ts`]: {
    sites: { reads_base64: 1 },
    what: 'the analytics relay',
    noFile: 'decodes an analytics payload it forwards; nothing is stored or opened',
  },
  [`${W}lib/auth/bridge-secret.ts`]: {
    sites: { reads_base64: 1 },
    what: 'a sealed secret',
    noFile: 'decodes a sealed secret the server itself wrote',
  },
  [`${W}app/api/admin/backfill-item-thumbs/route.ts`]: {
    sites: { writes_storage: 1 },
    what: 'thumbnails made by the server',
    noFile: 'writes a thumbnail the server made from an item photo already stored; no file comes in',
  },
};

/** Every phone-app file that writes into storage or mints an upload URL, and its finalize. */
const PHONE: Readonly<Record<string, { sites: Partial<Record<Site, number>>; what: string; finalizedBy?: string; knownGap?: string }>> = {
  'apps/mobile/src/lib/storage-upload.ts': {
    sites: { mints_upload_url: 1 },
    what: 'PO and order attachments, written by the phone',
    finalizedBy: `${W}server/services/upload-verification.ts`,
  },
  'apps/mobile/app/(drawer)/support.tsx': {
    sites: { writes_storage: 1 },
    what: 'support screenshot, written by the phone',
    finalizedBy: `${W}app/api/v1/support/route.ts`,
  },
  'apps/mobile/src/lib/item-photo-upload.ts': {
    sites: { writes_storage: 2 },
    what: 'item photo and thumbnail, written by the phone',
    knownGap:
      'stage 6c: the phone writes the photo and inserts its item_images row itself; no finalize runs, so nothing reads these bytes. The phone moves to the finalize first, then the direct insert policy goes.',
  },
};

/**
 * KNOWN GAPS that are not a file of the walk: what stage 6a does not close,
 * each closed by stage 6c (part-6-DESIGN.md).
 */
const KNOWN_GAPS: readonly string[] = [
  'stage 6c: the direct INSERT policies on item_images, po_attachments and order_request_attachments let a member insert a row naming an object no finalize checked.',
  'stage 6c: the storage UPDATE policies (for example "user-avatars own update", 0312) let a checked object be overwritten after its finalize.',
  'stage 6c: avatars and logos are public buckets: an object can be read at its public URL from its upload until a refusing finalize removes it; they will land in a pending place and be re-encoded first.',
  'stage 6c: a client can write to a bucket under its own folder without ever calling the finalize; such an object has no row and is never shown, but it is not removed either.',
];

describe('every way a file comes in is listed with its check (part 6)', () => {
  const web = sourceFiles(WEB_SRC).map((f) => ({ file: rel(f), found: readSource(readFileSync(f, 'utf8'), f, !rel(f).startsWith(`${W}server/security/`)) }));
  const phone = MOBILE_ROOTS.flatMap((r) => sourceFiles(r)).map((f) => ({ file: rel(f), found: readSource(readFileSync(f, 'utf8'), f, false) }));
  const hasSites = (f: Found) => Object.values(f.sites).some((n) => (n ?? 0) > 0);
  const counts = (s: Partial<Record<Site, number>>) =>
    Object.fromEntries(Object.entries(s).filter(([, n]) => (n ?? 0) > 0).sort());

  it('the walk sees the files it should (a walk that reads nothing proves nothing)', () => {
    expect(web.length).toBeGreaterThan(500);
    expect(phone.length).toBeGreaterThan(50);
    expect(web.some((w) => w.file === `${W}server/services/item-images.ts`)).toBe(true);
  });

  it('no website file has an upload-shaped site or a check call without an entry', () => {
    const unlisted = web
      .filter((w) => (hasSites(w.found) || w.found.calls.size > 0) && !REGISTRY[w.file])
      .map((w) => `${w.file} ${JSON.stringify(counts(w.found.sites))} calls ${[...w.found.calls].join(',')}`);
    expect(unlisted).toEqual([]);
  });

  it('every entry is current: the file exists and has exactly the sites listed', () => {
    const byFile = new Map(web.map((w) => [w.file, w.found]));
    const stale = Object.entries(REGISTRY)
      .filter(([file, entry]) => JSON.stringify(counts(byFile.get(file)?.sites ?? { missing: 1 } as never)) !== JSON.stringify(counts(entry.sites)))
      .map(([file, entry]) => `${file}: listed ${JSON.stringify(counts(entry.sites))}, found ${JSON.stringify(counts(byFile.get(file)?.sites ?? {}))}${byFile.has(file) ? '' : ' (no such file)'}`);
    expect(stale).toEqual([]);
  });

  it('each entry says how it is covered, in exactly one way, and that way holds', () => {
    const byFile = new Map(web.map((w) => [w.file, w.found]));
    const problems: string[] = [];
    for (const [file, entry] of Object.entries(REGISTRY)) {
      const ways = [entry.calls, entry.checkedBy, entry.noFile, entry.isTheCheck].filter((x) => x !== undefined);
      if (ways.length !== 1) problems.push(`${file}: ${ways.length} ways of being covered`);
      for (const check of entry.calls ?? []) {
        if (!byFile.get(file)?.calls.has(check)) problems.push(`${file}: lists ${check} but never calls it`);
      }
      const calledHere = [...(byFile.get(file)?.calls ?? [])];
      if (!entry.calls && !entry.isTheCheck && calledHere.length > 0) {
        problems.push(`${file}: calls ${calledHere.join(',')} but its entry does not say so`);
      }
      if (entry.checkedBy && !REGISTRY[entry.checkedBy]?.calls?.length) {
        problems.push(`${file}: checked by ${entry.checkedBy}, which is not an entry that calls a check`);
      }
      if (entry.noFile !== undefined && entry.noFile.trim().length < 20) problems.push(`${file}: say why no file comes in`);
    }
    expect(problems).toEqual([]);
  });

  it('every check call outside server/security is handed a server-built organization', () => {
    const problems = web.flatMap((w) => w.found.organizationProblems.map((p) => `${w.file}:${p}`));
    expect(problems).toEqual([]);
  });

  it('every phone write or upload-URL mint is listed with the website file that finalizes it, or as a known gap', () => {
    const unlisted = phone
      .filter((p) => (p.found.sites.writes_storage ?? 0) + (p.found.sites.mints_upload_url ?? 0) > 0)
      .filter((p) => !PHONE[p.file])
      .map((p) => `${p.file} ${JSON.stringify(counts(p.found.sites))}`);
    expect(unlisted).toEqual([]);
    const byFile = new Map(phone.map((p) => [p.file, p.found]));
    const problems: string[] = [];
    for (const [file, entry] of Object.entries(PHONE)) {
      const seen = counts(byFile.get(file)?.sites ?? {});
      const want = counts(entry.sites);
      const pick = (s: Record<string, unknown>) =>
        JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k === 'writes_storage' || k === 'mints_upload_url')));
      if (pick(seen) !== pick(want)) problems.push(`${file}: listed ${pick(want)}, found ${pick(seen)}`);
      if (Boolean(entry.finalizedBy) === Boolean(entry.knownGap)) problems.push(`${file}: a finalize or a known gap, exactly one`);
      if (entry.finalizedBy && !REGISTRY[entry.finalizedBy]?.calls?.length) problems.push(`${file}: finalized by ${entry.finalizedBy}, which calls no check`);
      if (entry.knownGap && !entry.knownGap.startsWith('stage 6c:')) problems.push(`${file}: a known gap names its stage`);
    }
    expect(problems).toEqual([]);
  });

  it('the known gaps that are not a file each name the stage that closes them', () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
    for (const gap of KNOWN_GAPS) expect(gap.startsWith('stage 6c:')).toBe(true);
  });
});

describe('the walk itself (self-tests on made-up source)', () => {
  it('finds each kind of site', () => {
    const found = readSource(
      `
      async function f(req: Request, store: any, admin: any) {
        await admin.storage.from('b').createSignedUploadUrl('p');
        await req.formData();
        Buffer.from(body.image, 'base64');
        Buffer.from(cursor, 'base64url');
        await fetchObjectPrefix(store, 'p');
        await fetchObjectWindow(store, 'p');
        await store.upload('p', bytes);
      }`,
      'made-up.ts',
    );
    expect(found.sites).toEqual({
      mints_upload_url: 1,
      reads_multipart: 1,
      reads_base64: 1,
      reads_stored_object: 2,
      writes_storage: 1,
    });
  });

  it('a site in a comment or a string is not a site', () => {
    const found = readSource(
      `// await req.formData(); createSignedUploadUrl(x)
       const s = "Buffer.from(x, 'base64')";`,
      'made-up.ts',
    );
    expect(found.sites).toEqual({});
  });

  it('the organization rule flags a request value, a missing one, a spread and a non-literal input', () => {
    const found = readSource(
      `
      await checkUploadBytes(b, { surface: 'x', accept: [], organizationId: ctx.organizationId });
      await checkUploadBytes(b, { surface: 'x', accept: [], organizationId: body.organizationId });
      await checkUploadPrefix(b, { surface: 'x', accept: [] });
      await checkStoredUpload(s, p, { ...input, organizationId: this.ctx.organizationId });
      await checkStoredUploadSignature(s, p, input);
      await verifyStoredDocumentOrDelete({ organizationId: req.org }, 'po-attachments', p);
      await verifyStoredDocumentOrDelete(this.ctx, 'po-attachments', p);
      await checkUploadBytes(b, { surface: 'x', accept: [], organizationId: order.organization_id });`,
      'made-up.ts',
    );
    expect(found.organizationProblems).toEqual([
      "3: checkUploadBytes is handed organizationId body.organizationId",
      '4: checkUploadPrefix is handed organizationId (missing)',
      "5: checkStoredUpload's input spreads another object",
      "6: checkStoredUploadSignature's input is not an object literal",
      '7: verifyStoredDocumentOrDelete is not handed ctx or this.ctx',
    ]);
    expect([...found.calls].sort()).toEqual([
      'checkStoredUpload',
      'checkStoredUploadSignature',
      'checkUploadBytes',
      'checkUploadPrefix',
      'verifyStoredDocumentOrDelete',
    ]);
  });
});
