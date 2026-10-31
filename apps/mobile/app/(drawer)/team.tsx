import { Mail, Users } from 'lucide-react-native';
import * as React from 'react';
import { Image, Linking, Pressable, View } from 'react-native';

import { plainAddressMailtoUrl } from '@stockpilot/core';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Mono } from '@/components/ui/text';
import { joinMemberProfiles, loadOrgMembers } from '@/lib/org-members';
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
  // The member list did not load: an error, not "No team yet.". Set by every
  // load that completes.
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    // Two-step fetch — the embedded `profile:user_profiles!user_id (...)`
    // was returning zero rows because organization_members has two FKs
    // into user_profiles (user_id + invited_by) and PostgREST's hint
    // resolution silently nulled the embed.
    // `invited_email` lives on `organization_invites`, not here — selecting
    // it caused `column ... does not exist` and dropped every row.
    //
    // Both reads live in loadOrgMembers: paged, batched, and THROWING on
    // either failure, which used to render "No team yet." or a list of
    // "Unnamed" members.
    try {
      const { members, profiles } = await loadOrgMembers<{
        id: string;
        full_name: string | null;
        avatar_url: string | null;
        email: string | null;
      }>(supabase, orgId, { profileColumns: 'id, full_name, avatar_url, email' });
      setRows(
        joinMemberProfiles(members, profiles).map(({ member: m, profile: p }) => ({
          user_id: m.user_id,
          role: m.role,
          accepted_at: m.accepted_at,
          invited_email: null,
          profile: p
            ? {
                full_name: p.full_name ?? null,
                avatar_url: p.avatar_url ?? null,
                email: p.email ?? null,
              }
            : null,
        })),
      );
      setLoadFailed(false);
    } catch (e) {
      console.warn('[team] members load failed:', e instanceof Error ? e.message : e);
      setRows([]);
      setLoadFailed(true);
    }
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

  const accepted = rows.filter((r) => r.accepted_at).length;
  const pending = rows.length - accepted;

  return (
    <DataListScreen
      eyebrow={
        loadFailed
          ? 'TEAM'
          : `TEAM · ${accepted} MEMBERS${pending > 0 ? ` · ${pending} PENDING` : ''}`
      }
      title="Team"
      italic="& roles."
      emptyTitle="No team yet."
      emptyBody="Invite teammates on the web. Pending invites and active members show here."
      emptyIcon={Users}
      // The failed read in its own words, through the list's failed state
      // (a warning glyph and an alert), never the empty team's words.
      failed={
        loadFailed
          ? {
              title: 'Could not load the team.',
              body: 'Check your connection and pull down to try again.',
            }
          : null
      }
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
  // A link only for one plain address (core plainAddressMailtoUrl). Before,
  // `mailto:${email}` opened whatever was stored, so an address such as
  // "a@b.com?bcc=x@y.z" or one with an invisible character opened a message
  // to someone the card does not show. Any other text is shown, not linked.
  const mailto = plainAddressMailtoUrl(email);
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
          {email && mailto ? (
            // A link (it opens Mail) in a 44pt frame. The frame is padding
            // around the email, so it grows with the email (a wrapped or
            // larger address) instead of centring it in a fixed box, and the
            // negative margins give the padding back: the email sits 3pt
            // under the name and the card keeps its padding at every text
            // size. One line at the default size is 15.2 + 29 = 44.2pt;
            // minHeight keeps 44 at the sizes below the default.
            <Pressable
              onPress={() => Linking.openURL(mailto).catch(() => undefined)}
              accessibilityRole="link"
              style={({ pressed }) => ({
                minHeight: 44,
                paddingVertical: 14.5,
                marginTop: -11.5,
                marginBottom: -14.5,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Mail size={11} color={c.ink3} strokeWidth={1.5} />
              <Mono size={11.5} tracking={0.04} color={c.ink3}>
                {email}
              </Mono>
            </Pressable>
          ) : email ? (
            // Not one plain address: the same words in the same place, with
            // no touchable and no Mail glyph, so nothing offers to open Mail.
            <View style={{ marginTop: 3 }}>
              <Mono size={11.5} tracking={0.04} color={c.ink3}>
                {email}
              </Mono>
            </View>
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
