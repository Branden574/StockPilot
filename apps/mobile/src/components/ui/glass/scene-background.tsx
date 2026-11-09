import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '../../../lib/use-theme';

import { SCENE_IMAGES } from './scene-assets';

/**
 * Layer 0 of Liquid Glass (spec/design-system.md 3.1): the scene behind the
 * content, drawn once per screen, absolutely filling its parent, under
 * everything (pointerEvents none).
 *
 *   - the theme's `scene` on (Liquid Glass on iOS in the glass or blur
 *     material, or a low-end iPhone whose chrome is opaque; material.ts
 *     selectScene): the iOS boards' ground (spec/design-system.md 13, "iOS
 *     glass"; sp.css:1040-1041), from the bottom: the pre-blurred day or night
 *     illustration (committed, scene-assets.ts) by cover at 42% across and
 *     centred down, as the boards place it, then the 180deg wash (Day a warm
 *     white, Night black), then the scheme's veil (Day: a warm 6-2% wash;
 *     Night: an ink 18-30% wash);
 *   - otherwise (Reduce Transparency, Android, or a classic screen): the
 *     opaque --bg, which is also what paints first while an image loads, so
 *     the first paint is never blank.
 *
 * expo-image draws the picture because React Native's Image can only centre
 * a cover image; its contentPosition places it as CSS object-position does.
 * Both expo-image and expo-linear-gradient are in the 1.4.0 binary (app
 * dependencies since April and May 2026), so this ships by update.
 *
 * Never a live BlurView: content cards read on their own card fill over this.
 */
export function SceneBackground() {
  const { scene, mode, c } = useTheme();
  const source = scene ? (mode === 'dark' ? SCENE_IMAGES.night : SCENE_IMAGES.day) : null;
  const ground = mode === 'dark' ? NIGHT : DAY;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.paper }]}>
      {source ? (
        <>
          <Image
            source={source}
            contentFit="cover"
            contentPosition={SCENE_POSITION}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={ground.wash}
            locations={WASH_STOPS}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient colors={ground.veil} style={StyleSheet.absoluteFill} />
        </>
      ) : null}
    </View>
  );
}

/** `42% center / cover` (sp.css:1040): the board's crop, not the centre. */
const SCENE_POSITION = { left: '42%', top: '50%' } as const;

/** The wash's stops: top, 40% down, bottom. Both gradients run top to bottom (180deg), expo-linear-gradient's default. */
const WASH_STOPS = [0, 0.4, 1] as const;

/** sp.css:1040: the wash; --scene-veil (spec tokens): linear-gradient(180deg, rgba(255,250,242,.06), .02). */
const DAY = {
  wash: ['rgba(255,250,244,0.30)', 'rgba(255,250,244,0.10)', 'rgba(255,250,244,0.36)'],
  veil: ['rgba(255,250,242,0.06)', 'rgba(255,250,242,0.02)'],
} as const;

/** sp.css:1041: the wash; --scene-veil (spec tokens): linear-gradient(180deg, rgba(6,10,9,.18), .30). */
const NIGHT = {
  wash: ['rgba(0,0,0,0.25)', 'rgba(0,0,0,0.05)', 'rgba(0,0,0,0.35)'],
  veil: ['rgba(6,10,9,0.18)', 'rgba(6,10,9,0.30)'],
} as const;
