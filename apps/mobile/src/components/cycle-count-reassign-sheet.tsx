import * as React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface Member {
  userId: string;
  name: string;
  role: string;
}

/**
 * Manager-only force-reassign of an active cycle count to another member, with
 * a required reason. Members are fetched two-step (organization_members ->
 * user_profiles) because organization_members has two FKs into user_profiles
 * (user_id + invited_by), which breaks the PostgREST embed.
 */
export function CycleCountReassignSheet({
  visible,
  cycleCountId,
  orgId,
  currentAssigneeId,
  onClose,
  onReassigned,
}: {
  visible: boolean;
  cycleCountId: string;
  orgId: string | null;
  currentAssigneeId: string | null;
  onClose: () => void;
  onReassigned: () => void;
}) {
  const [members, setMembers] = React.useState<Member[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    setSelected(null);
    setReason('');
    setError(null);
    setSubmitting(false);
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: rows } = await supabase
          .from('organization_members')
          .select('user_id, role, accepted_at')
          .eq('organization_id', orgId)
          .not('accepted_at', 'is', null);
        const ids = (rows ?? [])
          .map((r) => (r as { user_id: string }).user_id)
          .filter(Boolean);
        const byId = new Map<string, { role: string }>();
        for (const r of (rows ?? []) as Array<{ user_id: string; role: string }>) {
          byId.set(r.user_id, { role: r.role });
        }
        let profiles: Array<{ id: string; full_name: string | null; email: string | null }> = [];
        if (ids.length > 0) {
          const { data: profs } = await supabase
            .from('user_profiles')
            .select('id, full_name, email')
            .in('id', ids);
          profiles = (profs ?? []) as typeof profiles;
        }
        const list: Member[] = profiles.map((p) => ({
          userId: p.id,
          name: p.full_name ?? p.email ?? 'Unnamed',
          role: byId.get(p.id)?.role ?? 'staff',
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setMembers(list);
      } catch {
        if (!cancelled) setError('Could not load team members.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, orgId]);

  const canSubmit = !!selected && reason.trim().length > 0 && !submitting;

  async function submit() {
    if (!selected || reason.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/v1/cycle-counts/${cycleCountId}/reassign`, {
        method: 'POST',
        body: { assignedTo: selected, reason: reason.trim() },
      });
      onReassigned();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^API \d+:\s*/, '')
          : 'Could not reassign the count. Try again.',
      );
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: 'rgba(14,15,13,0.45)',
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={{
              backgroundColor: theme.card,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              paddingTop: 12,
              paddingBottom: 36,
              paddingHorizontal: 22,
              maxHeight: '88%',
            }}
          >
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <View
                style={{
                  width: 36,
                  height: 5,
                  borderRadius: 100,
                  backgroundColor: 'rgba(14,15,13,0.18)',
                }}
              />
            </View>

            <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>
              Reassign this count
            </Text>
            <Text style={{ color: theme.textMuted, fontSize: 13, marginTop: 6, lineHeight: 18 }}>
              The current employee will lose access to it. Counts so far are
              kept. Your reason is recorded.
            </Text>

            <Text style={{ color: theme.text, fontSize: 13, fontWeight: '700', marginTop: 18, marginBottom: 8 }}>
              Assign to
            </Text>
            {loading ? (
              <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} />
            ) : (
              <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
                {members
                  .filter((m) => m.userId !== currentAssigneeId)
                  .map((m) => {
                    const sel = selected === m.userId;
                    return (
                      <Pressable
                        key={m.userId}
                        onPress={() => setSelected(m.userId)}
                        style={{
                          minHeight: 48,
                          paddingVertical: 10,
                          paddingHorizontal: 14,
                          marginBottom: 6,
                          borderRadius: radius.md,
                          borderWidth: 1,
                          borderColor: sel ? theme.primary : theme.border,
                          backgroundColor: sel ? theme.primary : 'transparent',
                          justifyContent: 'center',
                        }}
                      >
                        <Text style={{ color: sel ? '#fff' : theme.text, fontSize: 15, fontWeight: sel ? '700' : '500' }}>
                          {m.name}
                        </Text>
                        <Text style={{ color: sel ? 'rgba(255,255,255,0.8)' : theme.textMuted, fontSize: 12, marginTop: 2 }}>
                          {m.role}
                        </Text>
                      </Pressable>
                    );
                  })}
                {members.filter((m) => m.userId !== currentAssigneeId).length === 0 ? (
                  <Text style={{ color: theme.textMuted, fontSize: 13, paddingVertical: 12 }}>
                    No other team members to assign.
                  </Text>
                ) : null}
              </ScrollView>
            )}

            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Reason (required)"
              placeholderTextColor={theme.textMuted}
              multiline
              style={{
                marginTop: 14,
                minHeight: 56,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: radius.md,
                padding: 12,
                color: theme.text,
                fontSize: 14,
                textAlignVertical: 'top',
              }}
            />

            {error ? (
              <Text style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{error}</Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: 18 }}>
              <Pressable
                onPress={onClose}
                disabled={submitting}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: theme.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={!canSubmit}
                style={{
                  flex: 1,
                  minHeight: 48,
                  borderRadius: radius.md,
                  backgroundColor: canSubmit ? theme.primary : theme.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Reassign</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
