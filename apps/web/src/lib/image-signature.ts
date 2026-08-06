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
export type SniffedImage = { kind: 'png' | 'jpeg' | 'webp'; width: number | null; height: number | null };

export const MIME_FOR_KIND: Record<SniffedImage['kind'], 'image/png' | 'image/jpeg' | 'image/webp'> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

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

export function sniffImage(data: Uint8Array): SniffedImage | null {
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
      if (markerAt >= data.length) return null;
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
        if (markerAt + 7 >= data.length) return null;
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
      if (lenAt + 1 >= data.length) return null;
      const length = (data[lenAt]! << 8) | data[lenAt + 1]!;
      if (length <= 0) return null;
      offset = lenAt + length;
    }
    return null;
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
  return null;
}
