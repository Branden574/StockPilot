import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  SCENE_OUTPUTS,
  SCENE_SHA256,
  installScene,
  sha256,
  trackedOutputs,
} from '../../../../../scripts/liquid-glass/install-scene.mjs';

/**
 * scripts/liquid-glass/install-scene.mjs: the scene photos are never in the
 * public repository (owner, FOLLOWUPS SC1); the script installs them locally,
 * only when they are the exact originals, only into paths git ignores. These
 * tests use synthetic gradients, never the photos.
 */

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lg-scene-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function syntheticJpeg(width: number, height: number, tint: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = ((x >> 4) + (y >> 4)) % 2 === 0 ? tint : 255 - tint;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** A folder holding light.jpg and dark.jpg, and the hashes that make them "originals". */
async function sourceFolder(width = 2400, height = 1500) {
  const dir = tempDir();
  const light = await syntheticJpeg(width, height, 40);
  const dark = await syntheticJpeg(width, height, 200);
  writeFileSync(join(dir, 'light.jpg'), light);
  writeFileSync(join(dir, 'dark.jpg'), dark);
  return { dir, light, dark, expected: { light: sha256(light), dark: sha256(dark) } };
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('install-scene', () => {
  it('checks the two originals by their published SHA-256', () => {
    expect(SCENE_SHA256).toEqual({
      light: '023a8ee4de8794c6541247d61626e020d8e9c702202e986aea80dcf5d834de50',
      dark: 'b809c59334caa8d23ac43d02c67b93534bd6cf552d51d5df6a37a1d4c7ee62cb',
    });
  });

  it('every output path is ignored by the repository .gitignore, so the photos cannot be committed', () => {
    expect(SCENE_OUTPUTS.length).toBe(12);
    expect(trackedOutputs(REPO_ROOT)).toEqual([]);
  });

  it('writes only under the web public folder and the phone assets folder', () => {
    for (const output of SCENE_OUTPUTS) {
      expect(output.path).toMatch(
        /^apps\/(web\/public|mobile\/assets)\/liquid-glass\/scene-(light|dark)(-[12]x)?\.(jpg|avif|webp)$/u,
      );
    }
  });

  it('refuses a file that is not the original and writes nothing', async () => {
    const source = await sourceFolder(64, 40);
    const root = tempDir();
    await expect(installScene({ source: source.dir, root, requireIgnored: false })).rejects.toThrow(
      /is not the original light scene/u,
    );
    expect(filesUnder(root)).toEqual([]);
  });

  it('refuses a missing file and writes nothing', async () => {
    const source = await sourceFolder(64, 40);
    rmSync(join(source.dir, 'dark.jpg'));
    const root = tempDir();
    await expect(
      installScene({ source: source.dir, root, expected: source.expected, requireIgnored: false }),
    ).rejects.toThrow(/missing .*dark\.jpg/u);
    expect(filesUnder(root)).toEqual([]);
  });

  it('refuses an image of another size even when the hash is the expected one', async () => {
    const source = await sourceFolder(64, 40);
    const root = tempDir();
    await expect(
      installScene({ source: source.dir, root, expected: source.expected, requireIgnored: false }),
    ).rejects.toThrow(/expected jpeg 2400x1500/u);
    expect(filesUnder(root)).toEqual([]);
  });

  it('refuses to write into a checkout whose .gitignore does not cover the outputs', async () => {
    const source = await sourceFolder();
    const root = tempDir();
    execFileSync('git', ['init', '-q', root]);
    await expect(
      installScene({ source: source.dir, root, expected: source.expected }),
    ).rejects.toThrow(/refusing to write files git would track/u);
    expect(filesUnder(root).filter((f) => !f.includes(`${root}/.git/`))).toEqual([]);
  });

  it('writes the original, the 1x and 2x AVIF and WebP for the web, and a blurred phone JPEG', async () => {
    const source = await sourceFolder();
    const root = tempDir();
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, '.gitignore'),
      'apps/web/public/liquid-glass/scene-*\napps/mobile/assets/liquid-glass/scene-*\n',
    );
    const written = await installScene({ source: source.dir, root, expected: source.expected });
    expect(written.map((w) => w.path).sort()).toEqual(SCENE_OUTPUTS.map((o) => o.path).sort());

    for (const output of SCENE_OUTPUTS) {
      const bytes = readFileSync(join(root, output.path));
      const original = output.scheme === 'light' ? source.light : source.dark;
      const meta = await sharp(bytes).metadata();
      if (output.kind === 'copy') {
        expect(bytes.equals(original)).toBe(true);
        continue;
      }
      expect(meta.format).toBe(
        output.kind === 'blurred-jpeg' ? 'jpeg' : output.kind === 'avif' ? 'heif' : 'webp',
      );
      expect(meta.width).toBe(output.width);
      expect(meta.height).toBe((output.width! * 1500) / 2400);
    }

    // The phone copy is blurred: far less detail than the same size unblurred.
    const phone = SCENE_OUTPUTS.find((o) => o.app === 'phone' && o.scheme === 'light')!;
    const blurred = await sharp(readFileSync(join(root, phone.path)))
      .greyscale()
      .raw()
      .toBuffer();
    const sharpCopy = await sharp(source.light)
      .resize({ width: 1200 })
      .greyscale()
      .raw()
      .toBuffer();
    const edges = (px: Buffer) => {
      let sum = 0;
      for (let i = 1; i < px.length; i += 1) sum += Math.abs(px[i]! - px[i - 1]!);
      return sum;
    };
    expect(edges(blurred)).toBeLessThan(edges(sharpCopy));
  }, 120_000);
});
