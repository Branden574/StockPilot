import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * RECURRENCE GUARD (Liquid Glass plan 2.2, 4.6): no page branches its render on
 * the appearance. A page that rendered one tree in classic and another in glass
 * would unmount every stateful leaf (typed values, selection, open dialogs) on
 * a switch, and a server read of the cookie would make static pages dynamic.
 * So useAppearance(), and the selectors' useAppearanceChoice() (which returns
 * the Design on screen), may be used only by the appearance modules, the
 * selectors and the error-boundary recovery; no file outside
 * components/theme reads the sp_style cookie or the data-appearance
 * attribute, except the dashboard's own sidebar breakpoint helper when it
 * arrives (stage 3) and the error boundaries through components/theme. The
 * inert markers data-appearance-exempt (the signature pad, the label sheet)
 * and data-appearance-panel (Settings > Profile) are not reads.
 *
 * Revision (plans/REVISION-DEFAULT.md R13, items 20 and 23): every Theme
 * control goes through the provider's chooseTheme; next-themes' setTheme is
 * called only by the provider, by origin/main's verbatim markup under the
 * `off` rollout, and by the selectors' fallback when no provider is mounted.
 * The account is named to the appearance layer only by the dashboard shell
 * and the portal (which already knows its signed-in user).
 */

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The code without its comments (several comments explain the appearance). */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const FILES = walk(SRC).map((f) => ({
  file: relative(SRC, f),
  text: withoutComments(readFileSync(f, 'utf8')),
}));

/** Either appearance hook: the provider's own, or the selectors' (appearance-select.tsx). */
const USES_APPEARANCE = /\buseAppearance(?:Choice)?\b/u;

const MAY_USE_APPEARANCE = new Set([
  // The appearance modules.
  'components/theme/appearance-provider.tsx',
  'components/theme/appearance-select.tsx',
  // The selectors: they read the choices to mark the one in use, and branch
  // nothing else on them.
  'components/theme/theme-toggle.tsx',
  'components/dashboard/user-menu.tsx',
  'components/settings/appearance-panel.tsx',
  // The error boundaries' Use classic design.
  'components/theme/appearance-recovery.tsx',
]);

describe('appearance render guard', () => {
  it('finds the source tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('the hook check sees both hooks: useAppearance() and the selectors’ useAppearanceChoice()', () => {
    // useAppearanceChoice() returns the Design on screen (`style`): a page
    // that branched its tree on it would remount every stateful leaf on a
    // switch, exactly what this guard exists to stop.
    expect(USES_APPEARANCE.test('const a = useAppearance();')).toBe(true);
    expect(USES_APPEARANCE.test('const { style } = useAppearanceChoice();')).toBe(true);
    expect(USES_APPEARANCE.test('import { useAppearanceChoice } from "x";')).toBe(true);
    expect(USES_APPEARANCE.test('const a = useAppearances();')).toBe(false);
  });

  it('useAppearance() and useAppearanceChoice() are used only by the appearance modules, the selectors and the recovery', () => {
    const users = FILES.filter(({ text }) => USES_APPEARANCE.test(text)).map((f) => f.file);
    expect(users.filter((f) => !MAY_USE_APPEARANCE.has(f))).toEqual([]);
  });

  it('no server code or page reads the appearance cookie or attribute', () => {
    const readers = FILES.filter(
      ({ file, text }) =>
        !file.startsWith('components/theme/') &&
        !file.startsWith('styles/liquid-glass/') &&
        // The route that re-issues the Design cookie sets it; it renders nothing.
        file !== 'app/api/appearance/style/route.ts' &&
        (/sp_style|sp_appearance/.test(text) || /data-appearance(?!-(exempt|panel))/.test(text)),
    ).map((f) => f.file);
    expect(readers).toEqual([]);
  });

  it('no layout or page reads cookies() for the appearance', () => {
    const offenders = FILES.filter(
      ({ file, text }) =>
        /(^|\/)(layout|page)\.tsx$/.test(file) &&
        /cookies\(\)/.test(text) &&
        /appearance/i.test(text),
    ).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('next-themes setTheme is called only by the provider, the off-rollout markup and the no-provider fallback', () => {
    const callers = FILES.filter(({ text }) => /\bsetTheme\b/.test(text)).map((f) => f.file);
    expect(callers.sort()).toEqual([
      'components/dashboard/user-menu.tsx',
      'components/theme/appearance-provider.tsx',
      'components/theme/appearance-select.tsx',
      'components/theme/theme-toggle.tsx',
    ]);
    const text = (file: string) => FILES.find((f) => f.file === file)!.text;
    // user-menu: setTheme only as the `off` branch of the Theme radio.
    expect(text('components/dashboard/user-menu.tsx')).toMatch(
      /const onThemeChange = glassBuild\s*\?[\s\S]*?appearance\.chooseTheme\(value\)[\s\S]*?:\s*setTheme;/u,
    );
    expect(text('components/dashboard/user-menu.tsx').match(/\bsetTheme\b/gu)).toHaveLength(2);
    // theme-toggle: setTheme only inside ClassicThemeToggle, rendered under `off`.
    const toggle = text('components/theme/theme-toggle.tsx');
    expect(toggle).toMatch(/if \(liquidGlassRollout\(\) === 'off'\) return <ClassicThemeToggle/u);
    expect(toggle.slice(0, toggle.indexOf('function ClassicThemeToggle'))).not.toMatch(
      /\bsetTheme\b/u,
    );
    // appearance-select: setTheme only when no provider is mounted.
    const select = text('components/theme/appearance-select.tsx');
    const fallback = select.slice(select.indexOf('if (appearance) {'));
    expect(select.match(/\bsetTheme\(/gu)).toHaveLength(1);
    expect(fallback).toContain('chooseTheme: (next) => setTheme(next)');
  });

  it('only the dashboard shell and the portal name the signed-in person to the appearance layer', () => {
    const users = FILES.filter(({ text }) => /<AppearanceAccountSync\b/.test(text)).map(
      (f) => f.file,
    );
    expect(users.sort()).toEqual([
      'app/portal/page.tsx',
      'components/dashboard/dashboard-shell.tsx',
    ]);
  });

  it('every glass-only element in the source is on the 8.5 allowlist (R13: the external appearance menu)', () => {
    const allowlist = JSON.parse(
      readFileSync(
        join(SRC, '..', 'tests', 'e2e', 'appearance', 'glass-only-allowlist.json'),
        'utf8',
      ),
    ) as { kinds: Record<string, string>; entries: { source: string; kind: string }[] };
    const listed = new Set(allowlist.entries.map((e) => e.source));
    const carriers = FILES.filter(
      ({ file, text }) => file.endsWith('.tsx') && /data-glass-only/.test(text),
    ).map((f) => `apps/web/src/${f.file}`);
    expect(carriers.length).toBeGreaterThan(0);
    expect(carriers.filter((f) => !listed.has(f))).toEqual([]);
    for (const entry of allowlist.entries) {
      expect(Object.keys(allowlist.kinds)).toContain(entry.kind);
    }
    expect(allowlist.kinds).toHaveProperty(['appearance control (no data action)']);
  });

  it('the one-time intro notice and its two actions live only in the provider', () => {
    const owners = FILES.filter(({ text }) =>
      /switch back to the classic design at any time/.test(text),
    ).map((f) => f.file);
    expect(owners).toEqual(['components/theme/appearance-provider.tsx']);
  });

  it('appearance is never part of a data read, query key or channel name', () => {
    const offenders = FILES.filter(
      ({ file, text }) =>
        (file.startsWith('lib/') || file.startsWith('server/')) &&
        file !== 'server/actions/appearance.ts' &&
        /appearance/i.test(text),
    ).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});
