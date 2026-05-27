import { Mail, Users } from 'lucide-react-native';
import * as React from 'react';
import { Image, Linking, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface MemberRow {
  user_id: string;
  role: string;
  accepted_at: string | null;
  invited_email: string | null;
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

export default function TeamScreen() {
  const { orgId } = useOrg();
  const [rows, setRows] = React.useState<MemberRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('organization_members')
      .select(
        `user_id, role, accepted_at, invited_email,
         profile:user_profiles!user_id (full_name, avatar_url, email)`,
      )
      .eq('organization_id', orgId)
      .order('accepted_at', { ascending: false });
    setRows(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const p = r.profile as MemberRow['profile'] | MemberRow['profile'][] | null;
        return {
          user_id: r.user_id as string,
          role: r.role as string,
          accepted_at: (r.accepted_at as string | null) ?? null,
          invited_email: (r.invited_email as string | null) ?? null,
          profile: Array.isArray(p) ? p[0] ?? null : p,
        };
      }),
    );
    setLoading(false);
  }, [orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const accepted = rows.filter((r) => r.accepted_at).length;
  const pending = rows.length - accepted;

  return (
    <DataListScreen
      eyebrow={`TEAM · ${accepted} MEMBERS${pending > 0 ? ` · ${pending} PENDING` : ''}`}
      title="Team"
      italic="& roles."
      emptyTitle="No team yet."
      emptyBody="Invite teammates on the web. Pending invites and active members show here."
      emptyIcon={Users}
      data={rows}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(m, i) => m.user_id || `pending-${i}`}
      renderItem={(m) => <MemberCard member={m} />}
    />
  );
}

function MemberCard({ member }: { member: MemberRow }) {
  const { c } = useTheme();
  const pending = !member.accepted_at;
  const name = member.profile?.full_name ?? member.profile?.email ?? member.invited_email ?? 'Unnamed';
  const email = member.profile?.email ?? member.invited_email;
  const avatar = member.profile?.avatar_url ?? null;
  const initials = name
    .split(/[\s._-]+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const pill =
    ROLE_PILL[member.role] ?? { label: member.role.toUpperCase(), status: 'default' as const };

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
              <Mono size={11.5} tracking={0.04} color={c.ink4}>
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
