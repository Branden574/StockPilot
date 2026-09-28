import { BookOpen } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { BOOK_COVER_PLACEHOLDER, bookCoverAlt } from '@stockpilot/core';

import { CachedImage } from '@/components/ui/cached-image';
import { bookCoverCacheKey } from '@/lib/book-order-totals-view';
import { useTheme } from '@/lib/use-theme';

/**
 * A book's cover in a portrait box (Book Order Totals, plan 9.4).
 *
 *   - `contain`, never `cover`: the whole jacket shows, title included, on a
 *     neutral backing (CachedImage defaults to cover, which crops).
 *   - The disk cache key is the storage path without the signed token, so a
 *     rotated URL is still the same picture; an external cover keeps its
 *     whole URL as the key (bookCoverCacheKey).
 *   - No URL yet, no cover, or a failed load: a neutral book glyph read as
 *     "No cover". A missing picture never removes or changes a number; the
 *     row around it is drawn from the API's figures either way.
 *   - With `onPress` and a picture, the cover is its own button ("Cover of
 *     <title>", opens it larger). It is a sibling of the row's button, never
 *     inside it: a touchable inside a touchable is unreachable with
 *     VoiceOver.
 */
export function BookCover({
  uri,
  title,
  width = 48,
  height = 72,
  onPress,
}: {
  uri: string | null;
  title: string;
  width?: number;
  height?: number;
  onPress?: () => void;
}) {
  const { c } = useTheme();
  // The URL that failed, so a new URL (a refreshed signature) gets its own try.
  const [failedUri, setFailedUri] = React.useState<string | null>(null);
  const showImage = uri !== null && failedUri !== uri;
  const frame = {
    width,
    height,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.hair,
    backgroundColor: c.paper2,
    overflow: 'hidden' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  if (!showImage) {
    return (
      <View
        style={frame}
        accessible
        accessibilityRole="image"
        accessibilityLabel={BOOK_COVER_PLACEHOLDER}
      >
        <BookOpen size={Math.round(width * 0.42)} color={c.ink4} strokeWidth={1.4} />
      </View>
    );
  }

  const image = (
    <CachedImage
      uri={uri}
      cacheKey={bookCoverCacheKey(uri)}
      contentFit="contain"
      style={{ width: width - 2, height: height - 2 }}
      onError={() => setFailedUri(uri)}
    />
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="imagebutton"
        accessibilityLabel={bookCoverAlt(title)}
        accessibilityHint="Opens the cover larger"
        style={({ pressed }) => [frame, { opacity: pressed ? 0.8 : 1 }]}
      >
        {image}
      </Pressable>
    );
  }

  return (
    <View style={frame} accessible accessibilityRole="image" accessibilityLabel={bookCoverAlt(title)}>
      {image}
    </View>
  );
}
