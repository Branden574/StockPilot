import { useRouter } from 'expo-router';
import {
  ArrowLeftRight,
  ArrowRight,
  Boxes,
  ClipboardList,
  Sparkles,
  Smartphone,
  Truck,
  type LucideIcon,
} from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Boxes, title: 'Items that mean something', body: 'Lots, par levels, sell prices, costs — all first-class. Cycle counts that survive an audit.' },
  { icon: ArrowLeftRight, title: 'Movements you can trust', body: 'Receive, sell, transfer, adjust. Every quantity change is a row you can stand behind.' },
  { icon: ClipboardList, title: 'Purchase orders, end to end', body: 'Draft → approve → in transit → received, three-way matched against your counts.' },
  { icon: Truck, title: 'Live delivery tracking', body: 'Watch an order move on a map, signed for at the door, proof captured.' },
  { icon: Sparkles, title: 'AI insights briefing', body: 'A daily read on what needs attention — low stock, overdue POs, approvals.' },
  { icon: Smartphone, title: 'Built for the floor', body: 'Scan, count, receive, and pick from your pocket. Syncs with the web in real time.' },
];

const STATS: { value: string; label: string }[] = [
  { value: '240ms', label: 'real-time sync' },
  { value: '6', label: 'live integrations' },
  { value: '100%', label: 'changes audited' },
  { value: 'Multi', label: 'tenant + RLS' },
];

export default function Welcome() {
  const { c } = useTheme();
  const router = useRouter();

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 44 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Top bar */}
        <View style={styles.topbar}>
          <Mono size={13} tracking={0.04} color={c.ink}>
            StockPilot
          </Mono>
          <Pressable hitSlop={10} onPress={() => router.push('/(auth)/sign-in')}>
            <Body size={14} color={c.ink2}>
              Sign in
            </Body>
          </Pressable>
        </View>

        {/* Hero */}
        <View style={{ marginTop: 28 }}>
          <Eyebrow>INVENTORY + ORDER OPS</Eyebrow>
          <Display size={40} style={{ marginTop: 14 }}>
            Inventory software <Em>quiet enough</Em> to actually use.
          </Display>
          <Body muted style={{ marginTop: 14, maxWidth: 340 }}>
            Inventory and order operations for teams that actually run a warehouse — counts, costs,
            and movements you can trust, without the dashboard slop.
          </Body>

          <View style={{ marginTop: 22, gap: 10 }}>
            <Button
              block
              onPress={() => router.push('/(auth)/sign-in')}
              trailing={<ArrowRight size={16} color={c.paper} strokeWidth={1.7} />}
            >
              Sign in
            </Button>
            <Body size={13} color={c.ink4} style={{ textAlign: 'center', marginTop: 4 }}>
              New here? Your organization admin can invite you.
            </Body>
          </View>
        </View>

        {/* Proof stats */}
        <View style={styles.statRow}>
          {STATS.map((s) => (
            <View key={s.label} style={styles.statCell}>
              <Display size={24}>{s.value}</Display>
              <Mono size={9.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                {s.label}
              </Mono>
            </View>
          ))}
        </View>

        {/* Features */}
        <Eyebrow style={{ marginTop: 34 }}>BUILT FOR OPERATIONS</Eyebrow>
        <View style={{ marginTop: 14, gap: 10 }}>
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <Card key={f.title} padding={16}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <Icon size={20} color={c.ink} strokeWidth={1.5} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1 }}>
                    <Body size={15} color={c.ink}>
                      {f.title}
                    </Body>
                    <Body size={12.5} color={c.ink3} style={{ marginTop: 3, lineHeight: 18 }}>
                      {f.body}
                    </Body>
                  </View>
                </View>
              </Card>
            );
          })}
        </View>

        {/* Final CTA */}
        <View style={{ marginTop: 30, alignItems: 'center' }}>
          <Display size={26} style={{ textAlign: 'center' }}>
            Get your stock <Em>under control.</Em>
          </Display>
          <View style={{ marginTop: 18, width: '100%', gap: 10 }}>
            <Button
              block
              onPress={() => router.push('/(auth)/sign-in')}
              trailing={<ArrowRight size={16} color={c.paper} strokeWidth={1.7} />}
            >
              Sign in
            </Button>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statRow: {
    marginTop: 30,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statCell: { flex: 1 },
});
