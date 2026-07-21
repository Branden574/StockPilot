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
import { radius, space, theme } from '@/lib/theme';

// Owner-approved release-reason categories. "Other" requires free text.
const REASON_CATEGORIES = [
  'Shift ending',
  'Unable to locate inventory',
  'Equipment unavailable',
  'Scanner or device problem',
  'Safety issue',
  'Wrong assignment',
  'Workload conflict',
  'Need manager assistance',
  'Other',
] as const;

type Category = (typeof REASON_CATEGORIES)[number];

export function CycleCountReleaseSheet({
  visible,
  cycleCountId,
  onClose,
  onReleased,
}: {
  visible: boolean;
  cycleCountId: string;
  onClose: () => void;
  onReleased: () => void;
}) {
  const [category, setCategory] = React.useState<Category | null>(null);
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset when the sheet is (re)opened.
  React.useEffect(() => {
    if (visible) {
      setCategory(null);
      setNotes('');
      setError(null);
      setSubmitting(false);
    }
  }, [visible]);

  const needsNotes = category === 'Other';
  const canSubmit =
    !!category && (!needsNotes || notes.trim().length > 0) && !submitting;

  async function submit() {
    if (!category) return;
    // Compose a non-blank reason for the server (release route requires min 1).
    const reason =
      category === 'Other'
        ? notes.trim()
        : notes.trim()
          ? `${category} — ${notes.trim()}`
          : category;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/v1/cycle-counts/${cycleCountId}/release`, {
        method: 'POST',
        body: { reason },
      });
      onReleased();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^API \d+:\s*/, '')
          : 'Could not release the count. Try again.',
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
              Release this cycle count?
            </Text>
            <Text style={{ color: theme.textMuted, fontSize: 13, marginTop: 6, lineHeight: 18 }}>
              You will no longer be able to edit or submit this count unless a
              manager assigns it back to you. Your counts so far are kept. Your
              reason is recorded.
            </Text>

            <Text
              style={{
                color: theme.text,
                fontSize: 13,
                fontWeight: '700',
                marginTop: 18,
                marginBottom: 8,
              }}
            >
              Reason
            </Text>
            <ScrollView
              style={{ maxHeight: 220 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                {REASON_CATEGORIES.map((cat) => {
                  const selected = category === cat;
                  return (
                    <Pressable
                      key={cat}
                      onPress={() => setCategory(cat)}
                      style={{
                        minHeight: 40,
                        paddingVertical: 9,
                        paddingHorizontal: 14,
                        borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: selected ? theme.primary : theme.border,
                        backgroundColor: selected ? theme.primary : 'transparent',
                        justifyContent: 'center',
                      }}
                    >
                      <Text
                        style={{
                          color: selected ? '#fff' : theme.text,
                          fontSize: 13,
                          fontWeight: selected ? '700' : '500',
                        }}
                      >
                        {cat}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <TextInput
                value={notes}
                onChangeText={setNotes}
                placeholder={
                  needsNotes ? 'Add a note (required)' : 'Add a note (optional)'
                }
                placeholderTextColor={theme.textMuted}
                multiline
                style={{
                  marginTop: 14,
                  minHeight: 64,
                  borderWidth: 1,
                  borderColor: theme.border,
                  borderRadius: radius.md,
                  padding: 12,
                  color: theme.text,
                  fontSize: 14,
                  textAlignVertical: 'top',
                }}
              />
            </ScrollView>

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
                  backgroundColor: canSubmit ? '#dc2626' : 'rgba(220,38,38,0.4)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                    Release count
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
