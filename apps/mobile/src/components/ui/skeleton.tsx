import * as React from 'react';
import { Animated, Easing, View } from 'react-native';

import { Hair } from '@/components/ui/card';
import { useTheme } from '@/lib/use-theme';

/**
 * Subtle pulsing block used as a placeholder while real content
 * loads. Apple-style: a low-amplitude opacity fade rather than a
 * sweeping shimmer — looks intentional, not flashy.
 */
function Block({
  width,
  height,
  radius = 4,
  style,
}: {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: object;
}) {
  const { c } = useTheme();
  const opacity = React.useRef(new Animated.Value(0.55)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.55,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: c.paper2,
          opacity,
        },
        style,
      ]}
    />
  );
}

/**
 * Mimics the Items list row exactly — joined edges, thumb + two
 * text bars + qty/status block. Caller passes `index` and `total`
 * so the first/last row get the right rounded corners.
 */
export function ItemRowSkeleton({ index, total }: { index: number; total: number }) {
  const { c } = useTheme();
  const isFirst = index === 0;
  const isLast = index === total - 1;
  return (
    <View
      style={{
        backgroundColor: c.card,
        borderTopWidth: isFirst ? 1 : 0,
        borderBottomWidth: 1,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderColor: c.hair,
        borderTopLeftRadius: isFirst ? 10 : 0,
        borderTopRightRadius: isFirst ? 10 : 0,
        borderBottomLeftRadius: isLast ? 10 : 0,
        borderBottomRightRadius: isLast ? 10 : 0,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          paddingVertical: 14,
          paddingHorizontal: 16,
        }}
      >
        <Block width={56} height={56} radius={10} />
        <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
          <Block width="72%" height={14} />
          <Block width="42%" height={10} />
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Block width={32} height={18} />
          <Block width={42} height={18} radius={9} />
        </View>
      </View>
      {!isLast ? <Hair inset={86} /> : null}
    </View>
  );
}

/**
 * Mimics a BookCard — standalone Card with gap between rows
 * (different from the joined Items layout).
 */
export function BookCardSkeleton() {
  const { c } = useTheme();
  return (
    <View
      style={{
        backgroundColor: c.card,
        borderColor: c.hair,
        borderWidth: 1,
        borderRadius: 12,
        padding: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Block width={56} height={56} radius={10} />
        <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
          <Block width="78%" height={14} />
          <Block width="48%" height={10} />
          <Block width="52%" height={10} />
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Block width={28} height={18} />
          <Block width={40} height={18} radius={9} />
        </View>
      </View>
    </View>
  );
}

/** Renders N stacked ItemRowSkeletons. */
export function ItemListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
      {Array.from({ length: count }).map((_, i) => (
        <ItemRowSkeleton key={i} index={i} total={count} />
      ))}
    </View>
  );
}

/** Renders N stacked BookCardSkeletons with a 10px gap. */
export function BookListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 6, gap: 10 }}>
      {Array.from({ length: count }).map((_, i) => (
        <BookCardSkeleton key={i} />
      ))}
    </View>
  );
}
