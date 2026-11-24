import { expect, type Mock } from 'vitest';

/**
 * Tiny made-up files for the upload-check tests (security tools part 6,
 * stage 6a), built here from their bytes. The repository is public: none of
 * these is a real file, a real piece of malware, or any antivirus product's
 * test string. Each is just enough structure for the app's own checks to
 * read it as what it claims to be, or to refuse it for one stated reason.
 */

export const ascii = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A copy whose buffer is exactly its bytes (what a Blob or a body hands over). */
export const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A PNG: signature, an IHDR of the given size, and IEND. No pixels. */
export function tinyPng(width = 2, height = 3): Uint8Array {
  const ihdr = new Uint8Array(25);
  ihdr.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  new DataView(ihdr.buffer).setUint32(8, width);
  new DataView(ihdr.buffer).setUint32(12, height);
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Uint8Array.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  );
}

/** A JPEG: start, one frame header of the given size, end. No pixels. */
export function tinyJpeg(width = 4, height = 5): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff, 0x01, 0x00, 0xff, 0xd9,
  ]);
}

/** The first bytes of an archive, after the end of a picture. */
export const withArchiveAfter = (image: Uint8Array): Uint8Array =>
  concat(image, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));

export const TINY_PNG = tinyPng();
export const TINY_JPEG = tinyJpeg();
export const PNG_WITH_ARCHIVE = withArchiveAfter(TINY_PNG);
export const JPEG_WITH_ARCHIVE = withArchiveAfter(TINY_JPEG);

export const TINY_PDF = ascii('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n');
/** A PDF that names a script action (no script). */
export const PDF_WITH_SCRIPT = ascii('%PDF-1.7\n1 0 obj\n<< /S /JavaScript >>\nendobj\n%%EOF\n');
/** A PDF that says it is locked (nothing is locked). */
export const PDF_LOCKED = ascii('%PDF-1.7\ntrailer << /Encrypt 5 0 R >>\n%%EOF\n');

/** A web page, which no upload path takes. */
export const HTML_PAGE = ascii('<!DOCTYPE html><p>not a picture</p>');

/** An MP4's first box, then the start of a movie box. */
export const TINY_MP4 = concat(
  Uint8Array.from([0, 0, 0, 0x18]),
  ascii('ftypisom'),
  Uint8Array.from([0, 0, 2, 0]),
  ascii('isommp41'),
  Uint8Array.from([0, 0, 0, 8]),
  ascii('moov'),
);
/** A QuickTime file's first box (major brand qt). */
export const TINY_QUICKTIME = concat(
  Uint8Array.from([0, 0, 0, 0x14]),
  ascii('ftypqt  '),
  Uint8Array.from([0, 0, 2, 0]),
  ascii('qt  '),
);
/** A WebM's EBML header naming its kind. */
export const TINY_WEBM = concat(
  Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]),
  ascii('webm'),
);

/**
 * The one refusal a path recorded, checked the way every path's test checks
 * it: exactly one call, exactly the five fields of the record, malware and
 * blocked, the family's reason, the organization, and none of the given
 * strings (the file's name, its path) anywhere in what was recorded.
 */
export function expectOneRefusal(
  record: Mock,
  expected: { reason: string; organizationId: string | null; source?: 'web' | 'phone' },
  mustNotContain: readonly string[] = [],
): void {
  expect(record).toHaveBeenCalledTimes(1);
  const [event] = record.mock.calls[0]! as [Record<string, unknown>];
  expect(event).toEqual({
    category: 'malware',
    outcome: 'blocked',
    reason: expected.reason,
    source: expected.source ?? 'web',
    organizationId: expected.organizationId,
  });
  const recorded = JSON.stringify(record.mock.calls[0]);
  for (const s of mustNotContain) expect(recorded).not.toContain(s);
}
