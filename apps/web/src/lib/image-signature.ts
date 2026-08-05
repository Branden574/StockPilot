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

export function sniffImage(data: Uint8Array): SniffedImage | null {
  // PNG: 8-byte signature, IHDR width at 16 / height at 20 (BE32).
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { kind: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: SOI then walk markers to the first SOF.
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1]!;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        const height = (data[offset + 5]! << 8) | data[offset + 6]!;
        const width = (data[offset + 7]! << 8) | data[offset + 8]!;
        return width > 0 && height > 0 ? { kind: 'jpeg', width, height } : { kind: 'jpeg', width: null, height: null };
      }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (length <= 0) return null;
      offset += 2 + length;
    }
    return null;
  }
  // WEBP: 'RIFF'....'WEBP'.
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
