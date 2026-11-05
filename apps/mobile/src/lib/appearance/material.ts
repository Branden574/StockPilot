import type { AppearanceStyle } from '@stockpilot/core';

import { GLASS_MIN_IOS, iosMajor } from './ios-version';

/**
 * Which material Liquid Glass draws with on this device (plan 5.2):
 *
 *   glass   iOS 26+, the ExpoGlassEffect module present and its API available,
 *           Reduce Transparency off: GlassView (glassEffectStyle "regular",
 *           isInteractive) for floating chrome.
 *   blur    iOS below 26, or the glass module absent: BlurView (tint
 *           systemMaterial, intensity 80) for bars and sheets; the tab bar takes
 *           the artifact's solid fallback (IosTabBar material="solid").
 *   opaque  Reduce Transparency on (any iOS), a low-end device (revision R9:
 *           Device.deviceYearClass < 2019 or Device.totalMemory < 3 GB, so old
 *           iPhones on iOS 16.4-18 do not all run BlurView chrome now that
 *           glass is the default), Android (Material 3, no blur; not
 *           released), anything else: every layer opaque, same layout.
 *
 * Classic is always 'opaque': it has no material, and its look never depends
 * on these inputs.
 *
 * The content layer is the pre-blurred scene photo (SceneBackground), never a
 * live blur behind lists, whenever `selectScene` says so: in the glass and
 * blur materials, and on a low-end iPhone too (its chrome is opaque, the
 * photo is a plain image and costs nothing to scroll); never with Reduce
 * Transparency, on Android or in classic, where it is the opaque --bg. The
 * illustration files are committed (scene-assets.ts).
 */
export type GlassMaterial = 'glass' | 'blur' | 'opaque';

export interface MaterialInputs {
  style: AppearanceStyle;
  os: string;
  version: string | number;
  /** getGlassModule() !== null: the module is present and its API and Liquid Glass are available. */
  glassModuleAvailable: boolean;
  /** AccessibilityInfo.isReduceTransparencyEnabled (iOS); false elsewhere. */
  reduceTransparency: boolean;
  /** isLowEndDevice(...) for this phone. */
  lowEnd: boolean;
}

export function selectMaterial(inputs: MaterialInputs): GlassMaterial {
  if (inputs.style !== 'liquid-glass') return 'opaque';
  if (inputs.os !== 'ios') return 'opaque';
  if (inputs.reduceTransparency) return 'opaque';
  if (inputs.lowEnd) return 'opaque';
  if (inputs.glassModuleAvailable && iosMajor(inputs.version) >= GLASS_MIN_IOS) return 'glass';
  return 'blur';
}

/** Whether the pre-blurred scene photo is drawn behind the content (plan 5.2, R9). */
export function selectScene(
  inputs: Pick<MaterialInputs, 'style' | 'os' | 'reduceTransparency'>,
): boolean {
  return inputs.style === 'liquid-glass' && inputs.os === 'ios' && !inputs.reduceTransparency;
}

/** Revision R9: a phone made before 2019 by expo-device's year class ... */
export const LOW_END_YEAR_CLASS = 2019;
/**
 * ... or with less than 3 GB of memory. Device.totalMemory is the bytes the
 * OS reports (a 3 GB iPhone reports a little over 3,000,000,000 and a 2 GB
 * one about 2,070,000,000), so the threshold is the decimal 3 GB: a
 * nominal 3 GB phone is not "less than 3 GB".
 */
export const LOW_END_MEMORY_BYTES = 3_000_000_000;

/**
 * expo-device's deviceYearClass and totalMemory (either may be null: not
 * known, which never counts as low-end). Pure, so the matrix is tested;
 * device-class.ts reads the real values.
 */
export function isLowEndDevice(device: {
  yearClass: number | null;
  totalMemory: number | null;
}): boolean {
  if (device.yearClass !== null && device.yearClass < LOW_END_YEAR_CLASS) return true;
  return device.totalMemory !== null && device.totalMemory < LOW_END_MEMORY_BYTES;
}

/** The palette is the opaque (reduced) one only for the opaque material. */
export function isOpaqueMaterial(material: GlassMaterial): boolean {
  return material === 'opaque';
}
