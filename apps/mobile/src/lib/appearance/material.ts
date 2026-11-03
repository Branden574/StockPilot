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
 *   opaque  Reduce Transparency on (any iOS), Android (Material 3, no blur; not
 *           released), anything else: every layer opaque, same layout.
 *
 * Classic is always 'opaque': it has no material, and its look never depends
 * on these inputs.
 *
 * In every glass material the content layer is the pre-blurred scene image
 * (SceneBackground), never a live blur behind lists; until the scene images
 * arrive it is the opaque --bg (DECISIONS Q7).
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
}

export function selectMaterial(inputs: MaterialInputs): GlassMaterial {
  if (inputs.style !== 'liquid-glass') return 'opaque';
  if (inputs.os !== 'ios') return 'opaque';
  if (inputs.reduceTransparency) return 'opaque';
  if (inputs.glassModuleAvailable && iosMajor(inputs.version) >= GLASS_MIN_IOS) return 'glass';
  return 'blur';
}

/** The palette is the opaque (reduced) one only for the opaque material. */
export function isOpaqueMaterial(material: GlassMaterial): boolean {
  return material === 'opaque';
}
