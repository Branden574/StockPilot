import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No module the browser loads may import the account READ action
 * (getMyAppearanceAction, server/actions/appearance.ts).
 *
 * WHY (measured in the lab 2026-11-11, and re-run by an independent check).
 * The provider reads the signed-in person's row a few milliseconds after the
 * hydration commit of every signed-in hard load. While a server action is
 * pending, React holds the hydration of the page's streamed content (1557 ms
 * with the read held 1500 ms, against 67 ms not held), the router holds a
 * client redirect (the legacy audit and users addresses then read their
 * notifications a 4th time from the document that is thrown away), and a link
 * click can queue behind it. A plain request holds none of the three. So the
 * read goes out by `fetch` to POST /api/appearance/account
 * (components/theme/appearance-account-read.ts), which answers from the same
 * server function as the action.
 *
 * The SAVE stays a server action: it only runs when a person chooses.
 *
 * Held here over the source text, comments left out: outside the action's own
 * module, no source file names the read action, and the provider's read is the
 * plain request.
 */

const SRC = join(__dirname, '..');
const READ_ACTION = 'getMyAppearanceAction';
const ACTIONS_MODULE = 'server/actions/appearance.ts';
const PROVIDER = 'components/theme/appearance-provider.tsx';
const READER = 'components/theme/appearance-account-read.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/u.test(entry.name) && !/\.(test|spec)\.[a-z]+$/u.test(entry.name))
      out.push(full);
  }
  return out;
}

/** The code without its comments (several comments explain the read). */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');

const FILES = walk(SRC).map((full) => ({
  file: relative(SRC, full).split(sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));
const textOf = (file: string) => FILES.find((f) => f.file === file)?.text;

/** The files whose code names the read action. */
const naming = (files: { file: string; text: string }[]) =>
  files.filter(({ text }) => code(text).includes(READ_ACTION)).map((f) => f.file);

describe('the account read is never a server action in the browser', () => {
  it('finds the source tree', () => {
    expect(FILES.length).toBeGreaterThan(1000);
    for (const file of [ACTIONS_MODULE, PROVIDER, READER]) expect(textOf(file), file).toBeDefined();
  });

  it('no source file but the action module names the read action', () => {
    expect(naming(FILES)).toEqual([ACTIONS_MODULE]);
  });

  it('the provider reads through the plain request, and saves through the action', () => {
    const provider = code(textOf(PROVIDER)!);
    expect(provider).toMatch(
      /import \{ readAccountAppearance \} from '\.\/appearance-account-read';/u,
    );
    expect(provider).toMatch(/case 'fetch': \{[\s\S]{0,120}?readAccountAppearance\(userId\)/u);
    expect(provider).toMatch(
      /import \{ setMyAppearanceAction \} from '@\/server\/actions\/appearance';/u,
    );
  });

  it('the reader is one fetch of the route, and loads no server action', () => {
    const reader = code(textOf(READER)!);
    expect(reader).toMatch(/ACCOUNT_APPEARANCE_ROUTE = '\/api\/appearance\/account'/u);
    expect(reader.match(/\bfetch\(/gu)).toHaveLength(1);
    expect(reader).toMatch(/fetch\(ACCOUNT_APPEARANCE_ROUTE,/u);
    // A type is erased; a value import would pull the action's reference in.
    const imports = reader.match(/^\s*import\b[^;]*;/gmu) ?? [];
    for (const line of imports.filter((l) => /server\//u.test(l)))
      expect(line.trim(), line).toMatch(/^import type\b/u);
    expect(reader).not.toMatch(/['"]use server['"]/u);
  });

  describe('the rule itself', () => {
    it('reports an import, a re-export and a dynamic import; a comment is not one', () => {
      const planted = (text: string) => naming([{ file: 'components/x.tsx', text }]);
      expect(planted(`import { ${READ_ACTION} } from '@/server/actions/appearance';`)).toEqual([
        'components/x.tsx',
      ]);
      expect(
        planted(`import { ${READ_ACTION} as read } from '@/server/actions/appearance';`),
      ).toEqual(['components/x.tsx']);
      expect(planted(`export { ${READ_ACTION} } from '@/server/actions/appearance';`)).toEqual([
        'components/x.tsx',
      ]);
      expect(
        planted(`const m = await import('@/server/actions/appearance'); m.${READ_ACTION}(id);`),
      ).toEqual(['components/x.tsx']);
      expect(planted(`// ${READ_ACTION} is not called here\nexport const a = 1;`)).toEqual([]);
      expect(planted(`/** was ${READ_ACTION} */\nexport const a = 1;`)).toEqual([]);
      expect(planted(`const url = 'https://example.test/x'; // ${READ_ACTION}`)).toEqual([]);
    });
  });
});
