import { useRouter } from 'expo-router';
import { Bell, BellOff, type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { ensureRealtimeAuth } from '@/lib/realtime-auth';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/use-workspace';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * Notifications inbox — reads `public.notifications` for the current user
 * and subscribes to inserts/updates via Supabase Realtime so new
 * notifications appear live without pull-to-refresh. Tap to mark read
 * and follow the link. Same source the web's bell uses.
 */
export default function NotificationsScreen() {
  const { user } = useAuth();
  const { activeOrgId } = useWorkspace();
  const router = useRouter();
  const [rows, setRows] = React.useState<NotificationRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!user || !activeOrgId) return;
    const { data } = await supabase
      .from('notifications')
      .select('id, type, title, body, link, read_at, created_at')
      .eq('user_id', user.id)
      // Scope to the ACTIVE workspace — a user in several orgs otherwise
      // sees other workspaces' notifications in this inbox (their links
      // would navigate into the wrong org). Mirrors the web bell.
      .eq('organization_id', activeOrgId)
      .order('created_at', { ascending: false })
      .limit(100);
    setRows((data ?? []) as NotificationRow[]);
    setLoading(false);
  }, [user, activeOrgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Realtime subscription — Supabase pushes any INSERT / UPDATE on
  // notifications scoped to this user. Saves a poll loop and matches
  // the web's "new bell badge appears live" behavior.
  React.useEffect(() => {
    if (!user) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    void (async () => {
      // Join AFTER the JWT reaches the realtime socket — a channel joined
      // off a restored session (INITIAL_SESSION) registers as `anon` and
      // RLS silently drops every event. See lib/realtime-auth.ts.
      await ensureRealtimeAuth();
      if (cancelled) return;
      channel = supabase
        .channel(`notif-${user.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${user.id}`,
          },
          () => {
            void load();
          },
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [user, load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function open(notif: NotificationRow) {
    if (!notif.read_at) {
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', notif.id);
      setRows((prev) =>
        prev.map((r) => (r.id === notif.id ? { ...r, read_at: new Date().toISOString() } : r)),
      );
    }
    if (notif.link) router.push(notif.link as never);
  }

  return (
    <DataListScreen
      eyebrow={`INBOX · ${rows.filter((r) => !r.read_at).length} UNREAD`}
      title="Notifications"
      italic="."
      emptyTitle="All caught up."
      emptyBody="When stock hits reorder, a PO is overdue, or an order needs your approval, it shows up here."
      emptyIcon={BellOff}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(n) => n.id}
      renderItem={(n) => <NotifRow row={n} onPress={() => open(n)} />}
    />
  );
}

function NotifRow({ row, onPress }: { row: NotificationRow; onPress: () => void }) {
  const { c } = useTheme();
  const unread = !row.read_at;
  const when = new Date(row.created_at);
  const ago = relativeTime(when);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              marginTop: 8,
              backgroundColor: unread ? ACCENT.mint : 'transparent',
            }}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 8,
              }}
            >
              <Body
                size={15}
                color={c.ink}
                style={{ flex: 1, fontFamily: unread ? FONT.display : FONT.displayRegular }}
              >
                {row.title}
              </Body>
              <Mono size={10.5} tracking={0.04} color={c.ink4}>
                {ago}
              </Mono>
            </View>
            {row.body ? (
              <Body muted size={13} style={{ marginTop: 4 }}>
                {row.body}
              </Body>
            ) : null}
            {unread ? (
              <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                <Pill status="ok">NEW</Pill>
              </View>
            ) : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

function relativeTime(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
