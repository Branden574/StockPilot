/**
 * Deterministic synthetic product photos for the Perf Lab dataset.
 *
 * WHAT A PHOTO HAS TO BE GOOD FOR: judging delivered sharpness and measuring
 * transfer/decode cost. So every master carries the things that reveal blur at
 * DPR 2-3 (small printed text, a barcode of fine vertical bars, 1 px
 * hairlines) on top of what a product photo looks like from a distance (studio
 * backdrop, a large shaded shape, a floor shadow), plus photographic GRAIN.
 *
 * THE GRAIN IS THE SIZE KNOB. A clean vector render compresses to a few tens
 * of KB at any resolution; real phone photos are 200-600 KB because sensor
 * noise is incompressible. Each master has a byte target from dataset.mjs, and
 * the generator binary-searches the grain amplitude (`sigma`, in 8-bit levels)
 * until the encoded file lands within BYTE_TOLERANCE of it. The encoder
 * settings stay what a real upload would have used; only the grain moves
 * (and, for the smoothest tenth of photos, the surface texture: see below).
 * To make every file heavier or lighter, change the targets in dataset.mjs,
 * not this file.
 *
 * DETERMINISM: no clock, no Math.random. Noise comes from one seeded pool, the
 * search is a fixed bisection, and sharp/libvips encode identically for
 * identical input. Same DATASET_VERSION => byte-identical files, PROVIDED the
 * same sharp build and the same installed fonts (librsvg draws the label text
 * with system fonts). `seed.mjs --fingerprint` prints a hash of all 443 masters
 * so two machines, or two dates, can be compared in one line.
 *
 * Nothing is downloaded. Everything is drawn here.
 */
import { createHash } from 'node:crypto';

import sharp from 'sharp';

import { DATASET_VERSION } from './dataset.mjs';
import { createRng } from './lib.mjs';

// The app's own variant settings, so the derived files are the ones its uploader
// would have produced from the same master. Source of truth:
//   apps/web/src/lib/image-variants.config.ts   IMAGE_VARIANTS
//     master 2048 px / 0.85, thumb 200 px / 0.8, lqip 16 px / 0.5 / 2000 chars
// (On a checkout older than that file the same numbers are the constants at the
// top of image-variants.worker.ts, the path every current browser runs. The
// main-thread fallback once said 400 for the thumbnail and never reached a real
// upload: both censuses found every production thumbnail at 200 px or less.)
// That 200 px thumbnail, upscaled into a retina cell, IS the condition being
// reproduced.
//
// WHAT THE SETTINGS DO NOT DECIDE IS THE FORMAT. The uploader ASKS for
// image/webp. A browser that can encode WebP returns it. WebKit cannot, and
// returns image/png from the same call, on both code paths; the uploader stores
// what it got under the name and type it asked for. So `thumbKind` and
// `lqipKind` in the plan (dataset.mjs) say which of the two a row's writer was,
// and the quality numbers below apply only where the encoder is WebP.
const WEBP_MASTER_QUALITY = 85;
const THUMB_DIMENSION = 200;
const THUMB_QUALITY = 80;
const LQIP_DIMENSION = 16;
const LQIP_QUALITY = 50;
const LQIP_MAX_CHARS = 2000;

/** How close to its byte target a searched file must land. Exported so the seed can report misses. */
export const BYTE_TOLERANCE = 0.025;
const MAX_SIGMA = 56;
const SEARCH_STEPS = 10;

// libvips keeps an operation cache that only costs memory here: every image is
// distinct, nothing is ever reused.
sharp.cache(false);

// ── Noise pool ─────────────────────────────────────────────────────────────
// 2^21 standard-normal samples, generated once per process from the dataset
// seed. Each photo walks the pool from its own start with its own ODD stride
// (odd => the walk visits every slot before repeating), so photos do not share
// a grain pattern and no per-pixel PRNG call is needed: 443 photos are about
// one billion pixels-channels, and this keeps that to index arithmetic.
const POOL_BITS = 21;
const POOL_MASK = (1 << POOL_BITS) - 1;
let noisePool = null;
function pool() {
  if (noisePool) return noisePool;
  const rng = createRng(DATASET_VERSION, 'noise-pool');
  noisePool = new Float32Array(1 << POOL_BITS);
  for (let i = 0; i < noisePool.length; i++) noisePool[i] = rng.normal();
  return noisePool;
}

/**
 * base + grain. Luma noise is shared by the three channels; a smaller
 * independent part per channel gives the faint colour speckle real sensors
 * have (and that chroma subsampling then has to spend bits on, as it does for
 * a real photo). Uint8ClampedArray rounds and clamps on assignment.
 */
function addGrain(base, pixels, sigma, walk) {
  const p = pool();
  const out = new Uint8ClampedArray(base.length);
  const chroma = sigma * 0.45;
  let li = walk.lumaStart;
  let ci = walk.chromaStart;
  for (let px = 0, i = 0; px < pixels; px++, i += 3) {
    const l = p[li] * sigma;
    li = (li + walk.lumaStride) & POOL_MASK;
    out[i] = base[i] + l + p[ci] * chroma;
    ci = (ci + walk.chromaStride) & POOL_MASK;
    out[i + 1] = base[i + 1] + l + p[ci] * chroma;
    ci = (ci + walk.chromaStride) & POOL_MASK;
    out[i + 2] = base[i + 2] + l + p[ci] * chroma;
    ci = (ci + walk.chromaStride) & POOL_MASK;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * SURFACE TEXTURE: THE THUMBNAIL'S SIZE KNOB. Per-pixel grain averages away when
 * a master is reduced to 200 px, and the drawing itself (label, edges, shadow)
 * is worth only about 0.6 KB at that size, where the census measured a thumbnail
 * p50 of 8 KB. Real product photos keep detail at thumbnail scale (cardboard,
 * fabric, uneven light). One octave of seeded value noise, cubic-upscaled, stands
 * in for that.
 *
 * Both numbers below were MEASURED, not chosen by eye (200 px, WebP 0.8):
 *   cell size dominates. At equal amplitude 12 px cells cost twice the bytes of
 *     31 px cells: blotches several thumbnail pixels wide are too smooth to cost
 *     anything, and cells near one thumbnail pixel are removed by the downscale
 *     filter. Mixing octaves DILUTES, because it splits the amplitude across bands
 *     the thumbnail cannot see. So: one octave, about 1.5 thumbnail pixels wide.
 *   TEXTURE_CELL_U is in image units (1% of the short side), not pixels, so the
 *     cell is the same width IN THE THUMBNAIL for a 1200 px master and a 12 MP one.
 *   TEXTURE_AMPLITUDE is in 8-bit levels, peak (typical excursion is about half).
 *     12 px cells on a flat test scene: 24 -> 6.7 KB, 32 -> 8.0 KB. At 28 the
 *     ordinary thumbnail of a REAL drawing measures 7.0-7.8 KB (verify: p50 7 KB). Raise it to make every ordinary thumbnail heavier.
 * The masters do not change size: the grain search absorbs what the texture adds.
 *
 * EXCEPT for smooth photos. Full-strength texture costs about 1.0 bit per pixel
 * on its own, and the planned byte budgets run from 0.77 to 2.76 bits per pixel:
 * for roughly one master in ten the texture ALONE is heavier than the whole
 * target, and a grain search has nothing left to remove. Left alone, those files
 * would all clump at their floor and bend the low tail of the size distribution
 * (found on the first sample run: 136 KB against a 115 KB target). So for those
 * photos the TEXTURE amplitude is bisected down instead, with grain held at
 * MIN_GRAIN_SIGMA. Their thumbnails come out lighter, which is the honest
 * direction: a master that compresses to few bits per pixel is a smooth photo.
 * The median photo is never in this group, so the thumbnail p50 is unaffected.
 *
 * The printed label is left flat: paper is smooth, and the small print has to
 * stay legible in the master for the sharpness comparison to mean anything.
 */
const TEXTURE_AMPLITUDE = 28;
const TEXTURE_CELL_U = 1.0;
/**
 * Every LOSSY photo keeps at least this much sensor noise, even when its byte
 * budget is spent on texture. NOT the PNG: one level of noise is nearly free
 * after JPEG/WebP quantisation, but a lossless codec has to store every
 * randomised low bit, and sigma 1.0 alone puts a 1200 px PNG at 1.9 MB against
 * its 1.4 MB target (measured; a 36% miss). A PNG master in the wild is an
 * export or a screenshot rather than a camera frame, so near-zero noise is also
 * the truer picture of one.
 */
const MIN_GRAIN_SIGMA = 1.0;
const minGrainFor = (photo) => (photo.format === 'png' ? 0 : MIN_GRAIN_SIGMA);

/** What this machine encodes with. The bytes depend on it, so the seed and the fingerprint print it. */
export const encoderVersions = () =>
  `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`;
/** The texture field for one photo: built once, then applied at whatever amplitude the photo can afford. */
async function buildTexture(W, H, index) {
  const rng = createRng(DATASET_VERSION, 'texture', index);
  const cell = (Math.min(W, H) / 100) * TEXTURE_CELL_U;
  const gw = Math.max(2, Math.ceil(W / cell));
  const gh = Math.max(2, Math.ceil(H / cell));
  const grid = Buffer.alloc(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.int(0, 255);
  const out = await sharp(grid, { raw: { width: gw, height: gh, channels: 1 } })
    .resize(W, H, { fit: 'fill', kernel: 'cubic' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (out.info.channels !== 1) throw new Error('texture field is not single-channel');
  return out.data;
}

function applyTexture(base, texture, amplitude, label, W, H) {
  const out = new Uint8ClampedArray(base.length);
  const k = amplitude / 128;
  const lx0 = Math.floor(label.x);
  const lx1 = Math.ceil(label.x + label.w);
  const ly0 = Math.floor(label.y);
  const ly1 = Math.ceil(label.y + label.h);
  for (let y = 0, px = 0, i = 0; y < H; y++) {
    const inLabelRow = y >= ly0 && y < ly1;
    for (let x = 0; x < W; x++, px++, i += 3) {
      const t = inLabelRow && x >= lx0 && x < lx1 ? 0 : (texture[px] - 128) * k;
      out[i] = base[i] + t;
      out[i + 1] = base[i + 1] + t;
      out[i + 2] = base[i + 2] + t;
    }
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Bisection on the grain amplitude. Encoded size rises monotonically with
 * sigma for all three codecs, so ten halvings of [0, MAX_SIGMA] resolve sigma
 * to about 0.05 levels, far finer than BYTE_TOLERANCE needs. Returns the
 * closest file seen, so a target below the zero-grain size (or above the
 * MAX_SIGMA size) still yields the nearest achievable file instead of failing.
 */
async function searchGrain({ base, width, height, targetBytes, walk, encode, minSigma = 0 }) {
  const pixels = width * height;
  let lo = minSigma;
  let hi = MAX_SIGMA;
  let best = null;
  for (let step = 0; step < SEARCH_STEPS; step++) {
    const sigma = (lo + hi) / 2;
    const raw = addGrain(base, pixels, sigma, walk);
    const file = await encode(raw);
    const miss = Math.abs(file.length - targetBytes) / targetBytes;
    if (!best || miss < best.miss) best = { file, raw, sigma, miss };
    if (miss <= BYTE_TOLERANCE) break;
    if (file.length < targetBytes) lo = sigma;
    else hi = sigma;
  }
  return best;
}

// ── Drawing ────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const n1 = (v) => Math.round(v * 10) / 10;

/** Breaks a name into at most two label lines at a word boundary. */
function wrapName(name, maxChars) {
  if (name.length <= maxChars) return [name];
  const words = name.split(' ');
  let first = '';
  while (words.length > 1 && (first + ' ' + words[0]).trim().length <= maxChars)
    first = (first + ' ' + words.shift()).trim();
  if (!first) first = words.shift();
  const rest = words.join(' ');
  return [first, rest.length > maxChars ? `${rest.slice(0, maxChars - 1)}...` : rest];
}

/**
 * The barcode: fine vertical bars, 1-4 px wide AT MASTER SCALE, snapped to
 * whole pixels and drawn with crispEdges so each bar is a hard-edged column.
 * This is the single most blur-sensitive element in the picture.
 */
function barcode(rng, x, y, width, height) {
  const bars = [];
  let cursor = Math.round(x);
  const end = Math.round(x + width);
  let dark = true;
  while (cursor < end) {
    const w = Math.min(rng.int(1, 4), end - cursor);
    if (dark)
      bars.push(
        `<rect x="${cursor}" y="${Math.round(y)}" width="${w}" height="${Math.round(height)}"/>`,
      );
    cursor += w;
    dark = !dark;
  }
  return `<g fill="#111" shape-rendering="crispEdges">${bars.join('')}</g>`;
}

function productShape(photo, item, W, H, u) {
  const hue = photo.hue;
  const light = `hsl(${hue},52%,62%)`;
  const mid = `hsl(${hue},56%,46%)`;
  const dark = `hsl(${hue},60%,30%)`;
  const cx = W / 2;
  const defs = `
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${dark}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>`;
  if (item.itemType === 'book') {
    const bw = W * 0.5;
    const bh = H * 0.72;
    const bx = cx - bw / 2;
    const by = H * 0.12;
    const lines = wrapName(item.name, 16);
    return {
      defs,
      box: { x: bx, y: by, w: bw, h: bh },
      svg: `
        <rect x="${n1(bx)}" y="${n1(by)}" width="${n1(bw)}" height="${n1(bh)}" rx="${n1(u * 0.8)}" fill="url(#body)"/>
        <rect x="${n1(bx)}" y="${n1(by)}" width="${n1(bw * 0.07)}" height="${n1(bh)}" fill="${dark}" opacity="0.55"/>
        <rect x="${n1(bx + bw * 0.07)}" y="${n1(by)}" width="${n1(bw * 0.3)}" height="${n1(bh)}" fill="url(#sheen)"/>
        ${lines
          .map(
            (line, k) =>
              `<text x="${n1(bx + bw * 0.54)}" y="${n1(by + bh * 0.16 + k * u * 6.4)}" font-family="Georgia, 'Times New Roman', serif" font-size="${n1(u * 5.2)}" font-weight="700" fill="#fdfbf4" text-anchor="middle">${esc(line)}</text>`,
          )
          .join('')}
        <text x="${n1(bx + bw * 0.54)}" y="${n1(by + bh * 0.16 + lines.length * u * 6.4 + u * 1.5)}" font-family="Georgia, 'Times New Roman', serif" font-size="${n1(u * 2.6)}" fill="#fdfbf4" opacity="0.85" text-anchor="middle">${esc(item.customFields.author ?? '')}</text>`,
    };
  }
  const shapes = {
    box: { w: 0.56, h: 0.6, y: 0.2, rx: 1.6 },
    crate: { w: 0.66, h: 0.5, y: 0.28, rx: 1.0 },
    bottle: { w: 0.34, h: 0.62, y: 0.22, rx: 5 },
    tube: { w: 0.3, h: 0.66, y: 0.18, rx: 9 },
  };
  const s = shapes[photo.shape];
  const bw = W * s.w;
  const bh = H * s.h;
  const bx = cx - bw / 2;
  const by = H * s.y;
  let extra = '';
  if (photo.shape === 'bottle' || photo.shape === 'tube') {
    const nw = bw * 0.34;
    extra = `
      <rect x="${n1(cx - nw / 2)}" y="${n1(by - H * 0.085)}" width="${n1(nw)}" height="${n1(H * 0.1)}" rx="${n1(u)}" fill="${mid}"/>
      <rect x="${n1(cx - nw * 0.62)}" y="${n1(by - H * 0.12)}" width="${n1(nw * 1.24)}" height="${n1(H * 0.05)}" rx="${n1(u * 0.8)}" fill="#2b2b2e"/>`;
  }
  if (photo.shape === 'crate') {
    // Slats: 1 px hairlines across the body, the second blur tell after the barcode.
    const slats = [];
    for (let k = 1; k < 9; k++) {
      const y = Math.round(by + (bh * k) / 9) + 0.5;
      slats.push(`<line x1="${n1(bx)}" y1="${y}" x2="${n1(bx + bw)}" y2="${y}"/>`);
    }
    extra = `<g stroke="${dark}" stroke-width="1" shape-rendering="crispEdges" opacity="0.8">${slats.join('')}</g>`;
  }
  return {
    defs,
    box: { x: bx, y: by, w: bw, h: bh },
    svg: `
      <rect x="${n1(bx)}" y="${n1(by)}" width="${n1(bw)}" height="${n1(bh)}" rx="${n1(u * s.rx)}" fill="url(#body)"/>
      <rect x="${n1(bx)}" y="${n1(by)}" width="${n1(bw * 0.38)}" height="${n1(bh)}" rx="${n1(u * s.rx)}" fill="url(#sheen)"/>
      ${extra}`,
  };
}

/** The whole picture as SVG, at the master's exact pixel size. */
function buildSvg(item, photo) {
  const W = photo.width;
  const H = photo.height;
  const u = Math.min(W, H) / 100;
  const rng = createRng(DATASET_VERSION, 'drawing', item.index);
  const tint = photo.hue;
  const shape = productShape(photo, item, W, H, u);
  const { box } = shape;

  // Printed label, lower part of the product. Sizes are fractions of the image,
  // so at 1600 px the name is ~28 px tall and the small print ~11 px: legible in
  // the master, mush in an upscaled 200 px thumbnail. That contrast is the point.
  const lw = box.w * (item.itemType === 'book' ? 0.62 : 0.78);
  const lh = Math.min(box.h * 0.44, u * 30);
  const lx = box.x + (box.w - lw) / 2 + (item.itemType === 'book' ? box.w * 0.035 : 0);
  const ly = box.y + box.h - lh - box.h * 0.08;
  const pad = u * 1.4;
  const nameLines = item.itemType === 'book' ? [] : wrapName(item.name, 24);
  const nameSize = u * 2.3;
  let ty = ly + pad + nameSize;
  const text = [];
  for (const line of nameLines) {
    text.push(
      `<text x="${n1(lx + pad)}" y="${n1(ty)}" font-family="Helvetica, Arial, sans-serif" font-size="${n1(nameSize)}" font-weight="700" fill="#151515">${esc(line)}</text>`,
    );
    ty += nameSize * 1.18;
  }
  text.push(
    `<text x="${n1(lx + pad)}" y="${n1(ty + u * 0.4)}" font-family="Menlo, 'Courier New', monospace" font-size="${n1(u * 1.7)}" fill="#222">SKU ${esc(item.sku)}${item.barcode ? `  ISBN ${esc(item.barcode)}` : ''}</text>`,
  );
  ty += u * 2.6;
  const small = [
    `Lot ${rng.int(10, 99)}-${rng.int(1000, 9999)}  Qty/case ${rng.pick([6, 12, 24, 48])}  Net wt ${rng.int(1, 40)}.${rng.int(0, 9)} kg`,
    'Synthetic benchmark item. Not for resale. Keep dry. Store below 30 C.',
    `${esc(item.category)} / ${esc(item.supplier)}`,
  ];
  for (const line of small) {
    text.push(
      `<text x="${n1(lx + pad)}" y="${n1(ty)}" font-family="Helvetica, Arial, sans-serif" font-size="${n1(u * 0.95)}" fill="#333">${esc(line)}</text>`,
    );
    ty += u * 1.35;
  }
  const bcH = Math.max(u * 3.2, ly + lh - pad - ty - u * 0.2);
  const bars = barcode(rng, lx + pad, ly + lh - pad - bcH, lw * 0.62, bcH);

  // 1 px hairlines: a rule under the name block, a border on the label, and a
  // frame inset from the image edge. Centred on half-pixels so each is exactly
  // one device pixel wide instead of two half-grey ones.
  const hl = (v) => Math.round(v) + 0.5;
  const hair = `
    <g stroke="#1a1a1a" stroke-width="1" fill="none" shape-rendering="crispEdges">
      <rect x="${hl(lx)}" y="${hl(ly)}" width="${Math.round(lw)}" height="${Math.round(lh)}"/>
      <line x1="${hl(lx + pad)}" y1="${hl(ly + lh - pad - bcH - u * 0.7)}" x2="${hl(lx + lw - pad)}" y2="${hl(ly + lh - pad - bcH - u * 0.7)}"/>
      <line x1="${hl(lx + lw * 0.68)}" y1="${hl(ly + lh - pad - bcH)}" x2="${hl(lx + lw * 0.68)}" y2="${hl(ly + lh - pad)}"/>
    </g>
    <rect x="${hl(u * 2)}" y="${hl(u * 2)}" width="${Math.round(W - u * 4)}" height="${Math.round(H - u * 4)}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="1" shape-rendering="crispEdges"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.4" r="0.8">
      <stop offset="0" stop-color="hsl(${tint},10%,94%)"/><stop offset="0.6" stop-color="hsl(${tint},9%,84%)"/><stop offset="1" stop-color="hsl(${tint},10%,68%)"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.16"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="${n1(u * 1.8)}"/></filter>
    <clipPath id="label"><rect x="${n1(lx)}" y="${n1(ly)}" width="${n1(lw)}" height="${n1(lh)}"/></clipPath>
    ${shape.defs}
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect y="${n1(H * 0.7)}" width="${W}" height="${n1(H * 0.3)}" fill="url(#floor)"/>
  <ellipse cx="${n1(W / 2)}" cy="${n1(box.y + box.h + u * 1.2)}" rx="${n1(box.w * 0.56)}" ry="${n1(u * 3.4)}" fill="#000" opacity="0.34" filter="url(#soft)"/>
  ${shape.svg}
  <rect x="${n1(lx)}" y="${n1(ly)}" width="${n1(lw)}" height="${n1(lh)}" fill="#fbfaf6"/>
  <g clip-path="url(#label)">
  ${text.join('\n  ')}
  </g>
  ${bars}
  ${hair}
</svg>`;
  return { svg, label: { x: lx, y: ly, w: lw, h: lh } };
}

// ── Encoders ───────────────────────────────────────────────────────────────
function masterEncoder(photo) {
  const raw = { raw: { width: photo.width, height: photo.height, channels: 3 } };
  if (photo.format === 'jpeg') {
    // Baseline 4:2:0 at the quality a phone or an export dialog would pick.
    return (buf) =>
      sharp(buf, raw)
        .jpeg({
          quality: photo.jpegQuality,
          chromaSubsampling: '4:2:0',
          progressive: false,
          mozjpeg: false,
        })
        .toBuffer();
  }
  if (photo.format === 'webp') {
    // What the web uploader stores: canvas.toBlob('image/webp', 0.85).
    return (buf) => sharp(buf, raw).webp({ quality: WEBP_MASTER_QUALITY, effort: 4 }).toBuffer();
  }
  return (buf) => sharp(buf, raw).png({ compressionLevel: 9, palette: false }).toBuffer();
}

/**
 * Builds one item's master, thumbnail and LQIP.
 * Returns { master, thumb, lqip, sha256, sigma, thumbDims }.
 */
export async function generatePhoto(item) {
  const photo = item.photo;
  const drawing = buildSvg(item, photo);
  const render = await sharp(Buffer.from(drawing.svg))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    render.info.width !== photo.width ||
    render.info.height !== photo.height ||
    render.info.channels !== 3
  ) {
    throw new Error(
      `render for ${item.sku} came back ${render.info.width}x${render.info.height}x${render.info.channels}`,
    );
  }
  const walkRng = createRng(DATASET_VERSION, 'grain-walk', item.index);
  const walk = {
    lumaStart: walkRng.u32() & POOL_MASK,
    lumaStride: (walkRng.u32() & POOL_MASK) | 1,
    chromaStart: walkRng.u32() & POOL_MASK,
    chromaStride: (walkRng.u32() & POOL_MASK) | 1,
  };
  const W = photo.width;
  const H = photo.height;
  const encode = masterEncoder(photo);
  const texture = await buildTexture(W, H, item.index);
  const missOf = (file) => Math.abs(file.length - photo.targetBytes) / photo.targetBytes;
  const minSigma = minGrainFor(photo);

  // The lightest this photo can be at FULL texture: minimum grain, nothing else.
  let textureAmplitude = TEXTURE_AMPLITUDE;
  const textured = applyTexture(render.data, texture, TEXTURE_AMPLITUDE, drawing.label, W, H);
  const floorRaw = addGrain(textured, W * H, minSigma, walk);
  const floorFile = await encode(floorRaw);
  let found;
  if (missOf(floorFile) <= BYTE_TOLERANCE) {
    found = { file: floorFile, raw: floorRaw, sigma: minSigma, miss: missOf(floorFile) };
  } else if (floorFile.length < photo.targetBytes) {
    // The ordinary case: room to spare, so grain makes up the difference.
    found = await searchGrain({
      base: textured,
      width: W,
      height: H,
      targetBytes: photo.targetBytes,
      walk,
      encode,
      minSigma,
    });
  } else {
    // A smooth photo: the texture alone overshoots. Same fixed bisection, on the
    // texture amplitude, grain held at the minimum. Size rises monotonically with
    // amplitude, and at amplitude 0 the bare drawing is far under every target.
    let lo = 0;
    let hi = TEXTURE_AMPLITUDE;
    for (let step = 0; step < SEARCH_STEPS; step++) {
      const amplitude = (lo + hi) / 2;
      const raw = addGrain(
        applyTexture(render.data, texture, amplitude, drawing.label, W, H),
        W * H,
        minSigma,
        walk,
      );
      const file = await encode(raw);
      const miss = missOf(file);
      if (!found || miss < found.miss) {
        found = { file, raw, sigma: minSigma, miss };
        textureAmplitude = amplitude;
      }
      if (miss <= BYTE_TOLERANCE) break;
      if (file.length < photo.targetBytes) lo = amplitude;
      else hi = amplitude;
    }
  }
  const master = found.file;
  let thumbMiss = 0;
  const pixels = { raw: { width: photo.width, height: photo.height, channels: 3 } };

  // Thumbnail and LQIP come from the SAME pixels the master was encoded from,
  // as in the uploader (one decoded bitmap, three canvases). `fit: inside` +
  // withoutEnlargement is fitWithin(): long side 200, aspect kept, never
  // upscaled. (A browser canvas downsamples with a different kernel than
  // libvips' lanczos3; both are ordinary 200 px thumbnails of the same picture.)
  const inside = { fit: 'inside', withoutEnlargement: true };
  let thumb = null;
  let thumbDims = null;
  if (photo.thumbKind === 'webp-inside') {
    // The uploader, in a browser that can encode WebP.
    const out = await sharp(found.raw, pixels)
      .resize(THUMB_DIMENSION, THUMB_DIMENSION, inside)
      .webp({ quality: THUMB_QUALITY, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    thumb = out.data;
    thumbDims = { w: out.info.width, h: out.info.height };
  } else if (photo.thumbKind === 'webp-cover') {
    // backfill-item-thumbs.mjs: a signed transform of the master at
    // width 200, height 200, resize cover, fetched with Accept: image/webp. The
    // transform's default quality is 80. A SQUARE crop, unlike the uploader's.
    const out = await sharp(found.raw, pixels)
      .resize(THUMB_DIMENSION, THUMB_DIMENSION, { fit: 'cover' })
      .webp({ quality: THUMB_QUALITY, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    thumb = out.data;
    thumbDims = { w: out.info.width, h: out.info.height };
  } else if (photo.thumbKind === 'png-inside') {
    // The uploader in WebKit: the same 200 px canvas, encoded as PNG because that
    // is what WebKit returns when asked for WebP. Grain is searched AT THUMBNAIL
    // SCALE to the census byte target (dataset.mjs PNG_THUMB_KNOTS says why: a
    // real photo has detail at every scale, a drawing does not).
    const small = await sharp(found.raw, pixels)
      .resize(THUMB_DIMENSION, THUMB_DIMENSION, inside)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const t = { raw: { width: small.info.width, height: small.info.height, channels: 3 } };
    const png = await searchGrain({
      base: small.data,
      width: small.info.width,
      height: small.info.height,
      targetBytes: photo.thumbTargetBytes,
      walk,
      encode: (buf) => sharp(buf, t).png({ compressionLevel: 6, palette: false }).toBuffer(),
    });
    thumb = png.file;
    thumbDims = { w: small.info.width, h: small.info.height };
    thumbMiss = png.miss;
  }

  // The placeholder comes out of the same canvas call as the thumbnail, so it
  // shares its fate: data:image/webp from a WebP-capable browser, data:image/png
  // from WebKit. A 16 px RGB PNG is 0.6 to 0.9 KB, about 1.2 KB as a data URL, so
  // it fits the 2000-character cap (item_images_lqip_size_chk, migration 0122)
  // with room to spare; that is how production holds 67 of them.
  let lqip = null;
  if (photo.lqipKind) {
    const tinyPipe = sharp(found.raw, pixels).resize(LQIP_DIMENSION, LQIP_DIMENSION, inside);
    const tiny =
      photo.lqipKind === 'png'
        ? await tinyPipe.png({ compressionLevel: 6, palette: false }).toBuffer()
        : await tinyPipe.webp({ quality: LQIP_QUALITY, effort: 4 }).toBuffer();
    const dataUrl = `data:image/${photo.lqipKind};base64,${tiny.toString('base64')}`;
    // Same rule as the uploader and the 0122 CHECK: oversize => no placeholder.
    lqip = dataUrl.length <= LQIP_MAX_CHARS ? dataUrl : null;
  }

  return {
    master,
    thumb,
    lqip,
    thumbDims,
    sigma: found.sigma,
    textureAmplitude,
    miss: found.miss,
    thumbMiss,
    sha256: createHash('sha256').update(master).digest('hex'),
  };
}
