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
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
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
 *
 * The look (redesign P5.10): the shared text boxes, warehouse chips and
 * checkbox on the per-mode palette. What is typed is content, so it grows
 * with the text size as these boxes always did (0 lifts the shared box's
 * input ceiling). The warehouse read says when it failed, and an
 * organization with none shows None alone, where both used to spin forever.
 */
export default function NewScheduleEvent() {
  const router = useRouter();
  const { orgId } = useOrg();
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  // Days and time sit side by side, one over the other past the stacking scale.
  const stacked = shouldStackRow(fontScale);
  const [warehouses, setWarehouses] = React.useState<WarehouseRow[]>([]);
  // The warehouse read: loading, answered, or failed (the field is optional,
  // so None stays offered after a failure).
  const [warehousesRead, setWarehousesRead] = React.useState<'loading' | 'ready' | 'failed'>(
    'loading',
  );
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
      const { data, error } = await supabase
        .from('warehouses')
        .select('id, name')
        .eq('organization_id', orgId)
        .neq('status', 'archived')
        .order('name', { ascending: true });
      if (error) {
        setWarehousesRead('failed');
        return;
      }
      const list = (data ?? []) as WarehouseRow[];
      setWarehouses(list);
      setWarehousesRead('ready');
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
          <IconChip icon={ChevronLeft} onPress={() => router.back()} accessibilityLabel="Back" minTap />
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
              accessibilityLabel="Title"
              value={title}
              onChangeText={setTitle}
              placeholder="Delivery to L4L Fresno"
              autoCapitalize="sentences"
              maxFontSizeMultiplier={0}
            />
          </FormSection>

          <FormSection icon={Clock} label="WHEN">
            <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 12 }}>
              <View style={stacked ? undefined : { flex: 1 }}>
                <Field
                  label="DAYS FROM TODAY"
                  accessibilityLabel="Days from today"
                  value={daysFromNow}
                  onChangeText={setDaysFromNow}
                  placeholder="0"
                  keyboardType="number-pad"
                  maxFontSizeMultiplier={0}
                />
              </View>
              {!allDay ? (
                <View style={stacked ? undefined : { flex: 1 }}>
                  <Field
                    label="TIME (HH:MM)"
                    accessibilityLabel="Time"
                    value={timeOfDay}
                    onChangeText={setTimeOfDay}
                    placeholder="09:00"
                    maxFontSizeMultiplier={0}
                  />
                </View>
              ) : null}
            </View>
            {!allDay ? (
              <Field
                label="DURATION (HOURS)"
                accessibilityLabel="Duration in hours"
                value={durationHours}
                onChangeText={setDurationHours}
                placeholder="1"
                keyboardType="decimal-pad"
                maxFontSizeMultiplier={0}
              />
            ) : null}
            {/* The shared checkbox: announced as a checkbox with its state,
                in a 44pt frame (the hand-drawn box had neither). */}
            <Checkbox
              checked={allDay}
              onChange={() => setAllDay((v) => !v)}
              label="All-day event"
            />
            {startsAt ? (
              <Mono size={11} tracking={0.04} color={c.ink3}>
                Starts {startsAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: allDay ? undefined : 'short' })}
                {endsAt && !allDay ? ` · ends ${endsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
              </Mono>
            ) : null}
          </FormSection>

          <FormSection icon={MapPin} label="WHERE">
            <Field
              label="LOCATION TEXT"
              accessibilityLabel="Location text"
              value={location}
              onChangeText={setLocation}
              placeholder="DC4 dock 2, customer HQ, etc."
              maxFontSizeMultiplier={0}
            />
          </FormSection>

          <FormSection icon={Warehouse} label="WAREHOUSE (OPTIONAL)">
            {warehousesRead === 'loading' ? (
              <ActivityIndicator color={c.ink} style={{ paddingVertical: 8 }} />
            ) : (
              <View style={{ gap: 10 }}>
                {warehousesRead === 'failed' ? (
                  <Body size={13} color={c.critText} accessibilityRole="alert">
                    Could not load warehouses.
                  </Body>
                ) : null}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Chip
                    label="None"
                    active={warehouseId === null}
                    onPress={() => setWarehouseId(null)}
                  />
                  {warehouses.map((w) => (
                    <Chip
                      key={w.id}
                      label={w.name}
                      active={w.id === warehouseId}
                      onPress={() => setWarehouseId(w.id)}
                    />
                  ))}
                </View>
              </View>
            )}
          </FormSection>

          <FormSection icon={User} label="REQUESTER (OPTIONAL)">
            <Field
              label="NAME"
              accessibilityLabel="Requester name"
              value={requesterName}
              onChangeText={setRequesterName}
              placeholder="Who asked for this?"
              autoCapitalize="words"
              maxFontSizeMultiplier={0}
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
        <Mono size={10.5} tracking={0.12} upper color={c.ink3}>
          {label}
        </Mono>
      </View>
      <View style={{ gap: 12 }}>{children}</View>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
  // chip on every side, so the bar takes 3pt off its padding (12, 8) and what
  // sits under it 3pt off its top: the chip and the title sit where they did.
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
  },
  head: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 12 },
});
