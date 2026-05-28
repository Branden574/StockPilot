import { useRouter } from 'expo-router';
import { ArrowLeft, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import {
  countSelection,
  useCountPicks,
  type CountPick,
} from '@/lib/use-count-selection';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface StartResult {
  id: string;
  lineCount: number;
  skipped: number;
}

export default function NewCycleCount() {
  const router = useRouter();
  const { c } = useTheme();
  const picks = useCountPicks();
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const books = picks.filter((p) => p.itemType === 'book');
  const products = picks.filter((p) => p.itemType !== 'book');

  async function start() {
    if (picks.length === 0 || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    try {
      const res = await api<StartResult>('/api/v1/cycle-counts', {
        method: 'POST',
        body: {
          scope: 'selection',
          itemIds: picks.map((p) => p.id),
          notes: notes.trim() || null,
        },
      });
      countSelection.clear();
      router.replace({ pathname: '/cycle-count/[id]', params: { id: res.id } });
    } catch (e) {
      setBusy(false);
      Alert.alert(
        'Could not start count',
        e instanceof Error ? e.message : 'Please try again.',
      );
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/');
            }}
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>{`${picks.length} ITEM${picks.length === 1 ? '' : 'S'} SELECTED`}</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            New <Em>count.</Em>
          </Display>
        </View>
      </SafeAreaView>

      {picks.length === 0 ? (
        <View style={styles.empty}>
          <Display size={18}>
            Nothing <Em>selected.</Em>
          </Display>
          <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
            Go to Items or Books, tap Select, choose what to count, then come back.
          </Body>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140, gap: 16 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {products.length > 0 ? (
            <PickGroup title={`PRODUCTS · ${products.length}`} picks={products} />
          ) : null}
          {books.length > 0 ? (
            <PickGroup title={`BOOKS · ${books.length}`} picks={books} />
          ) : null}

          <View style={{ gap: 8 }}>
            <Mono size={11} tracking={0.14} upper color={c.ink4}>
              Notes (optional)
            </Mono>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="e.g. Spot count · Rack 3"
              placeholderTextColor={c.ink4}
              multiline
              maxLength={2000}
              style={[
                styles.notes,
                { backgroundColor: c.card, borderColor: c.hair, color: c.ink, fontFamily: FONT.displayRegular },
              ]}
            />
          </View>
        </ScrollView>
      )}

      {picks.length > 0 ? (
        <SafeAreaView edges={['bottom']} style={styles.footer}>
          <Pressable
            onPress={start}
            disabled={busy}
            style={({ pressed }) => [
              styles.startBtn,
              { backgroundColor: c.ink, opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
            ]}
          >
            {busy ? (
              <ActivityIndicator color={c.paper} />
            ) : (
              <Mono size={14} color={c.paper} style={{ fontFamily: FONT.display }}>
                Start count
              </Mono>
            )}
          </Pressable>
        </SafeAreaView>
      ) : null}
    </View>
  );
}

function PickGroup({ title, picks }: { title: string; picks: CountPick[] }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Mono size={11} tracking={0.14} upper color={c.ink4}>
        {title}
      </Mono>
      <Card padding={0}>
        {picks.map((p, i) => (
          <View
            key={p.id}
            style={[
              styles.pickRow,
              i < picks.length - 1 ? { borderBottomWidth: 1, borderBottomColor: c.hair } : null,
            ]}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Body size={14.5} color={c.ink} numberOfLines={2}>
                {p.name}
              </Body>
              {p.sku ? (
                <Mono size={11} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 2 }}>
                  {p.sku}
                </Mono>
              ) : null}
            </View>
            <Pressable onPress={() => countSelection.remove(p.id)} hitSlop={10}>
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>
        ))}
      </Card>
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
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  notes: {
    minHeight: 64,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14.5,
    textAlignVertical: 'top',
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
  },
  startBtn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
