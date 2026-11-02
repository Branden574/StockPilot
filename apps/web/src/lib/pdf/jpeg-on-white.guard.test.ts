import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * GUARD (B62): a JPEG made with sharp flattens its transparency first, or its
 * input can never be transparent.
 *
 * JPEG has no transparency, and libvips paints every transparent pixel black
 * on a JPEG save, even one that hides white. lib/pdf/image-prefetch.ts had two
 * JPEG encodes side by side and only the sized one flattened, so a photo with
 * a see-through background printed on a black square in the pick slip, both
 * packing slips and the report PDFs (pattern #26: a fix in one copy). Both now
 * go through one encoder, jpegOnWhite, which flattens onto white.
 *
 * This scan reads every production .ts and .tsx file under src with its
 * comments removed by TypeScript's printer (so a docblock quoting `.jpeg()` is
 * not counted, and a `//` in a string such as `https://` is not taken for a
 * comment) and counts the sharp JPEG encodes: `.jpeg(`, and `.toFormat(` with
 * jpeg, jpg or jpe. A file not listed below, or an encode added to one, fails.
 */
const SRC = path.resolve(__dirname, '..', '..');

/** The files that may encode JPEG, how many times, and why it never prints a
 *  transparent pixel black. */
const ALLOWED: Record<string, number> = {
  // jpegOnWhite: flattens onto white before its one encode (checked below).
  'lib/pdf/image-prefetch.ts': 1,
  // Writes a JPEG only when the upload's sniffed bytes are JPEG, which has no
  // transparency (server/services/exception-evidence.ts and
  // maintenance-attachments.ts pass the kind they sniffed).
  'lib/image-reencode.ts': 1,
};

const JPEG_ENCODE = /\.\s*jpeg\s*\(|\.\s*toFormat\s*\([^)]*\bjp(?:e?g|e)\b/g;

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__mocks__' || full === path.join(SRC, 'test')) continue;
      out.push(...productionFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** A file's code with every comment removed. */
function codeOf(text: string, tsx = false): string {
  const source = ts.createSourceFile(
    tsx ? 'file.tsx' : 'file.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

function jpegEncodes(code: string): number {
  return code.match(JPEG_ENCODE)?.length ?? 0;
}

const FILES = productionFiles(SRC);

/** How many JPEG encodes each file makes, for the files that make any. A file
 *  that never spells jpeg, jpg or jpe cannot make one, so only those are
 *  parsed. */
function encodesByFile(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    if (!/jp[eg]/.test(text)) continue;
    const n = jpegEncodes(codeOf(text, file.endsWith('.tsx')));
    if (n > 0) out[path.relative(SRC, file).split(path.sep).join('/')] = n;
  }
  return out;
}

describe('sharp JPEG encodes in the web app (B62)', () => {
  it('scans the real tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain(path.join(SRC, 'lib/pdf/image-prefetch.ts'));
    expect(FILES.some((f) => f.includes(`${path.sep}__mocks__${path.sep}`))).toBe(false);
    expect(FILES.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });

  it('only the files named here encode JPEG, each as many times as named', () => {
    expect(
      encodesByFile(),
      'A JPEG encode paints every transparent pixel black unless it flattens first (B62). ' +
        'Use jpegOnWhite in lib/pdf/image-prefetch.ts, or name the file in ALLOWED with the ' +
        'reason its input can never be transparent.',
    ).toEqual(ALLOWED);
  });

  it('the PDF image encode flattens onto a background before it encodes', () => {
    const code = codeOf(readFileSync(path.join(SRC, 'lib/pdf/image-prefetch.ts'), 'utf8'));
    const encoding = code.split(';').filter((statement) => jpegEncodes(statement) > 0);
    const flattenThenJpeg = /\.\s*flatten\s*\(\s*\{\s*background\s*:[^;]*\.\s*jpeg\s*\(/;
    expect(encoding.filter((statement) => !flattenThenJpeg.test(statement))).toEqual([]);
    expect(encoding).toHaveLength(1);
  });

  // The scan's own controls: each planted encode is counted, and nothing in a
  // comment is.
  it.each([
    ['a .jpeg() call', 'await sharp(b).jpeg({ quality: 80 }).toBuffer();'],
    ['a .jpeg() call on its own line', 'await sharp(b)\n  .resize(10)\n  .jpeg()\n  .toBuffer();'],
    ["toFormat('jpeg')", "await sharp(b).toFormat('jpeg').toBuffer();"],
    ['toFormat("jpg")', 'await sharp(b).toFormat("jpg", { quality: 80 }).toBuffer();'],
    ["toFormat({ id: 'jpeg' })", "await sharp(b).toFormat({ id: 'jpeg' }).toBuffer();"],
    ['toFormat(sharp.format.jpeg)', 'await sharp(b).toFormat(sharp.format.jpeg).toBuffer();'],
    [
      'an encode after a URL on the same line',
      "const u = 'https://x.test/a'; await sharp(b).jpeg().toBuffer();",
    ],
  ])('counts %s', (_label, planted) => {
    expect(jpegEncodes(codeOf(planted))).toBe(1);
  });

  it.each([
    [
      'a docblock quoting .jpeg()',
      "/** Converts with sharp(raw).jpeg() and toFormat('jpeg'). */\nexport const x = 1;",
    ],
    ['a line comment', '// sharp(raw).jpeg({ quality: 80 })\nexport const x = 1;'],
    ['a JSX comment', 'export const C = () => <p>{/* sharp(raw).jpeg() */}photo</p>;'],
  ])('ignores %s', (label, planted) => {
    expect(jpegEncodes(codeOf(planted, label.includes('JSX')))).toBe(0);
  });
});
