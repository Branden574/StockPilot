import * as React from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { ACCENT } from '@/lib/theme';

/**
 * Animated corner-bracket scan frame. Four L-shaped brackets pulse
 * gently outward and a thin mint scan line sweeps top-to-bottom-to-top.
 * Used on Scan and AI shelf-scan capture screens.
 */
export function ScanFrame({
  width = 260,
  height = 260,
  color = '#fafaf7',
  animated = true,
}: {
  width?: number;
  height?: number;
  color?: string;
  animated?: boolean;
}) {
  const sweep = React.useRef(new Animated.Value(0)).current;
  const pulse = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!animated) return;
    Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 2000,
        easing: Easing.bezier(0.4, 0, 0.6, 1),
        useNativeDriver: true,
      }),
    ).start();
    Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2400,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    ).start();
  }, [animated, pulse, sweep]);

  const sweepY = sweep.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [height * 0.08, height * 0.92, height * 0.08],
  });
  const sweepOpacity = sweep.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.4, 1, 0.4],
  });

  const pulseScale = pulse.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 1.04, 1],
  });

  const arm = 28;
  const sw = 2.4;
  const corner = (pos: 'tl' | 'tr' | 'br' | 'bl') => {
    let rotate = '0deg';
    let style: any = {};
    if (pos === 'tl') {
      rotate = '0deg';
      style = { top: 0, left: 0 };
    }
    if (pos === 'tr') {
      rotate = '90deg';
      style = { top: 0, right: 0 };
    }
    if (pos === 'br') {
      rotate = '180deg';
      style = { bottom: 0, right: 0 };
    }
    if (pos === 'bl') {
      rotate = '-90deg';
      style = { bottom: 0, left: 0 };
    }
    return (
      <Animated.View
        key={pos}
        style={[
          style,
          {
            position: 'absolute',
            transform: [{ rotate }, { scale: pulseScale }],
          },
        ]}
      >
        <Svg width={arm + sw} height={arm + sw} viewBox={`0 0 ${arm + sw} ${arm + sw}`}>
          <Path
            d={`M 1 ${arm} V 1 H ${arm}`}
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>
      </Animated.View>
    );
  };

  return (
    <View style={[styles.frame, { width, height }]}>
      {corner('tl')}
      {corner('tr')}
      {corner('br')}
      {corner('bl')}
      {animated ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.sweep,
            {
              top: sweepY,
              opacity: sweepOpacity,
              shadowColor: ACCENT.mint,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'relative',
  },
  sweep: {
    position: 'absolute',
    left: 14,
    right: 14,
    height: 1.5,
    backgroundColor: ACCENT.mint,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 12,
    elevation: 4,
  },
});
