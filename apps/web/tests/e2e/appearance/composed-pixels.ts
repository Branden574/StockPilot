import type { BrowserContext, Page } from '@playwright/test';

import type { Rgb } from './a11y-math';

/**
 * Composed-pixel sampling for plan 8.3-3 / R11: what a text run is drawn
 * over is what the browser composed behind it (scene photo, frost, veil,
 * fill), so it is read from a screenshot, not from a token.
 *
 * Method: the page is shot twice. First as it is; then with every glyph made
 * transparent (an injected style: color and text fill transparent, no text
 * shadow, no caret), which leaves exactly the composed backdrop behind each
 * text box. The second shot is decoded in a blank page of the same context
 * (a canvas; the app's CSP never applies there) and sampled on a grid inside
 * each box. The specs then take the worst ratio of the text colour over those
 * pixels (a11y-math.ts worstContrast).
 */

export interface TextRun {
  /** A short description for the report (tag, role, the first words). */
  id: string;
  box: { x: number; y: number; w: number; h: number };
  color: string;
  fontSizePx: number;
  fontWeight: number;
  /** For a field edge: its border colour (non-text, 3:1), else null. */
  edgeColor: string | null;
  /** The nearest glass pane holding it (data-glass value), or null. */
  pane: string | null;
}

const HIDE_GLYPHS = `*, *::before, *::after {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  caret-color: transparent !important;
}
input::placeholder, textarea::placeholder { color: transparent !important; }`;

/**
 * The visible text runs (elements with their own text) and glass field edges
 * in the viewport. `within` (a selector) keeps the walk inside the first
 * element it matches, for a surface that floats over the page (the
 * product-update card): nothing is returned when it matches nothing.
 */
export async function textRuns(page: Page, limit = 400, within?: string): Promise<TextRun[]> {
  return page.evaluate(
    ({ max, scope }) => {
      const out: TextRun[] = [];
      const root = scope ? document.querySelector(scope) : document.body;
      if (!root) return out;
      const vw = innerWidth;
      const vh = innerHeight;
      const describe = (el: Element) => {
        const text = (el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 32);
        const role = el.getAttribute('role');
        return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ''} "${text}"`;
      };
      const paneOf = (el: Element) =>
        el.closest('[data-glass]')?.getAttribute('data-glass') ?? null;
      const inactive = (el: Element) =>
        el.closest('[disabled], [aria-disabled="true"], [aria-hidden="true"], [inert]') !== null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node && out.length < max; node = walker.nextNode()) {
        const el = node as HTMLElement;
        const own = [...el.childNodes].some(
          (c) => c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim().length > 0,
        );
        const field = el.matches('[data-glass="input"], [data-glass="select"]');
        if (!own && !field) continue;
        if (inactive(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0)
          continue;
        const r = el.getBoundingClientRect();
        if (
          r.width < 2 ||
          r.height < 2 ||
          r.bottom <= 0 ||
          r.right <= 0 ||
          r.top >= vh ||
          r.left >= vw
        )
          continue;
        const box = {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          w: Math.min(vw, r.right) - Math.max(0, r.left),
          h: Math.min(vh, r.bottom) - Math.max(0, r.top),
        };
        out.push({
          id: describe(el),
          box,
          color: cs.color,
          fontSizePx: parseFloat(cs.fontSize),
          fontWeight: Number(cs.fontWeight) || 400,
          edgeColor: field ? cs.borderTopColor : null,
          pane: paneOf(el),
        });
      }
      return out;
    },
    { max: limit, scope: within ?? null },
  );
}

/** Shoots the viewport with every glyph transparent: the composed backdrop. */
export async function backdropShot(page: Page): Promise<Buffer> {
  const handle = await page.addStyleTag({ content: HIDE_GLYPHS });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await handle.evaluate((el) => (el as Element).remove());
  return png;
}

export interface Samples {
  /** Pixels inside the box (grid, at most `per` of them). */
  inside: Rgb[];
  /** Pixels in a 3 px ring just outside the box (for a field edge). */
  around: Rgb[];
}

/**
 * Decodes `png` in a blank page of `context` and samples each box. `scale`
 * is the device pixel ratio the shot was taken at.
 */
export async function sampleBoxes(
  context: BrowserContext,
  png: Buffer,
  boxes: readonly TextRun['box'][],
  scale: number,
  per = 300,
): Promise<Samples[]> {
  const blank = await context.newPage();
  try {
    await blank.goto('about:blank');
    return await blank.evaluate(
      async ({ b64, list, dpr, n }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const W = canvas.width;
        const H = canvas.height;
        const data = ctx.getImageData(0, 0, W, H).data;
        const px = (x: number, y: number): [number, number, number] | null => {
          const X = Math.round(x * dpr);
          const Y = Math.round(y * dpr);
          if (X < 0 || Y < 0 || X >= W || Y >= H) return null;
          const i = (Y * W + X) * 4;
          return [data[i]!, data[i + 1]!, data[i + 2]!];
        };
        return list.map((b) => {
          const inside: [number, number, number][] = [];
          const step = Math.max(1, Math.sqrt((b.w * b.h) / n));
          for (let y = b.y + step / 2; y < b.y + b.h; y += step)
            for (let x = b.x + step / 2; x < b.x + b.w; x += step) {
              const p = px(x, y);
              if (p) inside.push(p);
            }
          const around: [number, number, number][] = [];
          const ring = 3;
          const edgeStep = Math.max(1, (b.w + b.h) / 60);
          for (let x = b.x; x <= b.x + b.w; x += edgeStep) {
            for (const y of [b.y - ring, b.y + b.h + ring]) {
              const p = px(x, y);
              if (p) around.push(p);
            }
          }
          for (let y = b.y; y <= b.y + b.h; y += edgeStep) {
            for (const x of [b.x - ring, b.x + b.w + ring]) {
              const p = px(x, y);
              if (p) around.push(p);
            }
          }
          return { inside, around };
        });
      },
      { b64: png.toString('base64'), list: [...boxes], dpr: scale, n: per },
    );
  } finally {
    await blank.close();
  }
}
