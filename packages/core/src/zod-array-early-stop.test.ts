import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Security invariant: zod stops at the first over-long list.
 *
 * The repository patches zod 3.25.76 (patches/zod@3.25.76.patch, root
 * package.json pnpm.patchedDependencies) so that ZodArray answers as soon as a
 * list is longer than its .max() or .length(), with that one too_big issue,
 * without validating the list's elements. zod 4.6.6 does the same. Every
 * request schema bounds its lists (apps/web/src/test/zod-array-bounds.guard.test.ts),
 * and this test proves the bound is what stops the work.
 *
 * Both builds are checked: the ESM build (`import`, what Next.js and Metro
 * load) and the CommonJS build (`require`).
 *
 * IF THIS FAILS: the patch is not applied. Run `pnpm install` and read its
 * output; a zod version change needs the patch carried over (or zod 4).
 */

const requireCjs = createRequire(import.meta.url);
const zCjs = requireCjs('zod') as typeof import('zod');

const BUILDS = [
  ['ESM', z],
  ['CommonJS', zCjs],
] as const;

/** A list far longer than any schema allows, of elements that all fail. */
const FAILING_ELEMENTS = 500_000;

describe.each(BUILDS)('zod %s build: an over-long list', (_name, zod) => {
  const line = zod.object({
    itemId: zod.string().uuid(),
    quantity: zod.number().int().positive(),
  });

  it('answers with the one too_big issue and does not validate its elements', () => {
    const schema = zod.object({ lines: zod.array(line).max(500) });
    const input = { lines: new Array(FAILING_ELEMENTS).fill({}) };

    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = schema.safeParse(input);
    const elapsedMs = performance.now() - started;
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({
      code: 'too_big',
      type: 'array',
      maximum: 500,
      path: ['lines'],
      message: 'Array must contain at most 500 element(s)',
    });
    // Generous bounds: the element work this replaces is hundreds of times larger.
    expect(elapsedMs).toBeLessThan(250);
    expect(heapGrowth).toBeLessThan(32 * 1024 * 1024);
  });

  it('keeps a custom .max() message as the first issue', () => {
    const schema = zod.array(zod.number()).max(1, 'Too many lines.');
    const result = schema.safeParse([1, 'a', 'b']);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message)).toEqual(['Too many lines.']);
  });

  it('stops the same way for .length() when the list is too long', () => {
    const result = zod.array(zod.number()).length(2).safeParse(new Array(10_000).fill('x'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({ code: 'too_big', exact: true });
  });

  it('still reports the other fields of the object around the list', () => {
    const schema = zod.object({ name: zod.string(), lines: zod.array(zod.number()).max(2) });
    const result = schema.safeParse({ name: 7, lines: ['a', 'b', 'c'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.')).sort()).toEqual(['lines', 'name']);
  });

  it('is unchanged for a list within its bound and for a list that is too short', () => {
    const bounded = zod.array(zod.number()).min(2).max(3);
    expect(bounded.safeParse([1, 2]).success).toBe(true);

    const badElements = bounded.safeParse([1, 'a', 'b']);
    expect(badElements.success).toBe(false);
    if (!badElements.success) expect(badElements.error.issues).toHaveLength(2);

    const tooShort = bounded.safeParse(['a']);
    expect(tooShort.success).toBe(false);
    if (!tooShort.success) {
      expect(tooShort.error.issues.map((i) => i.code)).toEqual(['too_small', 'invalid_type']);
    }
  });

  it('stops the same way when parsed asynchronously', async () => {
    const schema = zod.array(line).max(10);
    const result = await schema.safeParseAsync(new Array(200_000).fill({}));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
  });
});
