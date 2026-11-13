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
 * inert markers data-appearance-exempt (the signature pad, the label sheet),
 * data-appearance-panel (Settings > Profile) and data-appearance-design (the
 * two menus' Design group, L4 triage BF3) are not reads: each is written on
 * an element and never read back, and the last two exist only so that the
 * lab's parity run can take the approved selector places out of a page
 * (stockpilot-work/liquid-glass/verify/allowances.json). The design marker is
 * held to its two menus, its one spelling and no CSS (checked below).
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
const USES_APPEARANCE = /\buseAppearance(?:Choice|Actions)?\b/u;

/**
 * A read of the attribute <html> carries. The three inert markers are not
 * reads (see above); anything else that starts with data-appearance is.
 */
const READS_ATTRIBUTE = /data-appearance(?!-(exempt|panel|design))/;

/** The menus' inert Design wrapper, exactly as the lab's allowances expect it. */
const DESIGN_MARKER = 'data-appearance-design';
const DESIGN_WRAPPER = '<div data-appearance-design="" className="contents">';

function walkCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkCss(full, out);
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const MAY_USE_APPEARANCE = new Set([
  // The appearance modules.
  'components/theme/appearance-provider.tsx',
  'components/theme/appearance-select.tsx',
  // The selectors: they read the choices to mark the one in use, and branch
  // nothing else on them. The header menu also takes its trigger's glass name
  // from the provider's state (DECISIONS.md F6; checked below).
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
    // The actions alone (the recovery): still the appearance layer's own hook.
    expect(USES_APPEARANCE.test('const a = useAppearanceActions();')).toBe(true);
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
        (/sp_style|sp_appearance/.test(text) || READS_ATTRIBUTE.test(text)),
    ).map((f) => f.file);
    expect(readers).toEqual([]);
  });

  it('the attribute check still sees a read next to the inert markers', () => {
    for (const read of [
      "root.getAttribute('data-appearance')",
      '<div data-appearance="liquid-glass">',
      "[data-appearance='liquid-glass'] .card",
      'data-appearance-style',
      'data-appearances',
    ]) {
      expect(READS_ATTRIBUTE.test(read), read).toBe(true);
    }
    for (const marker of [
      'data-appearance-exempt=""',
      'data-appearance-panel=""',
      'data-appearance-design=""',
    ]) {
      expect(READS_ATTRIBUTE.test(marker), marker).toBe(false);
    }
  });

  it('the Design marker is written once in each of the two menus, in its one spelling, and nothing reads or styles it', () => {
    const carriers = FILES.filter(({ text }) => text.includes(DESIGN_MARKER));
    expect(carriers.map((f) => f.file).sort()).toEqual([
      'components/dashboard/user-menu.tsx',
      'components/theme/theme-toggle.tsx',
    ]);
    for (const { file, text } of carriers) {
      // The only mention is the wrapper itself: no selector, no query, no
      // longer name that the prefix would let through.
      expect(text.split(DESIGN_MARKER), file).toHaveLength(2);
      expect(text, file).toContain(DESIGN_WRAPPER);
    }
    // No stylesheet selects it: the wrapper is `contents` and nothing else.
    const styled = walkCss(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes(DESIGN_MARKER))
      .map((f) => relative(SRC, f));
    expect(styled).toEqual([]);
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

  it('the header menu’s trigger takes its glass name from the provider’s state, never from the cookie or <html> (F6: no hydration mismatch)', () => {
    // The server cannot see the attribute or the stored Design, so a name read
    // from either during render would differ between the server HTML and the
    // first client render. glassApplied is false until the provider has
    // written the attribute after mount, so the trigger hydrates as classic.
    const toggle = FILES.find((f) => f.file === 'components/theme/theme-toggle.tsx')!.text;
    // (The inert Design wrapper's marker is not a read; it is pinned above.)
    expect(toggle.replace(DESIGN_WRAPPER, '')).not.toMatch(
      /\bdocument\b|\bwindow\b|cookie|sp_style|data-appearance|getAttribute|localStorage|isGlassShowing/u,
    );
    expect(toggle).toMatch(/\{\s*chooseTheme,\s*glassApplied\s*\}\s*=\s*useAppearanceChoice\(\)/u);
    expect(toggle).toMatch(/aria-label=\{glassApplied \? GLASS_NAME : CLASSIC_NAME\}/u);
    expect(toggle).toMatch(/title=\{glassApplied \? GLASS_NAME : undefined\}/u);
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

  it('every width-bound entry of the 8.5 allowlist names its widths, and what it replaces or hides', () => {
    const allowlist = JSON.parse(
      readFileSync(
        join(SRC, '..', 'tests', 'e2e', 'appearance', 'glass-only-allowlist.json'),
        'utf8',
      ),
    ) as {
      entries: {
        id: string;
        kind: string;
        role?: string;
        name?: string;
        href?: string;
        minWidth?: number;
        maxWidth?: number;
        replaces?: { role?: string; selector?: string; name?: string; href?: string }[];
      }[];
    };
    const replaced = allowlist.entries.filter((e) => e.kind === 'replaced below a width');
    const hidden = allowlist.entries.filter(
      (e) => e.kind === 'hidden in a width band (target on screen)',
    );
    expect(replaced.map((e) => e.id)).toEqual(['orders-phone-cards']);
    expect(hidden.map((e) => e.id)).toEqual(['storefront-cart-fab']);
    for (const entry of replaced) {
      expect(entry.maxWidth, entry.id).toEqual(expect.any(Number));
      expect(entry.href, entry.id).toEqual(expect.any(String));
      expect(entry.replaces?.length, entry.id).toBeGreaterThan(0);
      for (const classic of entry.replaces ?? []) {
        // The check pairs a replaced action with the glass element by role
        // and target: each names both, and the target is the glass element's.
        expect(classic.role, entry.id).toBe(entry.role);
        expect(classic.href, entry.id).toBe(entry.href);
        expect(classic.selector, entry.id).toEqual(expect.any(String));
        expect(classic.name, entry.id).toEqual(expect.any(String));
      }
    }
    // A classic control moved into a menu below a width: the glass item and
    // the classic control each named, the width given.
    const moved = allowlist.entries.filter((e) => e.kind === 'moved into a menu below a width');
    expect(moved.map((e) => e.id)).toEqual(['account-menu-whats-new']);
    for (const entry of moved) {
      expect(entry.role, entry.id).toBe('menuitem');
      expect(entry.name, entry.id).toEqual(expect.any(String));
      expect(entry.maxWidth, entry.id).toEqual(expect.any(Number));
      expect(entry.replaces?.length, entry.id).toBeGreaterThan(0);
      for (const classic of entry.replaces ?? []) {
        expect(classic.role, entry.id).toEqual(expect.any(String));
        expect(classic.selector, entry.id).toEqual(expect.any(String));
        expect(classic.name, entry.id).toEqual(expect.any(String));
      }
    }
    for (const entry of hidden) {
      expect(entry.role, entry.id).toEqual(expect.any(String));
      expect(entry.name, entry.id).toEqual(expect.any(String));
      expect(entry.minWidth, entry.id).toEqual(expect.any(Number));
      expect(entry.maxWidth, entry.id).toBeGreaterThan(entry.minWidth ?? Infinity);
    }
  });

  it('the one-time intro notice and its two actions live only in the provider', () => {
    const owners = FILES.filter(({ text }) =>
      /switch back to the classic design at any time/.test(text),
    ).map((f) => f.file);
    expect(owners).toEqual(['components/theme/appearance-provider.tsx']);
  });

  it('appearance is never part of a data read, query key or channel name', () => {
    // The What's New registry is words for readers: the Liquid Glass release
    // (a draft until it is published) says "Appearance" where the app does. It
    // is let through only as words: it imports nothing but a type and loads
    // nothing at run time, so it cannot read data, name a query or a channel.
    const WORDS_ONLY = 'lib/releases/registry.ts';
    const offenders = FILES.filter(
      ({ file, text }) =>
        (file.startsWith('lib/') || file.startsWith('server/')) &&
        file !== 'server/actions/appearance.ts' &&
        // The one read of a person's own row, behind the read action and the
        // route POST /api/appearance/account alike.
        file !== 'server/lib/own-appearance-row.ts' &&
        file !== WORDS_ONLY &&
        /appearance/i.test(text),
    ).map((f) => f.file);
    expect(offenders).toEqual([]);

    const registry = FILES.find((f) => f.file === WORDS_ONLY);
    expect(registry, WORDS_ONLY).toBeDefined();
    const imports = registry!.text.match(/^\s*import\b[^\n]*/gmu) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line.trim(), line).toMatch(/^import type\b/u);
    expect(registry!.text).not.toMatch(/\brequire\s*\(|\bimport\s*\(|\bfetch\s*\(/u);
  });
});
