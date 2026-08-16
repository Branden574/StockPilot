import { useRouter } from 'expo-router';
import { BellOff, CheckCheck, X } from 'lucide-react-native';
import * as React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { ensureRealtimeAuth } from '@/lib/realtime-auth';
import { supabase } from '@/lib/supabase';
import { rewriteWebPath } from '@/lib/web-path-rewrite';
import { useWorkspace } from '@/lib/use-workspace';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
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
  // Web-only notifications (briefing, digests) open the detail sheet —
  // their link has no native page and a silent no-op tap reads as broken.
  const [detail, setDetail] = React.useState<NotificationRow | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
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
      // Topic must be UNIQUE per subscription: supabase.channel() returns
      // the EXISTING instance for a repeated topic, and this effect can
      // re-run before the previous channel's async removeChannel() lands —
      // .on() against that still-subscribed instance throws "cannot add
      // postgres_changes callbacks after subscribe()" (Sentry 837e6e00).
      channel = supabase
        .channel(`notif-${user.id}-${Math.random().toString(36).slice(2, 8)}`)
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
    })().catch(() => {
      // Never let a subscription race become an unhandled rejection —
      // the screen still works without realtime (pull-to-refresh).
    });
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [user, load]);

  // Unread stays HIGHLIGHTED until the user acts (owner ask 2026-07-10):
  // tapping a notification marks that one read; the header check-chip marks
  // all read. No auto-clear on open — seeing the list is not acting on it.
  async function markAllRead() {
    const unreadIds = rows.filter((r) => !r.read_at).map((r) => r.id);
    if (unreadIds.length === 0) return;
    const now = new Date().toISOString();
    // MUST await — a supabase-js builder is lazy (`void builder` is a no-op).
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: now })
      .in('id', unreadIds);
    if (!error) {
      setRows((prev) => prev.map((r) => (r.read_at ? r : { ...r, read_at: now })));
    }
  }

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
    // Notification links are WEB paths — translate through the ONE shared
    // rewriter (the in-app inbox is the third deep-link door; raw
    // router.push('/dashboard/insights') dead-ended on Unmatched Route).
    const native = notif.link ? rewriteWebPath(notif.link) : null;
    if (native && native !== '/' && native !== '/notifications') {
      router.push(native as never);
    } else {
      setDetail(notif);
    }
  }

  return (
    <>
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
      trailing={
        rows.some((r) => !r.read_at) ? (
          <IconChip icon={CheckCheck} onPress={() => void markAllRead()} />
        ) : null
      }
      keyExtractor={(n) => n.id}
      renderItem={(n) => <NotifRow row={n} onPress={() => open(n)} />}
    />
    {detail && <NotifDetailSheet row={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/**
 * Detail sheet for web-only notifications (briefing, digests): their link has
 * no native page, and a silent no-op tap reads as broken — show the full
 * content in-place instead.
 */
function NotifDetailSheet({ row, onClose }: { row: NotificationRow; onClose: () => void }) {
  const { c } = useTheme();
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      {/*
       * Backdrop is a SIBLING behind the card, not its parent. This was a
       * scrim Pressable wrapping a BARE <Pressable> (no onPress) whose only
       * job was to swallow backdrop taps — a bare Pressable still installs the
       * responder handlers, so it blocked identically to the
       * onPress={() => undefined} spelling used in the sibling sheets, and a
       * grep for that literal could not see this file. Being touch responders,
       * both beat the ScrollView's pan recogniser, so a long notification body
       * would not scroll until something else took the responder first.
       *
       * The scrim must paint the FULL screen, so it cannot live inside a
       * padded parent: Yoga insets an absolutely-positioned child by the
       * parent's padding, which would leave a 24pt undimmed band. Hence the
       * padding moves to a `pointerEvents="box-none"` layer above the scrim —
       * that layer is not itself a touch target, so taps beside the card fall
       * through to the scrim and close, while the card's own subtree keeps its
       * touches. See add-order-items-sheet.tsx for the measured detail.
       */}
      <View style={{ flex: 1 }}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]}
          onPress={onClose}
        />
        <View
          style={{ flex: 1, justifyContent: 'center', padding: 24 }}
          pointerEvents="box-none"
        >
          <Card padding={18}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Body size={16} color={c.ink} style={{ fontFamily: FONT.display }}>
                  {row.title}
                </Body>
                <Mono size={10.5} color={c.ink4} style={{ marginTop: 4 }}>
                  {new Date(row.created_at).toLocaleString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Mono>
              </View>
              <Pressable onPress={onClose} hitSlop={10}>
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            {row.body ? (
              <ScrollView style={{ maxHeight: 320, marginTop: 12 }}>
                <Body size={14} color={c.ink2}>
                  {row.body}
                </Body>
              </ScrollView>
            ) : null}
          </Card>
        </View>
      </View>
    </Modal>
  );
}

function NotifRow({ row, onPress }: { row: NotificationRow; onPress: () => void }) {
  const { c } = useTheme();
  const unread = !row.read_at;
  const when = new Date(row.created_at);
  const ago = relativeTime(when);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card
        padding={14}
        style={unread ? { backgroundColor: ACCENT.mintSoft, borderColor: ACCENT.mint } : undefined}
      >
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
              {/* Relative age is a micro-marker and the only non-shrinking
                  sibling of the title (plan §3 keeps the title itself
                  scaling): capped so it stops taking the title's width. */}
              <Mono
                size={10.5}
                tracking={0.04}
                color={c.ink4}
                numberOfLines={1}
                maxFontSizeMultiplier={capTo(10.5, TYPE_CEILING.chrome)}
                style={{ flexShrink: 0 }}
              >
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
