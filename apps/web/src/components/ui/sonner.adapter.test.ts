import { describe, expect, it } from 'vitest';

import { toSonnerTheme } from './sonner';

/**
 * Sonner understands only light, dark and system (Liquid Glass plan 1.2): the
 * word 'liquid-glass', or any malformed stored value, must never reach it.
 */
describe('toSonnerTheme', () => {
  it('passes light and dark through and turns everything else into system', () => {
    expect(toSonnerTheme('light')).toBe('light');
    expect(toSonnerTheme('dark')).toBe('dark');
    expect(toSonnerTheme('system')).toBe('system');
    expect(toSonnerTheme(undefined)).toBe('system');
    expect(toSonnerTheme('liquid-glass')).toBe('system');
    expect(toSonnerTheme('Dark')).toBe('system');
  });
});
