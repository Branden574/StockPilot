/**
 * RECURRENCE GUARD: no Tailwind group or peer variant on a focus state in the
 * web app.
 *
 * Tailwind v4 compiles every group-<state> variant to
 * `.x:is(:where(.group):<state> *)` (a peer one to
 * `.x:is(:where(.peer):<state> ~ *)`). WebKit cannot narrow its style
 * invalidation for that shape, so in Safari every focus change re-styles work
 * that grows with the page, on every page, because the stylesheet is global.
 * Stage 6 measured 18 and 46 ms per focus change on pages of 11,405 and 30,405
 * elements against 0.12 ms without those rules, and 2.3 to 2.9 ms on the lab
 * Items page against 0.37 ms. Production never had a group-focus variant; the
 * redesign added six, and Stage 6 batch H replaced them.
 *
 * USE INSTEAD the arbitrary descendant variant, which compiles to a plain
 * descendant selector (`.group:focus-within .x`), the shape Tailwind 3 used:
 *   focus anywhere in the group           [.group:focus-within_&]:opacity-100
 *   the group itself has keyboard focus   [.group:focus-visible_&]:opacity-100
 *   a named group (group/card)            [.group\/card:focus-within_&]:opacity-100
 * A stacked variant keeps its place: pointer-fine:[.group:focus-within_&]:opacity-100.
 * The "/" of a named group is escaped with ONE backslash, both in the class
 * the browser gets and in the text Tailwind scans, so write that class in
 * String.raw`...` or in a JSX attribute string. An ordinary string literal
 * needs two backslashes in its source, and Tailwind builds its rule from the
 * source text, so that rule matches nothing (this guard fails on it too).
 *
 * The descendant form is more specific than the variant (0,3,0 against
 * 0,2,0) and Tailwind writes it after the other utilities, so it now wins over
 * any class on the same element that sets the same property while the group
 * has focus (a disabled:opacity-50, say). Check those when you convert one.
 *
 * Every file under apps/web/src is read as Tailwind's scanner reads it: raw
 * text, comments and tests included, because a class written in a comment is
 * built too. group-hover has the same shape but is left alone: production has
 * it, so it is not this regression.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(__dirname, '..');
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|pdf|zip|gz)$/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') out.push(...sourceFiles(full));
    } else if (!BINARY.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = sourceFiles(WEB_SRC).map((file) => ({
  file: path.relative(WEB_SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/** A group or peer variant on a focus state, as a class or in @variant. */
const FOCUS_VARIANT = [
  // group-focus, group-focus-within, group-focus-visible and the peer ones,
  // named or not, followed by the rest of the class.
  /(?<![\w-])(?:group|peer)-focus(?:-within|-visible)?(?:\/[\w-]+)?:/g,
  // The arbitrary group / peer variants on a focus state, and has-[...] on one.
  /(?<![\w-])(?:group|peer)-(?:has-)?\[[^\]\s]*:focus[^\]\s]*\](?:\/[\w-]+)?:/g,
  // The same variants named by a stylesheet's @variant rule.
  /@variant\s+(?:group|peer)-(?:focus|(?:has-)?\[[^\]\s]*:focus)/g,
];
/** A named group in the descendant form with two backslashes before its "/". */
const DOUBLE_ESCAPED_GROUP = /\[\.(?:group|peer)\\\\\/[\w-]+:/g;

const offenders = (res: readonly RegExp[]) =>
  SOURCES.flatMap(({ file, text }) =>
    res.flatMap((re) =>
      [...text.matchAll(re)].map(
        (m) => `${file}:${text.slice(0, m.index).split('\n').length}: ${m[0]}`,
      ),
    ),
  );

describe('no Tailwind group or peer variant on a focus state (Safari restyles every page)', () => {
  it('reads the whole of apps/web/src', () => {
    expect(SOURCES.length).toBeGreaterThan(1000);
    expect(SOURCES.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'app/globals.css',
        'components/patterns/grid-card.tsx',
        'components/inventory/inventory-table.tsx',
        'lib/group-focus-variants.guard.test.ts',
      ]),
    );
  });

  it('catches every form of the variant and passes the descendant form', () => {
    // Built from parts: a whole class written here would be built by Tailwind.
    const v = (...parts: string[]) => `${parts.join('-')}:opacity-100`;
    const caught = (text: string) =>
      FOCUS_VARIANT.some((re) => [...text.matchAll(re)].length > 0) ||
      [...text.matchAll(DOUBLE_ESCAPED_GROUP)].length > 0;
    for (const bad of [
      v('group', 'focus'),
      v('group', 'focus', 'within'),
      v('group', 'focus', 'visible'),
      `pointer-fine:${v('group', 'focus', 'within')}`,
      v('group', 'focus', 'within/card'),
      v('peer', 'focus'),
      v('peer', 'focus', 'visible'),
      v('group', '[:focus-within]'),
      v('group', 'has', '[:focus-visible]'),
      `@variant ${['group', 'focus', 'within'].join('-')} {`,
      `${'[.group'}${'\\\\'}/card:focus-within_&]:opacity-100`,
    ]) {
      expect(caught(` ${bad} `), bad).toBe(true);
    }
    for (const good of [
      '[.group:focus-within_&]:opacity-100',
      'pointer-fine:[.group:focus-within_&]:opacity-100',
      '[.group:focus-visible_&]:opacity-100',
      String.raw`[.group\/card:focus-within_&]:opacity-100`,
      'group-hover:opacity-100',
      'focus-visible:opacity-100',
      `Tailwind's ${['group', 'focus', 'within'].join('-')} variant`,
    ]) {
      expect(caught(` ${good} `), good).toBe(false);
    }
  });

  it('no file uses one: use [.group:focus-within_&] and the like (see above)', () => {
    expect(offenders(FOCUS_VARIANT)).toEqual([]);
  });

  it('a named group in the descendant form keeps one backslash before its "/"', () => {
    expect(offenders([DOUBLE_ESCAPED_GROUP])).toEqual([]);
  });

  it('the stylesheet Tailwind builds from apps/web/src has no rule of that shape', async () => {
    const globals = path.join(WEB_SRC, 'app/globals.css');
    const source = readFileSync(globals, 'utf8');
    const importLine = /@import\s+['"]tailwindcss['"];/;
    expect(source).toMatch(importLine);
    const input = source
      .replace(importLine, "@import 'tailwindcss' source(none);")
      .concat(`\n@source "${WEB_SRC}";\n`);
    const { css } = await postcss([tailwindcss({ optimize: false })]).process(input, {
      from: globals,
    });
    const slow: string[] = [];
    let descendant = 0;
    postcss.parse(css).walkRules((rule: Rule) => {
      if (/:where\(\.(?:group|peer)\b[^)]*\)\S*:focus/.test(rule.selector)) {
        slow.push(rule.selector);
      }
      if (/\.(?:group|peer)(?:\\\/[\w-]+)?:focus(?:-within|-visible)? /.test(rule.selector)) {
        descendant += 1;
      }
    });
    expect(slow).toEqual([]);
    // The descendant forms the app uses are built (so the scan above ran).
    expect(descendant).toBeGreaterThan(0);
  });
});
