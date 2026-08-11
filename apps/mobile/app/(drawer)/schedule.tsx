import { useRouter } from 'expo-router';
import { Calendar, Plus } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Mono } from '@/components/ui/text';
import { showWriteCta } from '@/lib/cta-gating';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface ScheduleRow {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  location_text: string | null;
  requester_name: string | null;
  warehouse: { name: string | null } | null;
}

export default function ScheduleScreen() {
  const router = useRouter();
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<ScheduleRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // Write-CTA gate: adding an event requires schedule:manage. Cosmetic (the
  // API enforces server-side); while the effective set is loading (undefined)
  // the CTA shows — today's behavior.
  const perms = useEffectivePermissions();
  const canManageSchedule = showWriteCta(perms, 'schedule:manage');

  const load = React.useCallback(async () => {
    if (!orgId) return;
    // Upcoming events for the next 30 days (matches the web's default view).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('schedule_events')
      .select(
        `id, title, starts_at, ends_at, all_day, location_text, requester_name,
         warehouse:warehouses!warehouse_id (name)`,
      )
      .eq('organization_id', orgId)
      .gte('starts_at', since)
      .lte('starts_at', until)
      .order('starts_at', { ascending: true })
      .limit(100);
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
        return {
          id: r.id as string,
          title: r.title as string,
          starts_at: r.starts_at as string,
          ends_at: (r.ends_at as string | null) ?? null,
          all_day: Boolean(r.all_day),
          location_text: (r.location_text as string | null) ?? null,
          requester_name: (r.requester_name as string | null) ?? null,
          warehouse: Array.isArray(wh) ? wh[0] ?? null : wh,
        };
      }),
    );
    setLoading(false);
  }, [orgId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <DataListScreen
      eyebrow={`SCHEDULE · NEXT 30 DAYS`}
      title="Team"
      italic="calendar."
      emptyTitle="No upcoming events."
      emptyBody="Schedule deliveries, pickups, and team work on the web — it shows here so you can check on the floor."
      emptyIcon={Calendar}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      trailing={
        canManageSchedule ? (
          <IconChip icon={Plus} onPress={() => router.push('/schedule/new')} />
        ) : undefined
      }
      keyExtractor={(e) => e.id}
      renderItem={(e) => <EventCard event={e} />}
    />
  );
}

function EventCard({ event }: { event: ScheduleRow }) {
  const { c } = useTheme();
  const starts = new Date(event.starts_at);
  const today = new Date();
  const isToday = starts.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const isTomorrow = starts.toDateString() === tomorrow.toDateString();

  function openOnWeb() {
    Linking.openURL(`https://stockpilotusa.com/dashboard/schedule`).catch(() => undefined);
  }

  return (
    <Pressable onPress={openOnWeb} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
          <View
            style={{
              width: 56,
              alignItems: 'center',
              borderRightWidth: 1,
              borderRightColor: c.hair,
              paddingRight: 12,
            }}
          >
            <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
              {starts.toLocaleDateString(undefined, { month: 'short' })}
            </Mono>
            <Mono size={22} tracking={-0.022} color={c.ink} style={{ fontFamily: FONT.display, marginTop: 2 }}>
              {starts.getDate()}
            </Mono>
            <Mono size={10} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
              {event.all_day ? 'all day' : starts.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </Mono>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <Body size={15} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
                {event.title}
              </Body>
              {isToday ? <Pill status="ok">TODAY</Pill> : isTomorrow ? <Pill status="warn">TOMORROW</Pill> : null}
            </View>
            {event.location_text ? (
              <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                {event.location_text}
              </Mono>
            ) : null}
            {event.warehouse?.name || event.requester_name ? (
              <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
                {[event.warehouse?.name, event.requester_name].filter(Boolean).join(' · ')}
              </Mono>
            ) : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}
