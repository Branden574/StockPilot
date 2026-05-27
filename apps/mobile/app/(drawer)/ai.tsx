import { useNavigation, useRouter } from 'expo-router';
import { ArrowUpRight, Menu, Sparkles } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MintWash } from '@/components/ui/mint-wash';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * AI Assistant entry point. The conversation surface itself (streamed
 * tokens, tool calls, citations) lives on web — porting that to React
 * Native with the same fidelity is its own project, so this screen
 * acts as the launcher: explains what it does, lists example prompts,
 * and deep-links to the web chat. Same `/dashboard/ai` URL as the web.
 */
export default function AIAssistantScreen() {
  const { c } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  function openChat() {
    router.push('/ai/chat');
  }

  const examples = [
    'What\'s low at L4L North Region right now?',
    'Draft a PO for the books category from Ingram.',
    'How many Chromebooks did we receive this month?',
    'Which suppliers have the longest lead times?',
  ];

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={Menu} onPress={openDrawer} />
        </View>
        <View style={styles.head}>
          <Eyebrow>WORKSPACE · BETA</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            AI <Em>assistant.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card hero style={styles.heroCard}>
          <View pointerEvents="none" style={styles.washPos}>
            <MintWash width={240} height={240} intensity={0.22} />
          </View>
          <View style={[styles.iconWell, { backgroundColor: c.paper2, borderColor: c.hair }]}>
            <Sparkles size={36} color={c.ink} strokeWidth={1.3} />
            <View style={[styles.pip, { backgroundColor: ACCENT.mint }]} />
          </View>
          <Pill status="ok">BETA · NATIVE</Pill>
          <Display size={20} style={{ textAlign: 'center', marginTop: 4 }}>
            Ask anything about your <Em>inventory.</Em>
          </Display>
          <Body muted style={{ textAlign: 'center', maxWidth: 320 }}>
            Natural-language queries that resolve to real reads + writes — what&apos;s low, which POs are stuck, who needs reordering. Streamed responses with tool calls, same engine the web uses.
          </Body>
          <Button block onPress={openChat} trailing={<ArrowUpRight size={16} color={c.paper} strokeWidth={1.6} />}>
            Start chat
          </Button>
        </Card>

        <View style={{ marginTop: 24 }}>
          <Eyebrow>TRY ASKING</Eyebrow>
          <View style={{ marginTop: 12, gap: 8 }}>
            {examples.map((ex) => (
              <Pressable
                key={ex}
                onPress={() => openChat()}
                style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
              >
                <Card padding={14}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Sparkles size={14} color={c.ink4} strokeWidth={1.5} />
                    <Body size={14} color={c.ink2} style={{ flex: 1, fontFamily: FONT.displayRegular }}>
                      {ex}
                    </Body>
                    <ArrowUpRight size={14} color={c.ink4} strokeWidth={1.5} />
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        </View>

        <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 18, textAlign: 'center' }}>
          Native mobile chat ships after the desktop beta exits.
        </Mono>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  scroll: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },
  heroCard: {
    padding: 24,
    alignItems: 'center',
    gap: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  washPos: { position: 'absolute', top: -50, left: '50%', marginLeft: -120 },
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
