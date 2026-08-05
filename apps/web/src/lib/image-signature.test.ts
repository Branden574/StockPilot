import { describe, expect, it } from 'vitest';

import { MIME_FOR_KIND, sniffImage } from './image-signature';

/** Minimal real headers, from the format specs — no binary fixture files;
 *  every byte here is a literal from the PNG/JPEG/RIFF specs (task hygiene:
 *  no typed \uXXXX escapes, no external fixtures). */
function pngBytes(width = 2, height = 3): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // signature
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // IHDR len+tag
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpegBytes(width = 4, height = 5): Uint8Array {
  // SOI + one SOF0 segment carrying the dimensions.
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff,
    width & 0xff, 0x01, 0x00,
  ]);
}
function webpBytes(): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46]); // 'RIFF'
  b.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  return b;
}

describe('sniffImage', () => {
  it('identifies PNG with dimensions', () => {
    expect(sniffImage(pngBytes(2, 3))).toEqual({ kind: 'png', width: 2, height: 3 });
  });

  it('identifies JPEG with dimensions', () => {
    expect(sniffImage(jpegBytes(4, 5))).toEqual({ kind: 'jpeg', width: 4, height: 5 });
  });

  it('identifies WEBP (dimensions null — RIFF header only)', () => {
    expect(sniffImage(webpBytes())).toEqual({ kind: 'webp', width: null, height: null });
  });

  it('REJECTS fake MIME: an EXE/script/HTML body is null regardless of declared type (photo test 6)', () => {
    // 'MZ' DOS/PE header — a renamed .exe declaring image/png.
    expect(sniffImage(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]))).toBeNull();
    // A text/HTML body declaring an image MIME.
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
    // An empty (never-uploaded / zero-byte) object.
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });

  it('BYTES WIN: a genuine JPEG is sniffed as jpeg no matter what filename or declared MIME a caller pairs it with — sniffImage takes only bytes, never a name or a Content-Type', () => {
    // Same bytes a caller might upload as "photo.png" with declaredMime
    // 'image/png' (a renamed file, or a lying client). The pure sniffer has
    // no filename/MIME parameter to be fooled by — it reads magic bytes only.
    const renamed = jpegBytes(10, 20);
    expect(sniffImage(renamed)).toEqual({ kind: 'jpeg', width: 10, height: 20 });
  });

  it('maps kinds to the exact bucket MIME pins', () => {
    expect(MIME_FOR_KIND).toEqual({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });
    // Literal-pin each value individually too (test-tautology rule — never
    // rely solely on a structural comparison against the same object shape).
    expect(MIME_FOR_KIND.png).toBe('image/png');
    expect(MIME_FOR_KIND.jpeg).toBe('image/jpeg');
    expect(MIME_FOR_KIND.webp).toBe('image/webp');
  });

  it('a truncated PNG (too short to contain IHDR dimensions) is rejected, not crashed on', () => {
    const tooShort = pngBytes().slice(0, 20);
    expect(sniffImage(tooShort)).toBeNull();
  });

  it('a truncated JPEG (SOI only, no segments) is rejected', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('a JPEG whose marker chain never reaches a SOF segment is rejected, not classified as jpeg with null dimensions — deviation from the brief sketch (which fell through to {kind:"jpeg",width:null,height:null}): a fully-downloaded object with SOI but no SOF anywhere in it is malformed/adversarial, not a real photo missing a few trailing bytes, so this sniffer refuses to classify it rather than let a crafted SOI-prefixed blob pass as "jpeg"', () => {
    // SOI + one APP0 segment (length 4, i.e. 2 body bytes) and nothing after —
    // no SOF marker anywhere in the buffer.
    const noSof = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    expect(sniffImage(noSof)).toBeNull();
  });
});
