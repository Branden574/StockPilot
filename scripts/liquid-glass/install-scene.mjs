#!/usr/bin/env node
/**
 * The two Liquid Glass scene illustrations (the out-of-focus stockroom behind
 * Day glass and Night glass): writes every file the apps load, from the two
 * originals after checking each is the exact original, and checks the
 * committed files (stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md 1.3
 * and 5.3).
 *
 * The illustrations were made for StockPilot by Claude Design during the
 * Liquid Glass design work (confirmed 2026-11-05). Every file this script
 * writes is committed, and SCENE_MANIFEST pins the SHA-256 of each one.
 *
 *   node scripts/liquid-glass/install-scene.mjs <folder>
 *       from the originals: <folder> holds light.jpg and dark.jpg (2400x1500)
 *   node scripts/liquid-glass/install-scene.mjs --from-committed
 *       regenerates every output from the committed full-size web copies
 *       (apps/web/public/liquid-glass/scene-light.jpg and scene-dark.jpg, the
 *       originals byte for byte)
 *   node scripts/liquid-glass/install-scene.mjs --check
 *       writes nothing: checks the committed files (checkScene below)
 *
 * Nothing is written unless both sources are the originals (SCENE_SHA256)
 * and 2400x1500 JPEGs, every file to write has its stated container and size
 * and carries no metadata block, and no .gitignore rule covers an output (an
 * ignored output could not be committed, and the apps would be built without
 * it). The web and phone tests run checkScene, so a committed file that is
 * missing, altered or carries metadata fails a test.
 *
 * What it writes (SCENE_OUTPUTS, imported by the tests so there is one list
 * of names):
 *   web, apps/web/public/liquid-glass/ (named only by the two image-set()s in
 *   apps/web/src/styles/liquid-glass/scene.css, never preloaded; each address
 *   ends in ?v= and the first 12 hex digits of the file's SHA-256 in
 *   SCENE_MANIFEST, so the files are served as immutable, and
 *   scene-photo.test.ts fails until a rewritten file's new version is there):
 *     scene-<scheme>.jpg         the original, byte for byte (the JPEG fallback)
 *     scene-<scheme>-1x.avif     1200x750
 *     scene-<scheme>-1x.webp     1200x750
 *     scene-<scheme>-2x.avif     2400x1500
 *     scene-<scheme>-2x.webp     2400x1500
 *   phone, apps/mobile/assets/liquid-glass/ (bundled in the app and the OTA):
 *     scene-<scheme>.jpg         pre-blurred, 1200x750: the content layer has
 *                                no live blur behind lists, so the picture is
 *                                blurred once here to what a pane would show
 *                                (--pane-blur 36, spec/design-system.md).
 *   SCENE_MANIFEST, scripts/liquid-glass/scene-files.sha256: one
 *     "<sha256>  <path>" line per output, in SCENE_OUTPUTS order, so
 *     `shasum -a 256 -c scripts/liquid-glass/scene-files.sha256` checks them
 *     from the repository root.
 * <scheme> is light (Day glass) or dark (Night glass). sharp writes no
 * metadata unless asked (no EXIF, XMP, IPTC or ICC profile) and the originals
 * hold none either; inspectImage reads every segment, chunk or box to prove it.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE =
  'node scripts/liquid-glass/install-scene.mjs <folder holding light.jpg and dark.jpg> | --from-committed | --check';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/** The originals, sha-verified against the design artifact's asset store (DECISIONS Q7). */
export const SCENE_SHA256 = {
  light: '023a8ee4de8794c6541247d61626e020d8e9c702202e986aea80dcf5d834de50',
  dark: 'b809c59334caa8d23ac43d02c67b93534bd6cf552d51d5df6a37a1d4c7ee62cb',
};

export const SCENE_SIZE = { width: 2400, height: 1500 };

/**
 * The phone's pre-blur. The scene fills a portrait phone by `cover`, so its
 * 750 px height spans about 844 pt: a 36 pt pane blur is about 32 px here.
 */
export const PHONE_BLUR_SIGMA = 32;

const WEB_DIR = join('apps', 'web', 'public', 'liquid-glass');
const PHONE_DIR = join('apps', 'mobile', 'assets', 'liquid-glass');

/** The pinned SHA-256 of every output, relative to the repository root. */
export const SCENE_MANIFEST = join('scripts', 'liquid-glass', 'scene-files.sha256');

/** The committed full-size web copies: the originals byte for byte, the source of --from-committed. */
export const COMMITTED_SOURCES = {
  light: join(WEB_DIR, 'scene-light.jpg'),
  dark: join(WEB_DIR, 'scene-dark.jpg'),
};

/**
 * Every file this script writes, relative to the repository root, with how
 * it is made. `copy` is the original bytes; the others are encoded from it.
 */
export const SCENE_OUTPUTS = ['light', 'dark'].flatMap((scheme) => [
  { scheme, app: 'web', path: join(WEB_DIR, `scene-${scheme}.jpg`), kind: 'copy' },
  { scheme, app: 'web', path: join(WEB_DIR, `scene-${scheme}-1x.avif`), kind: 'avif', width: 1200 },
  { scheme, app: 'web', path: join(WEB_DIR, `scene-${scheme}-1x.webp`), kind: 'webp', width: 1200 },
  { scheme, app: 'web', path: join(WEB_DIR, `scene-${scheme}-2x.avif`), kind: 'avif', width: 2400 },
  { scheme, app: 'web', path: join(WEB_DIR, `scene-${scheme}-2x.webp`), kind: 'webp', width: 2400 },
  {
    scheme,
    app: 'phone',
    path: join(PHONE_DIR, `scene-${scheme}.jpg`),
    kind: 'blurred-jpeg',
    width: 1200,
  },
]);

/** The container and pixel size an output must have. */
export function expectedImage(output) {
  const width = output.kind === 'copy' ? SCENE_SIZE.width : output.width;
  return {
    format: output.kind === 'avif' ? 'avif' : output.kind === 'webp' ? 'webp' : 'jpeg',
    width,
    height: (width * SCENE_SIZE.height) / SCENE_SIZE.width,
  };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The output paths a .gitignore rule under `root` covers. The rules are read
 * on their own (--no-index), whether or not a file is tracked: an ignored
 * output could not be added to the repository, so the apps would be built
 * without it.
 */
export function ignoredOutputs(root, outputs = SCENE_OUTPUTS) {
  return outputs
    .map((o) => o.path)
    .filter((path) => {
      const run = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', path], {
        stdio: 'ignore',
      });
      if (run.status === 0) return true;
      if (run.status === 1) return false;
      throw new Error(
        `cannot read the .gitignore rules of ${root} (git check-ignore exit ${run.status})`,
      );
    });
}

/** The manifest's text for these entries, in the order given. */
export function manifestText(entries) {
  return entries.map(({ path, sha }) => `${sha}  ${path.split('\\').join('/')}\n`).join('');
}

/** The pinned SHA-256 by path, in the manifest's order. Throws on an unreadable line. */
export function readManifest(root = REPO_ROOT) {
  const entries = new Map();
  for (const line of readFileSync(join(root, SCENE_MANIFEST), 'utf8').split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64}) [ *](\S+)$/u.exec(line);
    if (!m) throw new Error(`unreadable line "${line}"`);
    entries.set(m[2], m[1]);
  }
  return entries;
}

// ── Reading the bytes: container, size and every metadata block ──────────────

const ascii = (bytes, from, length) =>
  Buffer.from(bytes.subarray(from, from + length)).toString('latin1');

/** JPEG: every marker segment up to EOI, the entropy-coded scans skipped. */
function inspectJpeg(b) {
  const out = { format: 'jpeg', width: null, height: null, blocks: [], metadata: [] };
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) throw new Error(`jpeg: no marker at byte ${i}`);
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // a fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) {
      out.blocks.push('EOI');
      return out;
    }
    if (i + 4 > b.length) throw new Error('jpeg: a segment runs past the end');
    const length = (b[i + 2] << 8) | b[i + 3];
    const body = b.subarray(i + 4, i + 2 + length);
    if (marker >= 0xe0 && marker <= 0xef) {
      const n = marker - 0xe0;
      const id = ascii(body, 0, 40);
      if (n === 0 && id.startsWith('JFIF\0')) out.blocks.push('APP0 JFIF');
      else if (n === 14 && id.startsWith('Adobe')) out.blocks.push('APP14 Adobe');
      else {
        out.blocks.push(`APP${n}`);
        out.metadata.push(
          n === 1 && id.startsWith('Exif\0')
            ? 'EXIF'
            : n === 1 && id.startsWith('http://ns.adobe.com/x')
              ? 'XMP'
              : n === 2 && id.startsWith('ICC_PROFILE\0')
                ? 'ICC profile'
                : n === 13 && id.startsWith('Photoshop 3.0\0')
                  ? 'IPTC (Photoshop 3.0)'
                  : n === 11
                    ? 'JUMBF (C2PA)'
                    : n === 0 && id.startsWith('JFXX\0')
                      ? 'JFXX thumbnail'
                      : `APP${n} ${JSON.stringify(id.replace(/\0.*$/su, ''))}`,
        );
      }
    } else if (marker === 0xfe) {
      out.blocks.push('COM');
      out.metadata.push('comment');
    } else {
      out.blocks.push(`FF${marker.toString(16).toUpperCase()}`);
      // SOF0-3, 5-7, 9-11 and 13-15 carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        out.height = (body[1] << 8) | body[2];
        out.width = (body[3] << 8) | body[4];
      }
    }
    i += 2 + length;
    if (marker === 0xda) {
      // Entropy-coded data, up to the next marker that is not a stuffed 00 or a restart.
      while (
        i + 1 < b.length &&
        !(b[i] === 0xff && b[i + 1] !== 0 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7))
      ) {
        i += 1;
      }
    }
  }
  throw new Error('jpeg: no EOI marker');
}

/** WebP: every RIFF chunk. */
function inspectWebp(b) {
  const out = { format: 'webp', width: null, height: null, blocks: [], metadata: [] };
  const end = Math.min(b.length, 8 + b.readUInt32LE(4));
  let i = 12;
  while (i + 8 <= end) {
    const fourcc = ascii(b, i, 4);
    const size = b.readUInt32LE(i + 4);
    const data = b.subarray(i + 8, i + 8 + size);
    out.blocks.push(fourcc);
    if (fourcc === 'VP8 ') {
      out.width = data.readUInt16LE(6) & 0x3fff;
      out.height = data.readUInt16LE(8) & 0x3fff;
    } else if (fourcc === 'VP8L') {
      const bits = data.readUInt32LE(1);
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >> 14) & 0x3fff) + 1;
    } else if (fourcc === 'VP8X') {
      const flags = data[0];
      if (flags & 0x20) out.metadata.push('ICC profile (VP8X flag)');
      if (flags & 0x08) out.metadata.push('EXIF (VP8X flag)');
      if (flags & 0x04) out.metadata.push('XMP (VP8X flag)');
      out.width = 1 + data.readUIntLE(4, 3);
      out.height = 1 + data.readUIntLE(7, 3);
    } else if (fourcc === 'EXIF') out.metadata.push('EXIF');
    else if (fourcc === 'XMP ') out.metadata.push('XMP');
    else if (fourcc === 'ICCP') out.metadata.push('ICC profile');
    else if (!['ALPH', 'ANIM', 'ANMF'].includes(fourcc)) {
      out.metadata.push(`chunk ${JSON.stringify(fourcc)}`);
    }
    i += 8 + size + (size % 2);
  }
  if (i !== end) throw new Error('webp: a chunk runs past the end');
  return out;
}

const AVIF_TOP = ['ftyp', 'meta', 'mdat', 'free', 'skip'];
const AVIF_META = ['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat', 'dinf', 'grpl'];
const AVIF_ITEMS = ['av01', 'grid', 'iden', 'iovl', 'tmap'];
const AVIF_PROPERTIES = [
  'ispe',
  'pixi',
  'av1C',
  'colr',
  'pasp',
  'clap',
  'irot',
  'imir',
  'auxC',
  'a1op',
  'lsel',
  'a1lx',
  'clli',
  'mdcv',
];

/** AVIF (ISO BMFF): every top-level box, the meta box's items and its properties. */
function inspectAvif(b) {
  const out = { format: 'avif', width: null, height: null, blocks: [], metadata: [] };
  const boxes = (from, to) => {
    const list = [];
    let i = from;
    while (i + 8 <= to) {
      let size = b.readUInt32BE(i);
      const type = ascii(b, i + 4, 4);
      let header = 8;
      if (size === 1) {
        size = Number(b.readBigUInt64BE(i + 8));
        header = 16;
      } else if (size === 0) size = to - i;
      if (size < header || i + size > to) throw new Error(`avif: box ${type} runs past its parent`);
      list.push({ type, start: i + header, end: i + size });
      i += size;
    }
    if (i !== to) throw new Error('avif: trailing bytes in a box');
    return list;
  };
  for (const top of boxes(0, b.length)) {
    out.blocks.push(top.type);
    if (top.type === 'ftyp') {
      const brand = ascii(b, top.start, 4);
      if (brand !== 'avif') throw new Error(`avif: major brand ${brand}`);
    } else if (top.type === 'meta') {
      for (const box of boxes(top.start + 4, top.end)) {
        out.blocks.push(`meta/${box.type}`);
        if (!AVIF_META.includes(box.type)) {
          out.metadata.push(`meta box ${JSON.stringify(box.type)}`);
        }
        if (box.type === 'iinf') {
          const version = b[box.start];
          const first = box.start + 4 + (version === 0 ? 2 : 4);
          for (const infe of boxes(first, box.end)) {
            const v = b[infe.start];
            if (infe.type !== 'infe' || v < 2) {
              out.metadata.push(`item info ${infe.type} v${v}`);
              continue;
            }
            const itemType = ascii(b, infe.start + 4 + (v === 2 ? 2 : 4) + 2, 4);
            out.blocks.push(`item ${itemType}`);
            if (itemType === 'Exif') out.metadata.push('EXIF item');
            else if (itemType === 'mime') out.metadata.push('mime item (XMP)');
            else if (!AVIF_ITEMS.includes(itemType)) {
              out.metadata.push(`item ${JSON.stringify(itemType)}`);
            }
          }
        }
        if (box.type === 'iprp') {
          for (const sub of boxes(box.start, box.end)) {
            if (sub.type !== 'ipco') continue;
            for (const prop of boxes(sub.start, sub.end)) {
              out.blocks.push(`prop ${prop.type}`);
              if (prop.type === 'ispe') {
                const width = b.readUInt32BE(prop.start + 4);
                const height = b.readUInt32BE(prop.start + 8);
                if (width > (out.width ?? 0)) {
                  out.width = width;
                  out.height = height;
                }
              } else if (prop.type === 'colr') {
                const kind = ascii(b, prop.start, 4);
                if (kind !== 'nclx') {
                  out.metadata.push(`colour profile ${JSON.stringify(kind)} (ICC)`);
                }
              } else if (!AVIF_PROPERTIES.includes(prop.type)) {
                out.metadata.push(`property ${JSON.stringify(prop.type)}`);
              }
            }
          }
        }
      }
    } else if (!AVIF_TOP.includes(top.type)) {
      out.metadata.push(
        top.type === 'uuid' || top.type === 'jumb'
          ? `${top.type} box (C2PA or other)`
          : `box ${JSON.stringify(top.type)}`,
      );
    }
  }
  return out;
}

/**
 * The container, pixel size, every block and every metadata block of a JPEG,
 * WebP or AVIF file, read from its bytes (no decoder). `metadata` lists EXIF
 * (and so GPS, which lives in EXIF or XMP), XMP, IPTC, ICC profiles, comments,
 * JUMBF/C2PA and any block this reader does not know; it is empty when the
 * file holds pixels only.
 */
export function inspectImage(bytes) {
  const b = Buffer.from(bytes);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return inspectJpeg(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return inspectWebp(b);
  if (ascii(b, 4, 4) === 'ftyp') return inspectAvif(b);
  throw new Error('not a JPEG, WebP or AVIF file');
}

/** Why these bytes are not a valid `output` (wrong container or size, or a metadata block); [] when they are. */
function imageProblems(output, bytes) {
  const want = expectedImage(output);
  let info;
  try {
    info = inspectImage(bytes);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const problems = [];
  if (info.format !== want.format || info.width !== want.width || info.height !== want.height) {
    problems.push(
      `is ${info.format} ${info.width}x${info.height}, expected ${want.format} ${want.width}x${want.height}`,
    );
  }
  if (info.metadata.length > 0) problems.push(`carries ${info.metadata.join(', ')}`);
  return problems;
}

// sharp is a dependency of the web app (apps/web/package.json), not of the
// repository root, so it is resolved from there.
const loadSharp = () => createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'))('sharp');

/**
 * Checks the committed files under `root` and returns every problem found
 * (an empty list when all is well): the manifest lists exactly SCENE_OUTPUTS,
 * in order; each file (of `app`, or of both apps) is there, has the SHA-256
 * the manifest pins (the full-size web copies: the originals' SHA-256 too),
 * is the stated container and size, carries no metadata block, and (with
 * `decode`) decodes at that size.
 */
export async function checkScene({
  root = REPO_ROOT,
  decode = true,
  app,
  expected = SCENE_SHA256,
} = {}) {
  const problems = [];
  let manifest;
  try {
    manifest = readManifest(root);
  } catch (error) {
    return [`${SCENE_MANIFEST}: ${error instanceof Error ? error.message : error}`];
  }
  const listed = [...manifest.keys()].join(', ');
  const wanted = SCENE_OUTPUTS.map((o) => o.path.split('\\').join('/')).join(', ');
  if (listed !== wanted) problems.push(`${SCENE_MANIFEST} lists ${listed}; expected ${wanted}`);
  const sharp = decode ? loadSharp() : null;
  for (const output of SCENE_OUTPUTS.filter((o) => !app || o.app === app)) {
    const file = join(root, output.path);
    if (!existsSync(file)) {
      problems.push(`${output.path} is missing`);
      continue;
    }
    const bytes = readFileSync(file);
    const digest = sha256(bytes);
    const pinned = manifest.get(output.path.split('\\').join('/'));
    if (pinned !== undefined && pinned !== digest) {
      problems.push(`${output.path} is not the file ${SCENE_MANIFEST} pins (sha256 ${digest})`);
    }
    if (output.kind === 'copy' && digest !== expected[output.scheme]) {
      problems.push(`${output.path} is not the original ${output.scheme} scene (sha256 ${digest})`);
    }
    problems.push(...imageProblems(output, bytes).map((p) => `${output.path} ${p}`));
    if (sharp) {
      const want = expectedImage(output);
      try {
        const { info } = await sharp(bytes, { failOn: 'error' })
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (info.width !== want.width || info.height !== want.height) {
          problems.push(
            `${output.path} decodes at ${info.width}x${info.height}, expected ${want.width}x${want.height}`,
          );
        }
      } catch (error) {
        problems.push(
          `${output.path} does not decode: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  return problems;
}

async function encode(sharp, bytes, output) {
  const image = sharp(bytes, { failOn: 'error' }).rotate();
  const sized = output.width ? image.resize({ width: output.width }) : image;
  switch (output.kind) {
    case 'avif':
      return sized.avif({ quality: 50, effort: 6 }).toBuffer();
    case 'webp':
      return sized.webp({ quality: 72, effort: 6 }).toBuffer();
    case 'blurred-jpeg':
      return sized
        .blur(PHONE_BLUR_SIGMA)
        .jpeg({ quality: 78, progressive: true, mozjpeg: true })
        .toBuffer();
    default:
      throw new Error(`unknown output kind ${output.kind}`);
  }
}

/** The two source files: light.jpg and dark.jpg in a folder, or a path per scheme. */
function sourcePaths(source) {
  if (typeof source === 'string') {
    return { light: join(source, 'light.jpg'), dark: join(source, 'dark.jpg') };
  }
  return source;
}

/**
 * Checks both sources, then writes every output and the manifest. Throws,
 * having written nothing, when a source is missing, is not the original or
 * has another size, when a file to write has the wrong container or size or
 * carries metadata, or when a .gitignore rule covers an output (with
 * `requireCommittable`). Returns the outputs written, with their sizes in
 * bytes and their SHA-256.
 *
 * `source` is a folder holding light.jpg and dark.jpg, or { light, dark }
 * file paths; `fromCommitted` reads the committed full-size web copies under
 * `root` instead.
 */
export async function installScene({
  source,
  fromCommitted = false,
  root = REPO_ROOT,
  expected = SCENE_SHA256,
  requireCommittable = true,
} = {}) {
  const paths = fromCommitted
    ? { light: join(root, COMMITTED_SOURCES.light), dark: join(root, COMMITTED_SOURCES.dark) }
    : source
      ? sourcePaths(source)
      : null;
  if (!paths) throw new Error(`usage: ${USAGE}`);
  const originals = {};
  for (const scheme of ['light', 'dark']) {
    const file = paths[scheme];
    if (!existsSync(file)) throw new Error(`missing ${file}`);
    const bytes = readFileSync(file);
    const digest = sha256(bytes);
    if (digest !== expected[scheme]) {
      throw new Error(
        `${file} is not the original ${scheme} scene: sha256 ${digest}, expected ${expected[scheme]}`,
      );
    }
    originals[scheme] = bytes;
  }

  const sharp = loadSharp();
  for (const [scheme, bytes] of Object.entries(originals)) {
    const meta = await sharp(bytes).metadata();
    if (
      meta.format !== 'jpeg' ||
      meta.width !== SCENE_SIZE.width ||
      meta.height !== SCENE_SIZE.height
    ) {
      throw new Error(
        `${scheme}.jpg is ${meta.format} ${meta.width}x${meta.height}, expected jpeg ${SCENE_SIZE.width}x${SCENE_SIZE.height}`,
      );
    }
  }

  if (requireCommittable) {
    const ignored = ignoredOutputs(root, [...SCENE_OUTPUTS, { path: SCENE_MANIFEST }]);
    if (ignored.length > 0) {
      throw new Error(
        `refusing to write files a .gitignore rule keeps out of the repository (they are committed): ${ignored.join(', ')}`,
      );
    }
  }

  // Encode and check everything first, then write, so a failure leaves nothing half done.
  const encoded = [];
  for (const output of SCENE_OUTPUTS) {
    const bytes =
      output.kind === 'copy'
        ? originals[output.scheme]
        : await encode(sharp, originals[output.scheme], output);
    const problems = imageProblems(output, bytes);
    if (problems.length > 0) {
      throw new Error(`refusing to write ${output.path}: it ${problems.join('; ')}`);
    }
    encoded.push({ path: output.path, bytes });
  }
  const written = encoded.map(({ path, bytes }) => ({
    path,
    bytes: bytes.length,
    sha: sha256(bytes),
  }));
  encoded.push({ path: SCENE_MANIFEST, bytes: Buffer.from(manifestText(written)) });
  for (const { path, bytes } of encoded) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    console.info(`usage: ${USAGE}`);
    process.exit(arg ? 0 : 2);
  }
  const done =
    arg === '--check'
      ? checkScene().then((problems) => {
          for (const problem of problems) console.error(problem);
          if (problems.length > 0) process.exit(1);
          console.info(
            `every scene file is the one ${SCENE_MANIFEST} pins, at its size, with no metadata`,
          );
        })
      : installScene(
          arg === '--from-committed' ? { fromCommitted: true } : { source: resolve(arg) },
        ).then((written) => {
          for (const { path, bytes } of written) {
            console.info(
              `wrote ${relative(process.cwd(), join(REPO_ROOT, path)) || path} (${bytes} bytes)`,
            );
          }
          console.info(`wrote ${SCENE_MANIFEST}: commit the scene files and the manifest together`);
        });
  done.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
