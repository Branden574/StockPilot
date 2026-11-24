import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  SECURITY_CATEGORIES_WITH_DETECTOR,
  UPLOAD_SECURITY_EVENT_REASON_LABELS,
} from '@stockpilot/core';

/**
 * Security invariant (part 6, stage 6a): EVERY WAY A FILE COMES IN IS LISTED
 * HERE WITH THE CHECK IT CALLS, so a new upload path cannot ship unchecked.
 *
 * THE WALK reads the TypeScript syntax tree of every non-test source file of
 * the website (apps/web/src) and of the phone app (apps/mobile/src and
 * apps/mobile/app) and finds each place that
 *   - mints an upload URL            createSignedUploadUrl(...)
 *   - reads a multipart body         <request>.formData()
 *   - is handed a form               a parameter typed FormData
 *   - reads a raw body               <x>.arrayBuffer() / <x>.blob()
 *   - reads a base64 body            Buffer.from(<text>, 'base64') / atob(...)
 *   - hands bytes to a model         an object with inlineData, with data and
 *                                    mediaType, or with type 'base64'
 *   - fetches a remote file          safeFetch(...)
 *   - reads a stored object          fetchObjectPrefix(...) / fetchObjectWindow(...)
 *   - records an object's path       insert / update / upsert / rpc handed a
 *                                    *_path, avatar_url or logo_url field
 *   - copies or moves in storage     <bucket>.copy(from, to) / <bucket>.move(from, to)
 *   - writes bytes into storage      <bucket>.upload(...)
 *   - writes to a signed URL         uploadToSignedUrl(...) / uploadAsync(...)
 *   - calls the upload check         checkUploadBytes / checkUploadPrefix /
 *                                    checkStoredUpload / checkStoredUploadSignature /
 *                                    verifyStoredDocumentOrDelete
 * and fails on any file with such a site that is not in REGISTRY (web) or
 * PHONE (phone) with exactly that many of each. Each listed file says how it
 * is covered, in one way: the checks it calls itself (each must be there);
 * the listed file whose check covers it; for a module that fetches or hands
 * on bytes for others, the listed files that use it (every importer with a
 * site must be one of them); for pictures put in a PDF or an export, that
 * each is passed on only redrawn or exactly as the pass-through check read
 * it; or why no file comes in at all (a form of text fields; a secret or a
 * cursor that happens to be base64; bytes the server made itself). Phone
 * writes name the web file that finalizes them, or a later stage.
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
  | 'takes_form_data'
  | 'reads_raw_bytes'
  | 'reads_base64'
  | 'sends_to_model'
  | 'fetches_remote'
  | 'reads_stored_object'
  | 'records_object_path'
  | 'copies_storage'
  | 'writes_storage'
  | 'writes_signed_url';

/** A row column (or a function argument) that names a stored object. */
const OBJECT_PATH_NAME = /(^|_)path$|^(avatar|logo)_url$/;
/** The calls that write a row or hand a function its arguments. */
const ROW_WRITES = new Set(['insert', 'update', 'upsert', 'rpc']);

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

/** The pass-through checks a picture passed on as it is must clear (lib/image-decode.ts). */
const PASS_THROUGH_NAMES = ['pngPassesUnchanged', 'jpegPassesUnchanged'] as const;

interface Found {
  sites: Partial<Record<Site, number>>;
  calls: Set<CheckName>;
  /** "line: why" for each call that breaks the organization rule. */
  organizationProblems: string[];
  /** The pass-through checks this file calls. */
  passThrough: Set<string>;
  /** The module names this file imports from, as written. */
  imports: string[];
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
  const found: Found = { sites: {}, calls: new Set(), organizationProblems: [], passThrough: new Set(), imports: [] };
  const add = (site: Site) => {
    found.sites[site] = (found.sites[site] ?? 0) + 1;
  };
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const e = node.expression;
      if (name && (PASS_THROUGH_NAMES as readonly string[]).includes(name)) found.passThrough.add(name);
      if (e.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        found.imports.push(node.arguments[0].text);
      }
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
      if (name === 'atob' && ts.isIdentifier(e)) add('reads_base64');
      if ((name === 'arrayBuffer' || name === 'blob') && ts.isPropertyAccessExpression(e) && node.arguments.length === 0) {
        add('reads_raw_bytes');
      }
      if (name === 'safeFetch' && ts.isIdentifier(e)) add('fetches_remote');
      if ((name === 'fetchObjectPrefix' || name === 'fetchObjectWindow') && ts.isIdentifier(e)) add('reads_stored_object');
      if ((name === 'copy' || name === 'move') && ts.isPropertyAccessExpression(e) && node.arguments.length >= 2) {
        add('copies_storage');
      }
      if (name === 'upload' && ts.isPropertyAccessExpression(e)) add('writes_storage');
      if ((name === 'uploadToSignedUrl' || name === 'uploadAsync') && ts.isPropertyAccessExpression(e)) {
        add('writes_signed_url');
      }
      if (name && ROW_WRITES.has(name) && ts.isPropertyAccessExpression(e)) {
        const objects = node.arguments.flatMap((a) =>
          ts.isObjectLiteralExpression(a)
            ? [a]
            : ts.isArrayLiteralExpression(a)
              ? a.elements.filter(ts.isObjectLiteralExpression)
              : [],
        );
        const namesAPath = objects.some((o) =>
          o.properties.some(
            (p) =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
              OBJECT_PATH_NAME.test(p.name.text),
          ),
        );
        if (namesAPath) add('records_object_path');
      }
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
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(
        node.properties
          .filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
            ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p),
          )
          .map((p) => p.name.getText(sf)),
      );
      const base64Source = node.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          p.name.getText(sf) === 'type' &&
          ts.isStringLiteralLike(p.initializer) &&
          p.initializer.text === 'base64',
      );
      if (names.has('inlineData') || (names.has('data') && names.has('mediaType')) || base64Source) {
        add('sends_to_model');
      }
    }
    if (
      ts.isParameter(node) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      node.type.typeName.getText(sf) === 'FormData'
    ) {
      add('takes_form_data');
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
/** A repository path without its extension or a trailing /index, as an import names it. */
const bare = (file: string) => file.replace(/\.(ts|tsx)$/, '').replace(/\/index$/, '');

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
  /**
   * Or, for a module that fetches or hands on bytes for others: the listed
   * files that use it. Every file that imports it and has a site of its own
   * must be one of them, and each of them must be covered itself.
   */
  usedBy?: readonly string[];
  /**
   * Or, for pictures put in a PDF or an export: each is passed on only
   * redrawn by the capped decoder, or exactly as both pass-through checks
   * (lib/image-decode.ts) read it to its end. Both must be called here.
   */
  redrawnOrExact?: true;
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
  [`${W}lib/storage-object-prefix.ts`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'the storage read the check is built on: a first window, or the whole object within its ceiling',
    isTheCheck: true,
  },
  [`${W}server/services/upload-verification.ts`]: {
    sites: {},
    what: 'the document buckets’ finalize (PO and order attachments, support screenshots)',
    calls: ['checkStoredUpload'],
  },

  // ── upload URLs minted by the server; each finalize checks ──────────────
  [`${W}server/services/item-images.ts`]: {
    sites: { mints_upload_url: 2, records_object_path: 1 },
    what: 'item photo and thumbnail: mint, then the web finalize records the checked paths',
    calls: ['checkStoredUpload'],
  },
  [`${W}server/services/maintenance-attachments.ts`]: {
    sites: { mints_upload_url: 2, reads_raw_bytes: 1, reads_stored_object: 1, records_object_path: 1, writes_storage: 2 },
    what: 'maintenance photo: mint, finalize, the re-encoded copy written back and recorded',
    calls: ['checkUploadPrefix', 'checkUploadBytes'],
  },
  [`${W}server/services/exception-evidence.ts`]: {
    sites: { mints_upload_url: 1, reads_raw_bytes: 1, records_object_path: 1, writes_storage: 2 },
    what: 'exception evidence photo: mint, finalize, the re-encoded copy written back and recorded',
    calls: ['checkUploadBytes'],
  },
  [`${W}server/services/procedure-videos.ts`]: {
    sites: { mints_upload_url: 2, records_object_path: 1 },
    what: 'procedure video and poster: mint, then the finalize records the checked paths',
    calls: ['checkStoredUploadSignature', 'checkStoredUpload'],
  },
  [`${W}server/services/po-imports.ts`]: {
    sites: { mints_upload_url: 1, reads_raw_bytes: 1, records_object_path: 2, writes_storage: 1 },
    what: 'PO import file (mint, checked at parse) and PO scan frames (checked, then stored and read by the model)',
    calls: ['checkUploadBytes'],
  },
  [`${W}lib/po-scan/extract.ts`]: {
    sites: { sends_to_model: 2 },
    what: 'PO scan frames and import files handed to the model',
    usedBy: [`${W}server/services/po-imports.ts`],
  },

  // ── finalizes of client-direct writes ───────────────────────────────────
  [`${W}server/services/po-attachments.ts`]: {
    sites: { reads_raw_bytes: 1, records_object_path: 1 },
    what: 'PO attachment finalize, and the read of a recorded attachment for the zip',
    calls: ['verifyStoredDocumentOrDelete'],
  },
  [`${W}server/services/order-attachments.ts`]: {
    sites: { records_object_path: 1 },
    what: 'order attachment finalize',
    calls: ['verifyStoredDocumentOrDelete'],
  },
  [`${W}server/actions/profile.ts`]: {
    sites: { records_object_path: 2 },
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
  [`${W}server/services/support-tickets.ts`]: {
    sites: { records_object_path: 1 },
    what: 'the ticket row naming a screenshot; both finalizes (web and phone) check it first',
    checkedBy: `${W}server/actions/support-tickets.ts`,
  },

  // ── bytes that pass through the server ──────────────────────────────────
  [`${W}app/api/cycle-counts/[id]/ai-scan/route.ts`]: {
    sites: { reads_multipart: 1, reads_raw_bytes: 1, sends_to_model: 2, writes_storage: 1 },
    what: 'cycle-count shelf scan photo: checked, then stored and sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}server/services/cycle-counts.ts`]: {
    sites: { records_object_path: 1 },
    what: 'the shelf scan row naming the photo the scan route checked and stored',
    checkedBy: `${W}app/api/cycle-counts/[id]/ai-scan/route.ts`,
  },
  [`${W}app/api/v1/size-counts/[id]/scan/route.ts`]: {
    sites: { reads_multipart: 1, reads_raw_bytes: 1, sends_to_model: 2 },
    what: 'size-count scan photo: checked, then sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/v1/size-counts/training/route.ts`]: {
    sites: { reads_multipart: 1, reads_raw_bytes: 1 },
    what: 'size-count training photo (multipart)',
    checkedBy: `${W}server/services/size-counts.ts`,
  },
  [`${W}server/services/size-counts.ts`]: {
    sites: { records_object_path: 1, writes_storage: 1 },
    what: 'size-count training photo: checked, then stored and recorded',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/v1/ai/identify-from-photo/route.ts`]: {
    sites: { reads_base64: 1, reads_multipart: 1, reads_raw_bytes: 1, sends_to_model: 2 },
    what: 'identify-from-photo (multipart or base64): checked, then sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}lib/ai/tools.ts`]: {
    sites: { fetches_remote: 2, reads_raw_bytes: 1, sends_to_model: 2 },
    what: 'the chat tool that identifies an item from a photo URL: fetched, checked, then sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}lib/ai/claude.ts`]: {
    sites: { sends_to_model: 3 },
    what: 'the model client: it builds the request from the bytes a caller hands it',
    usedBy: [
      `${W}app/api/cycle-counts/[id]/ai-scan/route.ts`,
      `${W}app/api/v1/ai/identify-from-photo/route.ts`,
      `${W}app/api/v1/size-counts/[id]/scan/route.ts`,
      `${W}lib/ai/tools.ts`,
      `${W}lib/books/isbn-ai-extract.ts`,
      `${W}lib/po-scan/extract.ts`,
    ],
  },
  [`${W}app/api/po-imports/scan/route.ts`]: {
    sites: { reads_multipart: 1, reads_raw_bytes: 1 },
    what: 'PO scan frames (multipart)',
    checkedBy: `${W}server/services/po-imports.ts`,
  },
  [`${W}app/api/books/extract-isbns/route.ts`]: {
    sites: { reads_multipart: 1, reads_raw_bytes: 1 },
    what: 'ISBN file, text pass: checked, then parsed',
    calls: ['checkUploadBytes'],
  },
  [`${W}app/api/books/extract-isbns-ai/route.ts`]: {
    sites: { reads_multipart: 1, reads_raw_bytes: 1 },
    what: 'ISBN file, AI pass: checked, then parsed or sent to the model',
    calls: ['checkUploadBytes'],
  },
  [`${W}lib/books/isbn-ai-extract.ts`]: {
    sites: { sends_to_model: 2 },
    what: 'the ISBN file handed to the model',
    usedBy: [`${W}app/api/books/extract-isbns-ai/route.ts`],
  },
  [`${W}app/api/orders/sign/route.ts`]: {
    sites: { reads_base64: 1 },
    what: 'order signature picture (a base64 data URL): decoded and checked before it is recorded',
    calls: ['checkUploadBytes'],
  },
  [`${W}server/services/books-import.ts`]: {
    sites: { fetches_remote: 1, records_object_path: 1, writes_storage: 1 },
    what: 'book cover fetched from a cover host: checked (type from its bytes), then stored and recorded',
    calls: ['checkUploadBytes'],
  },

  // ── pictures fetched to be put in a PDF or an export ────────────────────
  [`${W}lib/item-image-fetch.ts`]: {
    sites: { fetches_remote: 1 },
    what: 'the fetch of an item picture or a logo for a PDF or an export',
    usedBy: [`${W}lib/exports/export-images.ts`, `${W}lib/pdf/image-prefetch.ts`],
  },
  [`${W}lib/exports/export-images.ts`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'item pictures put in an inventory export',
    redrawnOrExact: true,
  },
  [`${W}lib/pdf/image-prefetch.ts`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'item pictures and the logo put in a PDF',
    redrawnOrExact: true,
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
  [`${W}components/po-imports/po-upload-form.tsx`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'PO import file, hashed in the browser after its upload',
    checkedBy: `${W}server/services/po-imports.ts`,
  },
  [`${W}lib/image-variants.worker.ts`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'item photo sizes made in the browser before the upload',
    checkedBy: `${W}server/services/item-images.ts`,
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
    sites: { reads_base64: 1, reads_raw_bytes: 1 },
    what: 'the analytics relay',
    noFile: 'decodes an analytics payload it forwards, and hands back the answer; nothing is stored or opened',
  },
  [`${W}lib/auth/bridge-secret.ts`]: {
    sites: { reads_base64: 1 },
    what: 'a sealed secret',
    noFile: 'decodes a sealed secret the server itself wrote',
  },
  [`${W}components/realtime/session-id-from-token.ts`]: {
    sites: { reads_base64: 1 },
    what: 'the session id inside the signed-in token',
    noFile: 'decodes the payload of the sign-in token the browser already holds',
  },
  [`${W}components/platform/security-map/world-geometry.ts`]: {
    sites: { reads_base64: 1 },
    what: 'the outline of the world map',
    noFile: 'decodes map data that ships in the source itself',
  },
  [`${W}app/api/admin/backfill-item-thumbs/route.ts`]: {
    sites: { reads_raw_bytes: 1, records_object_path: 1, writes_storage: 1 },
    what: 'thumbnails made by the server',
    noFile: 'reads an item photo already stored and writes and records a thumbnail the server made from it; no file comes in',
  },
  [`${W}app/api/purchase-orders/[id]/attachments.zip/route.ts`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'the PO zip',
    noFile: 'reads the PO PDF the server renders itself; the attachments come through po-attachments.ts',
  },
  [`${W}app/m/[token]/photo/[n]/route.ts`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'a shared maintenance photo',
    noFile: 'serves a stored maintenance photo, kept only after its finalize checked and re-made it',
  },
  [`${W}server/services/integration-events.ts`]: {
    sites: { fetches_remote: 1 },
    what: 'webhook deliveries',
    noFile: 'sends an event out and reads only the answer’s status',
  },
  [`${W}components/inventory/barcode-display.tsx`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'a barcode picture, in the browser',
    noFile: 'browser code: shows the barcode picture the server drew',
  },
  [`${W}components/reports/book-order-totals/export-menu.tsx`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'a report export, in the browser',
    noFile: 'browser code: saves an export file the server made',
  },
  [`${W}lib/download-export.ts`]: {
    sites: { reads_raw_bytes: 1 },
    what: 'an export, in the browser',
    noFile: 'browser code: saves an export file the server made',
  },
};

interface PhoneEntry {
  sites: Partial<Record<Site, number>>;
  what: string;
  finalizedBy?: string;
  /** A later stage closes it: the stage and the number of its entry in the private notes. */
  knownGap?: string;
}

/** Every phone-app file that writes into storage, to a signed URL, or mints an upload URL, and its finalize. */
const PHONE: Readonly<Record<string, PhoneEntry>> = {
  'apps/mobile/src/lib/storage-upload.ts': {
    sites: { mints_upload_url: 1, writes_signed_url: 1 },
    what: 'PO and order attachments, written by the phone',
    finalizedBy: `${W}server/services/upload-verification.ts`,
  },
  'apps/mobile/src/lib/signed-photo-upload.ts': {
    sites: { writes_signed_url: 2 },
    what: 'maintenance and exception evidence photos (and a thumbnail), written by the phone',
    finalizedBy: `${W}server/services/maintenance-attachments.ts`,
  },
  'apps/mobile/app/(drawer)/support.tsx': {
    sites: { writes_storage: 1 },
    what: 'support screenshot, written by the phone',
    finalizedBy: `${W}app/api/v1/support/route.ts`,
  },
  'apps/mobile/src/lib/item-photo-upload.ts': {
    sites: { writes_storage: 2 },
    what: 'item photo and thumbnail, written by the phone',
    knownGap: 'stage 6c, G1',
  },
};

/** How a later stage is named: a reference only; what it closes is in the private notes. */
const LATER_STAGE = /^stage 6c, G\d+$/;

/** Later-stage entries that are not a file of the walk (the detail is in the private notes). */
const KNOWN_GAPS: readonly string[] = ['stage 6c, G2', 'stage 6c, G3', 'stage 6c, G4', 'stage 6c, G5'];

describe('every way a file comes in is listed with its check (part 6)', () => {
  const web = sourceFiles(WEB_SRC).map((f) => ({ file: rel(f), found: readSource(readFileSync(f, 'utf8'), f, !rel(f).startsWith(`${W}server/security/`)) }));
  const phone = MOBILE_ROOTS.flatMap((r) => sourceFiles(r)).map((f) => ({ file: rel(f), found: readSource(readFileSync(f, 'utf8'), f, false) }));
  const hasSites = (f: Found) => Object.values(f.sites).some((n) => (n ?? 0) > 0);
  const counts = (s: Partial<Record<Site, number>>) =>
    Object.fromEntries(Object.entries(s).filter(([, n]) => (n ?? 0) > 0).sort());
  /** The file a module name written in `importer` names, without its extension. */
  const moduleOf = (importer: string, spec: string): string | null => {
    const base = spec.startsWith('@/')
      ? path.join(WEB_SRC, spec.slice(2))
      : spec.startsWith('.')
        ? path.resolve(path.dirname(path.join(REPO, importer)), spec)
        : null;
    return base === null ? null : bare(rel(base));
  };
  const importersOf = (file: string) =>
    web.filter((w) => w.file !== file && w.found.imports.some((spec) => moduleOf(w.file, spec) === bare(file))).map((w) => w.file);

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
      const ways = [entry.calls, entry.checkedBy, entry.noFile, entry.isTheCheck, entry.usedBy, entry.redrawnOrExact].filter(
        (x) => x !== undefined,
      );
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
      if (entry.redrawnOrExact) {
        for (const name of PASS_THROUGH_NAMES) {
          if (!byFile.get(file)?.passThrough.has(name)) problems.push(`${file}: passes pictures on but never calls ${name}`);
        }
      }
      if (entry.usedBy) {
        const importers = importersOf(file);
        for (const importer of importers) {
          if (hasSites(byFile.get(importer)!) && !entry.usedBy.includes(importer)) {
            problems.push(`${file}: imported by ${importer}, which has sites and is not in its usedBy`);
          }
        }
        for (const user of entry.usedBy) {
          const covered = REGISTRY[user];
          if (!importers.includes(user)) problems.push(`${file}: usedBy names ${user}, which does not import it`);
          if (!covered || !(covered.calls?.length || covered.usedBy || covered.redrawnOrExact)) {
            problems.push(`${file}: used by ${user}, which is not an entry that checks, redraws or is used by one that does`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every check call outside server/security is handed a server-built organization', () => {
    const problems = web.flatMap((w) => w.found.organizationProblems.map((p) => `${w.file}:${p}`));
    expect(problems).toEqual([]);
  });

  it('every phone write, signed-URL write or upload-URL mint is listed with the website file that finalizes it, or a later stage', () => {
    const PHONE_SITES: readonly Site[] = ['writes_storage', 'mints_upload_url', 'writes_signed_url'];
    const pick = (s: Partial<Record<Site, number>>) =>
      JSON.stringify(Object.fromEntries(Object.entries(counts(s)).filter(([k]) => (PHONE_SITES as readonly string[]).includes(k))));
    const unlisted = phone
      .filter((p) => PHONE_SITES.some((k) => (p.found.sites[k] ?? 0) > 0))
      .filter((p) => !PHONE[p.file])
      .map((p) => `${p.file} ${pick(p.found.sites)}`);
    expect(unlisted).toEqual([]);
    const byFile = new Map(phone.map((p) => [p.file, p.found]));
    const problems: string[] = [];
    for (const [file, entry] of Object.entries(PHONE)) {
      const seen = pick(byFile.get(file)?.sites ?? {});
      const want = pick(entry.sites);
      if (seen !== want) problems.push(`${file}: listed ${want}, found ${seen}`);
      if (Boolean(entry.finalizedBy) === Boolean(entry.knownGap)) problems.push(`${file}: a finalize or a later stage, exactly one`);
      if (entry.finalizedBy && !REGISTRY[entry.finalizedBy]?.calls?.length) problems.push(`${file}: finalized by ${entry.finalizedBy}, which calls no check`);
      if (entry.knownGap !== undefined && !LATER_STAGE.test(entry.knownGap)) problems.push(`${file}: a later stage is named as "stage 6c, G<n>"`);
    }
    expect(problems).toEqual([]);
  });

  it('the later-stage entries that are not a file are named as references, each once', () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
    for (const gap of KNOWN_GAPS) expect(gap).toMatch(LATER_STAGE);
    const all = [...KNOWN_GAPS, ...Object.values(PHONE).flatMap((e) => (e.knownGap ? [e.knownGap] : []))];
    expect(new Set(all).size).toBe(all.length);
  });
});

/**
 * Every place the website writes a security event with a literal reason: the
 * reason, its category and outcome (when literal), and whether the object is
 * handed straight to recordSecurityEvent.
 */
interface ReasonSite {
  reason: string;
  category: string | null;
  outcome: string | null;
  recorded: boolean;
}

function reasonSites(text: string, fileName: string): ReasonSite[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ReasonSite[] = [];
  const literal = (o: ts.ObjectLiteralExpression, name: string): string | null => {
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText(source) === name && ts.isStringLiteralLike(p.initializer)) {
        return p.initializer.text;
      }
    }
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const reason = literal(node, 'reason');
      if (reason !== null) {
        const parent = node.parent;
        const recorded =
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          parent.expression.getText(source).replace(/^await\s+/, '') === 'recordSecurityEvent';
        out.push({ reason, category: literal(node, 'category'), outcome: literal(node, 'outcome'), recorded });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('every upload reason code has a producer (part 6)', () => {
  const sites = sourceFiles(WEB_SRC).flatMap((f) =>
    reasonSites(readFileSync(f, 'utf8'), f).map((s) => ({ ...s, file: rel(f) })),
  );
  const UPLOAD_REASONS = Object.keys(UPLOAD_SECURITY_EVENT_REASON_LABELS).sort();

  it('the four reasons, each with words', () => {
    expect(UPLOAD_REASONS).toEqual(
      ['upload_active_content', 'upload_could_not_check', 'upload_hidden_file', 'upload_wrong_type'],
    );
  });

  it('each one is written, as a literal, by the one upload check: malware, blocked, straight to recordSecurityEvent', () => {
    for (const reason of UPLOAD_REASONS) {
      const producers = sites.filter((s) => s.reason === reason);
      expect(producers.length, `${reason} has no producer: a label must never stand for a kind nothing records`).toBeGreaterThan(0);
      for (const p of producers) {
        expect(p, reason).toMatchObject({
          file: `${W}server/security/upload-checks.ts`,
          category: 'malware',
          outcome: 'blocked',
          recorded: true,
        });
      }
    }
  });

  it('no upload reason is written that has no words, and nothing else writes the malware kind', () => {
    const upload = sites.filter((s) => s.reason.startsWith('upload_')).map((s) => s.reason);
    for (const reason of upload) expect(UPLOAD_REASONS, reason).toContain(reason);
    const malware = sites.filter((s) => s.category === 'malware');
    expect(malware.map((s) => s.reason).sort()).toEqual(UPLOAD_REASONS);
  });

  it('the map shows the malware kind only while something records it', () => {
    const detector = SECURITY_CATEGORIES_WITH_DETECTOR.malware;
    if (detector.shown) {
      expect(detector.firesNow.length).toBeGreaterThan(0);
      expect(sites.some((s) => s.category === 'malware' && s.recorded)).toBe(true);
    }
  });

  it('the reader of a reason sees a literal in a recordSecurityEvent call, and only there (self-test)', () => {
    const made = `
      await recordSecurityEvent({ category: 'malware', outcome: 'blocked', reason: 'upload_wrong_type', source, organizationId });
      const notRecorded = { category: 'malware', reason: 'upload_hidden_file' };
      other({ reason: 'upload_active_content' });
      const dynamic = { reason: someVariable };
    `;
    expect(reasonSites(made, 'made-up.ts')).toEqual([
      { reason: 'upload_wrong_type', category: 'malware', outcome: 'blocked', recorded: true },
      { reason: 'upload_hidden_file', category: 'malware', outcome: null, recorded: false },
      { reason: 'upload_active_content', category: null, outcome: null, recorded: false },
    ]);
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

  it('sees each of the eight shapes the review found unseen, and not their look-alikes', () => {
    const shapes: Array<[string, string, Partial<Record<Site, number>>]> = [
      ['a server action handed a form', `export async function act(form: FormData) { form.get('file'); }`, { takes_form_data: 1 }],
      ['a route reading the raw body', `export async function POST(req: Request) { await req.arrayBuffer(); await req.blob(); }`, { reads_raw_bytes: 2 }],
      [
        'base64 from a request handed straight to a model',
        `await gemini.generate([{ inlineData: { data: body.image, mimeType: 'image/png' } }]);
         await claude.create({ media: [{ data: body.image, mediaType: 'image/png' }] });
         const part = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: body.image } };`,
        { sends_to_model: 3 },
      ],
      ['base64 decoded with atob', `const bytes = atob(body.file);`, { reads_base64: 1 }],
      ['a remote file fetched and passed on', `const res = await safeFetch(url, {}); const b = await res.arrayBuffer();`, { fetches_remote: 1, reads_raw_bytes: 1 }],
      [
        'a finalize that records a client path',
        `await db.from('t').insert({ storage_path: input.path });
         await db.from('t').update({ avatar_url: input.url }).eq('id', id);
         await db.from('t').upsert([{ thumb_path: p }]);
         await db.rpc('record', { p_storage_path: p });`,
        { records_object_path: 4 },
      ],
      ['a stored object brought in by copy or move', `await bucket.copy(from, to); await bucket.move(from, to);`, { copies_storage: 2 }],
      [
        'a write to a signed URL',
        `await bucket.uploadToSignedUrl(p, token, file); await FileSystem.uploadAsync(url, uri, {});`,
        { writes_signed_url: 2 },
      ],
      [
        'look-alikes that are not a way in',
        `await db.from('t').update({ name: 'x' }).eq('id', id);
         Buffer.from(cursor, 'base64url');
         const copy = list.copy();
         const o = { data: rows };
         function f(form: HTMLFormElement) {}`,
        {},
      ],
    ];
    for (const [label, source, sites] of shapes) {
      expect(readSource(source, 'made-up.ts').sites, label).toEqual(sites);
    }
  });

  it('reads the imports (static, re-export and dynamic) and the pass-through calls', () => {
    const found = readSource(
      `
      import { a } from '@/lib/a';
      export { b } from './b';
      const c = await import('@/lib/c');
      if (await pngPassesUnchanged(x, limits)) use(x);
      jpegPassesUnchanged(x, limits);`,
      'made-up.ts',
    );
    expect(found.imports).toEqual(['@/lib/a', './b', '@/lib/c']);
    expect([...found.passThrough].sort()).toEqual(['jpegPassesUnchanged', 'pngPassesUnchanged']);
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
