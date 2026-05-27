import { Mail, Users } from 'lucide-react-native';
import * as React from 'react';
import { Image, Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface UserRow {
  user_id: string;
  role: string;
  accepted_at: string | null;
  invited_email: string | null;
  created_at: string;
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    email: string | null;
  } | null;
}

const ROLE_PILL: Record<string, { label: string; status: 'ok' | 'warn' | 'crit' | 'default' }> = {
  owner: { label: 'OWNER', status: 'ok' },
  admin: { label: 'ADMIN', status: 'ok' },
  manager: { label: 'MANAGER', status: 'default' },
  staff: { label: 'STAFF', status: 'default' },
  writer: { label: 'WRITER', status: 'default' },
  viewer: { label: 'VIEWER', status: 'default' },
};

export default function UsersAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<UserRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    // user_profiles.id == auth.users.id == organization_members.user_id.
    // Match Web's nav.ts approach — single query, embedded profile, ordered
    // by accepted_at desc so the latest active members surface first.
    const { data } = await supabase
      .from('organization_members')
      .select(
        `user_id, role, accepted_at, invited_email, created_at,
         profile:user_profiles!user_id (full_name, avatar_url, email)`,
      )
      .eq('organization_id', orgId)
      .order('accepted_at', { ascending: false });
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const p = r.profile as UserRow['profile'] | UserRow['profile'][] | null;
        return {
          user_id: r.user_id as string,
          role: r.role as string,
          accepted_at: (r.accepted_at as string | null) ?? null,
          invited_email: (r.invited_email as string | null) ?? null,
          created_at: r.created_at as string,
          profile: Array.isArray(p) ? p[0] ?? null : p,
        };
      }),
    );
    setLoading(false);
  }, [orgId, isAdmin]);

  React.useEffect(() => {
    if (!roleLoading) void load();
  }, [load, roleLoading]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!roleLoading && !isAdmin) {
    return (
      <DataListScreen
        eyebrow="ADMIN · USERS"
        title="Restricted"
        italic="access."
        emptyIcon={Users}
        emptyTitle="Admin only."
        emptyBody=""
        data={[]}
        loading={false}
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  const accepted = rows.filter((r) => r.accepted_at).length;
  const pending = rows.length - accepted;

  return (
    <DataListScreen
      eyebrow={`ADMIN · ${accepted} MEMBERS${pending > 0 ? ` · ${pending} PENDING` : ''}`}
      title="Users"
      italic="."
      emptyTitle="No users yet."
      emptyBody="Invite teammates on the web — pending and active members show here."
      emptyIcon={Users}
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(u, i) => u.user_id || `pending-${i}`}
      renderItem={(u) => <UserCard user={u} />}
    />
  );
}

function UserCard({ user }: { user: UserRow }) {
  const { c } = useTheme();
  const pending = !user.accepted_at;
  const name = user.profile?.full_name ?? user.profile?.email ?? user.invited_email ?? 'Unnamed';
  const email = user.profile?.email ?? user.invited_email;
  const avatar = user.profile?.avatar_url ?? null;
  const initials = name
    .split(/[\s._-]+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const pill = ROLE_PILL[user.role] ?? { label: user.role.toUpperCase(), status: 'default' as const };
  return (
    <Card padding={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={{ width: 40, height: 40, borderRadius: 20 }} />
        ) : (
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              borderWidth: 1.4,
              borderColor: c.ink3,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Mono size={11} tracking={0.04} color={c.ink}>
              {initials || '··'}
            </Mono>
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {name}
          </Body>
          {email ? (
            <Pressable
              onPress={() => Linking.openURL(`mailto:${email}`).catch(() => undefined)}
              style={({ pressed }) => ({
                marginTop: 3,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Mail size={11} color={c.ink4} strokeWidth={1.5} />
              <Mono size={11} tracking={0.04} color={c.ink4}>
                {email}
              </Mono>
            </Pressable>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          {pill.status === 'default' ? <Pill>{pill.label}</Pill> : <Pill status={pill.status}>{pill.label}</Pill>}
          {pending ? <Pill status="warn">PENDING</Pill> : null}
        </View>
      </View>
    </Card>
  );
}
