import { Image, type ImageContentFit } from 'expo-image';
import * as React from 'react';
import type { StyleProp, ImageStyle } from 'react-native';

import { cacheKeyForUrl } from '@/lib/image-cache';

/**
 * Thin wrapper over expo-image that gives every item photo a stable
 * disk cache key (the storage path, not the rotating signed-URL token)
 * and a memory+disk cache policy. Net effect: a photo downloads once,
 * then renders instantly everywhere it appears — list rows, the detail
 * hero, the scan sheet.
 */
export function CachedImage({
  uri,
  style,
  contentFit = 'cover',
  recyclingKey,
  onError,
  cacheKey,
}: {
  uri: string;
  style?: StyleProp<ImageStyle>;
  contentFit?: ImageContentFit;
  /** Pass the item id in recycled lists (FlatList rows) to avoid stale frames. */
  recyclingKey?: string;
  /** The image could not be loaded (a failed download, an expired link). */
  onError?: () => void;
  /** The disk cache key, when the caller knows better than cacheKeyForUrl
   *  (which drops the whole query: right for a signed storage URL, whose
   *  token rotates, wrong for an external URL whose query IS the picture). */
  cacheKey?: string;
}) {
  return (
    <Image
      source={{ uri, cacheKey: cacheKey ?? cacheKeyForUrl(uri) }}
      style={style}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      transition={120}
      recyclingKey={recyclingKey}
      onError={onError}
    />
  );
}
