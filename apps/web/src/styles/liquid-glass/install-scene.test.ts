import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import sharp, { type Sharp } from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMMITTED_SOURCES,
  REPO_ROOT,
  SCENE_MANIFEST,
  SCENE_OUTPUTS,
  SCENE_SHA256,
  checkScene,
  ignoredOutputs,
  inspectImage,
  installScene,
  manifestText,
  readManifest,
  sha256,
} from '../../../../../scripts/liquid-glass/install-scene.mjs';

/**
 * scripts/liquid-glass/install-scene.mjs. The scene illustrations were made
 * for StockPilot by Claude Design during the Liquid Glass design work
 * (confirmed 2026-11-05) and are committed: the script writes every output
 * from the two originals (sha-checked) or from the committed full-size
 * copies, only into paths no .gitignore rule keeps out, and pins each one in
 * the manifest; checkScene fails on a committed file that is missing, altered
 * or carries metadata. The tests that write use synthetic gradients in
 * throwaway folders, never the repository.
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

/** An empty git checkout (no .gitignore unless one is written). */
function checkout(): string {
  const root = tempDir();
  execFileSync('git', ['init', '-q', root]);
  return root;
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${root}/.git/`));
}

/** A copy of the committed files and the manifest in a throwaway folder. */
function committedCopy(): string {
  const root = tempDir();
  for (const path of [...SCENE_OUTPUTS.map((o) => o.path), SCENE_MANIFEST]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), join(root, path));
  }
  return root;
}

/** These JPEG bytes with one more segment right after the SOI marker. */
function withSegment(jpeg: Buffer, marker: number, body: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, marker]),
    length,
    body,
    jpeg.subarray(2),
  ]);
}

describe('install-scene', () => {
  it('checks the two originals by their published SHA-256', () => {
    expect(SCENE_SHA256).toEqual({
      light: '023a8ee4de8794c6541247d61626e020d8e9c702202e986aea80dcf5d834de50',
      dark: 'b809c59334caa8d23ac43d02c67b93534bd6cf552d51d5df6a37a1d4c7ee62cb',
    });
  });

  it('writes only under the web public folder and the phone assets folder', () => {
    expect(SCENE_OUTPUTS.length).toBe(12);
    for (const output of SCENE_OUTPUTS) {
      expect(output.path).toMatch(
        /^apps\/(web\/public|mobile\/assets)\/liquid-glass\/scene-(light|dark)(-[12]x)?\.(jpg|avif|webp)$/u,
      );
    }
    expect(COMMITTED_SOURCES).toEqual({
      light: 'apps/web/public/liquid-glass/scene-light.jpg',
      dark: 'apps/web/public/liquid-glass/scene-dark.jpg',
    });
  });

  it('every output and the manifest are committed: git tracks each, and no .gitignore rule keeps one out', () => {
    const paths = [...SCENE_OUTPUTS.map((o) => o.path), SCENE_MANIFEST];
    expect(
      ignoredOutputs(
        REPO_ROOT,
        paths.map((path) => ({ path })),
      ),
    ).toEqual([]);
    const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...paths], {
      encoding: 'utf8',
    });
    expect(tracked.split('\n').filter(Boolean).sort()).toEqual([...paths].sort());
  });

  it('the committed files are the ones the manifest pins: the originals byte for byte, each at its size, no metadata, each decodes', async () => {
    expect([...readManifest().keys()]).toEqual(SCENE_OUTPUTS.map((o) => o.path));
    for (const scheme of ['light', 'dark'] as const) {
      expect(readManifest().get(COMMITTED_SOURCES[scheme])).toBe(SCENE_SHA256[scheme]);
    }
    expect(await checkScene()).toEqual([]);
  }, 60_000);

  it('checkScene fails on a missing file, an altered file, a manifest that leaves one out, and a file carrying metadata', async () => {
    const root = committedCopy();
    expect(await checkScene({ root, decode: false })).toEqual([]);

    const [lightJpg, light1xAvif, , , light2xWebp, phoneLight] = SCENE_OUTPUTS;
    rmSync(join(root, lightJpg!.path));
    const avif = readFileSync(join(root, light1xAvif!.path));
    avif.writeUInt8(avif.readUInt8(avif.length - 1) ^ 0xff, avif.length - 1);
    writeFileSync(join(root, light1xAvif!.path), avif);
    const manifest = readFileSync(join(root, SCENE_MANIFEST), 'utf8')
      .split('\n')
      .filter((line) => !line.endsWith(light2xWebp!.path))
      .join('\n');
    writeFileSync(join(root, SCENE_MANIFEST), manifest);
    const tagged = await sharp(readFileSync(join(root, phoneLight!.path)))
      .withExif({ IFD0: { Copyright: 'example.test' } })
      .jpeg()
      .toBuffer();
    writeFileSync(join(root, phoneLight!.path), tagged);

    const problems = await checkScene({ root, decode: false });
    expect(problems).toEqual(
      expect.arrayContaining([
        `${lightJpg!.path} is missing`,
        expect.stringMatching(new RegExp(`^${light1xAvif!.path} is not the file .* pins`, 'u')),
        expect.stringMatching(new RegExp(`^${SCENE_MANIFEST} lists `, 'u')),
        expect.stringMatching(new RegExp(`^${phoneLight!.path} carries EXIF`, 'u')),
      ]),
    );
    // And a changed full-size copy is no longer the original.
    writeFileSync(join(root, lightJpg!.path), tagged);
    expect(await checkScene({ root, decode: false })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^${lightJpg!.path} is not the original light scene`, 'u'),
        ),
      ]),
    );
  }, 60_000);

  it('reads every metadata block a JPEG, WebP or AVIF can carry, and the committed files carry none', async () => {
    const pixels = await syntheticJpeg(64, 40, 90);
    const exif = { IFD0: { Copyright: 'example.test' } };
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>';
    const meta = async (image: Sharp) => inspectImage(await image.toBuffer()).metadata;

    expect(inspectImage(pixels).metadata).toEqual([]);
    expect(await meta(sharp(pixels).withExif(exif).jpeg())).toEqual(['EXIF']);
    expect(await meta(sharp(pixels).withXmp(xmp).jpeg())).toEqual(['XMP']);
    expect(await meta(sharp(pixels).withIccProfile('srgb').jpeg())).toEqual(['ICC profile']);
    const iptc = withSegment(pixels, 0xed, Buffer.from('Photoshop 3.0\0', 'latin1'));
    expect(inspectImage(iptc).metadata).toEqual(['IPTC (Photoshop 3.0)']);
    const c2pa = withSegment(pixels, 0xeb, Buffer.from('JP\0\0', 'latin1'));
    expect(inspectImage(c2pa).metadata).toEqual(['JUMBF (C2PA)']);
    const comment = withSegment(pixels, 0xfe, Buffer.from('made by', 'latin1'));
    expect(inspectImage(comment).metadata).toEqual(['comment']);

    expect(await meta(sharp(pixels).webp())).toEqual([]);
    expect(await meta(sharp(pixels).withExif(exif).webp())).toEqual(
      expect.arrayContaining(['EXIF (VP8X flag)', 'EXIF']),
    );
    expect(await meta(sharp(pixels).withXmp(xmp).webp())).toEqual(
      expect.arrayContaining(['XMP (VP8X flag)', 'XMP']),
    );
    expect(await meta(sharp(pixels).avif())).toEqual([]);
    expect(await meta(sharp(pixels).withExif(exif).avif())).toEqual(
      expect.arrayContaining(['EXIF item']),
    );
    expect(await meta(sharp(pixels).withXmp(xmp).avif())).toEqual(
      expect.arrayContaining(['mime item (XMP)']),
    );

    for (const output of SCENE_OUTPUTS) {
      const info = inspectImage(readFileSync(join(REPO_ROOT, output.path)));
      expect(info.metadata, output.path).toEqual([]);
    }
  }, 60_000);

  it('refuses a file that is not the original and writes nothing', async () => {
    const source = await sourceFolder(64, 40);
    const root = tempDir();
    await expect(
      installScene({ source: source.dir, root, requireCommittable: false }),
    ).rejects.toThrow(/is not the original light scene/u);
    expect(filesUnder(root)).toEqual([]);
  });

  it('refuses a missing file and writes nothing', async () => {
    const source = await sourceFolder(64, 40);
    rmSync(join(source.dir, 'dark.jpg'));
    const root = tempDir();
    await expect(
      installScene({
        source: source.dir,
        root,
        expected: source.expected,
        requireCommittable: false,
      }),
    ).rejects.toThrow(/missing .*dark\.jpg/u);
    expect(filesUnder(root)).toEqual([]);
  });

  it('refuses an image of another size even when the hash is the expected one', async () => {
    const source = await sourceFolder(64, 40);
    const root = tempDir();
    await expect(
      installScene({
        source: source.dir,
        root,
        expected: source.expected,
        requireCommittable: false,
      }),
    ).rejects.toThrow(/expected jpeg 2400x1500/u);
    expect(filesUnder(root)).toEqual([]);
  });

  it('refuses to write into a checkout whose .gitignore keeps an output out, since the outputs are committed', async () => {
    const source = await sourceFolder();
    const root = checkout();
    // The rule the repository held while the source was unconfirmed.
    writeFileSync(join(root, '.gitignore'), 'apps/mobile/assets/liquid-glass/scene-*\n');
    await expect(
      installScene({ source: source.dir, root, expected: source.expected }),
    ).rejects.toThrow(
      /refusing to write files a \.gitignore rule keeps out of the repository .*apps\/mobile\/assets\/liquid-glass\/scene-light\.jpg/u,
    );
    expect(filesUnder(root)).toEqual([join(root, '.gitignore')]);
  });

  it('writes the original, the 1x and 2x AVIF and WebP, a blurred phone JPEG and the manifest, and regenerates them all from the committed full-size JPEGs', async () => {
    const source = await sourceFolder();
    const root = checkout();
    const written = await installScene({ source: source.dir, root, expected: source.expected });
    expect(written.map((w) => w.path)).toEqual(SCENE_OUTPUTS.map((o) => o.path));
    const manifest = readFileSync(join(root, SCENE_MANIFEST), 'utf8');
    expect(manifest).toBe(manifestText(written));

    for (const output of SCENE_OUTPUTS) {
      const bytes = readFileSync(join(root, output.path));
      expect(sha256(bytes), output.path).toBe(written.find((w) => w.path === output.path)!.sha);
      if (output.kind === 'copy') {
        expect(bytes.equals(output.scheme === 'light' ? source.light : source.dark)).toBe(true);
        continue;
      }
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe(
        output.kind === 'blurred-jpeg' ? 'jpeg' : output.kind === 'avif' ? 'heif' : 'webp',
      );
      expect(meta.width).toBe(output.width);
      expect(meta.height).toBe((output.width! * 1500) / 2400);
    }
    expect(await checkScene({ root, expected: source.expected })).toEqual([]);

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

    // From the committed full-size copies alone: every other output comes back, the same bytes.
    for (const output of SCENE_OUTPUTS) {
      if (output.kind !== 'copy') rmSync(join(root, output.path));
    }
    rmSync(join(root, SCENE_MANIFEST));
    await installScene({ fromCommitted: true, root, expected: source.expected });
    expect(readFileSync(join(root, SCENE_MANIFEST), 'utf8')).toBe(manifest);

    // A committed full-size copy that is no longer the original is refused, and nothing is written.
    writeFileSync(join(root, COMMITTED_SOURCES.dark), source.light);
    rmSync(join(root, SCENE_MANIFEST));
    await expect(
      installScene({ fromCommitted: true, root, expected: source.expected }),
    ).rejects.toThrow(/is not the original dark scene/u);
    expect(existsSync(join(root, SCENE_MANIFEST))).toBe(false);
  }, 180_000);
});
