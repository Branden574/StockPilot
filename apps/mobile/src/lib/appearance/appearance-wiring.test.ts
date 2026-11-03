import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appearanceFootnote, appearanceLabel, appearanceOptions, syncLine } from './labels';

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
    const appearance = src.indexOf('if (!appearanceReady) {');
    expect(fonts).toBeGreaterThan(-1);
    expect(appearance).toBeGreaterThan(fonts);
    expect(src).toContain('const appearanceReady = useAppearanceReady();');
  });

  it('RootLayout subscribes to the ready flag alone, never to the sync status', () => {
    // A save or fetch answering ("Saving...", "Saved to your account") must not
    // re-render RootLayout and the whole tree under it.
    expect(src).not.toMatch(/useAppearance\(\)/);
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('<ReadyContext.Provider value={snapshot.ready}>');
  });

  it('the provider tells the OS a fixed Dark or Light, so alerts and the keyboard match', () => {
    const provider = flat('src/lib/appearance/provider.tsx');
    expect(provider).toContain('applyOsScheme(snapshot.effective);');
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

  it('every tab is a selected-aware tab for VoiceOver', () => {
    expect((bar.match(/accessibilityRole="tab"/g) ?? []).length).toBe(3);
    expect((bar.match(/accessibilityState=\{\{ selected: focused \}\}/g) ?? []).length).toBe(3);
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
  it('the Theme row is now Appearance, showing the choice in words and opening the screen', () => {
    const src = flat('app/(drawer)/settings.tsx');
    expect(src).toContain(
      'title="Appearance" detail={appearanceLabel(appearance.choice, appearance.glassEnabled)} chevron onPress={() => router.push(\'/settings/appearance\' as never)}',
    );
    expect(src).not.toContain('Mobile follows your device appearance');
  });

  it('the Appearance screen is a radio group of labelled choices, with no permission gate', () => {
    const src = flat('app/(drawer)/settings/appearance.tsx');
    expect(src).toContain('accessibilityRole="radiogroup" accessibilityLabel="Appearance"');
    expect(src).toContain(
      'accessibilityRole="radio" accessibilityState={{ checked }} accessibilityLabel={option.label} accessibilityHint={option.detail}',
    );
    expect(src).toContain('onPress={() => appearance.choose(option.mode)}');
    for (const gate of ['useRole', 'usePermission', 'useEffectivePermissions', 'isAdmin']) {
      expect(src, gate).not.toContain(gate);
    }
  });

  it('the footnote about Liquid Glass shows only in a build that offers Liquid Glass', () => {
    const src = flat('app/(drawer)/settings/appearance.tsx');
    expect(src).toContain('const footnote = appearanceFootnote(appearance.glassEnabled);');
    expect(src).toContain('{footnote !== null ? (');
    expect(src).not.toContain('APPEARANCE_FOOTNOTE');
  });
});

describe('the words', () => {
  it('offers Dark, Light, Liquid Glass and System, Liquid Glass only with the kill switch on', () => {
    expect(appearanceOptions(true).map((o) => o.label)).toEqual([
      'Dark',
      'Light',
      'Liquid Glass',
      'System',
    ]);
    expect(appearanceOptions(false).map((o) => o.label)).toEqual(['Dark', 'Light', 'System']);
    expect(appearanceLabel('liquid-glass', true)).toBe('Liquid Glass');
    expect(appearanceLabel('liquid-glass', false)).toBe('System');
    expect(appearanceLabel('system', true)).toBe('System');
  });

  it('never names Liquid Glass with the kill switch off (plan D12, 5.5)', () => {
    expect(appearanceFootnote(true)).toContain('Liquid Glass follows your device');
    expect(appearanceFootnote(false)).toBeNull();
    const offered = [
      ...appearanceOptions(false).flatMap((o) => [o.label, o.detail]),
      appearanceFootnote(false) ?? '',
    ].join(' ');
    expect(offered).not.toContain('Liquid Glass');
    expect(offered).not.toContain('glass');
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
