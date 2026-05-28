import { useRouter } from 'expo-router';
import { ClipboardCheck } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Mono } from '@/components/ui/text';
import { countSelection, useCountSelectionCount } from '@/lib/use-count-selection';
import { useTheme } from '@/lib/use-theme';

/**
 * Floating bar shown while a list tab is in cycle-count select mode.
 * Reads the shared count-selection store so it reflects picks made across
 * both the Items and Books tabs. "Review" opens the confirm screen.
 */
export function CountSelectBar({
  visible,
  bottomInset,
}: {
  visible: boolean;
  bottomInset: number;
}) {
  const router = useRouter();
  const { c } = useTheme();
  const count = useCountSelectionCount();

  if (!visible) return null;

  return (
    <View
      style={[
        styles.wrap,
        { bottom: bottomInset + 12, backgroundColor: c.card, borderColor: c.hair },
      ]}
    >
      <Mono size={13} color={c.ink} style={{ fontVariant: ['tabular-nums'] }}>
        {count} selected
      </Mono>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <Pressable onPress={() => countSelection.clear()} hitSlop={8} disabled={count === 0}>
          <Mono size={12.5} color={count === 0 ? c.ink4 : c.ink3}>
            Clear
          </Mono>
        </Pressable>
        <Pressable
          onPress={() => {
            if (count === 0) return;
            router.push('/cycle-count/new');
          }}
          disabled={count === 0}
          style={({ pressed }) => [
            styles.reviewBtn,
            { backgroundColor: c.ink, opacity: count === 0 ? 0.4 : pressed ? 0.85 : 1 },
          ]}
        >
          <ClipboardCheck size={15} color={c.paper} strokeWidth={1.8} />
          <Mono size={13} color={c.paper}>
            Review
          </Mono>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  reviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
});
