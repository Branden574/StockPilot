import { useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface Item {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  quantity_on_hand: number;
  reorder_point: number;
  reorder_quantity: number;
  unit_cost: number;
  retail_price: number;
  unit_of_measure: string;
  status: string;
}

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [item, setItem] = React.useState<Item | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('inventory_items')
      .select(
        'id, name, sku, description, quantity_on_hand, reorder_point, reorder_quantity, unit_cost, retail_price, unit_of_measure, status',
      )
      .eq('id', id)
      .maybeSingle();
    if (!data) {
      Alert.alert('Not found', 'This item no longer exists.', [{ text: 'OK', onPress: () => router.back() }]);
      return;
    }
    setItem(data as Item);
  }, [id, router]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function adjust(delta: number) {
    if (!item) return;
    setBusy(true);
    const { error } = await supabase.rpc('adjust_stock', {
      p_item_id: item.id,
      p_quantity_change: delta,
      p_movement_type: delta > 0 ? 'add' : 'remove',
      p_location_id: null,
      p_reason: 'Mobile detail',
      p_notes: null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not adjust', error.message);
      return;
    }
    setItem({ ...item, quantity_on_hand: item.quantity_on_hand + delta });
  }

  if (!item) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Text style={{ color: theme.primary, fontSize: 14 }}>← Back</Text>
        </Pressable>

        <Text style={styles.sku}>{item.sku}</Text>
        <Text style={styles.name}>{item.name}</Text>

        <View style={styles.qtyCard}>
          <Text style={styles.qtyLabel}>On hand</Text>
          <Text style={styles.qtyValue}>
            {item.quantity_on_hand}
            <Text style={styles.qtyUnit}> {item.unit_of_measure}</Text>
          </Text>
          <Text style={styles.statusLine}>
            Reorder at {item.reorder_point} · suggested reorder {item.reorder_quantity}
          </Text>

          <View style={styles.actions}>
            <ActionBtn label="−5" onPress={() => adjust(-5)} disabled={busy} />
            <ActionBtn label="−1" onPress={() => adjust(-1)} disabled={busy} />
            <ActionBtn label="+1" onPress={() => adjust(1)} disabled={busy} primary />
            <ActionBtn label="+5" onPress={() => adjust(5)} disabled={busy} primary />
          </View>
        </View>

        <View style={styles.metaCard}>
          <Row label="Unit cost" value={`$${item.unit_cost.toFixed(2)}`} />
          <Row label="Retail price" value={`$${item.retail_price.toFixed(2)}`} />
          <Row label="Inventory value" value={`$${(item.unit_cost * item.quantity_on_hand).toFixed(2)}`} />
        </View>

        {item.description && (
          <View style={styles.metaCard}>
            <Text style={styles.descLabel}>Description</Text>
            <Text style={styles.desc}>{item.description}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionBtn({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionBtn,
        primary && { backgroundColor: theme.primary },
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={[styles.actionLabel, primary && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  back: { marginBottom: space.md },
  sku: { color: theme.textMuted, fontSize: 12, fontFamily: 'Menlo' },
  name: { color: theme.text, fontSize: 24, fontWeight: '700', marginTop: 4 },
  qtyCard: {
    marginTop: space.lg,
    backgroundColor: theme.card,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  qtyLabel: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '500' },
  qtyValue: { color: theme.text, fontSize: 48, fontWeight: '700', marginTop: 4 },
  qtyUnit: { color: theme.textMuted, fontSize: 18, fontWeight: '500' },
  statusLine: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  actionLabel: { color: theme.text, fontWeight: '700', fontSize: 14 },
  metaCard: {
    marginTop: space.md,
    backgroundColor: theme.card,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { color: theme.textMuted, fontSize: 13 },
  rowValue: { color: theme.text, fontSize: 14, fontWeight: '600' },
  descLabel: { color: theme.textMuted, fontSize: 11, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  desc: { color: theme.text, fontSize: 14, marginTop: space.xs, lineHeight: 20 },
});
