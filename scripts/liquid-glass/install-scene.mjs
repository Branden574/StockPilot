#!/usr/bin/env node
/**
 * Installs the two Liquid Glass scene photos (the out-of-focus stockroom
 * behind Day glass and Night glass) into the places the apps load them from,
 * after checking each one is the exact original, and writes the sizes the
 * plan needs (stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md 1.3 and 5.3;
 * FOLLOWUPS SC1).
 *
 *   node scripts/liquid-glass/install-scene.mjs <folder>
 *
 * <folder> holds light.jpg and dark.jpg (2400x1500 JPEGs). Nothing is written
 * unless BOTH match their SHA-256 below and every output path is ignored by
 * git.
 *
 * THE PHOTOS ARE NOT IN THE REPOSITORY. The repository is public and the
 * owner has not yet confirmed where the photos came from, so every output is
 * listed in .gitignore and this script refuses to write a path git would
 * track. With the files absent the apps show the opaque --bg colour, the
 * documented fallback, and CI never needs them.
 *
 * What it writes (SCENE_OUTPUTS, imported by the generators and guards so
 * there is one list of names):
 *   web, apps/web/public/liquid-glass/ (CSS backgrounds, image-set(), never
 *   preloaded):
 *     scene-<scheme>.jpg         the original, byte for byte (the JPEG fallback)
 *     scene-<scheme>-1x.avif     1200x750
 *     scene-<scheme>-1x.webp     1200x750
 *     scene-<scheme>-2x.avif     2400x1500
 *     scene-<scheme>-2x.webp     2400x1500
 *   phone, apps/mobile/assets/liquid-glass/ (bundled in the OTA):
 *     scene-<scheme>.jpg         pre-blurred, 1200x750: the content layer has
 *                                no live blur behind lists, so the photo is
 *                                blurred once here to what a pane would show
 *                                (--pane-blur 36, spec/design-system.md).
 * <scheme> is light (Day glass) or dark (Night glass).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The output paths git would track (not ignored) under `root`. */
export function trackedOutputs(root, outputs = SCENE_OUTPUTS) {
  return outputs
    .map((o) => o.path)
    .filter((path) => {
      try {
        execFileSync('git', ['-C', root, 'check-ignore', '-q', path], {
          stdio: 'ignore',
        });
        return false;
      } catch {
        return true;
      }
    });
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

/**
 * Check both originals, then write every output. Throws, having written
 * nothing, when a file is missing, is not the original, has another size, or
 * an output path is not ignored by git (when `requireIgnored`).
 * Returns the outputs written, with their sizes in bytes.
 */
export async function installScene({
  source,
  root = REPO_ROOT,
  expected = SCENE_SHA256,
  requireIgnored = true,
} = {}) {
  if (!source) throw new Error('usage: install-scene.mjs <folder holding light.jpg and dark.jpg>');
  const originals = {};
  for (const scheme of ['light', 'dark']) {
    const file = join(source, `${scheme}.jpg`);
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

  // sharp is a dependency of the web app (apps/web/package.json), not of the
  // repository root, so it is resolved from there.
  const sharp = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'))('sharp');
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

  if (requireIgnored) {
    const tracked = trackedOutputs(root);
    if (tracked.length > 0) {
      throw new Error(
        `refusing to write files git would track (add them to .gitignore): ${tracked.join(', ')}`,
      );
    }
  }

  // Encode everything first, then write, so a failure leaves nothing half done.
  const encoded = [];
  for (const output of SCENE_OUTPUTS) {
    const bytes =
      output.kind === 'copy'
        ? originals[output.scheme]
        : await encode(sharp, originals[output.scheme], output);
    encoded.push({ output, bytes });
  }
  const written = [];
  for (const { output, bytes } of encoded) {
    const target = join(root, output.path);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
    } finally {
      rmSync(tmp, { force: true });
    }
    written.push({ path: output.path, bytes: bytes.length });
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const source = process.argv[2];
  if (!source || source === '--help' || source === '-h') {
    console.info(
      'usage: node scripts/liquid-glass/install-scene.mjs <folder holding light.jpg and dark.jpg>',
    );
    process.exit(source ? 0 : 2);
  }
  installScene({ source: resolve(source) })
    .then((written) => {
      for (const { path, bytes } of written) {
        console.info(
          `wrote ${relative(process.cwd(), join(REPO_ROOT, path)) || path} (${bytes} bytes)`,
        );
      }
      console.info(
        'scene photos installed (ignored by git: never commit them until the owner confirms their source)',
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
