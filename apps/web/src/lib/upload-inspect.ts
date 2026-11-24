/**
 * THE APP'S OWN FILE CHECKS, as one pure verdict (part 6 of the security
 * tools). Bytes in, a verdict out: the kind the bytes really are among the
 * kinds the caller accepts, and whether what they are is safe to take.
 *
 * Nothing here records, removes or answers anyone: server/security/
 * upload-checks.ts wraps this with the security record and the plain sentence,
 * and every upload path calls that module. Like the sniffers this composes
 * (image-signature.ts, file-signature.ts), it reads ONLY bytes: no file name,
 * no declared type except a declared MIME a caller asks to have compared.
 *
 * What it adds to the sniffers and the scanner (document-threat-scan.ts):
 *   - video containers by their signature (MP4, QuickTime, WebM), never their
 *     contents: nothing here decodes a frame;
 *   - Word and Excel files (.docx, .xlsx) as ZIP containers: the file must
 *     start as a ZIP, its central directory must list the parts of the kind
 *     it claims to be, and it is refused when it lists a macro part (or its
 *     content types declare one). The parts are never inflated, except the
 *     small content-types part, bounded;
 *   - text (CSV, TXT): no NUL byte and no control character a text file does
 *     not hold, and not a PDF in disguise.
 *
 * NOT AN ANTIVIRUS: it holds no list of known viruses. It reads what kind of
 * file this is and how it is built.
 */
import { inflateRawSync } from 'node:zlib';

import { scanDocumentBytes, type DocumentThreatCode } from './document-threat-scan';
import { MIME_FOR_KIND, sniffImage, type SniffedImage } from './image-signature';

export type UploadImageKind = SniffedImage['kind'];
export type UploadVideoKind = 'mp4' | 'quicktime' | 'webm';
export type UploadOfficeKind = 'docx' | 'xlsx';
export type UploadKind = UploadImageKind | 'pdf' | UploadVideoKind | UploadOfficeKind | 'text';

export const UPLOAD_IMAGE_KINDS: readonly UploadImageKind[] = ['png', 'jpeg', 'webp', 'avif', 'heic'];

/** The MIME each kind is stored and named as. */
export const MIME_FOR_UPLOAD_KIND: Readonly<Record<UploadKind, string>> = {
  ...MIME_FOR_KIND,
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  quicktime: 'video/quicktime',
  webm: 'video/webm',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  text: 'text/plain',
};

/** The kinds of verdict a refusal can be. Each has one reason code in the record. */
export type UploadRefusalFamily = 'wrong_type' | 'active_content' | 'hidden_file' | 'could_not_check';

/** Why, in one word the caller can test; never shown to anyone. */
export type UploadRefusalCode =
  | DocumentThreatCode
  | 'not_accepted_kind'
  | 'not_declared_kind'
  | 'office_macro'
  | 'office_wrong_parts'
  | 'office_unreadable'
  | 'not_text';

export type UploadInspection =
  | {
      ok: true;
      kind: UploadKind;
      mime: string;
      /** From the image sniffer; null for every other kind and for WebP, AVIF and HEIC. */
      width: number | null;
      height: number | null;
    }
  | { ok: false; family: UploadRefusalFamily; code: UploadRefusalCode };

export interface UploadInspectOptions {
  /** The kinds this path takes. The bytes must be one of them. */
  accept: readonly UploadKind[];
  /** When given, the bytes' MIME must be this one (a client's declared type the path already pins). */
  declaredMime?: string;
  /**
   * Where a PDF's header may sit: at the start (the default, the polyglot
   * defence of file-signature.ts) or anywhere in the first kilobyte (the PO
   * import's long-standing rule: that file is parsed and never served).
   */
  pdfHeader?: 'at_start' | 'in_first_kilobyte';
}

/** Which family each of the scanner's verdicts belongs to. */
export const FAMILY_OF_THREAT: Readonly<Record<DocumentThreatCode, UploadRefusalFamily>> = {
  pdf_javascript: 'active_content',
  pdf_launch_action: 'active_content',
  pdf_rich_media: 'active_content',
  pdf_embedded_file: 'hidden_file',
  appended_payload: 'hidden_file',
  pdf_encrypted: 'could_not_check',
  pdf_scan_limit: 'could_not_check',
  scan_budget: 'could_not_check',
};

const refuse = (family: UploadRefusalFamily, code: UploadRefusalCode): UploadInspection => ({
  ok: false,
  family,
  code,
});

// ───────────────────────── which kind the bytes are ─────────────────────────

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function startsWithAt(data: Uint8Array, magic: readonly number[], at: number): boolean {
  if (at < 0 || at + magic.length > data.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (data[at + i] !== magic[i]) return false;
  return true;
}

function hasPdfHeader(data: Uint8Array, where: 'at_start' | 'in_first_kilobyte'): boolean {
  if (where === 'at_start') return startsWithAt(data, PDF_MAGIC, 0);
  const window = Math.min(data.length, 1024);
  for (let i = 0; i + PDF_MAGIC.length <= window; i += 1) {
    if (startsWithAt(data, PDF_MAGIC, i)) return true;
  }
  return false;
}

/** Four bytes as ASCII, or null when any is not printable. */
function fourCc(data: Uint8Array, at: number): string | null {
  if (at + 4 > data.length) return null;
  let out = '';
  for (let i = at; i < at + 4; i += 1) {
    const b = data[i]!;
    if (b < 0x20 || b > 0x7e) return null;
    out += String.fromCharCode(b);
  }
  return out;
}

const BE32 = (data: Uint8Array, at: number): number =>
  ((data[at]! << 24) >>> 0) + (data[at + 1]! << 16) + (data[at + 2]! << 8) + data[at + 3]!;

/**
 * ISO-BMFF brands of a video (the major brand at 8, the compatible brands
 * from 16 to the end of the ftyp box). QuickTime's own brand is `qt  `.
 */
const MP4_BRANDS: ReadonlySet<string> = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'mp71', 'avc1', 'hvc1', 'hev1', 'av01', 'M4V ', 'M4VP', 'M4VH',
  'dash', 'msnv', 'ndas', 'f4v ', 'mmp4', '3gp4', '3gp5', '3gp6', '3gp7', '3g2a', '3g2b',
]);
const QUICKTIME_BRAND = 'qt  ';
/** The first atom of a QuickTime movie written before ftyp was usual. */
const QUICKTIME_FIRST_ATOMS: ReadonlySet<string> = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/**
 * A video's container from its leading bytes: MP4, QuickTime or WebM, or
 * null. Only the signature is read (a few dozen bytes); nothing decodes a
 * frame, so this says what the container is, never what it carries.
 */
export function sniffVideoContainer(data: Uint8Array): UploadVideoKind | null {
  if (data.length >= 12 && fourCc(data, 4) === 'ftyp') {
    const boxSize = BE32(data, 0);
    if (boxSize < 16) return null;
    const brands: string[] = [];
    const major = fourCc(data, 8);
    if (major) brands.push(major);
    const end = Math.min(boxSize, data.length, 4096);
    for (let at = 16; at + 4 <= end; at += 4) {
      const b = fourCc(data, at);
      if (b) brands.push(b);
    }
    // QuickTime by its major brand; an MP4 may list qt among its compatible ones.
    if (major === QUICKTIME_BRAND) return 'quicktime';
    if (brands.some((b) => MP4_BRANDS.has(b))) return 'mp4';
    if (brands.includes(QUICKTIME_BRAND)) return 'quicktime';
    return null;
  }
  if (data.length >= 8) {
    const atom = fourCc(data, 4);
    const size = BE32(data, 0);
    // A size of 1 says a 64-bit size follows; 8 or more is an ordinary atom.
    if (atom && QUICKTIME_FIRST_ATOMS.has(atom) && (size === 1 || size >= 8)) return 'quicktime';
  }
  // EBML header, then a DocType element (0x42 0x82) of "webm" within it.
  if (startsWithAt(data, [0x1a, 0x45, 0xdf, 0xa3], 0)) {
    const window = Math.min(data.length, 64);
    for (let i = 4; i + 7 <= window; i += 1) {
      if (data[i] === 0x42 && data[i + 1] === 0x82) {
        const len = data[i + 2]! & 0x7f; // a one-byte EBML size (0x84 is 4)
        if ((data[i + 2]! & 0x80) !== 0 && len === 4 && fourCc(data, i + 3) === 'webm') return 'webm';
        return null;
      }
    }
  }
  return null;
}

// ───────────────────────── text ─────────────────────────

/**
 * Whether the bytes read as a text file (CSV, TXT): no NUL byte, no control
 * character other than tab, line feed, the two old page breaks, carriage
 * return and the end-of-file mark some old programs add, and not a PDF in
 * disguise. Any encoding of text passes (UTF-8, or the single-byte code pages
 * spreadsheet programs still write), because the parsers read it as they
 * always did; what is refused is a binary file named .csv.
 */
export function looksLikeText(data: Uint8Array): boolean {
  if (startsWithAt(data, PDF_MAGIC, 0)) return false;
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i]!;
    if (b >= 0x20) continue;
    // \t \n \v \f \r and SUB (0x1a)
    if (b === 0x09 || b === 0x0a || b === 0x0b || b === 0x0c || b === 0x0d || b === 0x1a) continue;
    return false;
  }
  return true;
}

// ───────────────────────── Word and Excel (ZIP containers) ─────────────────────────

/** The most parts a Word or Excel file may list before it is not checked. */
export const MAX_OFFICE_PARTS = 5000;
/** The content-types part is inflated to at most this much. */
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;

const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_CENTRAL = [0x50, 0x4b, 0x01, 0x02];
const ZIP_END = [0x50, 0x4b, 0x05, 0x06];

const LE16 = (d: Uint8Array, at: number): number => d[at]! | (d[at + 1]! << 8);
const LE32 = (d: Uint8Array, at: number): number =>
  (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24)) >>> 0;

/** The part each kind's container must list. */
const OFFICE_MAIN_PART: Readonly<Record<UploadOfficeKind, string>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
};

/**
 * A part that carries code or a control that can run it: a VBA project and
 * its signature or data, an ActiveX control, an Excel 4 macro sheet or an
 * old dialog sheet. Matched on the part's name, lower-cased.
 */
function isMacroPart(name: string): boolean {
  return (
    name.endsWith('vbaproject.bin') ||
    name.endsWith('vbaprojectsignature.bin') ||
    name.endsWith('vbadata.xml') ||
    name.includes('/activex/') ||
    name.startsWith('xl/macrosheets/') ||
    name.startsWith('xl/dialogsheets/')
  );
}

/** The content types a part that carries code is declared under. */
const MACRO_CONTENT_TYPE = /vbaProject|macroEnabled|activeX|macrosheet|dialogsheet|vbaData/i;

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  localOffset: number;
}

type ZipRead = { ok: true; entries: ZipEntry[] } | { ok: false; family: UploadRefusalFamily };

/**
 * The central directory of a ZIP, as its readers see it (they locate it from
 * the end record). Refused as the wrong kind when the file does not start as
 * a ZIP or its records do not hold together; not checked (could_not_check)
 * when it is a ZIP64, lists more parts than MAX_OFFICE_PARTS, or encrypts a
 * part.
 */
function readZipDirectory(data: Uint8Array): ZipRead {
  if (!startsWithAt(data, ZIP_LOCAL, 0)) return { ok: false, family: 'wrong_type' };
  // The end record is 22 bytes plus a comment of up to 65535; it is the one
  // whose comment runs exactly to the end of the file.
  let end = -1;
  const lowest = Math.max(0, data.length - 22 - 0xffff);
  for (let at = data.length - 22; at >= lowest; at -= 1) {
    if (startsWithAt(data, ZIP_END, at) && at + 22 + LE16(data, at + 20) === data.length) {
      end = at;
      break;
    }
  }
  if (end === -1) return { ok: false, family: 'wrong_type' };
  const disk = LE16(data, end + 4);
  const cdDisk = LE16(data, end + 6);
  const onDisk = LE16(data, end + 8);
  const total = LE16(data, end + 10);
  const cdSize = LE32(data, end + 12);
  const cdOffset = LE32(data, end + 16);
  if (onDisk === 0xffff || total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, family: 'could_not_check' };
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) return { ok: false, family: 'wrong_type' };
  if (total > MAX_OFFICE_PARTS) return { ok: false, family: 'could_not_check' };
  if (cdOffset + cdSize > end) return { ok: false, family: 'wrong_type' };
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (at + 46 > end || !startsWithAt(data, ZIP_CENTRAL, at)) return { ok: false, family: 'wrong_type' };
    const flags = LE16(data, at + 8);
    const method = LE16(data, at + 10);
    const compressedSize = LE32(data, at + 20);
    const nameLength = LE16(data, at + 28);
    const extraLength = LE16(data, at + 30);
    const commentLength = LE16(data, at + 32);
    const localOffset = LE32(data, at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) return { ok: false, family: 'wrong_type' };
    const name = Buffer.from(data.subarray(at + 46, at + 46 + nameLength)).toString('utf8');
    if ((flags & 0x1) !== 0) return { ok: false, family: 'could_not_check' };
    entries.push({ name, method, flags, compressedSize, localOffset });
    at = next;
  }
  return { ok: true, entries };
}

/** The content-types part's text, inflated with a ceiling; null when it cannot be read. */
function contentTypesText(data: Uint8Array, entry: ZipEntry): string | null {
  const at = entry.localOffset;
  if (at + 30 > data.length || !startsWithAt(data, ZIP_LOCAL, at)) return null;
  const start = at + 30 + LE16(data, at + 26) + LE16(data, at + 28);
  const stop = start + entry.compressedSize;
  if (stop > data.length) return null;
  const raw = data.subarray(start, stop);
  try {
    if (entry.method === 0) {
      return raw.byteLength > MAX_CONTENT_TYPES_BYTES ? null : Buffer.from(raw).toString('latin1');
    }
    if (entry.method === 8) {
      return inflateRawSync(Buffer.from(raw), { maxOutputLength: MAX_CONTENT_TYPES_BYTES }).toString(
        'latin1',
      );
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A Word or Excel file: a ZIP whose central directory lists the main part of
 * the kind it claims (and the content-types part), with no macro part, and
 * whose content types declare none.
 */
export function inspectOfficeContainer(
  data: Uint8Array,
  kind: UploadOfficeKind,
): { ok: true } | { ok: false; family: UploadRefusalFamily; code: UploadRefusalCode } {
  const zip = readZipDirectory(data);
  if (!zip.ok) {
    return {
      ok: false,
      family: zip.family,
      code: zip.family === 'wrong_type' ? 'not_declared_kind' : 'office_unreadable',
    };
  }
  const names = zip.entries.map((e) => e.name.toLowerCase());
  if (names.some(isMacroPart)) return { ok: false, family: 'active_content', code: 'office_macro' };
  const types = zip.entries.find((e) => e.name === '[Content_Types].xml');
  if (!types || !names.includes(OFFICE_MAIN_PART[kind])) {
    return { ok: false, family: 'wrong_type', code: 'office_wrong_parts' };
  }
  const declared = contentTypesText(data, types);
  if (declared === null) return { ok: false, family: 'could_not_check', code: 'office_unreadable' };
  if (MACRO_CONTENT_TYPE.test(declared)) {
    return { ok: false, family: 'active_content', code: 'office_macro' };
  }
  return { ok: true };
}

// ───────────────────────── the verdict ─────────────────────────

function kindOf(
  data: Uint8Array,
  accept: readonly UploadKind[],
  pdfHeader: 'at_start' | 'in_first_kilobyte',
): { kind: UploadKind; width: number | null; height: number | null } | null {
  const takes = (k: UploadKind) => accept.includes(k);
  if (takes('pdf') && hasPdfHeader(data, pdfHeader)) return { kind: 'pdf', width: null, height: null };
  if (UPLOAD_IMAGE_KINDS.some(takes)) {
    const img = sniffImage(data);
    if (img && takes(img.kind)) return { kind: img.kind, width: img.width, height: img.height };
  }
  if (takes('mp4') || takes('quicktime') || takes('webm')) {
    const video = sniffVideoContainer(data);
    if (video && takes(video)) return { kind: video, width: null, height: null };
  }
  if (takes('docx') && startsWithAt(data, ZIP_LOCAL, 0)) return { kind: 'docx', width: null, height: null };
  if (takes('xlsx') && startsWithAt(data, ZIP_LOCAL, 0)) return { kind: 'xlsx', width: null, height: null };
  if (takes('text') && looksLikeText(data)) return { kind: 'text', width: null, height: null };
  return null;
}

/**
 * The kind of a file's LEADING bytes, for the cheap first look a finalize
 * takes before it reads an object whole: images (as lib/storage-object-prefix
 * hands them over, widened when a JPEG needs it), PDF and video containers.
 * A kind decided only by the whole file (text, Word, Excel) is never answered
 * here.
 */
export function inspectUploadPrefix(
  prefix: Uint8Array,
  options: UploadInspectOptions,
): UploadInspection {
  const prefixKinds = options.accept.filter((k) => k !== 'text' && k !== 'docx' && k !== 'xlsx');
  const found = kindOf(prefix, prefixKinds, options.pdfHeader ?? 'at_start');
  if (!found) return refuse('wrong_type', 'not_accepted_kind');
  const mime = MIME_FOR_UPLOAD_KIND[found.kind];
  if (options.declaredMime !== undefined && options.declaredMime !== mime) {
    return refuse('wrong_type', 'not_declared_kind');
  }
  return { ok: true, kind: found.kind, mime, width: found.width, height: found.height };
}

/**
 * The verdict on a WHOLE file: its kind from its bytes (one of `accept`, and
 * the declared MIME when one is given), then the check that kind has:
 *   - PDF and images: the scanner (active content, a hidden file, a file it
 *     could not finish within its budgets);
 *   - Word and Excel: the container check above;
 *   - video: the container's signature only;
 *   - text: the text rule only.
 * Never throws: a check that fails in a way nobody wrote for is "could not be
 * checked", which callers refuse.
 */
export function inspectUpload(data: Uint8Array, options: UploadInspectOptions): UploadInspection {
  try {
    const found = kindOf(data, options.accept, options.pdfHeader ?? 'at_start');
    if (!found) {
      return refuse('wrong_type', options.accept.includes('text') ? 'not_text' : 'not_accepted_kind');
    }
    const mime = MIME_FOR_UPLOAD_KIND[found.kind];
    if (options.declaredMime !== undefined && options.declaredMime !== mime) {
      return refuse('wrong_type', 'not_declared_kind');
    }
    if (found.kind === 'pdf' || (UPLOAD_IMAGE_KINDS as readonly string[]).includes(found.kind)) {
      const threat = scanDocumentBytes(data, found.kind as 'pdf' | UploadImageKind);
      if (threat) return refuse(FAMILY_OF_THREAT[threat.code], threat.code);
    } else if (found.kind === 'docx' || found.kind === 'xlsx') {
      const office = inspectOfficeContainer(data, found.kind);
      if (!office.ok) return refuse(office.family, office.code);
    }
    return { ok: true, kind: found.kind, mime, width: found.width, height: found.height };
  } catch {
    return refuse('could_not_check', 'scan_budget');
  }
}
