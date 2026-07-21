/**
 * Email motion-asset spec + minimal GIF/PNG structure parsers.
 *
 * Single source of truth for what `apps/web/public/email/motion/` must
 * contain, asserted by both the vitest suite (motion-assets.test.ts) and the
 * pipeline CLI (scripts/email-motion/validate.ts).
 *
 * Derived from the MOTION registry in docs/design/email-system/es-tokens.js
 * (13 board rows -> 14 GIFs; the clock row ships clock + clock-arc) and the
 * loop mapping pinned in docs/superpowers/plans/2026-07-20-email-system-
 * implementation.md decision 4: play once -> Netscape loop 1; "Loop xN, then
 * hold" -> N; "Infinite (subtle)" -> 0.
 */

export interface MotionAssetSpec {
  id: string;
  file: string;
  /** MOTION row size cap in KB. */
  maxKB: number;
  /** Expected Netscape loop-extension value. */
  loop: number;
  /** Pixel dims when not the standard 1200x440 hero (e.g. the tick dot). */
  width?: number;
  height?: number;
}

export const MOTION_DIMS = { width: 1200, height: 440 } as const;

export const MOTION_ASSET_SPECS: MotionAssetSpec[] = [
  { id: 'lock', file: 'lock@2x.gif', maxKB: 250, loop: 1 },
  { id: 'pulse', file: 'pulse@2x.gif', maxKB: 250, loop: 3 },
  { id: 'tiles', file: 'tiles@2x.gif', maxKB: 400, loop: 1 },
  { id: 'route', file: 'route@2x.gif', maxKB: 300, loop: 0 },
  { id: 'reverse', file: 'reverse@2x.gif', maxKB: 300, loop: 0 },
  { id: 'scanner', file: 'scanner@2x.gif', maxKB: 300, loop: 4 },
  { id: 'settle', file: 'settle@2x.gif', maxKB: 300, loop: 1 },
  { id: 'check', file: 'check@2x.gif', maxKB: 250, loop: 1 },
  { id: 'pin', file: 'pin@2x.gif', maxKB: 250, loop: 1 },
  { id: 'tag', file: 'tag@2x.gif', maxKB: 250, loop: 2 },
  { id: 'clock', file: 'clock@2x.gif', maxKB: 250, loop: 2 },
  { id: 'clock-arc', file: 'clock-arc@2x.gif', maxKB: 250, loop: 2 },
  { id: 'calendar', file: 'calendar@2x.gif', maxKB: 250, loop: 1 },
  { id: 'bars', file: 'bars@2x.gif', maxKB: 300, loop: 1 },
  // Timeline tick (received email) — 11x11-display inline dot, not a hero.
  { id: 'tick', file: 'tick@2x.gif', maxKB: 20, loop: 1, width: 22, height: 22 },
];

/** Logo marks exported alongside the motion assets (22x22 display @2x). */
export const LOGO_MARK_FILES = ['logo-mark-light.png', 'logo-mark-dark.png'] as const;
export const LOGO_MARK_SIZE = 44;

export interface GifInfo {
  width: number;
  height: number;
  frameCount: number;
  /** Netscape loop-extension value, or null when the extension is absent. */
  loopCount: number | null;
}

/** Bounds-checked byte accessor (noUncheckedIndexedAccess-safe). */
function reader(buf: Uint8Array, kind: string): (i: number) => number {
  return (i: number) => {
    const v = buf[i];
    if (v === undefined) throw new Error(`corrupt ${kind}: unexpected end of file at byte ${i}`);
    return v;
  };
}

function skipSubBlocks(at: (i: number) => number, pos: number): number {
  while (at(pos) !== 0) pos += 1 + at(pos);
  return pos + 1; // past the block terminator
}

/** Walks the full GIF block structure (no pixel decoding). */
export function parseGif(buf: Uint8Array): GifInfo {
  const at = reader(buf, 'GIF');
  const sig = String.fromCharCode(...buf.subarray(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') {
    throw new Error(`not a GIF (signature ${JSON.stringify(sig)})`);
  }
  const width = at(6) | (at(7) << 8);
  const height = at(8) | (at(9) << 8);
  const packed = at(10);
  let pos = 13;
  if (packed & 0x80) pos += 3 * (2 << (packed & 0x07)); // global color table

  let frameCount = 0;
  let loopCount: number | null = null;

  while (pos < buf.length) {
    const block = at(pos);
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      // extension: introducer + label, then sub-blocks
      const label = at(pos + 1);
      pos += 2;
      if (label === 0xff) {
        const appSize = at(pos);
        const appId = String.fromCharCode(...buf.subarray(pos + 1, pos + 1 + appSize));
        const dataPos = pos + 1 + appSize;
        if (appId === 'NETSCAPE2.0' && at(dataPos) === 3 && at(dataPos + 1) === 1) {
          loopCount = at(dataPos + 2) | (at(dataPos + 3) << 8);
        }
        pos = skipSubBlocks(at, dataPos);
      } else {
        pos = skipSubBlocks(at, pos);
      }
    } else if (block === 0x2c) {
      // image descriptor: separator + left/top/width/height (u16 x4) + packed
      frameCount += 1;
      const localPacked = at(pos + 9);
      pos += 10;
      if (localPacked & 0x80) pos += 3 * (2 << (localPacked & 0x07)); // local color table
      pos += 1; // LZW minimum code size
      pos = skipSubBlocks(at, pos);
    } else {
      throw new Error(`corrupt GIF: unexpected block 0x${block.toString(16)} at ${pos}`);
    }
  }

  return { width, height, frameCount, loopCount };
}

/** Reads the IHDR dimensions of a PNG. */
export function parsePngSize(buf: Uint8Array): { width: number; height: number } {
  const at = reader(buf, 'PNG');
  const isPng =
    buf.length > 24 &&
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    String.fromCharCode(...buf.subarray(12, 16)) === 'IHDR';
  if (!isPng) throw new Error('not a PNG');
  const width = (at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19);
  const height = (at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23);
  return { width, height };
}

/** Returns human-readable violations for one asset buffer ([] = valid). */
export function validateMotionGif(spec: MotionAssetSpec, buf: Uint8Array): string[] {
  const errors: string[] = [];
  let info: GifInfo;
  try {
    info = parseGif(buf);
  } catch (err) {
    return [`${spec.file}: ${err instanceof Error ? err.message : String(err)}`];
  }
  const wantW = spec.width ?? MOTION_DIMS.width;
  const wantH = spec.height ?? MOTION_DIMS.height;
  if (info.width !== wantW || info.height !== wantH) {
    errors.push(`${spec.file}: dimensions ${info.width}x${info.height}, expected ${wantW}x${wantH}`);
  }
  if (buf.byteLength > spec.maxKB * 1024) {
    errors.push(`${spec.file}: ${(buf.byteLength / 1024).toFixed(1)} KB exceeds cap ${spec.maxKB} KB`);
  }
  if (info.loopCount !== spec.loop) {
    errors.push(`${spec.file}: Netscape loop ${info.loopCount ?? 'absent'}, expected ${spec.loop}`);
  }
  if (info.frameCount <= 1) {
    errors.push(`${spec.file}: only ${info.frameCount} frame(s) — animation missing`);
  }
  return errors;
}
