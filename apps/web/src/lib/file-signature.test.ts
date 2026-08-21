import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_BUCKET_MIME_ALLOWLISTS,
  fileSniffNeedsMoreBytes,
  isSniffedFileAllowedInBucket,
  sniffFile,
  type DocumentBucket,
} from './file-signature';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

const PDF = ascii('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj');

// Fixture shapes mirror image-signature.test.ts: sniffImage parses DIMENSIONS,
// so a header alone is not a recognisable image. Hand-waving the body here
// would have made the delegation tests pass for the wrong reason — or, as it
// did on the first run, fail for a reason that has nothing to do with this
// module.
function pngBytes(width = 2, height = 3): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpegBytes(width = 4, height = 5): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff, 0x01, 0x00,
  ]);
}
function webpBytes(): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46]);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  return b;
}
const PNG = pngBytes();
const JPEG = jpegBytes();

describe('sniffFile', () => {
  it('recognises a PDF by its header', () => {
    expect(sniffFile(PDF)).toEqual({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('still recognises the image formats, by delegating', () => {
    // The point of composing rather than reimplementing: the image path keeps
    // one definition. If this drifts, two modules disagree about the same bytes.
    expect(sniffFile(PNG)?.mime).toBe('image/png');
    expect(sniffFile(JPEG)?.mime).toBe('image/jpeg');
  });

  it('returns null for bytes it does not recognise', () => {
    expect(sniffFile(ascii('<!DOCTYPE html><script>alert(1)</script>'))).toBeNull();
    expect(sniffFile(ascii('<svg onload="alert(1)"/>'))).toBeNull();
    expect(sniffFile(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull(); // MZ — a PE binary
  });

  it('REJECTS an HTML/PDF polyglot — this is why the header must sit at offset 0', () => {
    // A file that is simultaneously valid HTML and (leniently) valid PDF: a
    // reader that scans the first 1024 bytes for %PDF- accepts it, and a
    // browser renders the HTML half from our own storage origin. Matching at
    // offset 0 removes the whole class.
    const polyglot = ascii('<html><script>alert(1)</script></html>\n%PDF-1.7\n');
    expect(sniffFile(polyglot)).toBeNull();
  });

  it('rejects a near-miss header rather than guessing', () => {
    expect(sniffFile(ascii('%PDF'))).toBeNull(); // no trailing hyphen
    expect(sniffFile(ascii(' %PDF-1.7'))).toBeNull(); // one byte of leading junk
    expect(sniffFile(bytes(0x25, 0x50))).toBeNull(); // truncated
  });

  it('handles an empty buffer without throwing', () => {
    expect(sniffFile(new Uint8Array())).toBeNull();
  });
});

describe('fileSniffNeedsMoreBytes', () => {
  it('never widens for a PDF — five bytes decide it', () => {
    expect(fileSniffNeedsMoreBytes(PDF)).toBe(false);
  });
});

describe('isSniffedFileAllowedInBucket', () => {
  it('accepts a PDF into the attachment buckets', () => {
    const pdf = sniffFile(PDF)!;
    expect(isSniffedFileAllowedInBucket(pdf, 'po-attachments')).toBe(true);
    expect(isSniffedFileAllowedInBucket(pdf, 'order-attachments')).toBe(true);
  });

  it('REFUSES a PDF into support-attachments — screenshots only', () => {
    // The reason callers pass their bucket instead of checking `!== null`:
    // "known format" is weaker than "format THIS bucket holds".
    expect(isSniffedFileAllowedInBucket(sniffFile(PDF)!, 'support-attachments')).toBe(false);
  });

  it('accepts a PNG everywhere', () => {
    const png = sniffFile(PNG)!;
    for (const b of Object.keys(DOCUMENT_BUCKET_MIME_ALLOWLISTS) as DocumentBucket[]) {
      expect(isSniffedFileAllowedInBucket(png, b)).toBe(true);
    }
  });
});

describe('DOCUMENT_BUCKET_MIME_ALLOWLISTS', () => {
  it('never lists a mime the sniffer cannot actually produce', () => {
    // THE INVARIANT THAT KEEPS THE GUARD SAFE. A bucket listing a format
    // `sniffFile` cannot detect means every legitimate upload of it sniffs as
    // null and gets DELETED by the verify-or-delete caller. Adding a mime here
    // without teaching the sniffer to detect it must fail the build.
    const producible = new Set(
      [PDF, PNG, JPEG, webpBytes()]
        .map((b) => sniffFile(b))
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .map((v) => v.mime)
        // heic has no compact hand-built fixture here; image-signature.test.ts
        // owns its byte-level proof, so it is asserted producible there.
        .concat(['image/heic']),
    );
    for (const [bucket, mimes] of Object.entries(DOCUMENT_BUCKET_MIME_ALLOWLISTS)) {
      for (const m of mimes) {
        expect(producible.has(m), `${bucket} lists ${m}, which sniffFile cannot report`).toBe(true);
      }
    }
  });
});
