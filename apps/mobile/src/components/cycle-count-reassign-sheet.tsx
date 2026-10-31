import * as React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Modal } from '@/components/ui/modal';
import { BUTTON_RADIUS, buttonTone } from '@/components/ui/tones';
import { api } from '@/lib/api';
import { buildReassignCandidates, loadOrgMembers, type ReassignCandidate } from '@/lib/org-members';
import { supabase } from '@/lib/supabase';
import { FONT, RADIUS, SHADOW, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

type Member = ReassignCandidate;

/** The iOS minimum tap target, in points. */
const MIN_TAP = 44;

/**
 * Manager-only force-reassign of an active cycle count to another member, with
 * a required reason. Members are fetched two-step (organization_members ->
 * user_profiles) because organization_members has two FKs into user_profiles
 * (user_id + invited_by), which breaks the PostgREST embed.
 *
 * Drawn on the device's palette (redesign package P5.9a moved it off the
 * light-only legacy `theme` alias), as the release sheet beside it: the
 * members as 44pt choices (the chosen one filled with ink, and said to be
 * chosen), the reason box recessed, Cancel the outline button and Reassign
 * the ink button, both wrapping their words. VoiceOver: a modal sheet with a
 * Close backdrop and the escape scrub. Every word, rule (a member and a
 * reason) and request is unchanged.
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
  const { c, mode } = useTheme();
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
  const cancelTone = buttonTone('outline', c);
  const reassignTone = buttonTone('primary', c);
  const retryTone = buttonTone('outline', c);

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
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={onClose}
          onAccessibilityTap={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View style={[styles.sheet, { backgroundColor: c.card }, SHADOW.sheet]}>
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: c.hair2 }]} />
          </View>

          <Text accessibilityRole="header" style={[styles.title, { color: c.ink }]}>
            Reassign this count
          </Text>
          <Text style={[styles.body, { color: c.ink3 }]}>
            The current employee will lose access to it. Counts so far are kept. Your reason is
            recorded.
          </Text>

          <Text style={[styles.label, { color: c.ink }]}>Assign to</Text>
          {loading ? (
            <ActivityIndicator color={c.ink} style={{ marginVertical: 16 }} />
          ) : membersFailed ? (
            <View style={{ paddingVertical: 8, gap: 10 }}>
              <Text accessibilityRole="alert" style={[styles.failed, { color: c.critText }]}>
                Could not load team members.
              </Text>
              <Pressable
                onPress={retryMembers}
                disabled={loading}
                accessibilityRole="button"
                accessibilityState={{ disabled: loading }}
                style={({ pressed }) => [
                  styles.retry,
                  {
                    backgroundColor: retryTone.bg,
                    borderColor: retryTone.border,
                    opacity: loading ? 0.5 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[styles.retryLabel, { color: retryTone.fg }]}>Try again</Text>
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
                      // One member of the list: VoiceOver says which is chosen.
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel }}
                      style={({ pressed }) => [
                        styles.member,
                        {
                          borderColor: sel ? c.ink : c.hair2,
                          backgroundColor: sel ? c.ink : c.card,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.memberName,
                          {
                            color: sel ? c.paper : c.ink,
                            fontFamily: sel ? FONT.displaySemi : FONT.display,
                          },
                        ]}
                      >
                        {m.name}
                      </Text>
                      <Text style={[styles.memberRole, { color: sel ? c.paper : c.ink3 }]}>
                        {m.role}
                      </Text>
                    </Pressable>
                  );
                })}
              {members.filter((m) => m.userId !== currentAssigneeId).length === 0 ? (
                <Text style={[styles.none, { color: c.ink3 }]}>
                  No other team members to assign.
                </Text>
              ) : null}
            </ScrollView>
          )}

          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason (required)"
            placeholderTextColor={c.ink3}
            // Named once it holds words (an empty box reads its placeholder,
            // and a name as well would say it twice).
            accessibilityLabel={reason.length > 0 ? 'Reason (required)' : undefined}
            multiline
            style={[styles.reason, { borderColor: c.hair2, backgroundColor: c.sunk, color: c.ink }]}
          />

          {error ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: c.critText }]}>
              {error}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityState={{ disabled: submitting }}
              style={({ pressed }) => [
                styles.action,
                {
                  backgroundColor: cancelTone.bg,
                  borderColor: cancelTone.border,
                  opacity: submitting ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.actionLabel, { color: cancelTone.fg }]}>Cancel</Text>
            </Pressable>
            {/* Reassign commits the move: the ink button. Its words stay
                beside the spinner while the request is under way. */}
            <Pressable
              onPress={submit}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit, busy: submitting }}
              style={({ pressed }) => [
                styles.action,
                {
                  backgroundColor: reassignTone.bg,
                  borderColor: reassignTone.border,
                  opacity: !canSubmit ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {submitting ? <ActivityIndicator color={reassignTone.fg} /> : null}
              <Text style={[styles.actionLabel, { color: reassignTone.fg }]}>Reassign</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingBottom: 36,
    paddingHorizontal: 22,
    maxHeight: '88%',
  },
  grabberRow: { alignItems: 'center', marginBottom: 16 },
  grabber: { width: 36, height: 5, borderRadius: 100 },
  title: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 20 },
  body: { fontFamily: FONT.displayRegular, fontSize: 13, marginTop: 6, lineHeight: 18 },
  label: {
    fontFamily: FONT.displaySemi,
    fontWeight: '600',
    fontSize: 13,
    marginTop: 18,
    marginBottom: 8,
  },
  failed: { fontFamily: FONT.displayRegular, fontSize: 13 },
  // Try again is a 44pt target (it was 40pt).
  retry: {
    alignSelf: 'flex-start',
    minHeight: MIN_TAP,
    paddingHorizontal: 16,
    borderRadius: BUTTON_RADIUS.sm,
    borderWidth: 1,
    justifyContent: 'center',
  },
  retryLabel: { fontFamily: FONT.display, fontWeight: '500', fontSize: 14 },
  member: {
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 6,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    justifyContent: 'center',
  },
  memberName: { fontSize: 15 },
  memberRole: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 2 },
  none: { fontFamily: FONT.displayRegular, fontSize: 13, paddingVertical: 12 },
  reason: {
    marginTop: 14,
    minHeight: 56,
    borderWidth: 1,
    borderRadius: RADIUS.card,
    padding: 12,
    fontFamily: FONT.displayRegular,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  error: { fontFamily: FONT.displayRegular, fontSize: 13, marginTop: 12 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: 18 },
  // The shared Button's md recipe (52pt, radius 14), drawn here so a long
  // label wraps inside its half of the row instead of being cut short.
  action: {
    flex: 1,
    minHeight: 52,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: BUTTON_RADIUS.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionLabel: {
    fontFamily: FONT.display,
    fontWeight: '500',
    fontSize: 15,
    textAlign: 'center',
    flexShrink: 1,
  },
});
