/**
 * ACTIVE-CONTENT SCANNING for uploaded documents — phase 2c of the upload
 * hardening brief.
 *
 * ═══ WHAT THIS IS FOR, AND WHY IT IS NOT A VIRUS SCANNER ═══
 *
 * `sniffFile` (lib/file-signature.ts) answers "are these bytes really a PDF?".
 * It cannot answer "is this PDF safe to open?", and those are different
 * questions: a file can be a perfectly well-formed PDF whose whole purpose is
 * to run something on the machine of the warehouse manager who opens it.
 *
 * The brief asked for malware scanning, and the obvious answer was ClamAV.
 * That answer does not survive contact with this workload — the reasoning is
 * recorded in the PR, but the short version is that ClamAV needs ~30 seconds
 * to load its signature database on a cold instance, and at roughly two dozen
 * document uploads a MONTH essentially every upload is a cold instance. Every
 * attachment would take half a minute, and the baked signatures would go stale
 * between deploys.
 *
 * More importantly, signatures answer the wrong question here. ClamAV
 * recognises KNOWN malware. It has little to say about a freshly-authored PDF
 * whose only payload is `/OpenAction << /S /Launch ... >>` — no known family,
 * no signature, and a clean verdict. Structural inspection catches exactly
 * that file, deterministically, in single-digit milliseconds, with no
 * signature freshness problem and no external dependency.
 *
 * These are complementary layers, not substitutes, and this one is the layer
 * that matches the actual threat: a vendor emails an "invoice", someone
 * attaches it to a PO, and someone else opens it.
 *
 * ═══ WHY IT INFLATES STREAMS ═══
 *
 * A scanner that greps raw PDF bytes for `/JavaScript` is theatre. Every
 * modern producer packs objects into `/ObjStm` streams compressed with
 * `/FlateDecode`, so the marker a naive scan looks for is simply not present
 * as those bytes — not through any evasion effort, just as a side effect of
 * normal PDF writing. Anything hidden there passes.
 *
 * So this decompresses stream objects (bounded — see the constants) and scans
 * the inflated content too. Without that step the check would report clean on
 * the majority of real-world PDFs carrying active content, which is worse than
 * having no check at all, because it would be believed.
 *
 * ═══ WHY IT NORMALISES `#xx` ESCAPES ═══
 *
 * PDF name tokens may write any character as `#` plus two hex digits, so
 * `/JavaScript` and `/J#61vaScript` are the SAME name to a reader and
 * different byte strings to a grep. That is the oldest PDF evasion there is.
 * Each name token is decoded before it is compared, so both spellings land on
 * the same entry.
 *
 * Decoding is done per-token rather than across the whole document on purpose:
 * a global find-and-replace of `#xx` would let an innocuous run of text
 * assemble into a marker it never contained.
 */
import { inflateSync } from 'node:zlib';

import type { SniffedFile } from './file-signature';

export type DocumentThreatCode =
  | 'pdf_javascript'
  | 'pdf_launch_action'
  | 'pdf_embedded_file'
  | 'pdf_rich_media'
  | 'pdf_encrypted'
  | 'pdf_scan_limit'
  | 'appended_payload';

export type DocumentThreat = {
  code: DocumentThreatCode;
  /** Operator-facing detail — safe to log, never rendered to an end user. */
  detail: string;
};

/**
 * What the person who tried to upload actually sees.
 *
 * Every one of these names the specific problem AND the way out, because the
 * uploader is a warehouse manager holding a real invoice they need attached,
 * not an attacker. "Failed our security checks" with no route forward turns a
 * safe refusal into a support ticket. The one exception is the appended-payload
 * case, where there is no innocent explanation to offer.
 */
export const THREAT_MESSAGES: Record<DocumentThreatCode, string> = {
  pdf_javascript:
    'This PDF contains embedded JavaScript, which we do not accept. Open it and use Print to PDF to save a flat copy, then upload that.',
  pdf_launch_action:
    'This PDF contains an action that launches an external program, which we do not accept. Open it and use Print to PDF to save a flat copy, then upload that.',
  pdf_embedded_file:
    'This PDF has another file embedded inside it, which we do not accept. Open it and use Print to PDF to save a flat copy, then upload that.',
  pdf_rich_media:
    'This PDF contains embedded media, which we do not accept. Open it and use Print to PDF to save a flat copy, then upload that.',
  pdf_encrypted:
    'This PDF is password-protected, so we cannot check what is inside it. Open it, use Print to PDF to save an unprotected copy, then upload that.',
  pdf_scan_limit:
    'This PDF is too large or too complex for us to check safely. Open it and use Print to PDF to save a simpler copy, then upload that.',
  appended_payload:
    'This file has extra data hidden after the end of the image and could not be uploaded.',
};

// ───────────────────────── bounds ─────────────────────────
//
// Every one of these exists because the INPUT IS HOSTILE. A scanner that can
// be made to allocate without limit by the file it is scanning has replaced
// the threat it was looking for with a denial-of-service it created itself.

/**
 * Streams inflated per document. Generous — a fifty-page PDF legitimately has
 * hundreds — because this is not a quality bar, it is the ceiling on how many
 * times one upload can make us call into zlib. A document of a hundred thousand
 * two-byte streams costs nothing to write and a great deal to inspect.
 */
const MAX_STREAMS_INFLATED = 4096;

/** Per-stream inflated ceiling, enforced by zlib itself via `maxOutputLength`
 *  — it ABORTS at the limit rather than decompressing and then measuring, so
 *  a 40-byte stream that expands to 4 GB (a zip bomb) costs us 32 MB and a
 *  thrown error, not the 4 GB. */
const MAX_INFLATED_BYTES_PER_STREAM = 32 * 1024 * 1024;

/** Total inflated budget across the whole document — the many-medium-streams
 *  shape that slips under the per-stream cap. Sized so no honest PDF inside
 *  our upload limits can reach it: the bulk of a large real PDF is image data,
 *  which is /DCTDecode or /CCITTFaxDecode and does not inflate here at all. */
const MAX_TOTAL_INFLATED_BYTES = 256 * 1024 * 1024;

/**
 * PDF name tokens that mean active content, keyed by the DECODED name.
 *
 * DELIBERATELY NOT LISTED, and each for a reason:
 *
 *  - `/OpenAction` and `/AA` (additional actions) are how a PDF says "do this
 *    on open". Both are overwhelmingly benign — `/OpenAction` is usually just
 *    "start on page 1" — and both are only dangerous when they point AT one of
 *    the entries below, which is caught on its own. Listing them would reject
 *    a large share of ordinary invoices for nothing.
 *  - `/XFA` (XML Forms Architecture) is a genuine exploit surface, but real
 *    government and vendor forms use it and rejecting those would be a
 *    frequent, confusing refusal.
 *  - `/SubmitForm` and `/ImportData` move data rather than execute; they are a
 *    different (and much weaker) concern than the brief's "execution path".
 *
 * The bar for this table is: no legitimate purchase order, invoice, packing
 * slip or delivery photo has any business containing it.
 */
const PDF_ACTIVE_CONTENT: ReadonlyArray<
  readonly [name: string, code: DocumentThreatCode, detail: string]
> = [
  ['JavaScript', 'pdf_javascript', '/JavaScript action'],
  // The JS action's script entry. Not an abbreviation anything benign uses as
  // a name: font subset tags are always six letters plus '+', so `/JS` cannot
  // be one.
  ['JS', 'pdf_javascript', '/JS script entry'],
  ['Launch', 'pdf_launch_action', '/Launch action'],
  ['EmbeddedFile', 'pdf_embedded_file', '/EmbeddedFile stream'],
  // The catalog-level name tree. Matched separately because the comparison is
  // exact, so the singular entry above does not cover the plural.
  ['EmbeddedFiles', 'pdf_embedded_file', '/EmbeddedFiles name tree'],
  ['RichMedia', 'pdf_rich_media', '/RichMedia annotation'],
  ['Movie', 'pdf_rich_media', '/Movie annotation'],
  ['Sound', 'pdf_rich_media', '/Sound annotation'],
];

/**
 * Signatures for things that must never follow the end of an image.
 *
 * `cat photo.png payload.zip > photo.png` produces a file that is a valid
 * image to every viewer and a valid archive to every archive tool, because
 * ZIP readers locate the central directory by scanning BACKWARDS from the end
 * of the file. The image half is the disguise.
 */
const APPENDED_PAYLOAD_SIGNATURES: ReadonlyArray<{
  magic: readonly number[];
  detail: string;
  /** True for signatures short enough that a deep scan would match noise. */
  atStartOnly?: boolean;
}> = [
  { magic: [0x50, 0x4b, 0x03, 0x04], detail: 'ZIP local file header' },
  { magic: [0x50, 0x4b, 0x05, 0x06], detail: 'ZIP end-of-central-directory' },
  { magic: [0x52, 0x61, 0x72, 0x21], detail: 'RAR archive' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], detail: '7-Zip archive' },
  { magic: [0x7f, 0x45, 0x4c, 0x46], detail: 'ELF executable' },
  // `MZ` is TWO bytes, so roughly one random 64 KB region contains it by
  // chance. Anchoring it to offset 0 of the trailing run is what keeps it a
  // signature rather than a coin toss — and offset 0 is exactly where a
  // concatenation puts it.
  { magic: [0x4d, 0x5a], detail: 'DOS/PE executable', atStartOnly: true },
];

// ───────────────────────── entry point ─────────────────────────

/**
 * Inspect a document for active content or a hidden payload.
 *
 * Returns the FIRST threat found, or null for clean. First-wins rather than
 * collect-all because the caller's only decision is accept/reject; enumerating
 * every problem in a file we are about to delete buys nothing.
 *
 * ⚠️ REQUIRES THE WHOLE FILE. Unlike `sniffFile`, which decides from a 4 KB
 * prefix, active content lives anywhere in the document — commonly in the
 * cross-reference region at the very END. Handing this a prefix produces a
 * confident "clean" on a file that was never examined, which is the single
 * most dangerous way to misuse it.
 */
export function scanDocumentBytes(
  data: Uint8Array,
  kind: SniffedFile['kind'],
): DocumentThreat | null {
  if (kind === 'pdf') return scanPdf(data);
  return scanImageTrailer(data, kind);
}

// ───────────────────────── PDF ─────────────────────────

function scanPdf(data: Uint8Array): DocumentThreat | null {
  // latin1 maps each byte to exactly one code unit and back, so the string is
  // a lossless view of the bytes. utf8 would MANGLE high bytes into U+FFFD and
  // silently destroy the very stream offsets we go on to slice.
  const text = Buffer.from(data).toString('latin1');

  // Encryption is checked first and refused outright: with encrypted streams
  // every check below is blind, so passing such a file would mean reporting
  // "clean" to mean "we could not look". Elsewhere in this codebase an
  // unreadable object fails closed (fetchObjectPrefix returning null, the
  // archive guard on a holdings-read error) and this is the same rule.
  if (pdfNameTokens(text).has('Encrypt')) {
    return { code: 'pdf_encrypted', detail: '/Encrypt dictionary present' };
  }

  const direct = findActiveContent(text);
  if (direct) return direct;

  // …and again on what the compressed objects were hiding.
  return scanFlateStreams(data, text);
}

function findActiveContent(text: string): DocumentThreat | null {
  const names = pdfNameTokens(text);
  for (const [name, code, detail] of PDF_ACTIVE_CONTENT) {
    if (names.has(name)) return { code, detail };
  }
  return null;
}

/**
 * Every `/Name` token in the text, with `#xx` escapes decoded.
 *
 * The character class is the one PDF actually permits in a name after the
 * slash, plus `#` for the escapes. 127 is the practical cap on name length in
 * the spec and also stops a megabyte of slashes from becoming one token.
 */
const PDF_NAME_TOKEN = /\/([A-Za-z0-9#+._-]{1,127})/g;

function pdfNameTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(PDF_NAME_TOKEN)) {
    // `match[1]` is the capture group, which a match guarantees; the guard is
    // for noUncheckedIndexedAccess, not for a case that can occur.
    out.add(decodePdfNameEscapes(match[1] ?? ''));
  }
  return out;
}

/** `J#61vaScript` → `JavaScript`. Applied to ONE token, never to the document. */
function decodePdfNameEscapes(raw: string): string {
  if (!raw.includes('#')) return raw;
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_whole, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Inflate the `/FlateDecode` streams and scan what comes out, bounded on every
 * axis — and REFUSING rather than skipping when a bound is reached.
 *
 * ═══ WHY EXCEEDING A LIMIT IS A VERDICT, NOT A SHRUG ═══
 *
 * The first cut of this skipped any stream that blew its budget and carried on.
 * That is a hole you can drive a document through: pad an object stream out
 * past the cap with compressible filler, put the `/JavaScript` after the
 * padding, and the scanner declines to look and then reports clean. Every
 * bound becomes a hiding place.
 *
 * Any scanner with finite resources faces this, and the resolution is the one
 * ClamAV reaches with `--alert-exceeds-max`: hitting a limit means the file
 * could not be inspected, and "could not inspect" must not return the same
 * verdict as "inspected and found nothing". So a document that exhausts the
 * budget, the per-stream ceiling or the stream count is REFUSED. Same posture
 * as `/Encrypt` above, and the same the rest of this codebase takes on an
 * object it cannot read.
 *
 * The two zlib failures are deliberately NOT treated alike:
 *
 *   Z_DATA_ERROR          these bytes are not Flate at all — a /DCTDecode
 *                         JPEG, a font, or a keyword match inside binary data.
 *                         Nothing was hidden from us, because there was
 *                         nothing to decompress. Skip, silently.
 *
 *   ERR_BUFFER_TOO_LARGE  these bytes ARE Flate and we chose to stop reading.
 *                         Content exists that we did not see. Refuse.
 *
 * Streams are located by their `stream` / `endstream` keywords rather than by
 * parsing the cross-reference table, because a PDF built to hide something is
 * exactly the PDF whose xref lies. Keyword scanning sees what is physically in
 * the file. It over-matches — the word "endstream" can occur inside binary
 * data — but an over-match yields a slice that is not Flate, which is the skip
 * case above. Under-matching is the failure mode that would matter, and this
 * does not under-match.
 */
function scanFlateStreams(data: Uint8Array, text: string): DocumentThreat | null {
  let budget = MAX_TOTAL_INFLATED_BYTES;
  let searchFrom = 0;

  for (let n = 0; ; n += 1) {
    const kw = text.indexOf('stream', searchFrom);
    if (kw === -1) return null;

    if (n >= MAX_STREAMS_INFLATED) {
      return { code: 'pdf_scan_limit', detail: `more than ${MAX_STREAMS_INFLATED} streams` };
    }

    // Skip the EOL the spec requires between `stream` and the data: CRLF or
    // LF, never a bare CR. Starting one byte late corrupts the zlib header,
    // the inflate throws Z_DATA_ERROR, and the stream is dropped as "not
    // Flate" — a scanner reporting clean because it fed itself garbage.
    let start = kw + 'stream'.length;
    if (text.charCodeAt(start) === 0x0d && text.charCodeAt(start + 1) === 0x0a) start += 2;
    else if (text.charCodeAt(start) === 0x0a) start += 1;

    const end = text.indexOf('endstream', start);
    searchFrom = end === -1 ? kw + 'stream'.length : end + 'endstream'.length;
    if (end === -1 || end <= start) continue;

    let inflated: Buffer;
    try {
      inflated = inflateSync(Buffer.from(data.subarray(start, end)), {
        maxOutputLength: Math.min(MAX_INFLATED_BYTES_PER_STREAM, budget),
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        return { code: 'pdf_scan_limit', detail: 'a stream larger than we will decompress' };
      }
      continue; // not Flate — nothing was concealed here
    }

    budget -= inflated.byteLength;
    const hit = findActiveContent(inflated.toString('latin1'));
    if (hit) return { ...hit, detail: `${hit.detail} (inside a compressed stream)` };
  }
}

// ───────────────────────── images ─────────────────────────

/**
 * Whether anything recognisably archive- or executable-shaped follows the
 * image's own end-of-data marker.
 *
 * Note what this does NOT do: it does not reject trailing bytes as such.
 * Cameras and editors leave padding, thumbnails and metadata after the marker
 * all the time, and refusing those would reject a large share of genuine
 * phone photos. Only a recognised payload signature is a threat.
 */
function scanImageTrailer(
  data: Uint8Array,
  kind: Exclude<SniffedFile['kind'], 'pdf'>,
): DocumentThreat | null {
  const end = imageDataEnd(data, kind);
  // null = we do not know where this format ends, so we cannot say anything
  // about what follows it. Reporting "clean" would be a guess; reporting a
  // threat would be a false positive. Silence is the honest answer, and the
  // sniffer has already established the file IS this format.
  if (end === null || end >= data.length) return null;

  const trailer = data.subarray(end);
  for (const sig of APPENDED_PAYLOAD_SIGNATURES) {
    const at = sig.atStartOnly
      ? startsWith(trailer, sig.magic)
        ? 0
        : -1
      : indexOfMagic(trailer, sig.magic);
    if (at !== -1) {
      return {
        code: 'appended_payload',
        detail: `${sig.detail} ${at + end} bytes into the file, after the image ends at ${end}`,
      };
    }
  }
  return null;
}

/** Offset one past the last byte the image format itself accounts for. */
function imageDataEnd(
  data: Uint8Array,
  kind: Exclude<SniffedFile['kind'], 'pdf'>,
): number | null {
  switch (kind) {
    case 'png':
      return pngEnd(data);
    case 'jpeg':
      return jpegEnd(data);
    case 'webp':
      return riffEnd(data);
    // HEIC/HEIF is ISO-BMFF: a chain of boxes with no terminator, so "the end
    // of the image" is only knowable by walking every box. Not worth it for a
    // format that is transcoded before it reaches anything that opens it.
    default:
      return null;
  }
}

/** PNG ends with the IEND chunk: length(4) type(4) data(0) crc(4). */
function pngEnd(data: Uint8Array): number | null {
  const IEND = [0x49, 0x45, 0x4e, 0x44];
  for (let i = data.length - 8; i >= 8; i -= 1) {
    if (startsWithAt(data, IEND, i)) return i + IEND.length + 4;
  }
  return null;
}

/** JPEG ends at the EOI marker, FFD9. */
function jpegEnd(data: Uint8Array): number | null {
  for (let i = data.length - 2; i >= 2; i -= 1) {
    if (data[i] === 0xff && data[i + 1] === 0xd9) return i + 2;
  }
  return null;
}

/** RIFF declares its own length at bytes 4-7 (little-endian), covering
 *  everything after the 8-byte header. */
function riffEnd(data: Uint8Array): number | null {
  if (data.length < 8) return null;
  const size = data[4]! | (data[5]! << 8) | (data[6]! << 16) | (data[7]! << 24);
  if (size <= 0) return null;
  return 8 + size;
}

// ───────────────────────── byte helpers ─────────────────────────

function startsWith(data: Uint8Array, magic: readonly number[]): boolean {
  return startsWithAt(data, magic, 0);
}

function startsWithAt(data: Uint8Array, magic: readonly number[], at: number): boolean {
  if (at + magic.length > data.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (data[at + i] !== magic[i]) return false;
  return true;
}

function indexOfMagic(data: Uint8Array, magic: readonly number[]): number {
  for (let i = 0; i + magic.length <= data.length; i += 1) {
    if (startsWithAt(data, magic, i)) return i;
  }
  return -1;
}
