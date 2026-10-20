import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A movement type's words and tone live in movement-type.ts, a module that
 * imports no component. For a while the Overview read them from
 * components/movements/movements-table.tsx, which also imports the table's
 * client islands (EditableMovementNote and LocalDateTime): the build's
 * client reference manifest for /dashboard then listed
 * editable-movement-note.tsx and local-datetime.tsx, and the Overview's own
 * page chunk carried the Movements note editor, which the Overview never draws.
 * The Overview is the most visited page and its load is a do-not-regress area,
 * so these checks keep that import path closed. The words and tones themselves
 * are pinned in movements-table.test.tsx, through the table's re-export.
 */
const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** Every module a file names in an import, a re-export or a dynamic import(). */
function modulesNamed(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(?\s*'([^']+)'/g)].map(
    (m) => (m[1] ?? m[2])!,
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('movement type words and tones: no client imports (Overview bundle)', () => {
  it('imports no component and is not a client module, nor is the filter module it reads', () => {
    for (const rel of ['lib/movements/movement-type.ts', 'lib/movements-filters.ts']) {
      const text = read(rel);
      expect(text).not.toMatch(/^\s*['"]use client['"]/m);
      for (const mod of modulesNamed(text)) {
        expect(mod.startsWith('@/components/'), `${rel} imports ${mod}`).toBe(false);
      }
    }
    expect(modulesNamed(read('lib/movements/movement-type.ts')).sort()).toEqual([
      '@/lib/movements-filters',
      '@stockpilot/core',
    ]);
  });

  it('the Overview reads them here, and nothing it draws imports a Movements component', () => {
    const page = 'app/(dashboard)/dashboard/page.tsx';
    const activity = 'components/dashboard/widgets/recent-activity.tsx';
    expect(modulesNamed(read(page))).toContain('@/lib/movements/movement-type');
    expect(modulesNamed(read(activity))).toContain('@/lib/movements/movement-type');
    const files = [path.join(SRC, page), ...sourceFiles(path.join(SRC, 'components', 'dashboard'))];
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((file) =>
      modulesNamed(readFileSync(file, 'utf8'))
        .filter((mod) => mod.startsWith('@/components/movements/'))
        .map((mod) => `${path.relative(SRC, file)} imports ${mod}`),
    );
    expect(offenders).toEqual([]);
  });
});
