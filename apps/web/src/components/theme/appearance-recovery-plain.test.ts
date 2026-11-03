import { afterEach, describe, expect, it } from 'vitest';

import { APPEARANCE_STORAGE_KEYS, CLASSIC_APPEARANCE_MODES } from '@stockpilot/core';

import {
  holdClassicForThisTab,
  isLiquidGlassStored,
  storedAppearanceWord,
  switchToClassicOnThisDevice,
} from './appearance-recovery-plain';

/**
 * "Use classic appearance" with no imports (Liquid Glass plan 5.6), shared by
 * every error boundary, global-error.tsx included. Its written-out keys must
 * stay core's (read from the file's text, since it may import nothing).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, 'appearance-recovery-plain.ts'), 'utf8');

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_appearance=; path=/; max-age=0';
  document.documentElement.removeAttribute('data-appearance');
});

describe('appearance-recovery-plain', () => {
  it('imports nothing, and writes out exactly core’s keys and classic words', () => {
    expect(SOURCE).not.toMatch(/^import /m);
    expect(SOURCE).toContain(`const COOKIE = '${APPEARANCE_STORAGE_KEYS.webCookie}'`);
    expect(SOURCE).toContain(`const DEVICE = '${APPEARANCE_STORAGE_KEYS.webDevice}'`);
    expect(SOURCE).toContain(`const SYNC = '${APPEARANCE_STORAGE_KEYS.webSync}'`);
    expect(SOURCE).toContain(`const FALLBACK = '${APPEARANCE_STORAGE_KEYS.webFallback}'`);
    expect(SOURCE).toContain(
      `const CLASSIC = [${CLASSIC_APPEARANCE_MODES.map((m) => `'${m}'`).join(', ')}] as const`,
    );
  });

  it('reads the stored choice from the device record, then the cookie', () => {
    expect(isLiquidGlassStored()).toBe(false);
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    expect(isLiquidGlassStored()).toBe(true);
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'dark', lastClassic: 'dark' }),
    );
    expect(storedAppearanceWord()).toBe('dark');
    expect(isLiquidGlassStored()).toBe(false);
  });

  it('returns the device to the last classic choice, marks the account sync dirty and clears the fallback', () => {
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'dark' }),
    );
    localStorage.setItem(
      'sp-appearance-sync',
      JSON.stringify({ v: 1, userId: 'user-a', dirty: false, syncedAt: null }),
    );
    localStorage.setItem('theme', 'system');
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');

    expect(switchToClassicOnThisDevice()).toBe('dark');

    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({
      v: 1,
      mode: 'dark',
      lastClassic: 'dark',
    });
    expect(document.cookie).toContain('sp_appearance=dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(JSON.parse(localStorage.getItem('sp-appearance-sync')!)).toEqual({
      v: 1,
      userId: 'user-a',
      dirty: true,
      syncedAt: null,
    });
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
  });

  it('falls back to System when no classic choice is known or it is malformed', () => {
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 1, mode: 'liquid-glass', lastClassic: 'Dark' }),
    );
    expect(switchToClassicOnThisDevice()).toBe('system');
    expect(localStorage.getItem('theme')).toBe('system');
    // No sync record: none is invented.
    expect(localStorage.getItem('sp-appearance-sync')).toBeNull();
  });

  it('holds the tab in classic once without touching the stored choice', () => {
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    holdClassicForThisTab();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('pending');
    sessionStorage.setItem('sp-lg-fallback', 'shown');
    holdClassicForThisTab();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('shown');
    expect(isLiquidGlassStored()).toBe(true);
  });
});
