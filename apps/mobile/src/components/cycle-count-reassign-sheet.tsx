import * as React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api } from '@/lib/api';
import { buildReassignCandidates, loadOrgMembers, type ReassignCandidate } from '@/lib/org-members';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

type Member = ReassignCandidate;

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
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* key: remount the content per open/close transition so every session
          starts from a blank selection/reason — reset-by-remount instead of a
          reset-on-open effect. */}
      <ReassignSheetContent
        key={String(visible)}
        visible={visible}
        cycleCountId={cycleCountId}
        orgId={orgId}
        currentAssigneeId={currentAssigneeId}
        onClose={onClose}
        onReassigned={onReassigned}
      />
    </Modal>
  );
}

function ReassignSheetContent({
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
  // True exactly when the mount effect below will fetch — the remount above
  // makes the initial value the spinner switch, replacing a sync setLoading.
  const [loading, setLoading] = React.useState(visible && !!orgId);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The member list did not load. Kept apart from `error` (the submit's own
  // refusal): while it is set the list is hidden and a Try again is shown,
  // never "No other team members to assign.".
  const [membersFailed, setMembersFailed] = React.useState(false);
  const [reloadNonce, setReloadNonce] = React.useState(0);

  React.useEffect(() => {
    if (!visible || !orgId) return;
    let cancelled = false;
    (async () => {
      // loadOrgMembers THROWS on a failed read. The two reads made here used
      // to return their errors (supabase-js does not throw), so this catch
      // never fired and a failed profile read showed an empty list.
      try {
        const { members: rows, profiles } = await loadOrgMembers<{
          id: string;
          full_name: string | null;
          email: string | null;
        }>(supabase, orgId, { acceptedOnly: true, profileColumns: 'id, full_name, email' });
        if (!cancelled) {
          setMembers(buildReassignCandidates(rows, profiles));
          setMembersFailed(false);
        }
      } catch (e) {
        console.warn('[reassign] members load failed:', e instanceof Error ? e.message : e);
        if (!cancelled) {
          setMembers([]);
          setMembersFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, orgId, reloadNonce]);

  function retryMembers() {
    if (loading) return;
    setMembersFailed(false);
    setLoading(true);
    setReloadNonce((n) => n + 1);
  }

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
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
        {/*
         * Backdrop is a SIBLING behind the sheet, not its parent. A Pressable
         * ancestor claims the touch on press-down and beats the ScrollView's
         * pan recogniser, so the assignee list would not scroll until
         * something else took the responder first. Do not re-nest this card
         * inside the scrim — taps outside still close because the scrim fills
         * the screen behind it. See add-order-items-sheet.tsx.
         */}
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            onPress={onClose}
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(14,15,13,0.45)' }]}
          />
          <View
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
            ) : membersFailed ? (
              <View style={{ paddingVertical: 8, gap: 10 }}>
                <Text style={{ color: '#dc2626', fontSize: 13 }}>Could not load team members.</Text>
                <Pressable
                  onPress={retryMembers}
                  disabled={loading}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: loading }}
                  style={{
                    alignSelf: 'flex-start',
                    minHeight: 40,
                    paddingHorizontal: 16,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: theme.border,
                    justifyContent: 'center',
                    opacity: loading ? 0.5 : 1,
                  }}
                >
                  <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>Try again</Text>
                </Pressable>
              </View>
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
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
