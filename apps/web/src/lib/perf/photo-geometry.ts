/**
 * Geometry for the photo measurements: is a photo really on screen, how many
 * pixels did the browser really get, and how many does the box need.
 *
 * WHY THIS EXISTS. Two defects were found in the harness on 2026-09-21, both on
 * the order storefront, both of which made the APP look broken when it was not:
 *
 *   1. "On screen" was the photo's box against the VIEWPORT only. A card further
 *      along a horizontal strip sits inside the viewport's box while its strip
 *      clips it away entirely. The browser (correctly) never loads such a lazy
 *      photo, so every storefront sample reported "did not finish".
 *   2. `naturalWidth` of an `<img srcset sizes>` is DENSITY-CORRECTED: the
 *      browser divides the file's real width by (w descriptor / source size).
 *      A 640 px file in a `sizes="220px"` slot reports 220. The audit compared
 *      that with the pixels the box needs and called sharp photos too small.
 *
 * SELF-CONTAINED ON PURPOSE, like `classifyImageUrl`: the harness injects these
 * functions into the page with `.toString()`. Each one imports nothing, closes
 * over nothing and calls none of the others.
 */

/** A rectangle in viewport coordinates. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** An ancestor that clips its content, and on which axes (`overflow-x` / `overflow-y` other than `visible`). */
export interface ClipBox {
  box: Box;
  x: boolean;
  y: boolean;
}

/**
 * What is left of `rect` once the viewport and every clipping ancestor have cut
 * it. `null` means no pixel of it can be on screen.
 *
 * ANY remaining sliver counts, which is also when a browser starts a lazy load.
 * Known simplifications: the ancestor's border box stands in for its padding
 * box, and occlusion (something drawn on top) is not visibility's business.
 */
export function visibleBox(rect: Box, viewport: Box, clips: ClipBox[]): Box | null {
  let left = Math.max(rect.left, viewport.left);
  let right = Math.min(rect.right, viewport.right);
  let top = Math.max(rect.top, viewport.top);
  let bottom = Math.min(rect.bottom, viewport.bottom);
  for (const clip of clips) {
    if (clip.x) {
      left = Math.max(left, clip.box.left);
      right = Math.min(right, clip.box.right);
    }
    if (clip.y) {
      top = Math.max(top, clip.box.top);
      bottom = Math.min(bottom, clip.box.bottom);
    }
  }
  return right - left > 0 && bottom - top > 0 ? { left, top, right, bottom } : null;
}

/**
 * The length of the first `sizes` entry whose media condition matches, as
 * written (`220px`, `45vw`, `calc(50vw - 16px)`). The caller turns it into
 * pixels by laying it out, which is the only honest way to resolve `calc()`,
 * `vw`, `em`. `null` for an empty list or `auto`.
 */
export function pickSizesLength(
  sizes: string,
  matches: (mediaCondition: string) => boolean,
): string | null {
  const entries: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of sizes) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      entries.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  entries.push(current);
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    // The length is the LAST component: a function such as calc(...), or a token.
    let start: number;
    if (entry.endsWith(')')) {
      let level = 0;
      start = entry.length - 1;
      for (; start >= 0; start -= 1) {
        if (entry[start] === ')') level += 1;
        if (entry[start] === '(') {
          level -= 1;
          if (level === 0) break;
        }
      }
      while (start > 0 && /[a-zA-Z-]/.test(entry[start - 1] as string)) start -= 1;
    } else {
      start = entry.search(/\S+$/);
    }
    if (start < 0) continue;
    const length = entry.slice(start).trim();
    const condition = entry.slice(0, start).trim();
    if (!length || length === 'auto') continue;
    if (condition === '' || matches(condition)) return length;
  }
  return null;
}

/**
 * How many FILE pixels one pixel of `naturalWidth` stands for, for the srcset
 * candidate the browser is showing. `real width = naturalWidth × density`.
 *
 *   `640w` with a 220 px source size  ->  640 / 220
 *   `2x`                              ->  2
 *   no srcset, or no matching candidate -> null (naturalWidth is already real)
 *
 * `resolve` turns a srcset URL into the absolute form `currentSrc` uses.
 */
export function srcsetDensity(
  srcset: string,
  currentSrc: string,
  sourceSizePx: number | null,
  resolve: (url: string) => string,
): number | null {
  // Candidates are separated by a comma FOLLOWED BY white space; a bare comma
  // may be part of a URL.
  for (const part of srcset.split(/,\s+/)) {
    const candidate = part.trim();
    if (!candidate) continue;
    const match = /^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/.exec(candidate);
    if (!match) continue;
    let absolute: string;
    try {
      absolute = resolve(match[1] as string);
    } catch {
      continue;
    }
    if (absolute !== currentSrc) continue;
    const value = match[2] ? Number(match[2]) : 1;
    if (match[3] === 'w') {
      return sourceSizePx !== null && sourceSizePx > 0 ? value / sourceSizePx : null;
    }
    return value > 0 ? value : null;
  }
  return null;
}

/**
 * The file width a photo needs to be sharp in its box. `object-fit: cover` (and
 * `fill`) scale the photo until it covers the box, so the tighter axis decides;
 * `contain`, `scale-down` and `none` fit it inside, so the looser one does.
 */
export function neededIntrinsicWidth(
  box: { width: number; height: number },
  image: { width: number; height: number },
  devicePixelRatio: number,
  objectFit: string | null | undefined,
): number {
  if (!(image.width > 0) || !(image.height > 0)) return box.width * devicePixelRatio;
  const widthIfHeightDecides = (box.height * image.width) / image.height;
  const covers = objectFit === 'cover' || objectFit === 'fill' || !objectFit;
  const shown = covers
    ? Math.max(box.width, widthIfHeightDecides)
    : Math.min(box.width, widthIfHeightDecides);
  return shown * devicePixelRatio;
}
