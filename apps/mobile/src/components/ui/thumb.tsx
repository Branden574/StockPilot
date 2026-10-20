import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { Box, type LucideIcon } from 'lucide-react-native';

import { CachedImage } from '@/components/ui/cached-image';
import { useTheme } from '@/lib/use-theme';
import { PHOTO_BACKGROUND } from './tones';

/**
 * Thumb — square thumbnail used in inventory rows, bundle components,
 * and scan result cards. Renders the user's uploaded product photo
 * when `imageUrl` is supplied, on white in both modes (the reference's
 * thumbnail ground, so a photo shot on white reads the same in light and
 * dark); otherwise falls back to a Lucide line-art glyph centred in a
 * recessed, hairline-bordered square. Optional accent pip top-right.
 */
export function Thumb({
  size = 56,
  icon: Icon = Box,
  pip,
  imageUrl,
  recyclingKey,
}: {
  size?: number;
  icon?: LucideIcon;
  pip?: string;
  imageUrl?: string | null;
  /** Stable id (e.g. item id) so recycled list rows don't flash the previous photo. */
  recyclingKey?: string;
}) {
  const { c } = useTheme();
  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderColor: c.hair,
          backgroundColor: imageUrl ? PHOTO_BACKGROUND : c.sunk,
        },
      ]}
    >
      {imageUrl ? (
        <CachedImage
          uri={imageUrl}
          style={{ width: size, height: size, borderRadius: 7 }}
          recyclingKey={recyclingKey}
        />
      ) : (
        <Icon size={size * 0.42} color={c.ink3} strokeWidth={1.4} />
      )}
      {pip ? (
        <View
          style={[
            styles.pip,
            { backgroundColor: pip },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    position: 'relative',
  },
  pip: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
