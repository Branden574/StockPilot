import { describe, expect, it } from 'vitest';

import {
  isLaterTimestamp,
  isMissingAppearanceTableError,
  isUserId,
  legacyTheme,
  parseAccountRow,
  parseAnonFlowRecord,
  parseDeviceRecord,
  parseRollout,
  parseStyle,
  parseSyncRecord,
  parseThemeSetting,
  resolveScheme,
  shownStyle,
  timestampMicros,
} from './parse';
import {
  APPEARANCE_STORAGE_KEYS,
  APPEARANCE_STYLES,
  GLASS_ROLLOUTS,
  THEME_SETTINGS,
  defaultStyle,
} from './types';

const NOW = Date.UTC(2026, 10, 3, 10, 0, 0);
const A = 'a0000000-0000-4000-8000-0000000000a1';

describe('parseStyle and parseThemeSetting', () => {
  it('accept exactly the known words', () => {
    expect(APPEARANCE_STYLES).toEqual(['liquid-glass', 'classic']);
    expect(THEME_SETTINGS).toEqual(['light', 'dark', 'system']);
    for (const style of APPEARANCE_STYLES) expect(parseStyle(style)).toBe(style);
    for (const theme of THEME_SETTINGS) expect(parseThemeSetting(theme)).toBe(theme);
  });

  it('drop everything else: labels, case, spacing, the other axis, other types', () => {
    for (const bad of [
      'Liquid Glass',
      'liquid glass',
      'liquid_glass',
      'LIQUID-GLASS',
      'Classic',
      ' classic',
      'dark',
      'system',
      '',
      'glass',
      null,
      undefined,
      1,
      true,
      {},
      ['classic'],
    ]) {
      expect(parseStyle(bad)).toBeNull();
    }
    for (const bad of [
      'Dark',
      ' dark',
      'dark ',
      'auto',
      'liquid-glass',
      'classic',
      '',
      null,
      0,
      ['dark'],
    ]) {
      expect(parseThemeSetting(bad)).toBeNull();
    }
  });
});

describe('rollout', () => {
  it('reads exactly opt-in and default; anything else, the stage 2 value 1 included, is off', () => {
    expect(GLASS_ROLLOUTS).toEqual(['off', 'opt-in', 'default']);
    expect(parseRollout('opt-in')).toBe('opt-in');
    expect(parseRollout('default')).toBe('default');
    expect(parseRollout('off')).toBe('off');
    for (const bad of [
      undefined,
      null,
      '',
      '1',
      1,
      'true',
      'on',
      'Default',
      ' default',
      'opt_in',
      'optin',
    ]) {
      expect(parseRollout(bad)).toBe('off');
    }
  });

  it('the default style is the rollout’s: Liquid Glass only under default', () => {
    expect(defaultStyle('default')).toBe('liquid-glass');
    expect(defaultStyle('opt-in')).toBe('classic');
    expect(defaultStyle('off')).toBe('classic');
  });

  it('shownStyle follows the kill switch truth table (revision R5)', () => {
    // [style, rollout, crash fallback] -> shown
    const table: [
      Parameters<typeof shownStyle>[0],
      Parameters<typeof shownStyle>[1],
      boolean,
      string,
    ][] = [
      [null, 'off', false, 'classic'],
      ['classic', 'off', false, 'classic'],
      ['liquid-glass', 'off', false, 'classic'],
      [null, 'opt-in', false, 'classic'],
      ['classic', 'opt-in', false, 'classic'],
      ['liquid-glass', 'opt-in', false, 'liquid-glass'],
      [null, 'default', false, 'liquid-glass'],
      ['classic', 'default', false, 'classic'],
      ['liquid-glass', 'default', false, 'liquid-glass'],
    ];
    for (const [style, rollout, fallback, shown] of table) {
      expect(shownStyle(style, rollout, fallback)).toBe(shown);
    }
  });

  it('the crash fallback shows Classic under every rollout and for every choice', () => {
    for (const rollout of GLASS_ROLLOUTS) {
      for (const style of [null, 'classic', 'liquid-glass'] as const) {
        expect(shownStyle(style, rollout, true)).toBe('classic');
      }
    }
  });

  it('a malformed stored Design means never chose: the rollout default applies', () => {
    expect(shownStyle(parseStyle('Liquid Glass'), 'default', false)).toBe('liquid-glass');
    expect(shownStyle(parseStyle('garbage'), 'opt-in', false)).toBe('classic');
  });
});

describe('scheme', () => {
  it('resolveScheme: Light and Dark are fixed; System or nothing follows the device', () => {
    expect(resolveScheme('dark', false)).toBe('dark');
    expect(resolveScheme('dark', true)).toBe('dark');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('light', true)).toBe('light');
    expect(resolveScheme('system', false)).toBe('light');
    expect(resolveScheme('system', true)).toBe('dark');
    expect(resolveScheme(null, false)).toBe('light');
    expect(resolveScheme(null, true)).toBe('dark');
  });

  it('a legacy next-themes value is read as it is; anything else is null (follow the device)', () => {
    expect(legacyTheme('dark')).toBe('dark');
    expect(legacyTheme('light')).toBe('light');
    expect(legacyTheme('system')).toBe('system');
    expect(legacyTheme(null)).toBeNull();
    expect(legacyTheme(undefined)).toBeNull();
    expect(legacyTheme('liquid-glass')).toBeNull();
    expect(legacyTheme('"dark"')).toBeNull();
  });
});

describe('parseDeviceRecord', () => {
  it('reads a full version 2 record, as an object or as JSON text', () => {
    const record = { v: 2, style: 'classic', theme: 'dark', anonAt: NOW - 1000 };
    expect(parseDeviceRecord(record, NOW)).toEqual(record);
    expect(parseDeviceRecord(JSON.stringify(record), NOW)).toEqual(record);
  });

  it('reads one axis without the other', () => {
    expect(parseDeviceRecord({ v: 2, style: 'liquid-glass' }, NOW)).toEqual({
      v: 2,
      style: 'liquid-glass',
    });
    expect(parseDeviceRecord({ v: 2, theme: 'system' }, NOW)).toEqual({ v: 2, theme: 'system' });
  });

  it('drops a bad axis but keeps the good one', () => {
    expect(parseDeviceRecord({ v: 2, style: 'Liquid Glass', theme: 'dark' }, NOW)).toEqual({
      v: 2,
      theme: 'dark',
    });
    expect(parseDeviceRecord({ v: 2, style: 'classic', theme: 'auto' }, NOW)).toEqual({
      v: 2,
      style: 'classic',
    });
  });

  it('ignores the stage 2 version 1 record and its bare cookie word', () => {
    expect(parseDeviceRecord({ v: 1, mode: 'dark', lastClassic: 'dark' }, NOW)).toBeNull();
    expect(parseDeviceRecord({ v: 1, style: 'classic' }, NOW)).toBeNull();
    expect(parseDeviceRecord('liquid-glass', NOW)).toBeNull();
    expect(parseDeviceRecord('classic', NOW)).toBeNull();
    expect(parseDeviceRecord('dark', NOW)).toBeNull();
  });

  it('drops a record with no known axis, an unknown version, or broken JSON', () => {
    expect(parseDeviceRecord({ v: 2 }, NOW)).toBeNull();
    expect(parseDeviceRecord({ v: 2, anonAt: NOW }, NOW)).toBeNull();
    expect(parseDeviceRecord({ v: 3, style: 'classic' }, NOW)).toBeNull();
    expect(parseDeviceRecord({ style: 'classic' }, NOW)).toBeNull();
    expect(parseDeviceRecord('{"v":2,"style":', NOW)).toBeNull();
    expect(parseDeviceRecord('', NOW)).toBeNull();
    expect(parseDeviceRecord(null, NOW)).toBeNull();
    expect(parseDeviceRecord([], NOW)).toBeNull();
  });

  it('drops a bad anonAt instead of failing the whole record', () => {
    for (const anonAt of [String(NOW), Number.NaN, Number.POSITIVE_INFINITY, -5, 0, null]) {
      expect(parseDeviceRecord({ v: 2, style: 'classic', anonAt }, NOW)).toEqual({
        v: 2,
        style: 'classic',
      });
    }
  });

  it('SR2: drops an anonAt more than 60 s in the future, keeps one within 60 s', () => {
    expect(parseDeviceRecord({ v: 2, style: 'classic', anonAt: NOW + 60_001 }, NOW)).toEqual({
      v: 2,
      style: 'classic',
    });
    expect(
      parseDeviceRecord({ v: 2, style: 'classic', anonAt: NOW + 365 * 24 * 3600_000 }, NOW),
    ).toEqual({ v: 2, style: 'classic' });
    expect(parseDeviceRecord({ v: 2, style: 'classic', anonAt: NOW + 60_000 }, NOW)).toEqual({
      v: 2,
      style: 'classic',
      anonAt: NOW + 60_000,
    });
    expect(parseDeviceRecord({ v: 2, style: 'classic', anonAt: NOW - 3600_000 }, NOW)).toEqual({
      v: 2,
      style: 'classic',
      anonAt: NOW - 3600_000,
    });
  });
});

describe('parseSyncRecord', () => {
  const good = {
    v: 2,
    userId: A,
    dirtyAxes: ['style'],
    syncedAt: '2026-11-02T10:00:00.123456+00:00',
  };

  it('reads a well-formed record, as an object or as JSON text', () => {
    expect(parseSyncRecord(good)).toEqual(good);
    expect(parseSyncRecord(JSON.stringify(good))).toEqual(good);
    expect(parseSyncRecord({ ...good, syncedAt: null })).toEqual({ ...good, syncedAt: null });
    expect(parseSyncRecord({ ...good, dirtyAxes: [] })).toEqual({ ...good, dirtyAxes: [] });
  });

  it('puts the dirty axes in the canonical order', () => {
    expect(parseSyncRecord({ ...good, dirtyAxes: ['theme', 'style'] })?.dirtyAxes).toEqual([
      'style',
      'theme',
    ]);
  });

  it('SR1: the userId must be a UUID', () => {
    for (const userId of [
      '',
      'u-1',
      7,
      null,
      `${A} `,
      'a0000000-0000-4000-8000-0000000000a',
      '../x',
    ]) {
      expect(parseSyncRecord({ ...good, userId })).toBeNull();
    }
    expect(isUserId(A)).toBe(true);
    expect(isUserId(A.toUpperCase())).toBe(true);
  });

  it('SR1: dirtyAxes must be a subset of the two axes', () => {
    for (const dirtyAxes of [['mode'], ['style', 'style'], 'style', true, null, undefined, [1]]) {
      expect(parseSyncRecord({ ...good, dirtyAxes })).toBeNull();
    }
  });

  it('drops the stage 2 version 1 record and anything else malformed', () => {
    expect(parseSyncRecord({ v: 1, userId: A, dirty: true, syncedAt: null })).toBeNull();
    expect(parseSyncRecord({ ...good, v: 3 })).toBeNull();
    expect(parseSyncRecord({ ...good, syncedAt: 'yesterday' })).toBeNull();
    expect(parseSyncRecord({ ...good, syncedAt: undefined })).toBeNull();
    expect(parseSyncRecord('not json')).toBeNull();
    expect(parseSyncRecord(undefined)).toBeNull();
  });
});

describe('parseAnonFlowRecord', () => {
  it('reads the stamp, as an object or JSON text', () => {
    const stamp = { v: 1, anonAt: NOW, axes: ['theme'] };
    expect(parseAnonFlowRecord(stamp)).toEqual(stamp);
    expect(parseAnonFlowRecord(JSON.stringify(stamp))).toEqual(stamp);
  });

  it('drops a stamp with no axes, unknown axes, a bad time or another version', () => {
    expect(parseAnonFlowRecord({ v: 1, anonAt: NOW, axes: [] })).toBeNull();
    expect(parseAnonFlowRecord({ v: 1, anonAt: NOW, axes: ['mode'] })).toBeNull();
    expect(parseAnonFlowRecord({ v: 1, anonAt: 'now', axes: ['style'] })).toBeNull();
    expect(parseAnonFlowRecord({ v: 2, anonAt: NOW, axes: ['style'] })).toBeNull();
    expect(parseAnonFlowRecord(null)).toBeNull();
    expect(parseAnonFlowRecord('1')).toBeNull();
  });
});

describe('parseAccountRow', () => {
  it('reads the two columns as PostgREST returns them', () => {
    expect(
      parseAccountRow({
        style: 'liquid-glass',
        theme: 'dark',
        updated_at: '2026-11-02T10:00:00.5+00:00',
      }),
    ).toEqual({ style: 'liquid-glass', theme: 'dark', updatedAt: '2026-11-02T10:00:00.5+00:00' });
  });

  it('a null or unknown column is not chosen; the other is still read', () => {
    expect(
      parseAccountRow({ style: null, theme: 'light', updated_at: '2026-11-02T10:00:00Z' }),
    ).toEqual({
      style: null,
      theme: 'light',
      updatedAt: '2026-11-02T10:00:00Z',
    });
    expect(
      parseAccountRow({ style: 'classic', theme: 'Dark', updated_at: '2026-11-02T10:00:00Z' }),
    ).toEqual({ style: 'classic', theme: null, updatedAt: '2026-11-02T10:00:00Z' });
  });

  it('treats a missing, empty, stage 2 shaped or malformed row as no row', () => {
    expect(parseAccountRow(null)).toBeNull();
    expect(parseAccountRow(undefined)).toBeNull();
    expect(
      parseAccountRow({ style: null, theme: null, updated_at: '2026-11-02T10:00:00Z' }),
    ).toBeNull();
    expect(
      parseAccountRow({ appearance: 'liquid-glass', updated_at: '2026-11-02T10:00:00Z' }),
    ).toBeNull();
    expect(
      parseAccountRow({ style: 'Liquid Glass', updated_at: '2026-11-02T10:00:00Z' }),
    ).toBeNull();
    expect(parseAccountRow({ style: 'classic' })).toBeNull();
    expect(parseAccountRow({ style: 'classic', updated_at: 'soon' })).toBeNull();
    expect(parseAccountRow([{ style: 'classic', updated_at: '2026-11-02T10:00:00Z' }])).toBeNull();
  });
});

describe('timestamps', () => {
  it('keeps the microseconds Postgres returns', () => {
    const a = '2026-11-02T10:00:00.123456+00:00';
    const b = '2026-11-02T10:00:00.123457+00:00';
    expect(timestampMicros(b)! - timestampMicros(a)!).toBe(1);
    expect(isLaterTimestamp(b, a)).toBe(true);
    expect(isLaterTimestamp(a, b)).toBe(false);
    expect(isLaterTimestamp(a, a)).toBe(false);
  });

  it('reads every offset form and the Postgres space separator as the same instant', () => {
    const utc = timestampMicros('2026-11-02T10:00:00Z');
    expect(timestampMicros('2026-11-02T10:00:00+00:00')).toBe(utc);
    expect(timestampMicros('2026-11-02 10:00:00+00')).toBe(utc);
    expect(timestampMicros('2026-11-02T03:00:00-07:00')).toBe(utc);
    expect(timestampMicros('2026-11-02T15:30:00+0530')).toBe(utc);
    expect(timestampMicros('2026-11-02T10:00:00.000000000Z')).toBe(utc);
  });

  it('rejects text that is not a timestamp with an offset', () => {
    for (const bad of ['', 'now', '2026-11-02', '2026-11-02T10:00:00', '2026-13-45T10:00:00Z']) {
      expect(timestampMicros(bad)).toBeNull();
    }
  });

  it('a missing or unreadable earlier stamp is always earlier; an unreadable later one never wins', () => {
    expect(isLaterTimestamp('2026-11-02T10:00:00Z', null)).toBe(true);
    expect(isLaterTimestamp('2026-11-02T10:00:00Z', 'garbage')).toBe(true);
    expect(isLaterTimestamp('garbage', null)).toBe(false);
  });
});

describe('missing table', () => {
  it('recognises PostgREST PGRST205 and Postgres 42P01 only', () => {
    expect(
      isMissingAppearanceTableError({ code: 'PGRST205', message: 'not in schema cache' }),
    ).toBe(true);
    expect(isMissingAppearanceTableError({ code: '42P01' })).toBe(true);
    expect(isMissingAppearanceTableError({ code: '42501' })).toBe(false);
    expect(isMissingAppearanceTableError({ code: 'PGRST116' })).toBe(false);
    expect(isMissingAppearanceTableError(new Error('relation does not exist'))).toBe(false);
    expect(isMissingAppearanceTableError(null)).toBe(false);
  });
});

describe('storage keys', () => {
  it('the device records survive sign-out; the sync record on the phone is a workspace key', () => {
    expect(APPEARANCE_STORAGE_KEYS.phoneDevice.startsWith('workspace.')).toBe(false);
    expect(APPEARANCE_STORAGE_KEYS.phoneFallback.startsWith('workspace.')).toBe(false);
    expect(APPEARANCE_STORAGE_KEYS.phoneIntroSeen.startsWith('workspace.')).toBe(false);
    expect(APPEARANCE_STORAGE_KEYS.phoneSync.startsWith('workspace.')).toBe(true);
  });

  it('uses the revision names, none of the stage 2 ones (revision R2)', () => {
    expect(APPEARANCE_STORAGE_KEYS).toEqual({
      webCookie: 'sp_style',
      webDevice: 'sp-appearance',
      webSync: 'sp-appearance-sync',
      webFallback: 'sp-lg-fallback',
      webAnonFlow: 'sp-appearance-anon',
      webIntroSeen: 'sp-lg-intro-seen',
      webServerCookieAt: 'sp-style-server-at',
      phoneDevice: 'stockpilot.appearance.v2',
      phoneSync: 'workspace.appearance-sync',
      phoneFallback: 'stockpilot.appearance.fallback',
      phoneIntroSeen: 'stockpilot.appearance.intro.v1',
    });
  });
});
