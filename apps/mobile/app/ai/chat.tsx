import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { ChevronLeft, Paperclip, Plus, Send, Sparkles } from 'lucide-react-native';
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
import { GlassBackdrop } from '@/components/ui/glass/glass-backdrop';
import { INPUT_LINE, glassCardStyle, glassRowSub } from '@/components/ui/glass/primitive-styles';
import { glassHeroWell, glassStackRow } from '@/components/ui/glass/screens/admin';
import { GLASS_LIST } from '@/components/ui/glass/screens/list';
import { SceneBackground } from '@/components/ui/glass/scene-background';
import { useGlass } from '@/components/ui/glass/use-glass';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Mono } from '@/components/ui/text';
import { notifyUnauthorized } from '@/lib/account-eviction';
import {
  buildChatRequestBody,
  ChatFailure,
  chatRefusalSentence,
  parseChatStream,
} from '@/lib/ai-chat';
import { API_BASE, orgHeader } from '@/lib/api';
import { CONNECTION_FAILURE_COPY } from '@/lib/connection-copy';
import { resizeForUpload } from '@/lib/image-resize';
import { postMultipart } from '@/lib/multipart-upload';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Tool calls fired during this assistant turn. */
  tools?: { name: string; ok: boolean }[];
  /** True while tokens are still streaming in. */
  streaming?: boolean;
}

/**
 * Mobile-native AI chat surface. Calls the same /api/ai/chat NDJSON
 * stream the web uses, reads the whole answer, and renders it into the
 * assistant bubble. Tool-call notifications surface as inline pills so
 * the user can see when the agent is reading inventory / drafting POs /
 * etc.
 *
 * One chat is one session, as on the web: the screen keeps the session id
 * the route's answer names (sessionRef) and, while it holds one, sends no
 * history, so the route answers from the chat's own stored turns. The
 * request and the reading of the answer are lib/ai-chat.ts (docket B75:
 * this screen used to resend its whole transcript and never held a
 * session, so about the 22nd message of a chat was refused). New chat (+)
 * starts another; the chat it leaves stays in the AI Assistant on the web.
 */
export default function AIChat() {
  const router = useRouter();
  const { c } = useTheme();
  // Liquid Glass (inferred: DS-Components fields and cards as a native
  // chat): the scene, the glass nav, the prompts as one grouped list, the
  // assistant's answers on the grouped surface, the person's own in the
  // accent, and the composer as a glass field on the floating glass.
  const lg = useGlass();
  const [turns, setTurns] = React.useState<Turn[]>([]);
  // The session the route's answer named. A ref, not state: send() reads it
  // when it runs, so the photo flow's send() (from the render attachPhoto
  // started in) sends this chat's current id too.
  const sessionRef = React.useRef<string | null>(null);
  // Which chat is on screen: New chat counts it up. send() keeps an answer,
  // or says why a message failed, only in the chat the message was sent in.
  const chatRef = React.useRef(0);
  // Messages sent and not answered yet. Two can be on their way at once:
  // Send stays enabled while a photo uploads, and the photo's message goes
  // when the upload ends. So busy holds until the last answer is in. It
  // never refuses a send (that would drop the photo's message).
  const pendingRef = React.useRef(0);
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
    const chat = chatRef.current;
    pendingRef.current += 1;
    setBusy(true);
    scrollToBottom();

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API_BASE}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : null),
          ...(await orgHeader(session?.user.id ?? null)),
        },
        body: JSON.stringify(buildChatRequestBody(text, sessionRef.current, turns)),
      });

      if (!res.ok) {
        // The route's own sentence, or the status's: never the raw body. A
        // 401 asks for the account probe, as api() does (the bus ignores
        // every other status).
        const raw = await res.text().catch(() => '');
        notifyUnauthorized({ status: res.status });
        throw new ChatFailure(chatRefusalSentence(res.status, raw));
      }

      // React Native's fetch polyfill returns `response.body = null`
      // even for streaming responses (Hermes engine doesn't expose
      // ReadableStream from fetch the way browsers do). So we read
      // the full body, then parse the NDJSON in one pass and rebuild
      // the assistant turn. Loses the typewriter feel; gain is the
      // chat actually works. A real streaming UX needs an
      // XHR-with-onprogress shim — that's a follow-up.
      const answer = parseChatStream(await res.text());
      // New chat was taken while this answer was on its way: the answer is
      // the old chat's (the route stored it there, on the web). Its session
      // id, words and error stay out of the new chat.
      if (chatRef.current !== chat) return;
      // Kept before an error is shown: the route names the session after an
      // error event too, and the next message belongs to this chat.
      if (answer.sessionId) sessionRef.current = answer.sessionId;
      if (answer.errorMessage) throw new ChatFailure(answer.errorMessage);

      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            content: answer.text || '(no response)',
            tools: answer.tools,
          };
        }
        return next;
      });
      scrollToBottom();
    } catch (err) {
      // Anything without a sentence of its own got no answer from the server
      // (offline, a dropped connection): the network layer's text is never
      // shown (connection-copy.ts). Said only in the chat it was sent in.
      if (chatRef.current !== chat) return;
      Alert.alert('Chat error', err instanceof ChatFailure ? err.message : CONNECTION_FAILURE_COPY);
      setTurns((prev) => prev.slice(0, -1)); // remove the empty assistant bubble
    } finally {
      pendingRef.current -= 1;
      setBusy(pendingRef.current > 0);
      // After New chat this finds the new chat empty: busy held until now,
      // so nothing has been sent there yet.
      setTurns((prev) =>
        prev.map((t, i) => (i === prev.length - 1 ? { ...t, streaming: false } : t)),
      );
      scrollToBottom();
    }
  }

  /**
   * New chat: empties the screen and forgets the session, so the next
   * message starts a chat of its own. Nothing is deleted: the chat it leaves
   * stays in the AI Assistant on the web. Offered only while no answer is on
   * its way (busy holds until the last one is in). An answer that still
   * lands after it, from a tap taken before the chip was hidden, is the old
   * chat's: send() leaves it out of the new one (chatRef).
   */
  function startNewChat() {
    chatRef.current += 1;
    sessionRef.current = null;
    setTurns([]);
    setInput('');
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
      // Resize before upload — full-res library/camera picks are multi-MB; the
      // booklist/ISBN Vision extract is just as accurate at <=1600px and the
      // upload is far faster on cellular.
      const { uri: resizedUri, ext } = await resizeForUpload(asset.uri, {
        maxEdge: 1600,
        quality: 0.8,
      });
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await postMultipart(`${API_BASE}/api/books/extract-isbns-ai`, {
        files: [
          {
            field: 'file',
            uri: resizedUri,
            // The route sniffs the kind from BOTH name and type, so the
            // extension and the MIME have to agree.
            fileName: `booklist.${ext}`,
            contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
          },
        ],
        headers: {
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : null),
          ...(await orgHeader(session?.user.id ?? null)),
        },
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
    <View style={[styles.root, { backgroundColor: lg ? 'transparent' : c.paper }]}>
      {lg ? <SceneBackground /> : null}
      <SafeAreaView edges={['top']} style={{ backgroundColor: lg ? 'transparent' : c.paper }}>
        <View style={lg ? GLASS_LIST.nav : styles.topbar}>
          <IconChip icon={ChevronLeft} onPress={() => router.back()} accessibilityLabel="Back" minTap />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Sparkles
              size={lg ? 16 : 14}
              color={lg ? lg.g.accentText : c.ink3}
              strokeWidth={lg ? 1.8 : 1.4}
            />
            <Mono
              size={11}
              tracking={0.12}
              upper
              color={c.ink3}
              style={lg ? [lg.font.displaySemi, GLASS_CHAT_TITLE, { color: c.ink }] : undefined}
              accessibilityRole={lg ? 'header' : undefined}
            >
              {lg ? 'AI · Beta' : 'AI · BETA'}
            </Mono>
          </View>
          {/* New chat once the chat has started, hidden while an answer or a
              photo is pending. Otherwise a spacer: the chip's 44pt frame and
              the spacer both balance the back chip's, so the label stays
              centred. */}
          {turns.length > 0 && !busy && !uploading ? (
            <IconChip icon={Plus} onPress={startNewChat} accessibilityLabel="New chat" minTap />
          ) : (
            <View style={{ width: 44 }} />
          )}
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
                  ...(lg ? glassHeroWell(lg) : null),
                }}
              >
                <Sparkles
                  size={32}
                  color={lg ? lg.g.accentText : c.ink}
                  strokeWidth={lg ? 1.8 : 1.3}
                />
              </View>
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Display size={22} style={{ textAlign: 'center' }}>
                  Ask anything about your <Em>inventory.</Em>
                </Display>
                <Body muted style={{ textAlign: 'center', maxWidth: 300 }}>
                  Natural-language queries with real reads + drafts.
                </Body>
              </View>
              <View style={{ gap: lg ? 0 : 8, width: '100%' }}>
                {examples.map((ex) => (
                  <Pressable
                    key={ex}
                    onPress={() => setInput(ex)}
                    accessibilityRole="button"
                    style={({ pressed }) =>
                      lg
                        ? { transform: [{ scale: pressed ? 0.98 : 1 }] }
                        : { opacity: pressed ? 0.85 : 1 }
                    }
                  >
                    <Card
                      padding={12}
                      style={
                        lg
                          ? glassStackRow(lg, ex === examples[0], ex === examples[examples.length - 1])
                          : undefined
                      }
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Sparkles
                          size={lg ? 16 : 12}
                          color={lg ? lg.g.accentText : c.ink4}
                          strokeWidth={lg ? 1.8 : 1.5}
                        />
                        <Body
                          size={lg ? 16 : 13}
                          color={lg ? c.ink : c.ink2}
                          style={{ flex: 1, fontFamily: FONT.displayRegular }}
                        >
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

        <View
          style={[
            styles.inputBar,
            { backgroundColor: c.paper, borderTopColor: c.hair },
            lg && GLASS_CHAT_BAR,
          ]}
        >
          {lg ? <GlassBackdrop variant="floating" radius={0} /> : null}
          {/* The composer is a control: the stronger border, as the shared Field. */}
          <View
            style={[
              styles.inputBox,
              { backgroundColor: c.card, borderColor: c.hair2 },
              lg && {
                backgroundColor: lg.g.fieldFill,
                borderColor: INPUT_LINE[lg.mode],
                borderRadius: 24,
              },
            ]}
          >
            <Pressable
              onPress={attachPhoto}
              disabled={uploading || busy}
              style={({ pressed }) => [
                styles.tapFrame,
                { opacity: uploading || busy ? 0.4 : pressed ? 0.6 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Attach a book-list photo"
              accessibilityState={{ disabled: uploading || busy, busy: uploading }}
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
              placeholderTextColor={c.ink3}
              accessibilityLabel="Message StockPilot"
              multiline
              style={[styles.input, { color: c.ink }, lg && lg.font.displayRegular]}
            />
            {/* A 44pt frame around the same 36pt circle; it was a nameless
                icon with no role, so VoiceOver could not find Send. */}
            <Pressable
              onPress={() => void send()}
              disabled={!input.trim() || busy}
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !input.trim() || busy, busy }}
              style={({ pressed }) => [styles.tapFrame, { opacity: pressed ? 0.85 : 1 }]}
            >
              <View
                style={[
                  styles.sendBtn,
                  {
                    // Recessed (sunk) while there is nothing to send: paper2
                    // is the card colour itself in dark, so the circle
                    // vanished on the composer there.
                    backgroundColor: input.trim() && !busy ? c.ink : c.sunk,
                  },
                  lg && { backgroundColor: input.trim() && !busy ? lg.g.accent : lg.ios.fill },
                ]}
              >
                {/* While it sends, the box is cleared and the circle is the
                    recessed one: the spinner is ink so it shows there (paper
                    on paper2 drew it invisible in both modes). */}
                {busy ? (
                  <ActivityIndicator size="small" color={c.ink} />
                ) : (
                  <Send
                    size={16}
                    color={
                      lg ? (input.trim() ? lg.g.onAccent : c.ink3) : input.trim() ? c.paper : c.ink4
                    }
                    strokeWidth={lg ? 1.8 : 1.6}
                  />
                )}
              </View>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  const { c } = useTheme();
  const lg = useGlass();
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
          ...(lg
            ? isUser
              ? { backgroundColor: lg.g.accent, borderRadius: 20 }
              : { ...glassCardStyle(lg), borderRadius: 20 }
            : null),
        }}
      >
        {turn.content.length > 0 ? (
          <Body
            size={lg ? 16 : 14.5}
            color={lg ? (isUser ? lg.g.onAccent : c.ink) : isUser ? c.paper : c.ink}
          >
            {turn.content}
          </Body>
        ) : turn.streaming ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <ActivityIndicator size="small" color={isUser ? c.paper : c.ink} />
            <Mono size={11} tracking={0.04} color={c.ink3} style={lg ? glassRowSub(lg) : undefined}>
              thinking…
            </Mono>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Liquid Glass: the nav title's words (.ios-nav .ttl [701], 17/600). */
const GLASS_CHAT_TITLE = { fontSize: 17, letterSpacing: -0.4, textTransform: 'none' } as const;

/** Liquid Glass: the composer's bar on the floating glass, no rule over it. */
const GLASS_CHAT_BAR = { backgroundColor: 'transparent', borderTopWidth: 0 } as const;

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
  // chip on every side, so the bar takes 3pt off its padding (12, 8) and the
  // spacer opposite is 44: the chip and the centred label sit where they did.
  // (The conversation under the bar starts 3pt lower: it has no top padding
  // to take the 3pt from.)
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
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
  // The two buttons' 44pt frames are 4pt wider than their 36pt circles on
  // every side, so the box takes 4pt off its padding (6 -> 2) and the gap
  // between a frame and the text box 4pt (8 -> 4): the circles, the text and
  // the box sit where they did.
  inputBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    borderWidth: 1,
    borderRadius: 16,
    paddingLeft: 2,
    paddingRight: 2,
    paddingVertical: 2,
    minHeight: 48,
  },
  // A real 44pt frame, not hitSlop, so the target VoiceOver outlines is the
  // one a finger can hit (the IconChip minTap rule).
  tapFrame: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // marginVertical gives back the 4pt the box's padding gave up, so a long
  // message keeps its old space above and below.
  input: {
    flex: 1,
    fontFamily: FONT.displayRegular,
    fontSize: 15,
    maxHeight: 120,
    paddingTop: 8,
    paddingBottom: 8,
    marginVertical: 4,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
