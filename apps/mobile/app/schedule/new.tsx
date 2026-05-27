import { useRouter } from 'expo-router';
import {
  Calendar,
  ChevronLeft,
  Clock,
  MapPin,
  User,
  Warehouse,
} from 'lucide-react-native';
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
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT, RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface WarehouseRow {
  id: string;
  name: string;
}

/**
 * Mobile MVP for scheduling an event. Inserts into `schedule_events`
 * with the same shape the web's calendar uses. Date picking is
 * intentionally simple (days from now + time-of-day picker) — a real
 * native calendar UX is its own follow-up; this still gets you on the
 * shared org calendar.
 */
export default function NewScheduleEvent() {
  const router = useRouter();
  const { orgId } = useOrg();
  const { c } = useTheme();
  const [warehouses, setWarehouses] = React.useState<WarehouseRow[]>([]);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState('');
  const [daysFromNow, setDaysFromNow] = React.useState('0');
  const [timeOfDay, setTimeOfDay] = React.useState('09:00');
  const [durationHours, setDurationHours] = React.useState('1');
  const [allDay, setAllDay] = React.useState(false);
  const [location, setLocation] = React.useState('');
  const [requesterName, setRequesterName] = React.useState('');
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
    })();
  }, [orgId]);

  const startsAt = React.useMemo(() => {
    const days = parseInt(daysFromNow, 10);
    if (Number.isNaN(days) || days < 0) return null;
    const d = new Date();
    d.setDate(d.getDate() + days);
    if (allDay) {
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const [hh, mm] = timeOfDay.split(':').map((x) => parseInt(x, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    d.setHours(hh, mm, 0, 0);
    return d;
  }, [daysFromNow, timeOfDay, allDay]);

  const endsAt = React.useMemo(() => {
    if (!startsAt) return null;
    if (allDay) {
      const d = new Date(startsAt);
      d.setHours(23, 59, 59, 0);
      return d;
    }
    const hrs = parseFloat(durationHours);
    if (Number.isNaN(hrs) || hrs <= 0) return null;
    return new Date(startsAt.getTime() + hrs * 60 * 60 * 1000);
  }, [startsAt, durationHours, allDay]);

  const canSubmit =
    Boolean(orgId) &&
    title.trim().length > 0 &&
    Boolean(startsAt) &&
    !busy;

  async function submit() {
    if (!orgId || !startsAt) return;
    setBusy(true);
    const { error } = await supabase.from('schedule_events').insert({
      organization_id: orgId,
      title: title.trim(),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt?.toISOString() ?? null,
      all_day: allDay,
      location_text: location.trim() || null,
      warehouse_id: warehouseId,
      requester_name: requesterName.trim() || null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not schedule', error.message);
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
          <Eyebrow>SCHEDULE · NEW EVENT</Eyebrow>
          <Display size={32} style={{ marginTop: 12 }}>
            Add to <Em>calendar.</Em>
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
          <FormSection icon={Calendar} label="EVENT">
            <Field
              label="TITLE"
              value={title}
              onChangeText={setTitle}
              placeholder="Delivery to L4L Fresno"
              autoCapitalize="sentences"
            />
          </FormSection>

          <FormSection icon={Clock} label="WHEN">
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="DAYS FROM TODAY"
                  value={daysFromNow}
                  onChangeText={setDaysFromNow}
                  placeholder="0"
                  keyboardType="number-pad"
                />
              </View>
              {!allDay ? (
                <View style={{ flex: 1 }}>
                  <Field
                    label="TIME (HH:MM)"
                    value={timeOfDay}
                    onChangeText={setTimeOfDay}
                    placeholder="09:00"
                  />
                </View>
              ) : null}
            </View>
            {!allDay ? (
              <Field
                label="DURATION (HOURS)"
                value={durationHours}
                onChangeText={setDurationHours}
                placeholder="1"
                keyboardType="decimal-pad"
              />
            ) : null}
            <Pressable
              onPress={() => setAllDay((v) => !v)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 4,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  borderWidth: 1.4,
                  borderColor: c.ink3,
                  backgroundColor: allDay ? c.ink : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {allDay ? (
                  <Body size={11} color={c.paper}>
                    ✓
                  </Body>
                ) : null}
              </View>
              <Body size={14} color={c.ink2}>
                All-day event
              </Body>
            </Pressable>
            {startsAt ? (
              <Mono size={11} tracking={0.04} color={c.ink4}>
                Starts {startsAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: allDay ? undefined : 'short' })}
                {endsAt && !allDay ? ` · ends ${endsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
              </Mono>
            ) : null}
          </FormSection>

          <FormSection icon={MapPin} label="WHERE">
            <Field
              label="LOCATION TEXT"
              value={location}
              onChangeText={setLocation}
              placeholder="DC4 dock 2, customer HQ, etc."
            />
          </FormSection>

          <FormSection icon={Warehouse} label="WAREHOUSE (OPTIONAL)">
            {warehouses.length === 0 ? (
              <ActivityIndicator color={c.ink} style={{ paddingVertical: 8 }} />
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Chip active={warehouseId === null} onPress={() => setWarehouseId(null)}>
                  None
                </Chip>
                {warehouses.map((w) => (
                  <Chip
                    key={w.id}
                    active={w.id === warehouseId}
                    onPress={() => setWarehouseId(w.id)}
                  >
                    {w.name}
                  </Chip>
                ))}
              </View>
            )}
          </FormSection>

          <FormSection icon={User} label="REQUESTER (OPTIONAL)">
            <Field
              label="NAME"
              value={requesterName}
              onChangeText={setRequesterName}
              placeholder="Who asked for this?"
              autoCapitalize="words"
            />
          </FormSection>

          <Pill status="warn" style={{ alignSelf: 'flex-start', marginTop: 4 }}>
            MVP · simple form
          </Pill>
          <Body size={12.5} muted style={{ marginTop: 4 }}>
            This adds an event to the team calendar. Recurring events, drag-and-drop reschedule, and attendees stay on web for now.
          </Body>

          <Button block onPress={submit} disabled={!canSubmit} style={{ marginTop: 12 }}>
            {busy ? 'Saving…' : 'Add to calendar'}
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
  ...rest
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Mono size={10} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <TextInput
        {...rest}
        placeholderTextColor={c.ink5}
        style={{
          fontFamily: FONT.displayRegular,
          fontSize: 15,
          height: 48,
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: c.hair,
          borderRadius: RADIUS.tile,
          color: c.ink,
          backgroundColor: c.paper2,
        }}
      />
    </View>
  );
}

function Chip({
  active,
  onPress,
  children,
}: {
  active: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: active ? c.ink : c.hair,
          backgroundColor: active ? c.ink : c.card,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Body size={13} color={active ? c.paper : c.ink2} style={{ fontFamily: FONT.display }}>
        {children}
      </Body>
    </Pressable>
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
