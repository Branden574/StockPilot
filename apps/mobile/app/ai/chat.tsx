import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import {
  ChevronLeft,
  Paperclip,
  Send,
  Sparkles,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { API_BASE } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Tool calls fired during this assistant turn. */
  tools?: Array<{ name: string; ok: boolean }>;
  /** True while tokens are still streaming in. */
  streaming?: boolean;
}

/**
 * Mobile-native AI chat surface. Calls the same /api/ai/chat NDJSON
 * stream the web uses, reads token deltas as they arrive, and renders
 * them into a growing assistant bubble. Sessions persist across
 * messages via sessionId. Tool-call notifications surface as inline
 * pills so the user can see when the agent is reading inventory /
 * drafting POs / etc.
 */
export default function AIChat() {
  const router = useRouter();
  const { c } = useTheme();
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [sessionId, setSessionId] = React.useState<string | undefined>(undefined);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const scrollRef = React.useRef<ScrollView>(null);

  const scrollToBottom = React.useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  async function send(textArg?: string) {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;

    setInput('');
    const userTurn: Turn = { role: 'user', content: text };
    const assistantTurn: Turn = { role: 'assistant', content: '', streaming: true, tools: [] };
    setTurns((prev) => [...prev, userTurn, assistantTurn]);
    setBusy(true);
    scrollToBottom();

    // Build the history payload the server expects (excludes the new
    // user message since it's passed separately).
    const history = turns
      .filter((t) => t.content.trim().length > 0)
      .map((t) => ({ role: t.role, content: t.content }));

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API_BASE}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : null),
        },
        body: JSON.stringify({
          message: text,
          sessionId,
          history,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`AI chat ${res.status}: ${errText.slice(0, 200) || res.statusText}`);
      }

      // React Native's fetch polyfill returns `response.body = null`
      // even for streaming responses (Hermes engine doesn't expose
      // ReadableStream from fetch the way browsers do). So we read
      // the full body, then parse the NDJSON in one pass and rebuild
      // the assistant turn. Loses the typewriter feel; gain is the
      // chat actually works. A real streaming UX needs an
      // XHR-with-onprogress shim — that's a follow-up.
      const fullText = await res.text();
      const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);

      let assistantText = '';
      const tools: Array<{ name: string; ok: boolean }> = [];
      let errorMessage: string | null = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as
            | { type: 'text'; delta: string }
            | { type: 'tool'; name: string; ok: boolean }
            | { type: 'session'; id: string }
            | { type: 'done' }
            | { type: 'error'; message?: string };
          if (event.type === 'text') {
            assistantText += event.delta;
          } else if (event.type === 'tool') {
            tools.push({ name: event.name, ok: event.ok });
          } else if (event.type === 'session') {
            setSessionId(event.id);
          } else if (event.type === 'error') {
            errorMessage = event.message ?? 'AI error';
          }
        } catch (parseErr) {
          console.warn('[ai] bad line', line.slice(0, 100), parseErr);
        }
      }

      if (errorMessage) throw new Error(errorMessage);

      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            content: assistantText || '(no response)',
            tools,
          };
        }
        return next;
      });
      scrollToBottom();
    } catch (err) {
      Alert.alert('Chat error', err instanceof Error ? err.message : String(err));
      setTurns((prev) => prev.slice(0, -1)); // remove the empty assistant bubble
    } finally {
      setBusy(false);
      setTurns((prev) =>
        prev.map((t, i) => (i === prev.length - 1 ? { ...t, streaming: false } : t)),
      );
      scrollToBottom();
    }
  }

  /**
   * Attach a photo of a book list / shelf, send it to the
   * extract-isbns-ai endpoint, then auto-send the extracted ISBNs as a
   * chat message. Mirrors the web chat-panel's Paperclip upload — but
   * uses the camera/library (expo-image-picker) since that's the mobile
   * way to capture a printed list. (PDF attach would need
   * expo-document-picker + a native rebuild; photo covers the common case.)
   */
  async function attachPhoto() {
    if (uploading || busy) return;
    const choice = await new Promise<'camera' | 'library' | null>((resolve) => {
      Alert.alert('Attach a book list', 'Snap or pick a photo of a list of books to extract ISBNs.', [
        { text: 'Take photo', onPress: () => resolve('camera') },
        { text: 'Choose from library', onPress: () => resolve('library') },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ]);
    });
    if (!choice) return;

    let result: ImagePicker.ImagePickerResult;
    if (choice === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera access needed', 'Allow camera to photograph a book list.');
        return;
      }
      result = await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photo access needed', 'Allow photo library to attach an image.');
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    }
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    setUploading(true);
    try {
      const ext = (asset.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
      const form = new FormData();
      // React Native FormData file shape: { uri, name, type }.
      form.append('file', {
        uri: asset.uri,
        name: `booklist.${ext}`,
        type: asset.mimeType ?? `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      } as unknown as Blob);

      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API_BASE}/api/books/extract-isbns-ai`, {
        method: 'POST',
        headers: {
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : null),
        },
        body: form,
      });
      const json = (await res.json().catch(() => null)) as
        | { isbns?: string[]; totalFound?: number; message?: string }
        | null;
      if (!res.ok) {
        throw new Error(json?.message ?? `Couldn't read that image (${res.status}). Try a clearer photo.`);
      }
      const isbns = json?.isbns ?? [];
      if (isbns.length === 0) {
        Alert.alert('No ISBNs found', 'Couldn\'t spot any ISBNs in that photo. Try a clearer, closer shot of the list.');
        return;
      }
      // Auto-send the extracted ISBNs so the agent can add the books.
      void send(
        `I uploaded a photo of a book list. Please add these ${isbns.length} book${
          isbns.length === 1 ? '' : 's'
        } by ISBN:\n${isbns.join(', ')}`,
      );
    } catch (err) {
      Alert.alert('Upload failed', err instanceof Error ? err.message : 'Could not process the image.');
    } finally {
      setUploading(false);
    }
  }

  const examples = [
    'What\'s low at our biggest warehouse?',
    'Show me POs that are overdue.',
    'How many Chromebooks did we receive this month?',
  ];

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ChevronLeft} onPress={() => router.back()} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Sparkles size={14} color={c.ink4} strokeWidth={1.4} />
            <Mono size={11} tracking={0.12} upper color={c.ink4}>
              AI · BETA
            </Mono>
          </View>
          <View style={{ width: 38 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          {turns.length === 0 ? (
            <View style={{ alignItems: 'center', paddingTop: 40, gap: 16 }}>
              <View
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 18,
                  borderWidth: 1,
                  borderColor: c.hair,
                  backgroundColor: c.card,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Sparkles size={32} color={c.ink} strokeWidth={1.3} />
              </View>
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Display size={22} style={{ textAlign: 'center' }}>
                  Ask anything about your <Em>inventory.</Em>
                </Display>
                <Body muted style={{ textAlign: 'center', maxWidth: 300 }}>
                  Natural-language queries with real reads + drafts.
                </Body>
              </View>
              <View style={{ gap: 8, width: '100%' }}>
                {examples.map((ex) => (
                  <Pressable
                    key={ex}
                    onPress={() => setInput(ex)}
                    style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
                  >
                    <Card padding={12}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Sparkles size={12} color={c.ink4} strokeWidth={1.5} />
                        <Body size={13} color={c.ink2} style={{ flex: 1, fontFamily: FONT.displayRegular }}>
                          {ex}
                        </Body>
                      </View>
                    </Card>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            turns.map((t, i) => <Bubble key={i} turn={t} />)
          )}
        </ScrollView>

        <View style={[styles.inputBar, { backgroundColor: c.paper, borderTopColor: c.hair }]}>
          <View style={[styles.inputBox, { backgroundColor: c.card, borderColor: c.hair }]}>
            <Pressable
              onPress={attachPhoto}
              disabled={uploading || busy}
              hitSlop={8}
              style={({ pressed }) => [
                styles.attachBtn,
                { opacity: uploading || busy ? 0.4 : pressed ? 0.6 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Attach a book-list photo"
            >
              {uploading ? (
                <ActivityIndicator size="small" color={c.ink3} />
              ) : (
                <Paperclip size={18} color={c.ink3} strokeWidth={1.6} />
              )}
            </Pressable>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Message StockPilot…"
              placeholderTextColor={c.ink4}
              multiline
              style={[styles.input, { color: c.ink }]}
            />
            <Pressable
              onPress={() => void send()}
              disabled={!input.trim() || busy}
              style={({ pressed }) => [
                styles.sendBtn,
                {
                  backgroundColor: input.trim() && !busy ? c.ink : c.paper2,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={c.paper} />
              ) : (
                <Send size={16} color={input.trim() ? c.paper : c.ink4} strokeWidth={1.6} />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  const { c } = useTheme();
  const isUser = turn.role === 'user';
  return (
    <View style={{ alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      {!isUser && turn.tools && turn.tools.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {turn.tools.map((t, i) => (
            <Pill key={i} status={t.ok ? 'ok' : 'warn'}>
              {t.name}
            </Pill>
          ))}
        </View>
      ) : null}
      <View
        style={{
          maxWidth: '88%',
          padding: 12,
          paddingHorizontal: 14,
          borderRadius: 14,
          backgroundColor: isUser ? c.ink : c.card,
          borderWidth: isUser ? 0 : 1,
          borderColor: c.hair,
        }}
      >
        {turn.content.length > 0 ? (
          <Body size={14.5} color={isUser ? c.paper : c.ink}>
            {turn.content}
          </Body>
        ) : turn.streaming ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <ActivityIndicator size="small" color={isUser ? c.paper : c.ink} />
            <Mono size={11} tracking={0.04} color={c.ink4}>
              thinking…
            </Mono>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  inputBar: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    borderTopWidth: 1,
  },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    borderWidth: 1,
    borderRadius: 16,
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: 48,
  },
  attachBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    fontFamily: FONT.displayRegular,
    fontSize: 15,
    maxHeight: 120,
    paddingTop: 8,
    paddingBottom: 8,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
