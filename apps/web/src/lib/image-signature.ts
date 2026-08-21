/**
 * Magic-byte image sniffing for upload FINALIZE (audit Q8). The bucket's
 * allowed_mime_types (migration 0315) only checks the DECLARED
 * Content-Type at PUT time — this reads the actual bytes after upload, at
 * finalize. PNG/JPEG logic mirrors readImageDimensions
 * (inventory-export-xlsx.ts:58-95 — left in place there, it is byte-pinned
 * by the export suite); WEBP is added here because the bucket allows it and
 * the export path never needed to detect it.
 *
 * Pure function: takes ONLY bytes. No filename, no declared MIME, no
 * extension parameter — a caller cannot fool this by renaming a file or
 * lying about Content-Type, because there is nothing here for a lie to
 * reach. "Bytes win" is a property of the signature, not a behavior this
 * function has to implement.
 */
export type SniffedImage = {
  kind: 'png' | 'jpeg' | 'webp' | 'avif' | 'heic';
  width: number | null;
  height: number | null;
};

export const MIME_FOR_KIND: Record<
  SniffedImage['kind'],
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif' | 'image/heic'
> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  // avif/heic added by security wave D (MED-23), WITH detection branches in
  // sniffImage below — a widened union without them is worse than no widening
  // at all, because the members are unreachable and the guard that depends on
  // them silently deletes.
  //
  // Both are pinned in `allowed_mime_types` on buckets this sniffer now
  // guards: org-logos and user-avatars allow avif (migration 0046), and
  // item-images allows avif AND heic (0046). So a sniffer that returned null
  // for them would have DELETED legitimate uploads the buckets deliberately
  // accept — the exact trap a verify-or-delete guard walks into when its
  // sniffer is narrower than the allowlist it defends.
  //
  // This is not a hypothetical reachability argument. `image-uploader.tsx`
  // ACCEPTs image/avif and image/heic, and `compressImageVariants`
  // (lib/image-variants.ts) uploads the ORIGINAL, untranscoded file as the
  // master whenever its WebP encode does not come out smaller, whenever
  // `createImageBitmap` cannot decode the source, or whenever the heic2any
  // transcode fails — all three of which it does deliberately, to preserve
  // the upload rather than drop it. So an item-image master genuinely can be
  // AVIF or HEIC bytes in production.
  avif: 'image/avif',
  heic: 'image/heic',
};

/**
 * The `allowed_mime_types` of every bucket whose uploads this sniffer gates,
 * transcribed from the migrations that pin them.
 *
 * THE INVARIANT THIS TABLE EXISTS TO MAKE CHECKABLE: a verify-or-delete guard
 * is only safe when the sniffer is AT LEAST AS WIDE as the allowlist of the
 * bucket it defends. If a bucket accepts a format `sniffImage` cannot
 * recognize, every legitimate upload of that format sniffs as `null` and the
 * guard DELETES it. That is not a theoretical failure — it is exactly what a
 * half-finished widening of `SniffedImage['kind']` (union members added, no
 * detection branches) would have shipped for AVIF and HEIC. The unit suite
 * asserts both directions of this table against real byte fixtures, so adding
 * a MIME here without teaching `sniffImage` to detect it fails the build.
 *
 * The other direction matters too, and is why callers pass their bucket in
 * rather than just checking `sniffed !== null`: the sniffer is deliberately
 * WIDER than some of these buckets, and a surface must not accept a format
 * its own bucket refuses. maintenance-photos is the live case — 0315 leaves
 * HEIC out on purpose (both platforms transcode to JPEG client-side; the
 * order-attachments bucket does accept raw HEIC and produced unrenderable
 * originals, which is the mistake 0315 declines to repeat).
 */
export const SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS = {
  // migration 0046:196-205
  'item-images': ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/heic'],
  'org-logos': ['image/png', 'image/jpeg', 'image/webp', 'image/avif'],
  // migration 0315:29-35 — HEIC deliberately excluded.
  'maintenance-photos': ['image/png', 'image/jpeg', 'image/webp'],
  // Added by the upload-hardening audit, 2026-08-21. Both are server-side
  // capture paths whose bytes pass THROUGH a handler, so their guard sniffs
  // before the write rather than fetching back to verify — nothing unverified
  // reaches storage, and for cycle-count-scans nothing unverified reaches the
  // vision model either.
  //
  // Every mime below is one `sniffImage` already detects, which is the
  // invariant this table exists to keep checkable: a bucket listed here
  // accepting a format the sniffer cannot recognise would have its legitimate
  // uploads rejected, not protected.
  'cycle-count-scans': ['image/png', 'image/jpeg', 'image/webp'],
  'size-count-training': ['image/png', 'image/jpeg', 'image/webp'],
} as const;

export type SnifferGatedBucket = keyof typeof SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS;

/**
 * Whether a sniffed kind is a format the given bucket actually accepts.
 *
 * Callers should gate on THIS rather than on `sniffed !== null`: "the bytes
 * are some image" is a weaker property than "the bytes are an image this
 * bucket is pinned to hold", and the two differ for every bucket whose
 * allowlist is narrower than the sniffer.
 */
export function isSniffedKindAllowedInBucket(
  kind: SniffedImage['kind'],
  bucket: SnifferGatedBucket,
): boolean {
  const allowed: readonly string[] = SNIFFER_GATED_BUCKET_MIME_ALLOWLISTS[bucket];
  return allowed.includes(MIME_FOR_KIND[kind]);
}

/**
 * ISO base media file format (ISO/IEC 14496-12) brand sets.
 *
 * AVIF and HEIC are both ISO-BMFF containers, so they share a byte prefix
 * with MP4, QuickTime and every other member of the family: `ftyp` at bytes
 * 4..8. Matching `ftyp` alone would sniff an MP4 as an image. The BRAND —
 * the four bytes at 8..12, plus the optional compatible-brand list that
 * follows the minor version at 16 — is what actually names the format.
 *
 * The compatible-brand list is read as well as the major brand because real
 * encoders disagree about which goes where: an AVIF written by libavif
 * carries major brand `avif`, but files from some pipelines carry the generic
 * `mif1` as major and list `avif` only as compatible. AVIF brands are
 * therefore tested across the whole list BEFORE HEIC's, since `mif1`/`msf1`
 * are generic HEIF brands an AVIF may legitimately advertise.
 */
const ISO_BMFF_AVIF_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis']);
const ISO_BMFF_HEIC_BRANDS: ReadonlySet<string> = new Set([
  'heic',
  'heix',
  'hevc',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/** Four bytes as ASCII, or null if any of them is outside printable ASCII —
 *  a brand is always four printable characters, so anything else is not a
 *  brand and must not be coerced into one. */
function readBrand(data: Uint8Array, offset: number): string | null {
  if (offset + 4 > data.length) return null;
  let out = '';
  for (let i = offset; i < offset + 4; i += 1) {
    const byte = data[i]!;
    if (byte < 0x20 || byte > 0x7e) return null;
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Postgres `integer` (int4) range — `width`/`height` land in an `integer`
 *  column (migration 0314). A crafted/corrupted header can report a
 *  dimension up to 0xFFFFFFFF (this function reads it as an unsigned BE32);
 *  passing that through unchecked overflows the column at INSERT time
 *  (22003), which callers were surfacing as a raw 500 instead of the clean
 *  400 every other malformed-image path returns. Reject at the source
 *  instead — a real photo is never 4 billion pixels wide. Also excludes 0,
 *  which is never a real image dimension either. */
const INT4_MAX = 2147483647;
function isValidDimension(n: number): boolean {
  return n >= 1 && n <= INT4_MAX;
}

/**
 * "The verdict depends on bytes past the end of what was supplied."
 *
 * The classifier distinguishes this from a plain `null` because its input is
 * not always a whole file: fetchObjectPrefix (lib/storage-object-prefix.ts)
 * feeds it a LEADING WINDOW of the object, and for one real class of file the
 * window is not enough — a camera-original JPEG routinely carries more
 * metadata than the window before its SOF marker (a 5-20 KB APP1 EXIF segment
 * with an embedded thumbnail; multi-segment APP2 ICC profiles — the common
 * U.S. Web Coated CMYK profile alone is ~557 KB; XMP packets). Collapsing
 * "ran out of data mid-walk" into "not an image" is how a verify-or-delete
 * guard DELETES a legitimate photo: the callers treat null as fake and remove
 * the object. So truncation is reported distinctly, and the prefix reader
 * responds by fetching the rest of the object before judging.
 */
const NEEDS_MORE_BYTES = Symbol('needs-more-bytes');
type ClassifyResult = SniffedImage | null | typeof NEEDS_MORE_BYTES;

/**
 * Whether a sniff of these bytes is INDETERMINATE — i.e. `sniffImage` would
 * return null only because the classification ran past the end of the buffer,
 * not because the bytes are definitively not an image. Meaningful only when
 * the buffer is a leading window of a larger object; for a whole file,
 * "walked off the end" IS "malformed", which is why `sniffImage` itself maps
 * this case to null.
 */
export function sniffNeedsMoreBytes(data: Uint8Array): boolean {
  return classifyImageBytes(data) === NEEDS_MORE_BYTES;
}

export function sniffImage(data: Uint8Array): SniffedImage | null {
  const verdict = classifyImageBytes(data);
  // For a WHOLE file, a walk that ran out of bytes means the file is
  // truncated/malformed — the pre-refactor behavior, preserved exactly.
  return verdict === NEEDS_MORE_BYTES ? null : verdict;
}

function classifyImageBytes(data: Uint8Array): ClassifyResult {
  // PNG: the FULL 8-byte signature (not a truncated prefix), then the IHDR
  // chunk type at bytes 12-15 — the first chunk of a real PNG stream is
  // always IHDR, so a body that only shares a few leading signature bytes
  // with a PNG (or has the right signature but a different/garbage first
  // chunk) is rejected here rather than sniffed as PNG on partial evidence.
  // Width/height are IHDR's first two 4-byte fields (BE32) at 16/20.
  if (
    data.length > 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a &&
    data[12] === 0x49 && // 'I'
    data[13] === 0x48 && // 'H'
    data[14] === 0x44 && // 'D'
    data[15] === 0x52 // 'R'
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (!isValidDimension(width) || !isValidDimension(height)) return null;
    return { kind: 'png', width, height };
  }
  // JPEG: SOI then walk markers to the first SOF.
  //
  // Every bail-out in this walk is one of two DIFFERENT verdicts, and the
  // distinction is load-bearing (see NEEDS_MORE_BYTES above): structural
  // impossibilities (a segment length of zero, a SOF declaring a zero
  // dimension) are `null` — no amount of further data can redeem them —
  // while "the walk ran past the end of the buffer" is NEEDS_MORE_BYTES,
  // because a longer read of the same object could still land on a SOF.
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 1 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      // A conforming encoder may pad with any number of extra 0xFF "fill"
      // bytes before a marker (ITU T.81 §B.1.1.2) — perfectly legal, and
      // real encoders emit it. Skip past them to find the actual marker
      // byte instead of misreading the first fill byte as a two-byte
      // marker pair, which corrupted the rest of the walk and rejected an
      // otherwise-legitimate JPEG (its uploaded object was then deleted).
      let markerAt = offset + 1;
      while (data[markerAt] === 0xff) markerAt++;
      if (markerAt >= data.length) return NEEDS_MORE_BYTES;
      const marker = data[markerAt]!;
      // Markers with no length/payload field: TEM (0x01) and RSTn
      // (0xD0-0xD7). Nothing to skip via a length read — advance past the
      // marker byte itself and keep walking.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset = markerAt + 1;
        continue;
      }
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        if (markerAt + 7 >= data.length) return NEEDS_MORE_BYTES;
        const height = (data[markerAt + 4]! << 8) | data[markerAt + 5]!;
        const width = (data[markerAt + 6]! << 8) | data[markerAt + 7]!;
        // A SOF segment reporting a zero dimension is malformed, not a real
        // photo missing a few trailing bytes — reject outright (deliberately
        // stricter than letting it through with null dims: consistent with
        // the PNG dimension rejection above, and with the "adversarial input
        // gets refused, not half-classified" posture the no-SOF branch below
        // already takes).
        if (width < 1 || height < 1) return null;
        return { kind: 'jpeg', width, height };
      }
      const lenAt = markerAt + 1;
      if (lenAt + 1 >= data.length) return NEEDS_MORE_BYTES;
      const length = (data[lenAt]! << 8) | data[lenAt + 1]!;
      if (length <= 0) return null;
      offset = lenAt + length;
    }
    // The loop ended because `offset` reached (or a segment length carried it
    // past) the end of the buffer without a SOF: on a leading window this is
    // exactly the >4 KB-of-metadata camera JPEG, so ask for more bytes.
    return NEEDS_MORE_BYTES;
  }
  // WEBP: 'RIFF'....'WEBP'. All four fourcc bytes are checked — a RIFF file
  // of a different flavor (e.g. 'WAVE') must not be sniffed as WEBP just
  // because it shares the outer RIFF container.
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return { kind: 'webp', width: null, height: null };
  }
  // AVIF / HEIC — ISO-BMFF. Layout of the mandatory leading `ftyp` box:
  //   0..4    box size (BE32, includes these 4 bytes)
  //   4..8    'ftyp'
  //   8..12   major brand
  //   12..16  minor version
  //   16..    zero or more compatible brands, to the end of the box
  // The brand is read, never just `ftyp` (see the brand-set comments above):
  // an MP4 ('isom'/'mp42') and a QuickTime movie ('qt  ') reach this branch
  // with a valid ftyp box and must fall through to null, so a video renamed
  // to .heic is refused rather than recorded as a photo.
  //
  // width/height are DELIBERATELY null. Real ISO-BMFF dimensions live in an
  // `ispe` property box nested inside meta/iprp/ipco, which means walking a
  // box tree over attacker-supplied bytes — a much larger parser, and a much
  // larger attack surface, for a value both callers treat as optional. WEBP
  // above already returns null dimensions for the same reason, and the
  // `width`/`height` columns are nullable.
  if (
    data.length >= 12 &&
    data[4] === 0x66 && // 'f'
    data[5] === 0x74 && // 't'
    data[6] === 0x79 && // 'y'
    data[7] === 0x70 // 'p'
  ) {
    const boxSize = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    // A conforming ftyp box is at least 16 bytes (header + major brand +
    // minor version). A smaller or absent declared size means the header is
    // malformed, not that it needs guessing at.
    if (boxSize < 16) return null;
    const brands: string[] = [];
    const major = readBrand(data, 8);
    if (major) brands.push(major);
    // Compatible brands run from 16 to the end of the ftyp box. Clamp to the
    // bytes actually held: a crafted boxSize of 0xFFFFFFFF must not turn into
    // an out-of-range read, and a truncated download must not be walked past.
    const end = Math.min(boxSize, data.length);
    for (let offset = 16; offset + 4 <= end; offset += 4) {
      const brand = readBrand(data, offset);
      if (brand) brands.push(brand);
    }
    if (brands.some((b) => ISO_BMFF_AVIF_BRANDS.has(b))) {
      return { kind: 'avif', width: null, height: null };
    }
    if (brands.some((b) => ISO_BMFF_HEIC_BRANDS.has(b))) {
      return { kind: 'heic', width: null, height: null };
    }
    // No image brand seen — but if the declared ftyp box extends past the
    // buffer, the deciding brand may sit in the unseen part of the list, so a
    // leading window cannot condemn the file yet. (On a whole file this same
    // shape — a boxSize overrunning the actual bytes — is malformed, and
    // sniffImage maps it back to null.)
    return boxSize > data.length ? NEEDS_MORE_BYTES : null;
  }
  return null;
}
