import { useNavigation, useRouter } from 'expo-router';
import { ArrowUpRight, Menu, type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
 * Generic "coming to mobile" screen for surfaces that exist on web today
 * but haven't shipped a native UI yet. Brand-themed: warm paper, eyebrow,
 * display title with serif-italic emphasis, single line-art icon well,
 * deep-link CTA to the same route on the web app.
 *
 * Used for: Books, Bundles, Orders, Rentals, Categories, Tags,
 * Movements, Procedures, Purchase orders mgmt, Locations, Suppliers,
 * Reports, AI Assistant, Schedule, Notifications, Team.
 */
export function ComingSoonScreen({
  eyebrow,
  title,
  italic,
  body,
  icon: Icon,
  webPath,
  status = 'On web',
}: {
  eyebrow: string;
  title: string;
  italic?: string;
  body: string;
  icon: LucideIcon;
  webPath?: string;
  status?: string;
}) {
  const { c } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();

  const openWeb = () => {
    if (!webPath) return;
    const url = `https://stockpilotusa.com${webPath}`;
    Linking.openURL(url).catch(() => undefined);
  };

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={Menu}
            onPress={() => (navigation as { openDrawer?: () => void }).openDrawer?.()}
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>{eyebrow}</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            {italic ? (
              <>
                {title} <Em>{italic}</Em>
              </>
            ) : (
              title
            )}
          </Display>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card hero style={styles.heroCard}>
          <View pointerEvents="none" style={styles.washPos}>
            <MintWash width={220} height={220} intensity={0.22} />
          </View>
          <View style={[styles.iconWell, { backgroundColor: c.paper2, borderColor: c.hair }]}>
            <Icon size={42} color={c.ink} strokeWidth={1.3} />
            <View style={[styles.pip, { backgroundColor: ACCENT.pipTeal }]} />
          </View>
          <Pill status="ok">{status.toUpperCase()}</Pill>
          <View style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <Display size={20} style={{ textAlign: 'center' }}>
              Coming to <Em>mobile.</Em>
            </Display>
            <Body muted style={{ textAlign: 'center', maxWidth: 320 }}>
              {body}
            </Body>
          </View>
          {webPath ? (
            <Button
              block
              variant="outline"
              onPress={openWeb}
              trailing={<ArrowUpRight size={16} color={c.ink} strokeWidth={1.5} />}
            >
              Open on web
            </Button>
          ) : null}
          <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
            Available now at <Mono size={10.5} color={c.ink}>stockpilotusa.com</Mono>
          </Mono>
        </Card>

        <Pressable
          onPress={() => router.push('/')}
          style={({ pressed }) => ({
            opacity: pressed ? 0.7 : 1,
            alignItems: 'center',
            paddingVertical: 18,
          })}
        >
          <Mono size={11} tracking={0.12} upper color={c.ink4}>
            ← Back to home
          </Mono>
        </Pressable>
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
  scroll: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
  },
  heroCard: {
    padding: 28,
    alignItems: 'center',
    gap: 18,
    overflow: 'hidden',
    position: 'relative',
  },
  washPos: {
    position: 'absolute',
    top: -50,
    left: '50%',
    marginLeft: -110,
  },
  iconWell: {
    width: 96,
    height: 96,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  pip: {
    position: 'absolute',
    top: 14,
    right: 16,
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});
