import { Check, ChevronRight, Mail, Users } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
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

// Roles assignable from the role picker. `owner` is intentionally
// excluded — ownership transfers must go through a separate flow with
// stronger guardrails (mirrors the web app's behavior).
const ASSIGNABLE_ROLES = ['admin', 'manager', 'staff', 'viewer'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const ROLE_DESCRIPTION: Record<AssignableRole, string> = {
  admin: 'Full access — invite, remove, edit roles, change settings.',
  manager: 'Manage inventory, warehouses, POs, and counts. No member admin.',
  staff: 'Day-to-day inventory operations. Cannot change settings.',
  viewer: 'Read-only access to categories they\'re granted on the web.',
};

export default function UsersAdmin() {
  const { user } = useAuth();
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  const [rows, setRows] = React.useState<UserRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [editing, setEditing] = React.useState<UserRow | null>(null);

  const load = React.useCallback(async () => {
    if (!orgId || !isAdmin) {
      setLoading(false);
      return;
    }
    // The embed `profile:user_profiles!user_id (...)` previously resolved
    // to zero rows because `organization_members` has TWO foreign keys
    // into `user_profiles` (`user_id` and `invited_by`). PostgREST
    // ambiguity made the embed return null silently and we dropped the
    // whole row. Two-step fetch avoids the ambiguity entirely.
    // `invited_email` lives on `organization_invites`, not on
    // `organization_members` — including it here previously crashed the
    // whole query with `column ... does not exist` and returned zero
    // rows.
    const { data: members, error: membersErr } = await supabase
      .from('organization_members')
      .select('user_id, role, accepted_at, created_at')
      .eq('organization_id', orgId)
      .order('accepted_at', { ascending: false });
    if (membersErr) {
      console.warn('[admin/users] members fetch failed:', membersErr.message);
    }
    const memberRows = (members ?? []) as Array<{
      user_id: string;
      role: string;
      accepted_at: string | null;
      created_at: string;
    }>;
    const userIds = memberRows.map((m) => m.user_id).filter(Boolean);
    let profileMap = new Map<string, UserRow['profile']>();
    if (userIds.length > 0) {
      const { data: profiles, error: profilesErr } = await supabase
        .from('user_profiles')
        .select('id, full_name, avatar_url, email')
        .in('id', userIds);
      if (profilesErr) {
        console.warn('[admin/users] profile fetch failed:', profilesErr.message);
      }
      profileMap = new Map(
        (profiles ?? []).map((p) => [
          p.id as string,
          {
            full_name: (p.full_name as string | null) ?? null,
            avatar_url: (p.avatar_url as string | null) ?? null,
            email: (p.email as string | null) ?? null,
          },
        ]),
      );
    }
    setRows(
      memberRows.map((m) => ({
        user_id: m.user_id,
        role: m.role,
        accepted_at: m.accepted_at,
        invited_email: null,
        created_at: m.created_at,
        profile: profileMap.get(m.user_id) ?? null,
      })),
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

  async function changeRole(member: UserRow, nextRole: AssignableRole) {
    if (!orgId) return;
    if (member.role === nextRole) {
      setEditing(null);
      return;
    }
    if (member.role === 'owner') {
      Alert.alert(
        'Owner role',
        'Ownership transfers are handled in a separate flow on the web app.',
      );
      return;
    }
    if (member.user_id === user?.id) {
      Alert.alert(
        'Cannot change own role',
        'Ask another admin to change your role — this prevents accidentally locking yourself out.',
      );
      return;
    }
    const prevRole = member.role;
    setRows((prev) =>
      prev.map((r) => (r.user_id === member.user_id ? { ...r, role: nextRole } : r)),
    );
    setEditing(null);
    const { error } = await supabase
      .from('organization_members')
      .update({ role: nextRole })
      .eq('organization_id', orgId)
      .eq('user_id', member.user_id);
    if (error) {
      console.warn('[admin/users] role update failed:', error.message);
      Alert.alert('Could not change role', error.message);
      setRows((prev) =>
        prev.map((r) => (r.user_id === member.user_id ? { ...r, role: prevRole } : r)),
      );
    }
  }

  return (
    <>
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
        renderItem={(u) => (
          <UserCard
            user={u}
            isSelf={u.user_id === user?.id}
            onPress={() => setEditing(u)}
          />
        )}
      />
      <RolePickerSheet
        member={editing}
        orgId={orgId}
        onDismiss={() => setEditing(null)}
        onSelect={(role) => {
          if (editing) void changeRole(editing, role);
        }}
      />
    </>
  );
}

function UserCard({
  user,
  isSelf,
  onPress,
}: {
  user: UserRow;
  isSelf: boolean;
  onPress: () => void;
}) {
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
  // Owner role and self both block role editing — owner needs the
  // transferOwnership flow, self-edit is blocked to avoid lockout.
  const canEdit = user.role !== 'owner' && !isSelf;
  return (
    <Pressable
      onPress={canEdit ? onPress : undefined}
      disabled={!canEdit}
      style={({ pressed }) => ({ opacity: pressed && canEdit ? 0.85 : 1 })}
    >
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
            {pill.status === 'default' ? (
              <Pill>{pill.label}</Pill>
            ) : (
              <Pill status={pill.status}>{pill.label}</Pill>
            )}
            {pending ? <Pill status="warn">PENDING</Pill> : null}
          </View>
          {canEdit ? (
            <ChevronRight
              size={16}
              color={c.ink4}
              strokeWidth={1.5}
              style={{ marginLeft: 4 }}
            />
          ) : null}
        </View>
      </Card>
    </Pressable>
  );
}

interface CategoryRow {
  id: string;
  name: string;
}

function RolePickerSheet({
  member,
  orgId,
  onSelect,
  onDismiss,
}: {
  member: UserRow | null;
  orgId: string | null;
  onSelect: (role: AssignableRole) => void;
  onDismiss: () => void;
}) {
  const { c } = useTheme();
  const [categories, setCategories] = React.useState<CategoryRow[]>([]);
  const [grantedIds, setGrantedIds] = React.useState<Set<string>>(new Set());
  const [catsLoading, setCatsLoading] = React.useState(false);

  // Only viewers actually use the per-category grant table; load it lazily
  // when the sheet opens for a viewer member.
  const showCategoryAccess = member?.role === 'viewer';

  React.useEffect(() => {
    if (!member || !orgId || !showCategoryAccess) return;
    let cancelled = false;
    setCatsLoading(true);
    void (async () => {
      const [catsResp, grantsResp] = await Promise.all([
        supabase
          .from('categories')
          .select('id, name')
          .eq('organization_id', orgId)
          // Deleting a category soft-deletes it, so without this the picker
          // lists the tombstone alongside its live replacement and every
          // re-created category reads as a duplicate. Web has always filtered
          // here (dashboard/team/page.tsx); this screen was the one that did not.
          .is('deleted_at', null)
          .order('name', { ascending: true }),
        supabase
          .from('user_category_assignments')
          .select('category_id')
          .eq('organization_id', orgId)
          .eq('user_id', member.user_id),
      ]);
      if (cancelled) return;
      if (catsResp.error) console.warn('[admin/users] categories fetch:', catsResp.error.message);
      if (grantsResp.error) console.warn('[admin/users] grants fetch:', grantsResp.error.message);
      setCategories((catsResp.data ?? []) as CategoryRow[]);
      setGrantedIds(
        new Set(
          ((grantsResp.data ?? []) as Array<{ category_id: string }>).map((g) => g.category_id),
        ),
      );
      setCatsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [member, orgId, showCategoryAccess]);

  async function toggleCategory(categoryId: string) {
    if (!member || !orgId) return;
    const isGranted = grantedIds.has(categoryId);
    const next = new Set(grantedIds);
    if (isGranted) next.delete(categoryId);
    else next.add(categoryId);
    setGrantedIds(next);
    if (isGranted) {
      const { error } = await supabase
        .from('user_category_assignments')
        .delete()
        .eq('organization_id', orgId)
        .eq('user_id', member.user_id)
        .eq('category_id', categoryId);
      if (error) {
        console.warn('[admin/users] revoke category failed:', error.message);
        Alert.alert('Could not revoke access', error.message);
        setGrantedIds(grantedIds);
      }
    } else {
      const { error } = await supabase.from('user_category_assignments').insert({
        organization_id: orgId,
        user_id: member.user_id,
        category_id: categoryId,
      });
      if (error) {
        console.warn('[admin/users] grant category failed:', error.message);
        Alert.alert('Could not grant access', error.message);
        setGrantedIds(grantedIds);
      }
    }
  }

  if (!member) return null;
  const name = member.profile?.full_name ?? member.profile?.email ?? 'this user';
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onDismiss}>
      <Pressable style={pickerStyles.backdrop} onPress={onDismiss} />
      <View style={[pickerStyles.sheet, { backgroundColor: c.paper, borderColor: c.hair }]}>
        <View style={pickerStyles.grabber} />
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 12 }}
        >
          <Eyebrow>CHANGE ROLE</Eyebrow>
          <Display size={22} style={{ marginTop: 8 }}>
            Set role for <Em>{name}.</Em>
          </Display>
          <View style={{ marginTop: 18, gap: 8 }}>
            {ASSIGNABLE_ROLES.map((role) => {
              const selected = member.role === role;
              return (
                <Pressable
                  key={role}
                  onPress={() => onSelect(role)}
                  style={({ pressed }) => [
                    pickerStyles.option,
                    {
                      borderColor: selected ? c.ink : c.hair,
                      backgroundColor: selected ? c.card : 'transparent',
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
                      {role[0].toUpperCase() + role.slice(1)}
                    </Body>
                    <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                      {ROLE_DESCRIPTION[role]}
                    </Mono>
                  </View>
                  {selected ? <Check size={16} color={c.ink} strokeWidth={2} /> : null}
                </Pressable>
              );
            })}
          </View>

          {showCategoryAccess ? (
            <View style={{ marginTop: 22 }}>
              <Eyebrow>VIEWER ACCESS · CATEGORIES</Eyebrow>
              <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 8 }}>
                Pick which categories this viewer can read. Items in
                unchecked categories stay hidden from them.
              </Mono>
              {catsLoading ? (
                <ActivityIndicator color={c.ink} style={{ marginTop: 18 }} />
              ) : categories.length === 0 ? (
                <Mono size={11} color={c.ink4} style={{ marginTop: 12 }}>
                  No categories yet. Create one on the web first.
                </Mono>
              ) : (
                <View style={{ marginTop: 10, gap: 6 }}>
                  {categories.map((cat) => {
                    const granted = grantedIds.has(cat.id);
                    return (
                      <Pressable
                        key={cat.id}
                        onPress={() => toggleCategory(cat.id)}
                        style={({ pressed }) => [
                          pickerStyles.catRow,
                          {
                            borderColor: granted ? c.ink : c.hair,
                            backgroundColor: granted ? c.card : 'transparent',
                            opacity: pressed ? 0.8 : 1,
                          },
                        ]}
                      >
                        <Body size={14} color={c.ink} style={{ flex: 1, fontFamily: FONT.display }}>
                          {cat.name}
                        </Body>
                        {granted ? <Check size={14} color={c.ink} strokeWidth={2} /> : null}
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [pickerStyles.cancel, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Mono size={13} tracking={0.04} color={c.ink3} style={{ fontFamily: FONT.display }}>
              Done
            </Mono>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const pickerStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '85%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 36,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ccc',
    marginBottom: 14,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  catRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 10,
  },
  cancel: {
    marginTop: 16,
    alignSelf: 'center',
    padding: 10,
  },
});
