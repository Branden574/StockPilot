import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, ArrowUpRight, Menu, Sparkles } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { GlassHeading, GlassSubline } from '@/components/ui/glass/parts';
import { GLASS_LIST } from '@/components/ui/glass/screens/list';
import { SceneBackground } from '@/components/ui/glass/scene-background';
import { useGlass } from '@/components/ui/glass/use-glass';
import { glassRowSub } from '@/components/ui/glass/primitive-styles';
import { glassHeroWell, glassStackRow } from '@/components/ui/glass/screens/admin';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { goBackFromReturn } from '@/lib/return-path';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * AI Assistant launcher: says what the assistant does, lists example
 * prompts, and opens the native chat (app/ai/chat.tsx, the same /api/ai/chat
 * engine the web uses). Each prompt opens the chat too; its words are not
 * carried into it.
 *
 * The footer used to say native chat "ships after the desktop beta exits"
 * while Start chat already opened it (redesign defect D28); it now says what
 * is true, in the beta words the eyebrow and the pill already use.
 */
export default function AIAssistantScreen() {
  const { c } = useTheme();
  // Liquid Glass (inferred: the iOS grouped list with example prompts): the
  // scene, the glass nav and large title, the hero on the grouped surface,
  // the prompts as one grouped list. Start chat and every prompt stay.
  const lg = useGlass();
  const navigation = useNavigation();
  const router = useRouter();
  const { return: returnPath } = useLocalSearchParams<{ return?: string }>();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  function openChat() {
    router.push('/ai/chat');
  }

  const examples = [
    'What\'s low at our main warehouse right now?',
    'Draft POs for items that are running low.',
    'How many Chromebooks did we receive this month?',
    'Which suppliers have the longest lead times?',
  ];

  return (
    <View style={[styles.root, { backgroundColor: lg ? 'transparent' : c.paper }]}>
      {lg ? <SceneBackground /> : null}
      <SafeAreaView edges={['top']} style={{ backgroundColor: lg ? 'transparent' : c.paper }}>
        <View style={lg ? GLASS_LIST.nav : styles.topbar}>
          <View
            style={
              lg ? GLASS_LIST.navGroup : { flexDirection: 'row', alignItems: 'center', gap: 2 }
            }
          >
            <IconChip
              icon={ArrowLeft}
              accessibilityLabel="Back"
              minTap
              onPress={() => goBackFromReturn(router, returnPath)}
            />
            <IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />
          </View>
        </View>
        <View style={lg ? GLASS_LIST.head : styles.head}>
          {lg ? null : <Eyebrow>INSIGHTS · BETA</Eyebrow>}
          <Display
            size={34}
            style={lg ? GLASS_LIST.title : { marginTop: 12 }}
            accessibilityRole={lg ? 'header' : undefined}
          >
            AI {lg ? 'assistant' : <Em>assistant.</Em>}
          </Display>
          {lg ? <GlassSubline style={GLASS_LIST.sub}>Insights · Beta</GlassSubline> : null}
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={lg ? GLASS_AI_SCROLL : styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Card hero style={styles.heroCard}>
          <View
            style={[
              styles.iconWell,
              { backgroundColor: c.sunk, borderColor: c.hair },
              lg && glassHeroWell(lg),
            ]}
          >
            <Sparkles size={36} color={lg ? lg.g.accentText : c.ink} strokeWidth={lg ? 1.8 : 1.3} />
            <View style={[styles.pip, { backgroundColor: c.accent }]} />
          </View>
          <Pill status="ok">BETA · NATIVE</Pill>
          <Display size={20} style={{ textAlign: 'center', marginTop: 4 }}>
            Ask anything about your <Em>inventory.</Em>
          </Display>
          <Body muted style={{ textAlign: 'center', maxWidth: 320 }}>
            Natural-language queries that resolve to real reads + writes — what&apos;s low, which POs are stuck, who needs reordering. Streamed responses with tool calls, same engine the web uses.
          </Body>
          {/* Starting a chat is the page's create action: the accent button. */}
          <Button
            block
            variant="accent"
            onPress={openChat}
            trailing={<ArrowUpRight size={16} color={c.accentInk} strokeWidth={1.6} />}
          >
            Start chat
          </Button>
        </Card>

        <View style={{ marginTop: lg ? 22 : 24 }}>
          {lg ? <GlassHeading>Try asking</GlassHeading> : <Eyebrow>TRY ASKING</Eyebrow>}
          <View style={lg ? { marginTop: 8, gap: 0 } : { marginTop: 12, gap: 8 }}>
            {examples.map((ex) => (
              <Pressable
                key={ex}
                onPress={() => openChat()}
                accessibilityRole="button"
                style={({ pressed }) =>
                  lg
                    ? { transform: [{ scale: pressed ? 0.98 : 1 }] }
                    : { opacity: pressed ? 0.85 : 1 }
                }
              >
                <Card
                  padding={14}
                  style={
                    lg
                      ? glassStackRow(lg, ex === examples[0], ex === examples[examples.length - 1])
                      : undefined
                  }
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Sparkles
                      size={lg ? 16 : 14}
                      color={lg ? lg.g.accentText : c.ink4}
                      strokeWidth={lg ? 1.8 : 1.5}
                    />
                    <Body
                      size={lg ? 16 : 14}
                      color={lg ? c.ink : c.ink2}
                      style={{ flex: 1, fontFamily: FONT.displayRegular }}
                    >
                      {ex}
                    </Body>
                    <ArrowUpRight
                      size={14}
                      color={lg ? lg.ios.l2 : c.ink4}
                      strokeWidth={lg ? 1.8 : 1.5}
                    />
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        </View>

        <Mono
          size={10.5}
          tracking={0.04}
          color={c.ink3}
          style={
            lg
              ? [glassRowSub(lg), { marginTop: 18, textAlign: 'center' }]
              : { marginTop: 18, textAlign: 'center' }
          }
        >
          {AI_FOOTER}
        </Mono>
      </ScrollView>
    </View>
  );
}

/**
 * The footer, corrected (D28): native chat is here (Start chat opens it) and
 * in beta, as the eyebrow's BETA and the BETA · NATIVE pill say.
 */
const AI_FOOTER = 'Native mobile chat is in beta.';

/** Liquid Glass: the scroll at the 16pt edge, 14 under the title (.ios-scroll). */
const GLASS_AI_SCROLL = { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40 } as const;

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The chips' 44pt frames (IconChip minTap) are 3pt wider than the 38pt chip
  // on every side, so the bar takes 3pt off its padding (12, 8) and what sits
  // under it 3pt off its top: the chips and the title sit where they did (gap between chips 8 -> 2).
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 4 },
  scroll: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },
  heroCard: {
    padding: 24,
    alignItems: 'center',
    gap: 16,
  },
  iconWell: {
    width: 88,
    height: 88,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  pip: { position: 'absolute', top: 14, right: 16, width: 6, height: 6, borderRadius: 3 },
});
