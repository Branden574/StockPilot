import { describe, expect, it, vi } from 'vitest';

import { resolveGlassModule, type GlassModuleLoader } from './glass-module';
import { selectMaterial, type MaterialInputs } from './material';
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
  ])('%s -> %s', (_name, over, expected) => {
    expect(selectMaterial({ ...base, ...over })).toBe(expected);
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
