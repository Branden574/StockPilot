import { defaultStyle, type AppearanceStyle } from '@stockpilot/core';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow } from '@/components/ui/text';
import {
  DESIGN_OPTIONS,
  THEME_OPTIONS,
  appearanceFootnote,
  syncLine,
} from '@/lib/appearance/labels';
import { useAppearance } from '@/lib/appearance/provider';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { FONT, GLASS_DAY, GLASS_NIGHT, glassTokens, palette, type Palette } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Settings > Appearance (plan 5.4, revision R1; item 38): two groups, DESIGN
 * (Liquid Glass, the standard look, and Classic, the previous design, each
 * with a preview tile) and THEME (Light, Dark, System, which follows the
 * device as the phone always did). Switching the Design never changes the
 * Theme. A personal preference: every signed-in person can change their own,
 * with no permission gate, and it never changes anyone else's.
 *
 * A choice applies at once, without leaving this screen or restarting
 * anything (the provider re-renders the tree; nothing is keyed or remounted),
 * is kept on this phone, and is saved to the person's account. The line under
 * the choices says only what is true: "Saved to your account" after the
 * server answered, otherwise that it is on this phone, with Try again after a
 * failed save.
 *
 * With the Liquid Glass kill switch off the Settings row is today's "Theme /
 * Auto" alert and never opens this screen; reached anyway (a stale link), it
 * says the same words and offers nothing.
 *
 * VoiceOver: two radio groups named "Design" and "Theme"; each choice a radio
 * read by its name with its description as the hint, and its checked state.
 * Every row is at least 56pt tall (44pt targets), and the words grow with
 * Larger Text without a cap (the description moves under the name past the
 * shared threshold).
 */
export default function AppearanceScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const appearance = useAppearance();
  const sync = syncLine(appearance.status);
  // About Liquid Glass, so only in a build that offers it (kill switch, plan D12).
  const footnote = appearanceFootnote(appearance.glassEnabled);
  // A Design never chosen is the rollout's default (Liquid Glass under
  // 'default'); a Theme never chosen is System.
  const checkedStyle = appearance.chosenStyle ?? defaultStyle(appearance.rollout);
  const checkedTheme = appearance.chosenTheme ?? 'system';

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/settings' as never);
            }}
            accessibilityLabel="Back"
            minTap
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>SETTINGS · APPEARANCE</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Appearance<Em>.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
      >
        {appearance.glassEnabled ? (
          <>
            <View style={styles.section}>
              <Eyebrow>DESIGN</Eyebrow>
            </View>
            <Card padding={0} style={{ marginTop: 10 }}>
              <View accessibilityRole="radiogroup" accessibilityLabel="Design">
                {DESIGN_OPTIONS.map((option, idx) => (
                  <React.Fragment key={option.style}>
                    {idx > 0 ? <Hair inset={84} /> : null}
                    <ChoiceRow
                      label={option.label}
                      detail={option.detail}
                      checked={checkedStyle === option.style}
                      tile={<PreviewTile style={option.style} />}
                      onPress={() => appearance.chooseStyle(option.style)}
                    />
                  </React.Fragment>
                ))}
              </View>
            </Card>

            <View style={styles.section}>
              <Eyebrow>THEME</Eyebrow>
            </View>
            <Card padding={0} style={{ marginTop: 10 }}>
              <View accessibilityRole="radiogroup" accessibilityLabel="Theme">
                {THEME_OPTIONS.map((option, idx) => (
                  <React.Fragment key={option.theme}>
                    {idx > 0 ? <Hair inset={14} /> : null}
                    <ChoiceRow
                      label={option.label}
                      detail={option.detail}
                      checked={checkedTheme === option.theme}
                      onPress={() => appearance.chooseTheme(option.theme)}
                    />
                  </React.Fragment>
                ))}
              </View>
            </Card>

            <View accessibilityLiveRegion="polite" style={styles.sync}>
              <Body size={13.5} color={c.ink3}>
                {sync.text}
              </Body>
              {sync.retry ? (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={appearance.retry}
                  style={{ marginTop: 10 }}
                >
                  Try again
                </Button>
              ) : null}
            </View>
          </>
        ) : (
          <View style={styles.sync}>
            <Body size={13.5} color={c.ink3}>
              Mobile follows your device appearance (Light or Dark) automatically.
            </Body>
          </View>
        )}

        {footnote !== null ? (
          <View style={styles.footnote}>
            <Body size={13} color={c.ink3}>
              {footnote}
            </Body>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ChoiceRow({
  label,
  detail,
  checked,
  tile,
  onPress,
}: {
  label: string;
  detail: string;
  checked: boolean;
  tile?: React.ReactNode;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = shouldStackRow(fontScale);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      accessibilityHint={detail}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      {tile ?? null}
      <View style={styles.label}>
        <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
          {label}
        </Body>
        <Body size={13} color={c.ink3} style={{ marginTop: stacked ? 4 : 2 }}>
          {detail}
        </Body>
      </View>
      <View
        style={[
          styles.radio,
          {
            borderColor: checked ? c.accent : c.hair2,
            backgroundColor: checked ? c.accent : 'transparent',
          },
        ]}
      >
        {checked ? <View style={[styles.radioDot, { backgroundColor: c.accentInk }]} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * A small picture of each Design in the scheme on screen, drawn from its own
 * palette (never an image): the page, a card with two lines of text and the
 * accent. Liquid Glass shows its frosted card over its Day or Night page;
 * Classic today's card over today's page.
 */
function PreviewTile({ style }: { style: AppearanceStyle }) {
  const { mode: scheme } = useTheme();
  const glass = style === 'liquid-glass';
  const p = glass ? (scheme === 'dark' ? GLASS_NIGHT : GLASS_DAY) : palette(scheme);
  // The palette's card is opaque (it paints sheets); the preview shows the
  // frosted content card, the translucent --card-fill over the page.
  const frost = glass ? glassTokens(scheme, false) : null;
  return (
    <View
      style={styles.tile}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <TileFace p={p} rounded={glass} cardFill={frost?.cardFill} cardLine={frost?.cardLine} />
    </View>
  );
}

function TileFace({
  p,
  rounded = false,
  cardFill,
  cardLine,
}: {
  p: Palette;
  rounded?: boolean;
  cardFill?: string;
  cardLine?: string;
}) {
  return (
    <View style={[styles.face, { backgroundColor: p.paper }]}>
      <View
        style={[
          styles.faceCard,
          {
            backgroundColor: cardFill ?? p.card,
            borderColor: cardLine ?? p.hair2,
            borderRadius: rounded ? 8 : 3,
          },
        ]}
      >
        <View style={[styles.faceLine, { backgroundColor: p.ink, width: '70%' }]} />
        <View style={[styles.faceLine, { backgroundColor: p.ink3, width: '45%' }]} />
        <View style={[styles.faceDot, { backgroundColor: p.accent }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The same header as Customize tab bar: the 44pt back chip frame, then the title.
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 56,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  label: { flex: 1, minWidth: 0 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  tile: { width: 56, height: 40, borderRadius: 8, overflow: 'hidden' },
  face: { flex: 1, padding: 5, justifyContent: 'center' },
  faceCard: { flex: 1, borderWidth: StyleSheet.hairlineWidth, padding: 4, gap: 3 },
  faceLine: { height: 3, borderRadius: 1.5 },
  faceDot: { width: 6, height: 6, borderRadius: 3, marginTop: 1 },
  section: { paddingHorizontal: 4, paddingTop: 18 },
  sync: { paddingHorizontal: 4, paddingTop: 12 },
  footnote: { paddingHorizontal: 4, paddingTop: 16 },
});
