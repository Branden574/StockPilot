import { useRouter } from 'expo-router';
import { Calendar, ChevronLeft, PackageOpen, User, Warehouse } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT, RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface WarehouseRow {
  id: string;
  name: string;
}

/**
 * Mobile MVP for rental checkout. Creates a `rentals` row scoped to
 * the org + warehouse, with borrower name/email + expected return.
 * Same insert path the web's RentalCheckoutForm uses, just a phone-
 * shaped UI on top of it. Real check-in/return flow still lives on
 * web (multi-asset, custom fields, deposit handling).
 */
export default function NewRental() {
  const router = useRouter();
  const { user } = useAuth();
  const { orgId } = useOrg();
  const { c } = useTheme();
  const [warehouses, setWarehouses] = React.useState<WarehouseRow[]>([]);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [borrowerName, setBorrowerName] = React.useState('');
  const [borrowerEmail, setBorrowerEmail] = React.useState('');
  const [returnDays, setReturnDays] = React.useState('7');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!orgId) return;
    void (async () => {
      const { data } = await supabase
        .from('warehouses')
        .select('id, name')
        .eq('organization_id', orgId)
        .neq('status', 'archived')
        .order('name', { ascending: true });
      const list = (data ?? []) as WarehouseRow[];
      setWarehouses(list);
      if (list.length > 0) setWarehouseId(list[0].id);
    })();
  }, [orgId]);

  const expectedReturn = React.useMemo(() => {
    const days = parseInt(returnDays, 10);
    if (Number.isNaN(days) || days <= 0) return null;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
  }, [returnDays]);

  const canSubmit =
    Boolean(orgId) &&
    Boolean(warehouseId) &&
    borrowerName.trim().length > 0 &&
    Boolean(expectedReturn) &&
    !busy;

  async function submit() {
    if (!orgId || !warehouseId || !user) return;
    if (!expectedReturn) {
      Alert.alert('Expected return required', 'Enter the number of days until return.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.from('rentals').insert({
      organization_id: orgId,
      warehouse_id: warehouseId,
      borrower_name: borrowerName.trim(),
      borrower_email: borrowerEmail.trim() || null,
      expected_return_at: expectedReturn.toISOString(),
      notes: notes.trim() || null,
      status: 'out',
      created_by: user.id,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not check out', error.message);
      return;
    }
    router.back();
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ChevronLeft} onPress={() => router.back()} />
        </View>
        <View style={styles.head}>
          <Eyebrow>RENTALS · NEW CHECKOUT</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            Check <Em>out.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40, gap: 14 }}
          keyboardShouldPersistTaps="handled"
        >
          <FormSection icon={Warehouse} label="WAREHOUSE">
            {warehouses.length === 0 ? (
              <ActivityIndicator color={c.ink} style={{ paddingVertical: 8 }} />
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {warehouses.map((w) => {
                  const active = w.id === warehouseId;
                  return (
                    <Pressable
                      key={w.id}
                      onPress={() => setWarehouseId(w.id)}
                      style={({ pressed }) => [
                        styles.chip,
                        {
                          borderColor: active ? c.ink : c.hair,
                          backgroundColor: active ? c.ink : c.card,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Body
                        size={13}
                        color={active ? c.paper : c.ink2}
                        style={{ fontFamily: FONT.display }}
                      >
                        {w.name}
                      </Body>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </FormSection>

          <FormSection icon={User} label="BORROWER">
            <Field
              label="FULL NAME"
              value={borrowerName}
              onChangeText={setBorrowerName}
              placeholder="Who is checking this out?"
              autoCapitalize="words"
            />
            <Field
              label="EMAIL (OPTIONAL)"
              value={borrowerEmail}
              onChangeText={setBorrowerEmail}
              placeholder="branden@stockpilotusa.com"
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </FormSection>

          <FormSection icon={Calendar} label="EXPECTED RETURN">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="DAYS FROM TODAY"
                  value={returnDays}
                  onChangeText={setReturnDays}
                  placeholder="7"
                  keyboardType="number-pad"
                />
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
                  RETURN BY
                </Mono>
                <Mono
                  size={14}
                  tracking={-0.012}
                  color={c.ink}
                  style={{ fontFamily: FONT.display, marginTop: 4 }}
                >
                  {expectedReturn
                    ? expectedReturn.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })
                    : '—'}
                </Mono>
              </View>
            </View>
          </FormSection>

          <FormSection icon={PackageOpen} label="NOTES">
            <Field
              label="ITEM(S) + ANY CONTEXT"
              value={notes}
              onChangeText={setNotes}
              placeholder="e.g. Canopy #3, blue tarp, two folding tables"
              multiline
            />
          </FormSection>

          <Body size={12.5} muted style={{ marginTop: 8 }}>
            This creates a rental checkout record. Linking specific inventory items and automatic
            return-to-stock are managed on the web.
          </Body>

          <Button block onPress={submit} disabled={!canSubmit} style={{ marginTop: 12 }}>
            {busy ? 'Saving…' : 'Check out'}
          </Button>
          <Button block variant="ghost" onPress={() => router.back()}>
            Cancel
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function FormSection({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Calendar;
  label: string;
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Icon size={14} color={c.ink} strokeWidth={1.5} />
        <Mono size={10.5} tracking={0.12} upper color={c.ink4}>
          {label}
        </Mono>
      </View>
      <View style={{ gap: 12 }}>{children}</View>
    </Card>
  );
}

function Field({
  label,
  multiline = false,
  ...rest
}: React.ComponentProps<typeof TextInput> & { label: string; multiline?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Mono size={10} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <TextInput
        {...rest}
        multiline={multiline}
        placeholderTextColor={c.ink5}
        style={{
          fontFamily: FONT.displayRegular,
          fontSize: 15,
          minHeight: multiline ? 80 : 48,
          paddingHorizontal: 14,
          paddingVertical: multiline ? 10 : 0,
          borderWidth: 1,
          borderColor: c.hair,
          borderRadius: RADIUS.tile,
          color: c.ink,
          backgroundColor: c.paper2,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
});
