/**
 * Guards over the returns modules as files:
 *   1. importing any of them runs nothing (core's index re-exports them, the
 *      web bundles them on many routes and Metro does not tree-shake; the
 *      place-order guard explains the cost);
 *   2. no returns module reaches for a name heuristic to decide sizes or
 *      variants (brief 3: real product groups only; plan 3.6.10), nor reads a
 *      free-text rack key (brief 11, 13).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function topLevelCalls(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(path.join(DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) {
      found.push(n.getText(sf).slice(0, 60));
      return;
    }
    ts.forEachChild(n, visit);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
    visit(st);
  }
  return found;
}

describe('the returns modules', () => {
  it('are all here', () => {
    expect(SOURCES.sort()).toEqual([
      'exchange-status.ts',
      'restock-view.ts',
      'return-actions.ts',
      'return-error-map.ts',
      'return-schemas.ts',
      'returns-copy.ts',
    ]);
  });

  it.each(SOURCES)('%s has no call at its top level', (file) => {
    expect(topLevelCalls(file)).toEqual([]);
  });

  it.each(SOURCES)('%s never uses a name heuristic or a free-text rack key', (file) => {
    const text = readFileSync(path.join(DIR, file), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/sizeRunStyleKey|groupBySizeRun|extractSize|custom_fields|bin_location|primary_location_id/);
    expect(code).not.toMatch(/from '\.\.\/inventory\/size-run'/);
  });
});
