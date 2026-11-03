import * as React from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { useTheme } from '../../../lib/use-theme';

import { SCENE_IMAGES } from './scene-assets';

/**
 * Layer 0 of Liquid Glass (spec/design-system.md 3.1): the scene behind the
 * content, drawn once per screen, absolutely filling its parent, under
 * everything (pointerEvents none).
 *
 *   - glass / blur materials with the scene image present: the pre-blurred
 *     day or night image, cover, plus the scheme's veil (Day: a warm 2-6%
 *     wash; Night: an ink 18-30% wash);
 *   - otherwise (Reduce Transparency, Android, the images not added yet, or a
 *     classic screen): the opaque --bg, which is also what paints first while
 *     an image loads, so the first paint is never blank.
 *
 * Never a live BlurView: content cards read on their own card fill over this.
 */
export function SceneBackground() {
  const { style, material, mode, c } = useTheme();
  const source =
    style === 'liquid-glass' && material !== 'opaque'
      ? mode === 'dark'
        ? SCENE_IMAGES.night
        : SCENE_IMAGES.day
      : null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.paper }]}>
      {source ? (
        <>
          <Image source={source} resizeMode="cover" style={StyleSheet.absoluteFill} />
          <View
            style={[StyleSheet.absoluteFill, mode === 'dark' ? styles.veilNight : styles.veilDay]}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // --scene-veil (spec tokens): Day linear-gradient(rgba(255,250,242,.06), .02),
  // Night linear-gradient(rgba(6,10,9,.18), .30); drawn here at its mean, flat.
  veilDay: { backgroundColor: 'rgba(255,250,242,0.04)' },
  veilNight: { backgroundColor: 'rgba(6,10,9,0.24)' },
});
