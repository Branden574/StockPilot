import { CameraView, useCameraPermissions } from 'expo-camera';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface FoundItem {
  id: string;
  name: string;
  sku: string;
  quantity_on_hand: number;
  reorder_point: number;
}

export default function Scan() {
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = React.useState(true);
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [item, setItem] = React.useState<FoundItem | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastCode, setLastCode] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setOrgId((data?.organization_id as string | undefined) ?? null));
  }, [user]);

  async function onBarCodeScanned({ data }: { data: string }) {
    if (busy || !orgId || data === lastCode) return;
    setLastCode(data);
    setBusy(true);
    setScanning(false);

    const { data: row } = await supabase
      .from('inventory_items')
      .select('id, name, sku, quantity_on_hand, reorder_point')
      .eq('organization_id', orgId)
      .or(`barcode.eq.${data},sku.eq.${data}`)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();

    if (!row) {
      Alert.alert('Not found', `No item matches ${data}.`, [{ text: 'OK', onPress: reset }]);
      setBusy(false);
      return;
    }
    setItem(row as FoundItem);
    setBusy(false);
  }

  function reset() {
    setItem(null);
    setLastCode(null);
    setScanning(true);
  }

  async function adjust(delta: number) {
    if (!item) return;
    setBusy(true);
    const { error } = await supabase.rpc('adjust_stock', {
      p_item_id: item.id,
      p_quantity_change: delta,
      p_movement_type: delta > 0 ? 'add' : 'remove',
      p_location_id: null,
      p_reason: 'Mobile scan',
      p_notes: null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not adjust', error.message);
      return;
    }
    setItem({ ...item, quantity_on_hand: item.quantity_on_hand + delta });
  }

  if (!permission) return <CenterMessage>Loading camera permission…</CenterMessage>;
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.permission}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>StockPilot uses the camera to scan barcodes and QR codes.</Text>
          <Pressable style={styles.cta} onPress={requestPermission}>
            <Text style={styles.ctaLabel}>Grant access</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {scanning && !item ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{
            barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'codabar', 'pdf417'],
          }}
          onBarcodeScanned={onBarCodeScanned}
        />
      ) : null}

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.frame} />
        <Text style={styles.hint}>{scanning && !item ? 'Point at a barcode or QR code' : ''}</Text>
      </View>

      {item && (
        <View style={styles.sheet}>
          <Text style={styles.sheetSku}>{item.sku}</Text>
          <Text style={styles.sheetName}>{item.name}</Text>
          <View style={styles.sheetRow}>
            <Text style={styles.sheetLabel}>On hand</Text>
            <Text style={styles.sheetQty}>{item.quantity_on_hand}</Text>
          </View>

          <View style={styles.actions}>
            <ActionBtn label="−1" onPress={() => adjust(-1)} disabled={busy} />
            <ActionBtn label="+1" onPress={() => adjust(1)} disabled={busy} primary />
            <ActionBtn label="+5" onPress={() => adjust(5)} disabled={busy} primary />
            <ActionBtn label="+25" onPress={() => adjust(25)} disabled={busy} />
          </View>

          <Pressable style={styles.dismiss} onPress={reset}>
            <Text style={styles.dismissLabel}>Scan another</Text>
          </Pressable>
        </View>
      )}

      {busy && !item && <ActivityIndicator style={styles.spinner} color={theme.primary} size="large" />}
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

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <Text style={{ color: theme.textMuted }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  frame: {
    width: 260,
    height: 260,
    borderWidth: 2,
    borderColor: theme.primary,
    borderRadius: radius.xl,
  },
  hint: { color: '#fff', marginTop: space.lg, fontSize: 13, fontWeight: '500' },
  sheet: {
    position: 'absolute',
    bottom: 90,
    left: space.lg,
    right: space.lg,
    backgroundColor: theme.card,
    borderRadius: radius.xl,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  sheetSku: { color: theme.textMuted, fontSize: 11, fontFamily: 'Menlo' },
  sheetName: { color: theme.text, fontSize: 18, fontWeight: '700', marginTop: 2 },
  sheetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: space.md },
  sheetLabel: { color: theme.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  sheetQty: { color: theme.text, fontSize: 28, fontWeight: '700' },
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
  dismiss: { marginTop: space.md, alignItems: 'center', paddingVertical: 8 },
  dismissLabel: { color: theme.primary, fontSize: 13, fontWeight: '600' },
  permission: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xl, backgroundColor: theme.bg },
  permTitle: { color: theme.text, fontSize: 20, fontWeight: '700' },
  permBody: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginTop: space.sm },
  cta: { backgroundColor: theme.primary, paddingHorizontal: space.lg, paddingVertical: 12, borderRadius: radius.md, marginTop: space.lg },
  ctaLabel: { color: '#fff', fontWeight: '600' },
  spinner: { position: 'absolute', top: '50%', left: '50%' },
});
