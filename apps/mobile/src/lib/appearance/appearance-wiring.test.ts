import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DESIGN_OPTIONS,
  FALLBACK_NOTICE,
  INTRO_NOTICE,
  RECOVERY_ACTION_LABEL,
  THEME_OPTIONS,
  appearanceFootnote,
  appearanceLabel,
  syncLine,
} from './labels';

/**
 * How the appearance is wired into the shell, read as source (the suite has
 * no React Native renderer; phone-shell-structure.test.ts pins the classic
 * shell itself, which these changes leave as it was).
 */
const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const flat = (file: string) =>
  readFileSync(path.join(MOBILE_ROOT, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

describe('root layout', () => {
  const src = flat('app/_layout.tsx');

  it('the provider sits above RootLayout, unkeyed, and is what Sentry wraps', () => {
    expect(src).toContain(
      'function AppearanceRoot() { return ( <AppearanceProvider> <RootLayout /> </AppearanceProvider> ); }',
    );
    expect(src).toContain('export default Sentry.wrap(AppearanceRoot);');
    expect(src).not.toMatch(/<AppearanceProvider[^>]*key=/);
    expect(src).not.toMatch(/<RootLayout[^>]*key=/);
  });

  it('the first paint waits for the appearance read as it does for the fonts, after them', () => {
    const fonts = src.indexOf('if (!fontsReady) {');
    const appearance = src.indexOf('{appearanceReady ? (');
    expect(fonts).toBeGreaterThan(-1);
    expect(appearance).toBeGreaterThan(fonts);
    expect(src).toContain('const appearanceReady = useAppearanceReady();');
    // Everything drawn waits: the status bar, RootGate (and every screen),
    // the crash notice and the splash.
    const drawnAt = [...src.matchAll(/\{appearanceReady \? \(/g)].map((m) => m.index ?? -1);
    expect(drawnAt).toHaveLength(2);
    const [shell, overlays] = drawnAt;
    for (const [what, at] of [
      ['status bar', src.indexOf('<StatusBar ')],
      ['RootGate', src.indexOf('<RootGate />')],
    ] as const) {
      expect(at, what).toBeGreaterThan(shell);
      expect(at, what).toBeLessThan(src.indexOf('</AuthProvider>'));
    }
    expect(src.indexOf('<AppearanceFallbackNotice />')).toBeGreaterThan(overlays);
    expect(src.indexOf('<ColdLaunchSplash')).toBeGreaterThan(overlays);
  });

  it('AuthProvider mounts the moment the fonts are ready, as before, never behind the appearance wait (finding 2)', () => {
    // auth-js validates the stored session inside its own initialize(): a
    // refresh the server refuses removes it and announces SIGNED_OUT to the
    // listeners subscribed at that moment only (later ones get
    // INITIAL_SESSION). The first-start wait reads the session and the row
    // (both await that initialize), so AuthProvider must already be listening
    // or the involuntary sign-out (sign-in routing, the L137 cleanup) is lost.
    const layout = src.slice(
      src.indexOf('function RootLayout()'),
      src.indexOf('function AppearanceRoot()'),
    );
    expect(layout).not.toContain('if (!appearanceReady)');
    const fonts = layout.indexOf('if (!fontsReady) {');
    const auth = layout.indexOf('<AuthProvider>');
    const bridge = layout.indexOf('<AppearanceSessionBridge />');
    const firstWait = layout.indexOf('{appearanceReady ? (');
    expect(fonts).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(fonts);
    expect(bridge).toBeGreaterThan(auth);
    expect(firstWait).toBeGreaterThan(bridge);
  });

  it('RootLayout subscribes to the ready flag alone, never to the sync status', () => {
    // A save or fetch answering ("Saving...", "Saved to your account") must not
    // re-render RootLayout and the whole tree under it.
    expect(src).not.toMatch(/useAppearance\(\)/);
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('<ReadyContext.Provider value={snapshot.ready}>');
  });

  it('the provider tells the OS a fixed Light or Dark Theme in both Designs, so alerts and the keyboard match (item 34)', () => {
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('applyOsScheme(snapshot.theme);');
    expect(provider).not.toContain('applyOsScheme(snapshot.style');
  });

  it('every AppState change goes to the controller, which keeps B44’s definition of a return (item 32)', () => {
    const provider = flat('src/lib/appearance/provider.tsx');
    // Seeded with the state found at subscription (a launch in the background).
    expect(provider).toContain(
      "controller.onAppState(AppState.currentState); const sub = AppState.addEventListener('change', controller.onAppState);",
    );
    // No 'active' check of its own: inactive to active is not a return.
    expect(provider).not.toMatch(/next === 'active'/);
  });

  it('the network is listened to while a retry is owed, a failed read included (rule 2)', () => {
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('const retryOwed = snapshot.retryOwed;');
    expect(provider).toContain(
      'if (!retryOwed) return; const netSub = Network.addNetworkStateListener((net) => { controller.onNetwork(net.isConnected === true && net.isInternetReachable !== false); });',
    );
    expect(provider).toContain('}, [controller, retryOwed]);');
  });

  it('the first-start account read waits inside the font gate’s 4 s, never after it (item 31)', () => {
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('export const APPEARANCE_READ_TIMEOUT_MS = 4000;');
    expect(src).toContain('const FONT_GATE_TIMEOUT_MS = 4000;');
    // Both timers start at mount: the provider's with the read, not after the fonts.
    expect(provider).toContain(
      'void controller.hydrate(); const timer = setTimeout(() => controller.giveUpWaiting(), APPEARANCE_READ_TIMEOUT_MS);',
    );
  });

  it('the low-end class and the scene photo are decided with the material', () => {
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('const lowEnd = glass && isThisDeviceLowEnd();');
    expect(provider).toContain(
      'return { material: selectMaterial(inputs), scene: selectScene(inputs) };',
    );
  });

  it('the session bridge is inside AuthProvider; the notice outside the error boundary', () => {
    const auth = src.indexOf('<AuthProvider>');
    const bridge = src.indexOf('<AppearanceSessionBridge />');
    const authEnd = src.indexOf('</AuthProvider>');
    expect(bridge).toBeGreaterThan(auth);
    expect(bridge).toBeLessThan(authEnd);
    expect(src.indexOf('<AppearanceFallbackNotice />')).toBeGreaterThan(authEnd);
  });

  it('the status bar still gets light or dark only', () => {
    expect(src).toContain(
      "<StatusBar style={splashVisible || mode === 'dark' ? 'light' : 'dark'} />",
    );
  });
});

describe('tab bar', () => {
  const src = flat('app/(drawer)/(tabs)/_layout.tsx');
  const bar = flat('src/components/ui/glass/glass-tab-bar.tsx');

  it('Liquid Glass hands the navigator its own bar; classic passes none', () => {
    expect(src).toContain('tabBar={glassBar ? renderGlassTabBar : undefined}');
    expect(src).toContain("const glassBar = tabBarKind(style, Platform.OS) !== 'classic';");
    // The navigator's first height is the glass footprint; classic keeps styles.bar.
    expect(src).toContain(
      "glassFootprint === null ? null : { tabBarStyle: { position: 'absolute' as const, height: glassFootprint } }",
    );
    expect(src).toContain('...glassOptions, }}');
  });

  it('the glass bar reports the footprint it draws and draws inside it', () => {
    expect(bar).toContain(
      "const footprint = tabBarFootprint({ style: 'liquid-glass', os: 'ios', bottomInset: 0 });",
    );
    expect(bar).toContain('useReportHeight(footprint);');
    expect(bar).toContain('onHeightChange?.(height);');
    expect(bar).toContain('style={[styles.anchor, { height: footprint }]}');
    // Hidden (href: null) routes stay mounted but are not drawn.
    expect(bar).toContain("return flat?.display !== 'none';");
    // Presses go through the navigator's own tabPress event.
    expect(bar).toContain(
      "navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true, });",
    );
    expect(bar).toContain(
      'if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);',
    );
  });

  // LG-1: over the Scan camera the capsule went near-black in Day and its
  // Day-ink icons and labels with it. The Scan tab's camera page says it is
  // on screen, and the bar then draws the Night look with the Night sheet fill.
  it('over the Scan camera the bar draws the Night look and its fill, from one look', () => {
    expect(bar).toContain(
      'const overCamera = useCameraGround() && state.routes[state.index]?.name === SCAN_ROUTE;',
    );
    expect(bar).toContain('const look = glassTabBarLook(theme, overCamera);');
    // No colour of the bar is read past the look: the old fixed Day ink is gone.
    expect(bar).not.toContain('const color = focused ? accentText : c.ink;');
    expect(bar).toContain('const color = focused ? look.accentText : look.ink;');
    expect(bar).toContain('const selectedFill = withAlpha(look.ink, 0.08);');
    expect((bar.match(/scheme=\{look\.scheme\}/g) ?? []).length).toBe(2);
    expect(bar).toContain(
      '{look.cameraFill ? ( <View pointerEvents="none" style={[styles.fill, { borderRadius: m.radius, backgroundColor: look.cameraFill }]} /> ) : null}',
    );
    // The fill is under the tabs, inside the capsule.
    expect(bar.indexOf('look.cameraFill ? (')).toBeGreaterThan(bar.indexOf('variant="floating"'));
    expect(bar.indexOf('look.cameraFill ? (')).toBeLessThan(
      bar.indexOf('<View accessibilityRole="tablist" style={styles.tabs}>'),
    );
    expect(bar).toContain('const color = focused ? look.onAccent : look.accentText;');
    expect(bar).toContain('backgroundColor: look.accent }');
  });

  it('the Scan tab holds the camera ground only on its camera page, and only in Liquid Glass', () => {
    const scan = flat('app/(drawer)/(tabs)/scan.tsx');
    const held = scan.indexOf('{lg ? <CameraGround /> : null}');
    expect(held).toBeGreaterThan(-1);
    expect(scan.match(/<CameraGround \/>/g)).toHaveLength(1);
    // After both early returns: the permission pages sit over the Day or
    // Night scene and keep the ordinary capsule.
    expect(held).toBeGreaterThan(scan.indexOf('if (!permission.granted) {'));
    expect(held).toBeGreaterThan(scan.indexOf('<View style={styles.container}>'));
    expect(held).toBeLessThan(scan.indexOf('style={styles.cameraBar}'));
    expect(flat('src/components/ui/glass/camera-ground.tsx')).toContain(
      'React.useEffect(() => retainCameraGround(), []);',
    );
  });

  // A11Y-1. iOS React Native gives the role "tab" no trait
  // (accessibilityPropsConversions.h: anything it does not list is None), so
  // the glass tabs were read without "button" where Classic's are buttons
  // (the navigator's own tab item asks for 'button' on iOS and 'tab'
  // elsewhere). Selected comes from accessibilityState and is kept.
  it('every tab is a selected-aware button for VoiceOver on iOS, a tab on Android', () => {
    const ios = bar.slice(
      bar.indexOf('function IosGlassTabBar('),
      bar.indexOf('function AndroidMaterialTabBar('),
    );
    const android = bar.slice(bar.indexOf('function AndroidMaterialTabBar('));
    // The capsule's tabs and the Scan circle.
    expect((ios.match(/accessibilityRole="button"/g) ?? []).length).toBe(2);
    expect(ios).not.toContain('accessibilityRole="tab"');
    expect((ios.match(/accessibilityState=\{\{ selected: focused \}\}/g) ?? []).length).toBe(2);
    expect((android.match(/accessibilityRole="tab"/g) ?? []).length).toBe(1);
    expect((android.match(/accessibilityState=\{\{ selected: focused \}\}/g) ?? []).length).toBe(1);
    // The names VoiceOver reads are unchanged.
    expect(ios).toContain('accessibilityLabel={options.tabBarAccessibilityLabel ?? title}');
    expect(ios).toContain('accessibilityLabel={title}');
  });

  it('the glass segmented control (not on a screen yet) asks for the same roles', () => {
    const segmented = flat('src/components/ui/glass/glass-segmented.tsx');
    expect(segmented).not.toContain('accessibilityRole="tab"');
    expect(segmented).toContain("accessibilityRole={Platform.OS === 'ios' ? 'button' : 'tab'}");
    expect(segmented).toContain('accessibilityState={{ selected: on }}');
  });
});

describe('drawer', () => {
  it('registers Settings > Appearance as a hidden screen', () => {
    expect(flat('app/(drawer)/_layout.tsx')).toContain(
      "<Drawer.Screen name=\"settings/appearance\" options={{ drawerLabel: 'Appearance', drawerItemStyle: { display: 'none' } }} />",
    );
  });

  it('the glass panel is one surface behind the same rows, gates and actions', () => {
    const src = flat('src/components/drawer-content.tsx');
    expect(src).toContain(
      '{glass ? <GlassSurface variant="overlay" radius={0} style={StyleSheet.absoluteFill} /> : null}',
    );
    expect(src).toContain('const glass = g !== null;');
  });
});

describe('Settings', () => {
  it('opt-in and default: the row is Appearance, showing "Design · Theme" in words and opening the screen', () => {
    const src = flat('app/(drawer)/settings.tsx');
    expect(src).toContain(
      'title="Appearance" detail={appearanceLabel( appearance.chosenStyle, appearance.chosenTheme, appearance.rollout, )} chevron onPress={() => router.push(\'/settings/appearance\' as never)}',
    );
  });

  it('off: origin/main’s "Theme / Auto" row and its alert, verbatim (item 37)', () => {
    const src = flat('app/(drawer)/settings.tsx');
    expect(src).toContain(
      '{appearance.glassEnabled ? ( <SettingRow icon={Moon} title="Appearance"',
    );
    expect(src).toContain(
      ') : ( <SettingRow icon={Moon} title="Theme" detail="Auto" chevron onPress={() => Alert.alert( \'Theme\', \'Mobile follows your device appearance (Light or Dark) automatically.\', ) } /> )}',
    );
  });

  // A11Y-2. After the text size changed while the app ran, the glass
  // Appearance screen kept every row at its old height with its text cut,
  // until a relaunch: React Native's stale measurement, docket B10
  // (dynamic-type-layout.ts fontScaleKey). The cure is B10's: remount what was
  // laid out at the old size. Here it is glass-only and stays undefined until
  // the size really changes, so a Design switch remounts nothing.
  it('Liquid Glass remounts the head and the scroll of the Appearance screen after a live text-size change', () => {
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('const { fontScale } = useWindowDimensions();');
    expect(provider).toContain('const [launchFontScale] = React.useState(fontScale);');
    expect(provider).toContain(
      "const textSizeKey = snapshot.style === 'liquid-glass' ? liveFontScaleKey(launchFontScale, fontScale) : undefined;",
    );
    // It rides on the control (four readers), never on the theme every screen reads.
    expect(provider).toContain('textSizeKey, chooseStyle: controller.chooseStyle,');
    expect(provider).toContain('[snapshot, material, textSizeKey, controller],');
    expect(provider).toContain(
      '() => ({ style: snapshot.style, theme: snapshot.theme, material, scene }), [snapshot.style, snapshot.theme, material, scene],',
    );

    const screen = flat('app/(drawer)/settings/appearance.tsx');
    const key = 'key={lg ? appearance.textSizeKey : undefined}';
    expect(screen.split(key)).toHaveLength(3);
    expect(screen).toContain(`<View ${key} style={lg ? GLASS_LIST.head : styles.head} >`);
    expect(screen).toContain(`<ScrollView ${key} contentContainerStyle={`);
    // The back button keeps its place, as the list screens' top bar does.
    expect(screen).toContain('<View style={lg ? GLASS_LIST.nav : styles.topbar}>');
  });

  it('the Appearance screen: DESIGN first, then THEME, each a radio group of labelled choices, with no permission gate (item 38)', () => {
    const src = flat('app/(drawer)/settings/appearance.tsx');
    const design = src.indexOf('accessibilityRole="radiogroup" accessibilityLabel="Design"');
    const theme = src.indexOf('accessibilityRole="radiogroup" accessibilityLabel="Theme"');
    expect(design).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(design);
    expect(src).toContain('<Eyebrow>DESIGN</Eyebrow>');
    expect(src).toContain('<Eyebrow>THEME</Eyebrow>');
    expect(src).toContain(
      'accessibilityRole="radio" accessibilityState={{ checked }} accessibilityLabel={label} accessibilityHint={detail}',
    );
    expect(src).toContain('onPress={() => appearance.chooseStyle(option.style)}');
    expect(src).toContain('onPress={() => appearance.chooseTheme(option.theme)}');
    // A Design never chosen is drawn as the rollout's default and checked as it.
    expect(src).toContain(
      'const checkedStyle = appearance.chosenStyle ?? defaultStyle(appearance.rollout);',
    );
    expect(src).toContain("const checkedTheme = appearance.chosenTheme ?? 'system';");
    // 44 pt targets at least.
    expect(src).toMatch(/minHeight: (4[4-9]|5\d)/);
    for (const gate of ['useRole', 'usePermission', 'useEffectivePermissions', 'isAdmin']) {
      expect(src, gate).not.toContain(gate);
    }
  });

  it('under off the screen offers no choice (the row does not open it)', () => {
    const src = flat('app/(drawer)/settings/appearance.tsx');
    expect(src).toContain('{appearance.glassEnabled ? (');
    expect(src).toContain('Mobile follows your device appearance (Light or Dark) automatically.');
  });

  it('the footnote about Liquid Glass shows only in a build that offers Liquid Glass', () => {
    const src = flat('app/(drawer)/settings/appearance.tsx');
    expect(src).toContain('const footnote = appearanceFootnote(appearance.glassEnabled);');
    expect(src).toContain('{footnote !== null ? (');
    expect(src).not.toContain('APPEARANCE_FOOTNOTE');
  });
});

describe('the one-time "new look" card on Home (R13, item 39)', () => {
  it('sits at the top of Home’s content and draws nothing unless the controller says so', () => {
    const home = flat('app/(drawer)/(tabs)/index.tsx');
    expect(home).toContain(
      "import { AppearanceIntroNotice } from '@/components/appearance-intro-notice';",
    );
    expect(home).toContain('refreshControl={ <RefreshControl');
    // Both Designs keep the tab bar's room under the content (Liquid Glass
    // adds the board's section spacing to the same container).
    const scroll = home.indexOf(
      '<ScrollView contentContainerStyle={ lg ? [GLASS_HOME.scroll, { paddingBottom: tabBarHeight + 24 }] : { paddingBottom: tabBarHeight + 24 } }',
    );
    const card = home.indexOf('<AppearanceIntroNotice />');
    const firstContent = home.indexOf('{loading && !noWorkspace ? (');
    expect(scroll).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(scroll);
    expect(card).toBeLessThan(firstContent);
  });

  it('both buttons make the Design the person’s own; Close chooses nothing', () => {
    const src = flat('src/components/appearance-intro-notice.tsx');
    expect(src).toContain(
      'const { introVisible, chooseStyle, keepGlass, dismissIntro } = useAppearance();',
    );
    expect(src).toContain('if (!introVisible) return null;');
    expect(src).toContain("onPress={() => chooseStyle('classic')}");
    expect(src).toContain('{INTRO_NOTICE.useClassic}');
    expect(src).toContain('onPress={keepGlass}');
    expect(src).toContain('{INTRO_NOTICE.keepGlass}');
    expect(src).toContain('onPress={dismissIntro}');
    expect(src).toContain('accessibilityLabel={INTRO_NOTICE.close}');
    // The same card as the crash notice (stage 2's banner), inline, not floating.
    expect(src).toContain('<AppearanceNoticeCard');
  });

  it('the crash notice keeps its two actions; only its Classic label changed', () => {
    const src = flat('src/components/appearance-fallback-notice.tsx');
    expect(src).toContain("onPress={() => endFallback('glass')}");
    expect(src).toContain("onPress={() => endFallback('classic')}");
    expect(src).toContain('{FALLBACK_NOTICE.useClassic}');
    expect(src).toContain('export function AppearanceNoticeCard(');
  });
});

describe('the words (item 36)', () => {
  it('two groups: Design (Liquid Glass, Classic) and Theme (Light, Dark, System)', () => {
    expect(DESIGN_OPTIONS.map((o) => [o.style, o.label])).toEqual([
      ['liquid-glass', 'Liquid Glass'],
      ['classic', 'Classic'],
    ]);
    expect(DESIGN_OPTIONS.map((o) => o.detail)).toEqual([
      'The standard StockPilot look. Day or Night follows your Theme.',
      'The previous StockPilot design, unchanged.',
    ]);
    expect(THEME_OPTIONS.map((o) => [o.theme, o.label])).toEqual([
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['system', 'System'],
    ]);
  });

  it('the Settings row reads "Design · Theme", a choice never made read as the default', () => {
    expect(appearanceLabel(null, null, 'default')).toBe('Liquid Glass · System');
    expect(appearanceLabel(null, null, 'opt-in')).toBe('Classic · System');
    expect(appearanceLabel('classic', 'dark', 'default')).toBe('Classic · Dark');
    expect(appearanceLabel('liquid-glass', 'light', 'opt-in')).toBe('Liquid Glass · Light');
  });

  it('the way back reads "Use classic design" everywhere (R1, R13)', () => {
    expect(RECOVERY_ACTION_LABEL).toBe('Use classic design');
    expect(FALLBACK_NOTICE.useClassic).toBe('Use classic design');
    expect(INTRO_NOTICE).toEqual({
      title: 'StockPilot has a new look',
      body: 'You can switch back to the classic design at any time.',
      useClassic: 'Use classic design',
      keepGlass: 'Keep Liquid Glass',
      close: 'Close',
    });
  });

  it('the footnote about Liquid Glass only where Liquid Glass is offered (plan D12, 5.5)', () => {
    expect(appearanceFootnote(true)).toContain('Liquid Glass follows your device');
    expect(appearanceFootnote(false)).toBeNull();
  });

  it('claims the account only when the server answered', () => {
    expect(syncLine('synced')).toEqual({ text: 'Saved to your account.', retry: false });
    for (const status of ['idle', 'saving', 'failed', 'unavailable', 'signed-out'] as const) {
      expect(syncLine(status).text, status).not.toContain('Saved to your account');
    }
    expect(syncLine('failed').retry).toBe(true);
    expect(syncLine('unavailable').retry).toBe(true);
  });
});
