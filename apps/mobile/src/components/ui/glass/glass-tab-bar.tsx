import { BottomTabBarHeightCallbackContext, type BottomTabBarProps } from 'expo-router/js-tabs';
import * as React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCameraGround } from '../../../lib/appearance/camera-ground';
import { GlassContainerOrNull } from '../../../lib/appearance/glass-module';
import { GLASS_MD_TOKENS } from '../../../lib/appearance/glass-tokens.generated';
import {
  GLASS_ANDROID_TAB_BAR,
  GLASS_IOS_TAB_BAR,
  glassCapsuleRight,
  glassTabBarLook,
  tabBarFootprint,
  type GlassTabBarLook,
} from '../../../lib/appearance/tab-bar';
import { useTheme } from '../../../lib/use-theme';

import { GlassSurface } from './glass-surface';

/**
 * The bottom bar in Liquid Glass, given to the tabs navigator as its `tabBar`
 * ((tabs)/_layout.tsx draws the classic bar unchanged otherwise). It shows the
 * SAME routes in the SAME order as the classic bar: Home, then the person's
 * chosen slots; every hidden (href: null) candidate stays mounted and
 * deep-linkable and is simply not drawn. Presses go through the navigator's
 * own tabPress event, so listeners (scroll-to-top, the active-tab guard) see
 * exactly what the classic bar sends.
 *
 *   iOS      the IosTabBar board: a floating capsule (GlassView on iOS 26+, the
 *            solid fallback below it, opaque under Reduce Transparency) and,
 *            when Scan is one of the chosen slots, Scan as its own 64pt circle
 *            beside it; both in one GlassContainer (spacing 8) on iOS 26+.
 *   Android  the AndroidNav board: an opaque Material 3 bar, 80dp plus the
 *            bottom inset, with the 64x32 indicator pill.
 *
 * It reports its drawn footprint (tab-bar.ts tabBarFootprint) to the
 * navigator, so useBottomTabBarHeight() and BottomTabBarHeightContext give
 * every list the right bottom padding.
 *
 * Every colour of the iOS bar comes from one look (tab-bar.ts
 * glassTabBarLook): the theme's own, except over the Scan camera, where the
 * page is dark in every scheme and the bar draws the Night look with the
 * Night sheet fill inside the capsule (LG-1: in Day the capsule's glass went
 * near-black there and the Day-ink icons and labels could not be seen).
 */

const SCAN_ROUTE = 'scan';

/** #RRGGBB at an alpha (the artifact's color-mix(var(--ink) 8%, transparent)). */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
}

type Route = BottomTabBarProps['state']['routes'][number];

function isDrawn(props: BottomTabBarProps, route: Route): boolean {
  const flat = StyleSheet.flatten(props.descriptors[route.key]?.options.tabBarItemStyle);
  return flat?.display !== 'none';
}

function usePress(props: BottomTabBarProps) {
  const { navigation, state } = props;
  return React.useCallback(
    (route: Route) => {
      const focused = state.routes[state.index]?.key === route.key;
      const event = navigation.emit({
        type: 'tabPress',
        target: route.key,
        canPreventDefault: true,
      });
      if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
    },
    [navigation, state],
  );
}

function useReportHeight(height: number) {
  const onHeightChange = React.useContext(BottomTabBarHeightCallbackContext);
  React.useLayoutEffect(() => {
    onHeightChange?.(height);
  }, [onHeightChange, height]);
}

export function GlassTabBar(props: BottomTabBarProps) {
  return Platform.OS === 'ios' ? (
    <IosGlassTabBar {...props} />
  ) : (
    <AndroidMaterialTabBar {...props} />
  );
}

function IosGlassTabBar(props: BottomTabBarProps) {
  const theme = useTheme();
  const { material, type } = theme;
  const press = usePress(props);
  const footprint = tabBarFootprint({ style: 'liquid-glass', os: 'ios', bottomInset: 0 });
  useReportHeight(footprint);

  const { state, descriptors } = props;
  // The Scan tab stays mounted behind the other tabs, so its camera page is
  // the ground only while Scan is the tab in front.
  const overCamera = useCameraGround() && state.routes[state.index]?.name === SCAN_ROUTE;
  const look = glassTabBarLook(theme, overCamera);
  const focusedKey = state.routes[state.index]?.key;
  const drawn = state.routes.filter((r) => isDrawn(props, r));
  const scan = drawn.find((r) => r.name === SCAN_ROUTE) ?? null;
  const inCapsule = drawn.filter((r) => r !== scan);
  const m = GLASS_IOS_TAB_BAR;
  const selectedFill = withAlpha(look.ink, 0.08);
  const label = type?.tab ?? { fontSize: 10.5, fontWeight: '600' as const };

  const GlassContainer = material === 'glass' ? GlassContainerOrNull() : null;
  const bar = (
    <>
      <GlassSurface
        variant="floating"
        radius={m.radius}
        solid
        scheme={look.scheme}
        style={[
          styles.capsule,
          {
            left: m.left,
            right: glassCapsuleRight(scan !== null),
            bottom: m.bottom,
            height: m.height,
            paddingHorizontal: m.paddingHorizontal,
          },
        ]}
      >
        {look.cameraFill ? (
          <View
            pointerEvents="none"
            style={[styles.fill, { borderRadius: m.radius, backgroundColor: look.cameraFill }]}
          />
        ) : null}
        <View accessibilityRole="tablist" style={styles.tabs}>
          {inCapsule.map((route) => {
            const options = descriptors[route.key]!.options;
            const focused = route.key === focusedKey;
            const color = focused ? look.accentText : look.ink;
            const title = options.title ?? route.name;
            return (
              <Pressable
                key={route.key}
                // "button", as the classic bar's own tab item asks for on iOS:
                // React Native gives the role "tab" no trait there, so
                // VoiceOver read no "button" (A11Y-1). Selected comes from
                // accessibilityState.
                accessibilityRole="button"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={options.tabBarAccessibilityLabel ?? title}
                onPress={() => press(route)}
                style={[
                  styles.tab,
                  {
                    height: m.tabHeight,
                    borderRadius: m.tabRadius,
                    gap: m.labelGap,
                    backgroundColor: focused ? selectedFill : 'transparent',
                  },
                ]}
              >
                {options.tabBarIcon?.({ focused, color, size: m.iconSize })}
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  allowFontScaling={false}
                  style={[label, { color }]}
                >
                  {title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </GlassSurface>
      {scan ? (
        <ScanCircle
          focused={scan.key === focusedKey}
          look={look}
          title={descriptors[scan.key]!.options.title ?? 'Scan'}
          icon={descriptors[scan.key]!.options.tabBarIcon}
          onPress={() => press(scan)}
        />
      ) : null}
    </>
  );

  return (
    <View pointerEvents="box-none" style={[styles.anchor, { height: footprint }]}>
      {GlassContainer ? (
        // eslint-disable-next-line react-hooks/static-components -- resolved once per JS runtime (glass-module.ts memo), so the same component type on every render
        <GlassContainer
          spacing={m.containerSpacing}
          pointerEvents="box-none"
          style={StyleSheet.absoluteFill}
        >
          {bar}
        </GlassContainer>
      ) : (
        bar
      )}
    </View>
  );
}

function ScanCircle({
  focused,
  look,
  title,
  icon,
  onPress,
}: {
  focused: boolean;
  look: GlassTabBarLook;
  title: string;
  icon: BottomTabBarProps['descriptors'][string]['options']['tabBarIcon'];
  onPress: () => void;
}) {
  const m = GLASS_IOS_TAB_BAR;
  // .ios-scanfab: accent-text glyph on glass; .on: an accent fill with the on-accent glyph.
  const color = focused ? look.onAccent : look.accentText;
  const circle = { right: m.scanRight, bottom: m.bottom, width: m.scanSize, height: m.scanSize };
  return (
    <View style={[styles.scan, circle]}>
      {focused ? (
        <View
          style={[styles.fill, { borderRadius: m.scanSize / 2, backgroundColor: look.accent }]}
        />
      ) : (
        <GlassSurface
          variant="floating"
          radius={m.scanSize / 2}
          solid
          scheme={look.scheme}
          style={styles.fill}
        />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={title}
        onPress={onPress}
        style={styles.scanPress}
      >
        {icon?.({ focused, color, size: m.scanIconSize })}
      </Pressable>
    </View>
  );
}

function AndroidMaterialTabBar(props: BottomTabBarProps) {
  const { mode, type, font } = useTheme();
  const insets = useSafeAreaInsets();
  const press = usePress(props);
  const footprint = tabBarFootprint({
    style: 'liquid-glass',
    os: 'android',
    bottomInset: insets.bottom,
  });
  useReportHeight(footprint);

  // The Material 3 palette of the scheme (generated from the AndroidNav board's .md tokens).
  const md = GLASS_MD_TOKENS[mode];
  const { state, descriptors } = props;
  const focusedKey = state.routes[state.index]?.key;
  const drawn = state.routes.filter((r) => isDrawn(props, r));
  const m = GLASS_ANDROID_TAB_BAR;
  const label = type?.mdNav ?? { fontSize: 12, fontWeight: '500' as const };

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.anchor,
        styles.md,
        {
          height: footprint,
          paddingTop: m.paddingTop,
          paddingBottom: m.paddingBottom + insets.bottom,
          backgroundColor: md.c,
        },
      ]}
    >
      {drawn.map((route) => {
        const options = descriptors[route.key]!.options;
        const focused = route.key === focusedKey;
        const title = options.title ?? route.name;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? title}
            onPress={() => press(route)}
            style={[styles.mdItem, { gap: m.gap }]}
          >
            <View
              style={{
                width: m.indicatorWidth,
                height: m.indicatorHeight,
                borderRadius: m.indicatorRadius,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: focused ? md.sc : 'transparent',
              }}
            >
              {options.tabBarIcon?.({
                focused,
                color: focused ? md.onSc : md.onV,
                size: m.iconSize,
              })}
            </View>
            <Text
              numberOfLines={1}
              allowFontScaling={false}
              style={[font.display, label, { color: focused ? md.on : md.onV }]}
            >
              {title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  capsule: { position: 'absolute', flexDirection: 'row', alignItems: 'center' },
  tabs: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  tab: { flex: 1, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  scan: { position: 'absolute' },
  fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  scanPress: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  md: { flexDirection: 'row' },
  mdItem: { flex: 1, minHeight: 48, alignItems: 'center' },
});
