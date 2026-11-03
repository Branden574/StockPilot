import { afterEach, describe, expect, it } from 'vitest';

import { APPEARANCE_STORAGE_KEYS } from '@stockpilot/core';

import { APPEARANCE_SCRIPT } from './appearance-script';

/**
 * The first-paint script (Liquid Glass plan 2.1, 4.7 item 2). With no cookie,
 * or any value but exactly `liquid-glass`, it must leave <html> byte-identical,
 * so a classic page gets no DOM change from it; with the glass cookie it adds
 * only data-appearance; in the one-time crash fallback it adds nothing.
 */

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]!.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

function runScript(): void {
  // The script as the browser runs it: a classic inline script, no module.
  new Function(APPEARANCE_SCRIPT)();
}

afterEach(() => {
  clearCookies();
  sessionStorage.clear();
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.className = '';
});

describe('the first-paint appearance script', () => {
  it('reads the core cookie and fallback keys, nothing else', () => {
    expect(APPEARANCE_SCRIPT).toContain(`${APPEARANCE_STORAGE_KEYS.webCookie}=`);
    expect(APPEARANCE_SCRIPT).toContain(APPEARANCE_STORAGE_KEYS.webFallback);
    expect(APPEARANCE_SCRIPT).not.toMatch(/localStorage|fetch|classList|style/);
  });

  it.each([
    ['no cookie', null],
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'system'],
    ['a label', 'Liquid%20Glass'],
    ['an empty value', ''],
    ['a near miss', 'liquid-glasses'],
  ])('leaves <html> byte-identical with %s', (_label, value) => {
    document.documentElement.className = 'dark font-var';
    if (value !== null) document.cookie = `sp_appearance=${value}; path=/`;
    document.cookie = 'unrelated=liquid-glass; path=/';
    const before = document.documentElement.outerHTML;
    runScript();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('sets data-appearance="liquid-glass" before paint when the cookie holds it', () => {
    document.documentElement.className = 'light';
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    runScript();
    expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass');
    // The colour scheme stays next-themes': the class is untouched.
    expect(document.documentElement.className).toBe('light');
  });

  it('adds nothing while this tab is held in classic after a glass crash', () => {
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    const before = document.documentElement.outerHTML;
    runScript();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('never throws when storage is unavailable', () => {
    document.cookie = 'sp_appearance=liquid-glass; path=/';
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(() => runScript()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});
