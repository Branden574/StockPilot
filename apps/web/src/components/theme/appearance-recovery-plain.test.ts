import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPEARANCE_STORAGE_KEYS,
  GLASS_ROLLOUTS,
  INITIAL_APPEARANCE_STATE,
  reduceAppearance,
} from '@stockpilot/core';

import { EXEMPT_PATHS } from './appearance-flag';
import {
  holdClassicForThisTab,
  isGlassShown,
  isServerRenderError,
  readStyleCookie,
  switchToClassicOnThisDevice,
} from './appearance-recovery-plain';

/**
 * "Use classic design" with no imports (plans/REVISION-DEFAULT.md R13, item
 * 12), shared by every error boundary, global-error.tsx included. It sets the
 * Design to Classic (record, cookie, then the server route), keeps the Theme,
 * marks the Design dirty only for the signed-in person its caller names (never
 * for whoever a leftover sync record names: R4, SR1, SR4), and clears the
 * fallback.
 * Its written-out keys and its print-route pattern must stay core's and the
 * flag module's (read from the file's text, since it may import nothing).
 */

const SOURCE = readFileSync(join(__dirname, 'appearance-recovery-plain.ts'), 'utf8');
const USER = '11111111-1111-4111-8111-111111111111';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.removeAttribute('data-lg-material');
});

describe('appearance-recovery-plain', () => {
  it('imports nothing, and writes out exactly core’s keys and the flag module’s print route', () => {
    expect(SOURCE).not.toMatch(/^import /mu);
    expect(SOURCE).toContain(`const COOKIE = '${APPEARANCE_STORAGE_KEYS.webCookie}'`);
    expect(SOURCE).toContain(`const DEVICE = '${APPEARANCE_STORAGE_KEYS.webDevice}'`);
    expect(SOURCE).toContain(`const SYNC = '${APPEARANCE_STORAGE_KEYS.webSync}'`);
    expect(SOURCE).toContain(`const FALLBACK = '${APPEARANCE_STORAGE_KEYS.webFallback}'`);
    expect(SOURCE).toContain(`const EXEMPT = ${EXEMPT_PATHS.toString()}`);
  });

  it('reads the Design cookie by its exact name', () => {
    expect(readStyleCookie()).toBeNull();
    document.cookie = 'sp_style=classic; path=/';
    expect(readStyleCookie()).toBe('classic');
  });

  describe('isGlassShown (global-error.tsx: rollout + cookie + path)', () => {
    const PAGE = '/dashboard';
    it('off: never', () => {
      for (const cookie of [null, 'liquid-glass', 'classic']) {
        expect(isGlassShown('off', cookie, PAGE)).toBe(false);
      }
    });
    it('default: unless the cookie says classic', () => {
      expect(isGlassShown('default', null, PAGE)).toBe(true);
      expect(isGlassShown('default', 'garbage', PAGE)).toBe(true);
      expect(isGlassShown('default', 'liquid-glass', PAGE)).toBe(true);
      expect(isGlassShown('default', 'classic', PAGE)).toBe(false);
    });
    it('opt-in: only when the cookie says liquid-glass', () => {
      expect(isGlassShown('opt-in', null, PAGE)).toBe(false);
      expect(isGlassShown('opt-in', 'classic', PAGE)).toBe(false);
      expect(isGlassShown('opt-in', 'liquid-glass', PAGE)).toBe(true);
    });
    it('never on the print route', () => {
      for (const rollout of GLASS_ROLLOUTS) {
        expect(isGlassShown(rollout, 'liquid-glass', '/dashboard/orders/a/print')).toBe(false);
      }
    });
  });

  it('sets the Design to Classic and keeps the Theme, then asks the server to re-issue the cookie', async () => {
    localStorage.setItem(
      'sp-appearance',
      JSON.stringify({ v: 2, style: 'liquid-glass', theme: 'dark' }),
    );
    localStorage.setItem('theme', 'dark');
    sessionStorage.setItem('sp-lg-fallback', 'pending');
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    document.documentElement.setAttribute('data-lg-material', 'reduced');

    expect(switchToClassicOnThisDevice()).toBeUndefined();

    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({
      v: 2,
      style: 'classic',
      theme: 'dark',
    });
    expect(readStyleCookie()).toBe('classic');
    expect(document.cookie).toContain('sp_style=classic');
    // next-themes' theme is the person's Theme: untouched.
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(sessionStorage.getItem('sp-lg-fallback')).toBeNull();
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
    expect(document.documentElement.hasAttribute('data-lg-material')).toBe(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/appearance/style');
    expect(init).toMatchObject({ method: 'POST', body: '{"style":"classic"}' });
    expect(new Headers((init as RequestInit).headers).get('x-sp-appearance')).toBe('1');
  });

  it('starts a record when there is none, and drops a signed-out stamp it no longer stands for', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, theme: 'light', anonAt: 5 }));
    switchToClassicOnThisDevice();
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({
      v: 2,
      style: 'classic',
      theme: 'light',
    });
    localStorage.clear();
    switchToClassicOnThisDevice();
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toEqual({ v: 2, style: 'classic' });
  });

  it('marks the Design dirty for the signed-in person its caller names, keeping what the record already said', () => {
    localStorage.setItem(
      'sp-appearance-sync',
      JSON.stringify({
        v: 2,
        userId: USER,
        dirtyAxes: ['theme'],
        syncedAt: '2026-11-02T10:00:00.000001+00:00',
      }),
    );
    switchToClassicOnThisDevice(USER);
    expect(JSON.parse(localStorage.getItem('sp-appearance-sync')!)).toEqual({
      v: 2,
      userId: USER,
      dirtyAxes: ['style', 'theme'],
      syncedAt: '2026-11-02T10:00:00.000001+00:00',
    });
  });

  describe('a sync record its caller did not name (it can outlive its session: R4, SR1, SR4)', () => {
    const SYNCED = '2026-11-02T10:00:00.000001+00:00';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const lingering = (dirtyAxes: string[]) =>
      JSON.stringify({ v: 2, userId: USER, dirtyAxes, syncedAt: SYNCED });

    it('is never marked dirty when the caller names nobody (a signed-out page, global-error) or someone else', () => {
      for (const named of [undefined, null, OTHER]) {
        localStorage.setItem('sp-appearance-sync', lingering([]));
        switchToClassicOnThisDevice(named);
        expect(localStorage.getItem('sp-appearance-sync')).toBe(lingering([]));
      }
    });

    it('loses its Design flag (the Design on this device is no longer that person’s choice) and keeps its Theme flag', () => {
      localStorage.setItem('sp-appearance-sync', lingering(['style', 'theme']));
      switchToClassicOnThisDevice();
      expect(JSON.parse(localStorage.getItem('sp-appearance-sync')!)).toEqual({
        v: 2,
        userId: USER,
        dirtyAxes: ['theme'],
        syncedAt: SYNCED,
      });
    });

    it('so the person it names never has this device’s Classic pushed to their account unread at their next sign-in', () => {
      // Person A synced here; their session then ended without a sign-out
      // that forgets the account (the error card's "Sign out and back in",
      // an expired session). Someone else, signed out, presses Use classic
      // design on an error page.
      localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
      localStorage.setItem('sp-appearance-sync', lingering([]));
      switchToClassicOnThisDevice();
      // A signs in on this browser later: the provider hydrates, then the
      // dashboard shell names A.
      const now = Date.parse('2026-11-03T12:00:00Z');
      const hydrated = reduceAppearance(INITIAL_APPEARANCE_STATE, {
        type: 'hydrate',
        device: localStorage.getItem('sp-appearance'),
        sync: localStorage.getItem('sp-appearance-sync'),
        anonFlow: null,
        now,
      });
      const signIn = reduceAppearance(hydrated.state, { type: 'authenticated', userId: USER, now });
      expect(signIn.effects.filter((e) => e.type === 'save')).toEqual([]);
      expect(signIn.effects).toContainEqual({ type: 'fetch', userId: USER, gen: 0 });
    });
  });

  it('never invents a sync record, and leaves one it cannot read alone', () => {
    switchToClassicOnThisDevice();
    expect(localStorage.getItem('sp-appearance-sync')).toBeNull();
    const old = JSON.stringify({ v: 1, userId: USER, dirty: false, syncedAt: null });
    localStorage.setItem('sp-appearance-sync', old);
    switchToClassicOnThisDevice();
    expect(localStorage.getItem('sp-appearance-sync')).toBe(old);
  });

  it('a localStorage write that fails drops the Liquid Glass record, so the next load reads the classic cookie', () => {
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    // localStorage that throws for the device record only, as a full quota does.
    const real = window.localStorage;
    const fake = {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === 'sp-appearance') throw new DOMException('full', 'QuotaExceededError');
        real.setItem(key, value);
      },
      removeItem: (key: string) => real.removeItem(key),
    } as unknown as Storage;
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(fake);
    switchToClassicOnThisDevice();
    expect(real.getItem('sp-appearance')).toBeNull();
    expect(readStyleCookie()).toBe('classic');
  });

  it('tells a server render error (Next stamps a digest on it) from one thrown in the browser', () => {
    expect(isServerRenderError(Object.assign(new Error('x'), { digest: '2938471' }))).toBe(true);
    expect(isServerRenderError(new Error('x'))).toBe(false);
    expect(isServerRenderError(Object.assign(new Error('x'), { digest: '' }))).toBe(false);
    expect(isServerRenderError(Object.assign(new Error('x'), { digest: 42 }))).toBe(false);
    expect(isServerRenderError('boom')).toBe(false);
    expect(isServerRenderError(null)).toBe(false);
    expect(isServerRenderError(undefined)).toBe(false);
  });

  it('holds the tab in classic once without touching the stored choice', () => {
    document.cookie = 'sp_style=liquid-glass; path=/';
    holdClassicForThisTab();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('pending');
    sessionStorage.setItem('sp-lg-fallback', 'shown');
    holdClassicForThisTab();
    expect(sessionStorage.getItem('sp-lg-fallback')).toBe('shown');
    expect(readStyleCookie()).toBe('liquid-glass');
  });
});
