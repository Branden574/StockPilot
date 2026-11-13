import { describe, expect, it, vi } from 'vitest';

import { resolveGlassModule, type GlassModuleLoader } from './glass-module';
import {
  LOW_END_MEMORY_BYTES,
  LOW_END_YEAR_CLASS,
  isLowEndDevice,
  selectMaterial,
  selectScene,
  type MaterialInputs,
} from './material';
import {
  CLASSIC_TAB_BAR,
  GLASS_ANDROID_TAB_BAR,
  GLASS_IOS_TAB_BAR,
  glassCapsuleRight,
  tabBarFootprint,
  tabBarKind,
} from './tab-bar';

vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: '26.0' } }));

/**
 * Materials per platform and version (plan 5.2), the guarded glass module
 * (5.5), and the tab bar's reported footprint per style.
 */

const base: MaterialInputs = {
  style: 'liquid-glass',
  os: 'ios',
  version: '26.1',
  glassModuleAvailable: true,
  reduceTransparency: false,
  lowEnd: false,
};

describe('material selection matrix', () => {
  it.each([
    ['iOS 26 with the module', {}, 'glass'],
    [
      'iOS 26 without the module (the guarded require found nothing)',
      { glassModuleAvailable: false },
      'blur',
    ],
    ['iOS 18 (no Liquid Glass API)', { version: '18.6' }, 'blur'],
    ['iOS 16.4, the SDK floor', { version: '16.4', glassModuleAvailable: false }, 'blur'],
    ['iOS 26 with Reduce Transparency', { reduceTransparency: true }, 'opaque'],
    ['iOS 18 with Reduce Transparency', { version: '18.0', reduceTransparency: true }, 'opaque'],
    ['Android', { os: 'android', version: 35 }, 'opaque'],
    ['an unreadable iOS version', { version: 'beta' }, 'blur'],
    ['classic, anywhere', { style: 'classic' as const }, 'opaque'],
    // Revision R9: a low-end phone draws its chrome opaque (no live blur).
    ['a low-end iPhone on iOS 18', { version: '18.6', lowEnd: true }, 'opaque'],
    ['a low-end iPhone on iOS 26 with the module', { lowEnd: true }, 'opaque'],
  ])('%s -> %s', (_name, over, expected) => {
    expect(selectMaterial({ ...base, ...over })).toBe(expected);
  });
});

describe('the scene photo behind the content (plan 5.2, revision R9)', () => {
  it.each([
    ['iOS 26 glass', {}, true],
    ['iOS 18 blur', { version: '18.6' }, true],
    // Low-end: opaque chrome, same layout, the pre-blurred photo kept.
    ['a low-end phone', { lowEnd: true }, true],
    ['Reduce Transparency', { reduceTransparency: true }, false],
    ['a low-end phone with Reduce Transparency', { lowEnd: true, reduceTransparency: true }, false],
    ['Android (opaque Material 3)', { os: 'android', version: 35 }, false],
    ['classic', { style: 'classic' as const }, false],
  ])('%s -> %s', (_name, over, expected) => {
    expect(selectScene({ ...base, ...over })).toBe(expected);
  });
});

describe('a low-end device (revision R9: deviceYearClass < 2019 or totalMemory < 3 GB)', () => {
  it.each([
    ['iPhone 8 class: 2017, 2 GB', 2017, 2_076_000_000, true],
    ['iPhone XR class: 2018, 3 GB', 2018, 3_100_000_000, true],
    ['iPhone 11 class: 2019, 4 GB', 2019, 4_000_000_000, false],
    ['a 2020 device with 2 GB', 2020, 2_000_000_000, true],
    ['a 2021 device with 3 GB', 2021, 3_100_000_000, false],
    ['unknown year, 6 GB', null, 6_000_000_000, false],
    ['2022, unknown memory', 2022, null, false],
    ['nothing known', null, null, false],
  ])('%s -> %s', (_name, yearClass, totalMemory, expected) => {
    expect(isLowEndDevice({ yearClass, totalMemory })).toBe(expected);
  });

  it('the thresholds are the plan’s', () => {
    expect(LOW_END_YEAR_CLASS).toBe(2019);
    expect(LOW_END_MEMORY_BYTES).toBe(3_000_000_000);
  });
});

const present = (over: Partial<ReturnType<GlassModuleLoader['requirePackage']>> = {}) => ({
  optionalNativeModule: () => ({}),
  requirePackage: () => ({
    GlassView: 'GlassView',
    GlassContainer: 'GlassContainer',
    isGlassEffectAPIAvailable: () => true,
    isLiquidGlassAvailable: () => true,
    ...over,
  }),
});

describe('the one guarded loader of expo-glass-effect', () => {
  const ios26 = { os: 'ios', version: '26.0' };

  it('with the native module present and available: the components', () => {
    expect(resolveGlassModule(present(), ios26)).toEqual({
      GlassView: 'GlassView',
      GlassContainer: 'GlassContainer',
    });
  });

  it('with the native module ABSENT (the shipped binary lacks it): null, and the package is never required', () => {
    const requirePackage = vi.fn();
    expect(
      resolveGlassModule({ optionalNativeModule: () => null, requirePackage }, ios26),
    ).toBeNull();
    expect(requirePackage).not.toHaveBeenCalled();
  });

  it('present but the API missing (early iOS 26 betas) or Liquid Glass unavailable: null', () => {
    expect(
      resolveGlassModule(present({ isGlassEffectAPIAvailable: () => false }), ios26),
    ).toBeNull();
    expect(resolveGlassModule(present({ isLiquidGlassAvailable: () => false }), ios26)).toBeNull();
  });

  it('any throw while loading or checking: null, never a crash', () => {
    expect(
      resolveGlassModule(
        {
          optionalNativeModule: () => {
            throw new Error('no native glue');
          },
          requirePackage: () => ({}),
        },
        ios26,
      ),
    ).toBeNull();
    expect(
      resolveGlassModule(
        {
          optionalNativeModule: () => ({}),
          requirePackage: () => {
            throw new Error("Cannot find native view 'ExpoGlassEffect'");
          },
        },
        ios26,
      ),
    ).toBeNull();
  });

  it('below iOS 26 and on Android nothing is even asked', () => {
    const optionalNativeModule = vi.fn(() => ({}));
    const loader = { optionalNativeModule, requirePackage: present().requirePackage };
    expect(resolveGlassModule(loader, { os: 'ios', version: '18.2' })).toBeNull();
    expect(resolveGlassModule(loader, { os: 'android', version: 35 })).toBeNull();
    expect(optionalNativeModule).not.toHaveBeenCalled();
  });

  it('the real loader in a runtime without the module answers null without throwing', async () => {
    // Node has no ExpoGlassEffect: expo's native glue cannot load, which is
    // the absent-module path end to end (the require throws inside the guard).
    const { getGlassModule, GlassViewOrNull, GlassContainerOrNull } =
      await import('./glass-module');
    expect(() => getGlassModule()).not.toThrow();
    expect(getGlassModule()).toBeNull();
    expect(GlassViewOrNull()).toBeNull();
    expect(GlassContainerOrNull()).toBeNull();
  });
});

describe('the tab bar reports the footprint it draws', () => {
  it('classic is unchanged: 84 on iOS, 72 on Android', () => {
    expect(tabBarFootprint({ style: 'classic', os: 'ios', bottomInset: 34 })).toBe(84);
    expect(tabBarFootprint({ style: 'classic', os: 'android', bottomInset: 24 })).toBe(72);
    expect(CLASSIC_TAB_BAR.ios.height).toBe(84);
    expect(tabBarKind('classic', 'ios')).toBe('classic');
  });

  it('glass on iOS: the capsule (64) plus its bottom offset (22), for every material', () => {
    const footprint = tabBarFootprint({ style: 'liquid-glass', os: 'ios', bottomInset: 34 });
    expect(footprint).toBe(86);
    // The drawn frame: the capsule's top edge sits exactly footprint above the screen bottom,
    // and the Scan circle (64, same bottom) inside it.
    expect(GLASS_IOS_TAB_BAR.bottom + GLASS_IOS_TAB_BAR.height).toBe(footprint);
    expect(GLASS_IOS_TAB_BAR.bottom + GLASS_IOS_TAB_BAR.scanSize).toBeLessThanOrEqual(footprint);
    for (const material of ['glass', 'blur', 'opaque'] as const) {
      expect(tabBarFootprint({ style: 'liquid-glass', os: 'ios', bottomInset: 0, material })).toBe(
        86,
      );
    }
    expect(tabBarKind('liquid-glass', 'ios')).toBe('glass-ios');
  });

  it('glass on Android: the 80dp Material bar plus the bottom inset', () => {
    expect(tabBarFootprint({ style: 'liquid-glass', os: 'android', bottomInset: 24 })).toBe(
      GLASS_ANDROID_TAB_BAR.height + 24,
    );
    expect(tabBarFootprint({ style: 'liquid-glass', os: 'android', bottomInset: -3 })).toBe(80);
    expect(tabBarKind('liquid-glass', 'android')).toBe('material-android');
  });

  it('the capsule makes room for the Scan circle only when Scan is a chosen slot', () => {
    expect(glassCapsuleRight(true)).toBe(88);
    expect(glassCapsuleRight(false)).toBe(16);
  });
});
