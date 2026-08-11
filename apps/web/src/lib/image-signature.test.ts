import { describe, expect, it } from 'vitest';

import {
  isSniffedKindAllowedInBucket,
  MIME_FOR_KIND,
  SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS,
  sniffImage,
  sniffNeedsMoreBytes,
  type SniffedImage,
} from './image-signature';

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
/** A camera-original-shaped JPEG: SOI, then a single APP1 (EXIF) segment
 *  whose body is `metaBytes` long — real cameras put a 5-20 KB embedded
 *  thumbnail there, and multi-segment ICC profiles push further still — then
 *  the same SOF0 segment jpegBytes() uses. The SOF marker (and with it the
 *  whole verdict) sits at byte 6 + metaBytes, i.e. deliberately BEYOND a
 *  4096-byte leading window for the default metaBytes. */
function exifHeavyJpegBytes(metaBytes = 12 * 1024, width = 4, height = 5): Uint8Array {
  const app1Len = metaBytes + 2; // the length field counts itself, not the marker
  const sof = [
    0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff,
    width & 0xff, 0x01, 0x00,
  ];
  const b = new Uint8Array(6 + metaBytes + sof.length);
  b.set([0xff, 0xd8, 0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff]);
  b.fill(0x45, 6, 6 + metaBytes); // APP1 body filler (never 0xFF — no fake markers)
  b.set(sof, 6 + metaBytes);
  return b;
}

/**
 * An ISO-BMFF `ftyp` box, from ISO/IEC 14496-12: 4-byte box size, 'ftyp',
 * 4-byte major brand, 4-byte minor version, then zero or more compatible
 * brands. This is the container AVIF and HEIC both use — and so do MP4 and
 * QuickTime, which is the whole reason the brand has to be read.
 */
function isoBmffBytes(major: string, compatible: string[] = []): Uint8Array {
  const boxSize = 16 + compatible.length * 4;
  const b = new Uint8Array(boxSize);
  new DataView(b.buffer).setUint32(0, boxSize);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  b.set(ascii('ftyp'), 4);
  b.set(ascii(major), 8);
  b.set([0x00, 0x00, 0x00, 0x00], 12); // minor version
  compatible.forEach((brand, i) => b.set(ascii(brand), 16 + i * 4));
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
    expect(MIME_FOR_KIND).toEqual({
      png: 'image/png',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      avif: 'image/avif',
      heic: 'image/heic',
    });
    // Literal-pin each value individually too (test-tautology rule — never
    // rely solely on a structural comparison against the same object shape).
    expect(MIME_FOR_KIND.png).toBe('image/png');
    expect(MIME_FOR_KIND.jpeg).toBe('image/jpeg');
    expect(MIME_FOR_KIND.webp).toBe('image/webp');
    expect(MIME_FOR_KIND.avif).toBe('image/avif');
    expect(MIME_FOR_KIND.heic).toBe('image/heic');
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

  it('MUTATION GUARD (r6) — a RIFF file that is NOT WEBP (a real RIFF/WAVE prefix) is rejected: all four fourcc bytes must match, not just the outer RIFF wrapper', () => {
    // A real RIFF/WAVE header shape: 'RIFF' + size + 'WAVE' (the audio
    // container that shares WEBP's outer RIFF wrapper). A sniffer that
    // dropped the fourcc check (kept only the 'RIFF' bytes) would wrongly
    // accept this as WEBP.
    const riffWave = new Uint8Array(16);
    riffWave.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    riffWave.set([0x24, 0x00, 0x00, 0x00], 4); // chunk size (arbitrary, real-shaped)
    riffWave.set([0x57, 0x41, 0x56, 0x45], 8); // 'WAVE' — NOT 'WEBP'
    expect(sniffImage(riffWave)).toBeNull();
  });

  it('MUTATION GUARD (r11) — a body sharing only the first TWO PNG signature bytes (\\x89P) is rejected: the full 8-byte signature must match, not a truncated prefix', () => {
    // Bytes 0-1 match the start of the PNG signature; nothing after does —
    // bytes 2-7 are garbage, NOT the real 0x4e470d0a1a0a tail. Width/height
    // are set to real, valid values (2, 3) at the normal IHDR offsets so
    // this fixture is rejected ONLY by the signature check, never by the
    // (unrelated) dimension-range guard — a mutant that checked just these
    // first two bytes would otherwise still classify this as a valid PNG.
    const twoByteMagic = pngBytes(2, 3);
    twoByteMagic.set([0x89, 0x50, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
    expect(sniffImage(twoByteMagic)).toBeNull();
  });

  it('MUTATION GUARD (r11 extended) — a body sharing only the first FOUR PNG signature bytes (bytes 0-3 match, bytes 4-7 are garbage) is rejected: the full 8-byte signature must match, not a 4-byte prefix', () => {
    // Bytes 0-3 match the start of the PNG signature (0x89 0x50 0x4E 0x47);
    // bytes 4-7 are garbage (0x00 0x00 0x00 0x00), NOT the real 0x0d 0x0a
    // 0x1a 0x0a tail. IHDR chunk tag is intact at 12-15, and dimensions are
    // valid (2, 3) — so this fixture is rejected ONLY by the signature check
    // (bytes 4-7), never by the unrelated IHDR-tag or dimension guards. A
    // mutant that checked only the first 4 bytes (shortening the signature
    // requirement) would wrongly accept this as a valid PNG.
    const fourByteMagic = pngBytes(2, 3);
    fourByteMagic.set([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00], 0);
    expect(sniffImage(fourByteMagic)).toBeNull();
  });

  it('a body with the correct 8-byte PNG signature but a non-IHDR (or garbage) first chunk tag is rejected', () => {
    const wrongChunk = pngBytes(2, 3);
    // Overwrite the IHDR tag at bytes 12-15 with garbage, signature intact.
    wrongChunk.set([0xde, 0xad, 0xbe, 0xef], 12);
    expect(sniffImage(wrongChunk)).toBeNull();
  });

  it('Important 6 — a PNG reporting a dimension outside the 1..2147483647 int4 range is rejected, not passed through (a corrupted/adversarial IHDR reporting 4294967295 would otherwise overflow the `width`/`height` integer columns at INSERT and surface as a raw 500)', () => {
    const huge = pngBytes(2, 3);
    new DataView(huge.buffer).setUint32(16, 0xffffffff); // width = 4294967295
    expect(sniffImage(huge)).toBeNull();
  });

  it('a PNG reporting a zero dimension is rejected', () => {
    const zeroWidth = pngBytes(0, 3);
    expect(sniffImage(zeroWidth)).toBeNull();
  });

  it('a JPEG SOF segment reporting a zero dimension is rejected (Minor 8 — consistent with the PNG/overflow rejection, not passed through with null dims)', () => {
    const zeroDim = jpegBytes(0, 5);
    expect(sniffImage(zeroDim)).toBeNull();
  });

  it('identifies AVIF by its ISO-BMFF major brand (dimensions null — ispe lives in a nested box tree this deliberately does not walk)', () => {
    expect(sniffImage(isoBmffBytes('avif'))).toEqual({ kind: 'avif', width: null, height: null });
    // 'avis' is the image-sequence brand and is equally an AVIF.
    expect(sniffImage(isoBmffBytes('avis'))).toEqual({ kind: 'avif', width: null, height: null });
  });

  it('identifies AVIF from the COMPATIBLE-brand list when the major brand is the generic HEIF `mif1` — and classifies it as avif, not heic, because AVIF wins the ordering', () => {
    // Real files from some pipelines carry major brand 'mif1' with 'avif' only
    // in the compatible list. Sniffing that as HEIC would hand the caller
    // 'image/heic', which then mismatches a truthful `image/avif` declaration
    // and gets a legitimate upload DELETED by a verify-or-delete guard.
    const bytes = isoBmffBytes('mif1', ['avif', 'mif1', 'miaf']);
    expect(sniffImage(bytes)).toEqual({ kind: 'avif', width: null, height: null });
  });

  it('identifies HEIC across every brand iOS and HEIF encoders emit', () => {
    for (const brand of ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']) {
      expect(sniffImage(isoBmffBytes(brand))).toEqual({
        kind: 'heic',
        width: null,
        height: null,
      });
    }
  });

  it('SECURITY: an ISO-BMFF file that is NOT an image — an MP4 or a QuickTime movie — is REJECTED, not sniffed as heic just because it has an `ftyp` box', () => {
    // These share AVIF/HEIC's container and their first 8 bytes exactly. A
    // sniffer that matched on 'ftyp' alone (rather than reading the brand)
    // would classify all of them as an image and let a video be recorded as,
    // and served as, a photo.
    for (const brand of ['isom', 'mp41', 'mp42', 'M4V ', 'qt  ', 'crx ']) {
      expect(sniffImage(isoBmffBytes(brand))).toBeNull();
    }
  });

  it('an ISO-BMFF header whose declared ftyp box size is nonsense is rejected rather than walked out of bounds', () => {
    // boxSize = 0xFFFFFFFF, far past the buffer: the compatible-brand walk
    // must clamp to the bytes actually held. The brand is a real HEIC brand,
    // so the ONLY thing that can reject this is the bounds handling — and if
    // the walk read past the end it would throw instead of returning.
    const huge = isoBmffBytes('heic', ['heic']);
    new DataView(huge.buffer).setUint32(0, 0xffffffff);
    expect(sniffImage(huge)).toEqual({ kind: 'heic', width: null, height: null });

    // A declared size below the mandatory 16-byte minimum is malformed.
    const tiny = isoBmffBytes('heic');
    new DataView(tiny.buffer).setUint32(0, 8);
    expect(sniffImage(tiny)).toBeNull();
  });

  it('an ISO-BMFF header with non-printable bytes where the brand should be is rejected, not coerced into a brand string', () => {
    const garbageBrand = isoBmffBytes('heic');
    garbageBrand.set([0x00, 0x01, 0xff, 0xfe], 8);
    expect(sniffImage(garbageBrand)).toBeNull();
  });

  it('Minor 8 — a legitimate JPEG padded with 0xFF fill bytes before its SOF marker is still correctly sniffed (ITU T.81 §B.1.1.2: fill bytes before a marker are legal, real encoders emit them)', () => {
    // SOI, then THREE extra 0xFF fill bytes, then the real marker byte
    // (0xC0 = SOF0), then the same segment body jpegBytes() uses.
    const withFill = new Uint8Array([
      0xff, 0xd8, 0xff, 0xff, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01, 0x00,
    ]);
    expect(sniffImage(withFill)).toEqual({ kind: 'jpeg', width: 4, height: 5 });
  });
});

/**
 * THE WAVE-D INVARIANT.
 *
 * A verify-or-delete guard is a DESTRUCTIVE control: on a sniff it does not
 * like, it removes the uploaded object. That makes the sniffer's coverage a
 * correctness requirement, not a nicety — if a bucket accepts a format
 * `sniffImage` cannot recognize, every legitimate upload of that format sniffs
 * as null and gets deleted.
 *
 * This is not hypothetical. The half-finished version of this wave widened
 * `SniffedImage['kind']` to include 'avif' and 'heic' and extended
 * MIME_FOR_KIND to match, but never added detection branches — so both union
 * members were unreachable and the guard would have deleted every AVIF and
 * HEIC upload the item-images and org-logos buckets explicitly accept.
 *
 * The invariant, in both directions:
 *   NEVER NARROWER than a gated bucket's allowlist — else legitimate uploads
 *     are destroyed. Asserted with REAL BYTES per MIME, so declaring a MIME
 *     supported without teaching sniffImage to detect it fails here.
 *   NEVER SILENTLY WIDER at a call site — a surface must not accept a format
 *     its own bucket refuses, which is what `isSniffedKindAllowedInBucket`
 *     exists to let each caller state.
 */
describe('sniffer coverage vs the bucket allowlists it gates', () => {
  /** A real byte fixture per MIME this sniffer must recognize. Deliberately
   *  built here rather than derived from MIME_FOR_KIND: the point is to prove
   *  the sniffer against independent evidence, not to restate its own table. */
  const BYTES_FOR_MIME: Record<string, () => Uint8Array> = {
    'image/png': () => pngBytes(2, 3),
    'image/jpeg': () => jpegBytes(4, 5),
    'image/webp': () => webpBytes(),
    'image/avif': () => isoBmffBytes('avif'),
    'image/heic': () => isoBmffBytes('heic'),
  };

  it('is never NARROWER than any gated bucket: every MIME in every allowlist is produced by real bytes the sniffer recognizes', () => {
    for (const [bucket, allowlist] of Object.entries(SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS)) {
      for (const mime of allowlist) {
        const fixture = BYTES_FOR_MIME[mime];
        expect(
          fixture,
          `${bucket} accepts ${mime} but this suite has no byte fixture for it — add one, and make sure sniffImage detects it, before adding the MIME to the allowlist`,
        ).toBeDefined();
        const sniffed = sniffImage(fixture!());
        expect(sniffed, `sniffImage returned null for ${mime}, which ${bucket} accepts`).not.toBeNull();
        expect(MIME_FOR_KIND[sniffed!.kind]).toBe(mime);
        expect(isSniffedKindAllowedInBucket(sniffed!.kind, bucket as keyof typeof SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS)).toBe(true);
      }
    }
  });

  it('every kind the sniffer can return has a MIME_FOR_KIND entry, so no sniff result is ever undefined at a comparison site', () => {
    const kinds: SniffedImage['kind'][] = ['png', 'jpeg', 'webp', 'avif', 'heic'];
    for (const kind of kinds) {
      expect(MIME_FOR_KIND[kind], `MIME_FOR_KIND is missing ${kind}`).toMatch(/^image\//);
    }
    // And the table has no entries beyond those kinds — a stale MIME left in
    // MIME_FOR_KIND after a kind was removed would silently satisfy the
    // allowlist test above without any detection behind it.
    expect(Object.keys(MIME_FOR_KIND).sort()).toEqual([...kinds].sort());
  });

  it('is never silently WIDER at a call site: maintenance-photos refuses HEIC (0315 leaves it out on purpose) while item-images accepts it', () => {
    // The concrete divergence in the product. A HEIC body sniffs successfully
    // — so a guard checking only `sniffed !== null` would accept it into
    // maintenance-photos, a bucket pinned against it. The per-bucket check is
    // what refuses it.
    const heic = sniffImage(isoBmffBytes('heic'));
    expect(heic?.kind).toBe('heic');
    expect(isSniffedKindAllowedInBucket('heic', 'maintenance-photos')).toBe(false);
    expect(isSniffedKindAllowedInBucket('heic', 'item-images')).toBe(true);
    // org-logos allows AVIF but not HEIC (migration 0046).
    expect(isSniffedKindAllowedInBucket('avif', 'org-logos')).toBe(true);
    expect(isSniffedKindAllowedInBucket('heic', 'org-logos')).toBe(false);
  });

  it('pins each gated bucket allowlist to the exact set its migration writes', () => {
    // Literal pins, not a structural comparison: these are transcriptions of
    // migrations 0046 and 0315, and a drift between the two is the bug this
    // whole file guards against.
    expect(SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS['item-images']).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/avif',
      'image/heic',
    ]);
    expect(SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS['org-logos']).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/avif',
    ]);
    expect(SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS['maintenance-photos']).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
  });
});

/**
 * PREFIX-WINDOW SEMANTICS (fix-wave: Important 1).
 *
 * fetchObjectPrefix feeds the sniffer a 4096-byte LEADING WINDOW, and a
 * camera-original JPEG routinely carries more pre-SOF metadata than that
 * (5-20 KB APP1 EXIF thumbnails; ICC/XMP far larger). On the window alone the
 * marker walk runs out of bytes without a verdict — and if that reads as
 * plain null, every verify-or-delete caller DELETES a legitimate photo. So
 * "ran out of data" must be distinguishable from "definitively not an image":
 * `sniffNeedsMoreBytes` is that distinction, and this block pins BOTH sides
 * of it plus the invariant that `sniffImage`'s whole-file semantics did not
 * move (a truncated whole file is still null).
 */
describe('sniffNeedsMoreBytes — indeterminate window vs definitive fake', () => {
  it('the finding, end to end: a real JPEG with 12 KB of pre-SOF EXIF sniffs as jpeg from its FULL bytes, but its 4096-byte leading window is null under sniffImage — and sniffNeedsMoreBytes reports the window as indeterminate, which is what routes the reader to fetch the rest instead of deleting the upload', () => {
    const full = exifHeavyJpegBytes(12 * 1024, 4, 5);
    expect(sniffImage(full)).toEqual({ kind: 'jpeg', width: 4, height: 5 });
    const window = full.subarray(0, 4096);
    expect(sniffImage(window)).toBeNull();
    expect(sniffNeedsMoreBytes(window)).toBe(true);
  });

  it('a window ending exactly inside a SOF header (marker seen, dimensions cut off) is also indeterminate, not a fake', () => {
    const full = exifHeavyJpegBytes(64, 4, 5); // SOF at byte 70
    const midSof = full.subarray(0, 6 + 64 + 4); // SOF marker + length, dims cut
    expect(sniffImage(midSof)).toBeNull();
    expect(sniffNeedsMoreBytes(midSof)).toBe(true);
  });

  it('DEFINITIVE fakes are NOT indeterminate — no amount of further bytes redeems them, so the reader must never burn a full download on one', () => {
    // A renamed EXE.
    expect(sniffNeedsMoreBytes(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]))).toBe(false);
    // An HTML body.
    expect(sniffNeedsMoreBytes(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBe(false);
    // A zero-byte object.
    expect(sniffNeedsMoreBytes(new Uint8Array(0))).toBe(false);
    // A structurally impossible JPEG: segment length 0 can never be valid.
    expect(sniffNeedsMoreBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]))).toBe(false);
    // A SOF declaring a zero dimension is malformed, not truncated.
    expect(sniffNeedsMoreBytes(jpegBytes(0, 5))).toBe(false);
  });

  it('COMPLETE verdicts are not indeterminate: a decided image never triggers a second read', () => {
    expect(sniffNeedsMoreBytes(pngBytes(2, 3))).toBe(false);
    expect(sniffNeedsMoreBytes(jpegBytes(4, 5))).toBe(false);
    expect(sniffNeedsMoreBytes(webpBytes())).toBe(false);
    expect(sniffNeedsMoreBytes(isoBmffBytes('avif'))).toBe(false);
    expect(sniffNeedsMoreBytes(isoBmffBytes('heic'))).toBe(false);
  });

  it('an ISO-BMFF window whose ftyp box extends past the supplied bytes with no image brand YET seen is indeterminate (the deciding compatible brand may sit in the unseen tail) — but the same shape on a WHOLE file stays null under sniffImage', () => {
    // Major brand 'miaf' (neither AVIF nor HEIC set), declared box size 24
    // (room for two compatible brands), bytes cut at 16: the brand list is
    // entirely in the unseen tail.
    const cut = isoBmffBytes('miaf', ['avif', 'miaf']).subarray(0, 16);
    expect(sniffNeedsMoreBytes(cut)).toBe(true);
    expect(sniffImage(cut)).toBeNull();
    // The full box decides avif — proving the unseen tail really could have
    // changed the verdict.
    expect(sniffImage(isoBmffBytes('miaf', ['avif', 'miaf']))).toEqual({
      kind: 'avif',
      width: null,
      height: null,
    });
  });
});
