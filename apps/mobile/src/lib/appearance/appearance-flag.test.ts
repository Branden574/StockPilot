import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { glassRollout } from './flag';

/**
 * The phone's kill switch (revision R5, item 28): EXPO_PUBLIC_LIQUID_GLASS is
 * off | opt-in | default, read through the core parser, so anything else
 * (unset, empty, the stage 2 value '1', a typo) is 'off': classic for
 * everyone, nothing stored lost.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the rollout flag', () => {
  it.each([
    ['default', 'default'],
    ['opt-in', 'opt-in'],
    ['off', 'off'],
    ['1', 'off'],
    ['', 'off'],
    ['Default', 'off'],
    [' default', 'off'],
    ['true', 'off'],
  ] as const)('%j reads as %s', (value, expected) => {
    vi.stubEnv('EXPO_PUBLIC_LIQUID_GLASS', value);
    expect(glassRollout()).toBe(expected);
  });

  it('unset reads as off', () => {
    vi.stubEnv('EXPO_PUBLIC_LIQUID_GLASS', undefined as unknown as string);
    expect(glassRollout()).toBe('off');
  });

  it('reads the literal member access Expo inlines, never a computed one', () => {
    const src = readFileSync(path.join(__dirname, 'flag.ts'), 'utf8');
    expect(src).toContain('parseRollout(process.env.EXPO_PUBLIC_LIQUID_GLASS)');
    expect(src).not.toMatch(/process\.env\[/);
  });
});
