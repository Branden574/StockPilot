import * as React from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useProfile } from '@/lib/use-profile';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { Mono } from './text';

/**
 * Shared profile avatar — shows the user's uploaded photo from
 * `user_profiles.avatar_url` when present, otherwise falls back to a
 * monogram of their initials inside a hairline-bordered circle. Same
 * source as the web app's topbar avatar; updates on the web appear
 * here on the next mount (or after force-refresh).
 */
export function Avatar({
  size = 38,
  bordered = true,
  onPress,
}: {
  size?: number;
  bordered?: boolean;
  onPress?: () => void;
}) {
  const { c } = useTheme();
  const profile = useProfile();
  const radius = size / 2;
  const fontSize = size >= 52 ? 14 : size >= 38 ? 11 : 10;

  const content = profile.avatarUrl ? (
    <Image
      source={{ uri: profile.avatarUrl }}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
      }}
    />
  ) : (
    <View
      style={[
        styles.fallback,
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: c.card,
          borderColor: bordered ? c.ink3 : 'transparent',
          borderWidth: bordered ? 1.4 : 0,
        },
      ]}
    >
      {/*
        The monogram is decoration sized to its container: the circle is a
        fixed `size` prop set by the caller and cannot reflow, so the initials
        are capped to the chrome ceiling. Nothing is lost — this is a fallback
        for a missing photo, and the user's name is on the screen it opens.
      */}
      <Mono
        size={fontSize}
        tracking={0.04}
        color={c.ink}
        maxFontSizeMultiplier={capTo(fontSize, TYPE_CEILING.chrome)}
        style={{ fontFamily: FONT.mono }}
      >
        {profile.initials}
      </Mono>
    </View>
  );

  const wrapper = bordered && profile.avatarUrl
    ? (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          borderWidth: 1,
          borderColor: c.hair,
          overflow: 'hidden',
        }}
      >
        {content}
      </View>
    )
    : content;

  if (!onPress) return wrapper;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      hitSlop={8}
    >
      {wrapper}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
