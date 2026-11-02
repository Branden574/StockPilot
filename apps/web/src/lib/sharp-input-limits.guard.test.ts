import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * GUARD (S45): sharp decodes image files in two places only, each time with a
 * pixel limit of its own.
 *
 * lib/image-decode.ts is the decoder for PDFs, exports, logos and the
 * thumbnail backfill: it checks the format and the stated size in JavaScript
 * before sharp opens anything, and gives sharp the cap of that format.
 * lib/image-reencode.ts re-encodes uploaded evidence and maintenance photos
 * with its own limit. Before, three more files called sharp with no options
 * (sharp's default limit of 268 million pixels), so the cap had to be fixed
 * in each copy (pattern #26).
 *
 * The scan reads every production .ts and .tsx file under src through
 * TypeScript's syntax tree, so a comment or a string that mentions sharp is
 * not counted:
 *   (a) only the two files above load the module 'sharp' (import, export
 *       from, import(), require());
 *   (b) every sharp(...) call there passes a second argument that is an
 *       object literal with limitInputPixels set to something other than 0,
 *       false or true, no `unlimited: true` and no spread.
 */
const SRC = path.resolve(__dirname, '..');

const MAY_LOAD_SHARP = ['lib/image-decode.ts', 'lib/image-reencode.ts'];

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__mocks__' || full === path.join(SRC, 'test')) continue;
      out.push(...productionFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(text: string, tsx = false): ts.SourceFile {
  return ts.createSourceFile(
    tsx ? 'file.tsx' : 'file.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function isSharpSpecifier(node: ts.Node | undefined): boolean {
  return !!node && ts.isStringLiteralLike(node) && node.text === 'sharp';
}

/** Each place the code loads the module 'sharp', by line. */
function sharpLoads(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  walk(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      isSharpSpecifier(node.moduleSpecifier)
    ) {
      lines.push(line(node));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isSharpSpecifier(node.moduleReference.expression)
    ) {
      lines.push(line(node));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      isSharpSpecifier(node.arguments[0])
    ) {
      lines.push(line(node));
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      isSharpSpecifier(node.argument.literal)
    ) {
      lines.push(line(node));
    }
  });
  return lines;
}

/** Why one sharp(...) call's options do not hold a pixel limit, or null. */
function missingLimit(call: ts.CallExpression): string | null {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return 'no options object literal';
  }
  let limit: ts.Expression | null = null;
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop)) return 'a spread in the options';
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : prop.name?.getText();
    const value = ts.isPropertyAssignment(prop) ? prop.initializer : null;
    if (name === 'unlimited' && value?.kind !== ts.SyntaxKind.FalseKeyword) {
      return 'unlimited';
    }
    if (name === 'limitInputPixels') {
      limit = ts.isShorthandPropertyAssignment(prop) ? prop.name : value;
    }
  }
  if (!limit) return 'no limitInputPixels';
  if (
    limit.kind === ts.SyntaxKind.TrueKeyword ||
    limit.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isNumericLiteral(limit) && Number(limit.text) === 0)
  ) {
    return `limitInputPixels: ${limit.getText()}`;
  }
  return null;
}

/** Each sharp(...) call whose options do not hold a pixel limit. */
function unlimitedCalls(source: ts.SourceFile): string[] {
  const out: string[] = [];
  walk(source, (node) => {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'sharp'
    ) {
      const reason = ts.isCallExpression(node) ? missingLimit(node) : 'new sharp(...)';
      if (reason) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        out.push(`:${line} ${reason}`);
      }
    }
  });
  return out;
}

const FILES = productionFiles(SRC);
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('sharp in the web app (S45)', () => {
  it('scans the real tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
    for (const file of MAY_LOAD_SHARP) expect(FILES).toContain(path.join(SRC, file));
    expect(FILES.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });

  it('only lib/image-decode.ts and lib/image-reencode.ts load sharp', () => {
    const loading: Record<string, number[]> = {};
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('sharp')) continue;
      const lines = sharpLoads(parse(text, file.endsWith('.tsx')));
      if (lines.length > 0) loading[rel(file)] = lines;
    }
    expect(
      Object.keys(loading).sort(),
      'Decode images through lib/image-decode.ts (withCappedImage, pngFitInside), which checks ' +
        'the format and size first and gives sharp the cap of the format.',
    ).toEqual(MAY_LOAD_SHARP);
  });

  it('every sharp(...) call in them passes a pixel limit', () => {
    const found: Record<string, string[]> = {};
    for (const file of MAY_LOAD_SHARP) {
      const calls = unlimitedCalls(parse(readFileSync(path.join(SRC, file), 'utf8')));
      if (calls.length > 0) found[file] = calls;
    }
    expect(found).toEqual({});
  });

  it('the decoder’s caps are pinned', async () => {
    const { DECODE_MAX_INPUT_PIXELS } = await import('./image-decode');
    expect(DECODE_MAX_INPUT_PIXELS).toEqual({
      png: 50_000_000,
      jpeg: 50_000_000,
      webp: 50_000_000,
      gif: 4096 * 4096,
      avif: 4096 * 4096,
    });
  });

  // The scan's own controls: each planted load or call is caught, and
  // nothing in a comment or a string is.
  it.each([
    ['a default import', "import sharp from 'sharp';"],
    ['a type import', "import type { Sharp } from 'sharp';"],
    ['an import()', "const { default: sharp } = await import('sharp');"],
    ['a require()', "const sharp = require('sharp');"],
    ['an export from', "export { default } from 'sharp';"],
    ['an import type', "type S = import('sharp').Sharp;"],
  ])('finds %s', (_label, planted) => {
    expect(sharpLoads(parse(planted))).toEqual([1]);
  });

  it.each([
    ['no options', 'sharp(bytes).png();', 'no options object literal'],
    ['options with no limit', 'sharp(bytes, { autoOrient: true });', 'no limitInputPixels'],
    ['a limit of 0', 'sharp(bytes, { limitInputPixels: 0 });', 'limitInputPixels: 0'],
    ['a limit of false', 'sharp(bytes, { limitInputPixels: false });', 'limitInputPixels: false'],
    ['a limit of true', 'sharp(bytes, { limitInputPixels: true });', 'limitInputPixels: true'],
    ['unlimited', 'sharp(bytes, { limitInputPixels: 10, unlimited: true });', 'unlimited'],
    ['a spread', 'sharp(bytes, { ...opts, limitInputPixels: 10 });', 'a spread in the options'],
    ['options in a variable', 'sharp(bytes, opts);', 'no options object literal'],
  ])('catches %s', (_label, planted, reason) => {
    expect(unlimitedCalls(parse(planted))).toEqual([`:1 ${reason}`]);
  });

  it.each([
    ['a limit', 'sharp(bytes, { limitInputPixels: cap, autoOrient: true });'],
    ['a shorthand limit', 'sharp(bytes, { limitInputPixels });'],
    ['a docblock', "/** sharp(bytes).png() and import('sharp') */\nexport const x = 1;"],
    ['a line comment', "// const sharp = require('sharp'); sharp(b)\nexport const x = 1;"],
    ['a string', 'const s = "sharp(bytes) from \'sharp\'";'],
  ])('passes %s', (_label, planted) => {
    expect(sharpLoads(parse(planted))).toEqual([]);
    expect(unlimitedCalls(parse(planted))).toEqual([]);
  });
});
