import { useNetworkState } from 'expo-network';
import { type Href, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { ArrowLeft, Circle, CircleDot } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  CHECKLIST_LIMITS,
  checklistDraftsEqual,
  checklistDraftsFrom,
  checklistResultsFromDrafts,
  describeChecklistIncomplete,
  describeChecklistInvalid,
  isRunCompletable,
  normalizeChecklistResults,
  normalizeRunNote,
  randomRequestUuid,
  RECEIVING_CHECKLIST_COPY,
  receivingRunAboutLines,
  receivingRunStatusLines,
  validateRunForCompletion,
  type ChecklistAnswerDraft,
  type ChecklistAnswerDrafts,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, FieldLabel } from '@/components/ui/text';
import { isOfflineState } from '@/lib/exceptions-api';
import {
  checklistErrorReason,
  checklistIncompleteKeys,
  checklistInvalidKey,
  describeChecklistError,
  getReceivingRun,
  saveReceivingRun,
  type PhoneReceivingRun,
  type PhoneSavedRun,
} from '@/lib/receiving-checks-api';
import { CHECK_ANSWER_OPTIONS } from '@/lib/receiving-checks-view';
import { capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const C = RECEIVING_CHECKLIST_COPY;

/** The owner's minimum for a new control. */
const MIN_TAP = 44;

/**
 * ONE RECEIPT'S RECEIVING CHECKLIST (F4-1): the native twin of
 * /dashboard/purchase-orders/receiving-checks/<id>, reached from the "Posted"
 * alert, a Receipt history card, or a web link (web-path-rewrite.ts; the
 * cold-start shim is app/dashboard/purchase-orders/receiving-checks/[id].tsx).
 *
 * Reads GET /api/v1/receiving-checks/<id> and saves through POST on the same
 * path: the service the web page uses, so the same rules and the same words.
 * It shows "About this delivery", the steps (Pass, Fail or Not applicable as
 * radios with words, a number, a short answer, notes), Save progress and
 * Complete checklist (with a confirmation). A completed run, or one this
 * person may not record, is read only.
 *
 * Online only: offline, the buttons are disabled with the reason and the
 * answers stay on screen. Leaving with unsaved answers asks first (the Back
 * chip, the edge swipe and a replace alike, through usePreventRemove).
 */
export default function ReceivingCheckScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const offline = isOfflineState(useNetworkState());
  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'failed'; message: string }
    | { kind: 'ready'; view: PhoneReceivingRun }
  >({ kind: 'loading' });
  const [reloading, setReloading] = React.useState(false);
  // Only the newest read lands.
  const seqRef = React.useRef(0);

  const load = React.useCallback(async (): Promise<string | null> => {
    if (!id) return null;
    const seq = ++seqRef.current;
    try {
      const view = await getReceivingRun(id);
      if (seq === seqRef.current) setState({ kind: 'ready', view });
      return null;
    } catch (e) {
      const message = describeChecklistError(e, C.loadFailed);
      // A run already on screen stays; the caller says what failed.
      if (seq === seqRef.current) {
        setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'failed', message }));
      }
      return message;
    }
  }, [id]);

  // Read when the screen opens online (and again when the connection comes
  // back to a screen that has nothing yet). Every set is post-await.
  const haveView = state.kind === 'ready';
  React.useEffect(() => {
    if (offline || haveView) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set in load() is post-await; the effect synchronizes with the server
    void load();
  }, [load, offline, haveView]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  }

  /** Reload (after "someone else saved", or Try again): what the server holds now. */
  async function reload() {
    if (reloading) return;
    setReloading(true);
    try {
      const failed = await load();
      if (failed) Alert.alert(C.loadFailed, failed);
    } finally {
      setReloading(false);
    }
  }

  /** A save landed: show what the server holds without waiting for a read. */
  function applySaved(saved: PhoneSavedRun) {
    setState((prev) =>
      prev.kind === 'ready'
        ? {
            kind: 'ready',
            view: {
              ...prev.view,
              run: {
                ...prev.view.run,
                status: saved.status,
                revision: saved.revision,
                results: saved.results,
                note: saved.note,
                completedAt: saved.completedAt,
              },
            },
          }
        : prev,
    );
    // Then the names and the rest, in the background.
    void load();
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
      <View style={styles.topbar}>
        <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
      </View>
      {state.kind === 'ready' ? (
        <RunForm
          key={`${state.view.run.id}:${state.view.run.revision}:${state.view.run.status}`}
          view={state.view}
          offline={offline}
          reloading={reloading}
          onSaved={applySaved}
          onReload={() => void reload()}
        />
      ) : offline ? (
        <View style={styles.pad}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {C.offline}
            </Body>
          </Card>
        </View>
      ) : state.kind === 'failed' ? (
        <View style={styles.pad}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {state.message}
            </Body>
            <Button
              size="sm"
              variant="outline"
              disabled={reloading}
              onPress={() => void reload()}
              style={{ alignSelf: 'flex-start', marginTop: 12, minHeight: MIN_TAP }}
            >
              {C.tryAgain}
            </Button>
          </Card>
        </View>
      ) : (
        <ActivityIndicator color={c.ink3} style={{ marginTop: 40 }} />
      )}
    </SafeAreaView>
  );
}

type FormError =
  | { kind: 'changed'; message: string }
  | { kind: 'completed'; message: string }
  | { kind: 'incomplete'; message: string; missing: string[]; failedWithoutNote: string[] }
  | { kind: 'invalid'; message: string; key: string | null }
  | { kind: 'other'; message: string };

function RunForm({
  view,
  offline,
  reloading,
  onSaved,
  onReload,
}: {
  view: PhoneReceivingRun;
  offline: boolean;
  reloading: boolean;
  onSaved: (saved: PhoneSavedRun) => void;
  onReload: () => void;
}) {
  const { c } = useTheme();
  const navigation = useNavigation();
  const steps = view.version.steps;
  const tz = view.timeZone;
  const readOnly = view.run.status === 'completed' || !view.canRecord;

  const initial = React.useMemo(
    () => checklistDraftsFrom(steps, view.run.results),
    [steps, view.run.results],
  );
  const [drafts, setDrafts] = React.useState<ChecklistAnswerDrafts>(initial);
  const [note, setNote] = React.useState(view.run.note ?? '');
  const [saved, setSaved] = React.useState({ drafts: initial, note: view.run.note ?? '' });
  const [busy, setBusy] = React.useState<'save' | 'complete' | null>(null);
  const [error, setError] = React.useState<FormError | null>(null);
  // One save id per payload: resending the same answers after a lost reply is
  // answered as that save, never a second one; changed answers are a new save.
  const pending = React.useRef<{ payload: string; saveId: string } | null>(null);

  const dirty = !checklistDraftsEqual(drafts, saved.drafts) || note !== saved.note;

  // Leaving with unsaved answers asks first: the Back chip, the edge swipe
  // and a replace all remove the screen, and this catches each of them.
  usePreventRemove(dirty && !readOnly, ({ data }) => {
    Alert.alert(C.leaveTitle, C.leaveRunBody, [
      { text: C.stay, style: 'cancel' },
      { text: C.leave, style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const setDraft = (key: string, patch: Partial<ChecklistAnswerDraft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...(d[key] ?? { value: '', note: '' }), ...patch } }));

  async function send(complete: boolean) {
    if (busy || offline || readOnly) return;
    setError(null);
    const results = checklistResultsFromDrafts(steps, drafts);
    // Said before anything is sent, in the same words the server would use.
    const local = normalizeChecklistResults(steps, results);
    if (!local.ok) {
      setError({
        kind: 'invalid',
        message: describeChecklistInvalid(local.detail, steps),
        key: local.detail.key ?? null,
      });
      return;
    }
    const runNote = normalizeRunNote(note);
    if (!runNote.ok) {
      setError({
        kind: 'invalid',
        message: describeChecklistInvalid(runNote.detail, steps),
        key: null,
      });
      return;
    }
    if (complete) {
      const incomplete = validateRunForCompletion(steps, local.value);
      if (!isRunCompletable(incomplete)) {
        setError({
          kind: 'incomplete',
          message: describeChecklistIncomplete(incomplete, steps),
          missing: incomplete.missing,
          failedWithoutNote: incomplete.failedWithoutNote,
        });
        return;
      }
    }
    const payload = JSON.stringify({ results, note, complete, revision: view.run.revision });
    if (!pending.current || pending.current.payload !== payload) {
      pending.current = { payload, saveId: randomRequestUuid() };
    }
    setBusy(complete ? 'complete' : 'save');
    try {
      const res = await saveReceivingRun(view.run.id, {
        results,
        note: note.trim() === '' ? null : note,
        expectedRevision: view.run.revision,
        saveId: pending.current.saveId,
        complete,
      });
      pending.current = null;
      setSaved({ drafts, note });
      setBusy(null);
      onSaved(res);
    } catch (e) {
      setBusy(null);
      const reason = checklistErrorReason(e);
      const message = describeChecklistError(e, C.didNotGoThrough);
      if (reason === 'checklist_run_changed') setError({ kind: 'changed', message });
      else if (reason === 'checklist_run_completed') setError({ kind: 'completed', message });
      else if (reason === 'checklist_incomplete') {
        setError({ kind: 'incomplete', message, ...checklistIncompleteKeys(e) });
      } else if (reason === 'checklist_invalid') {
        setError({ kind: 'invalid', message, key: checklistInvalidKey(e) });
      } else setError({ kind: 'other', message });
      // The save id is kept for a resend of the same answers (a lost reply
      // may have landed); any refusal above wrote nothing, so it is harmless.
    }
  }

  function askComplete() {
    Alert.alert(C.completeChecklist, C.completeConfirm, [
      { text: 'Cancel', style: 'cancel' },
      { text: C.completeChecklist, onPress: () => void send(true) },
    ]);
  }

  const missing = new Set(error?.kind === 'incomplete' ? error.missing : []);
  const needsNote = new Set(error?.kind === 'incomplete' ? error.failedWithoutNote : []);
  const badKey = error?.kind === 'invalid' ? error.key : null;
  const anyFail = steps.some((s) => s.kind === 'check' && drafts[s.key]?.value === 'fail');
  const aboutLines = receivingRunAboutLines(view.about, anyFail);
  const statusLines = receivingRunStatusLines(
    {
      run: view.run,
      receipt: view.receipt,
      versionNumber: view.version.versionNumber,
      newerVersionNumber: view.newerVersionNumber,
      canRecord: view.canRecord,
    },
    tz,
  );
  const locked = readOnly || busy !== null;
  const procedure = view.version.procedure;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Eyebrow>{`RECEIVING CHECKLIST · ${view.po.poNumber}`}</Eyebrow>
        <Display size={28} style={{ marginTop: 10 }}>
          {view.receipt.receiptNumber}
        </Display>
        <Body muted size={13.5} style={{ marginTop: 6 }}>
          {view.po.supplierName
            ? `${view.po.poNumber} · ${view.po.supplierName}`
            : view.po.poNumber}
        </Body>
        <Body muted size={13.5}>
          {C.versionLine(view.version.versionNumber, view.version.title)}
        </Body>
        <Body muted size={13.5} style={{ marginTop: 10 }}>
          {C.honesty}
        </Body>

        <Card padding={14} style={{ marginTop: 16 }}>
          <Text
            accessibilityRole="header"
            style={[styles.sectionTitle, { color: c.ink }]}
            maxFontSizeMultiplier={capTo(15, TYPE_CEILING.display)}
          >
            {C.aboutHeading}
          </Text>
          {aboutLines.map((l, i) => (
            <Body
              key={i}
              size={14}
              color={l.tone === 'warn' ? c.warnText : undefined}
              style={{ marginTop: 4 }}
            >
              {l.text}
            </Body>
          ))}
          {view.lines.length > 0 ? (
            <View style={{ marginTop: 8 }}>
              {view.lines.map((l, i) => (
                <Body key={i} muted size={12.5}>
                  {`${l.itemName}${l.sku ? ` · ${l.sku}` : ''} · ${l.qtyReceived.toLocaleString('en-US')}`}
                </Body>
              ))}
            </View>
          ) : null}
          {procedure ? (
            <Pressable
              onPress={() =>
                Linking.openURL(
                  `https://stockpilotusa.com/dashboard/procedures/${procedure.id}`,
                ).catch(() => undefined)
              }
              accessibilityRole="link"
              style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
            >
              <Body size={14} style={{ textDecorationLine: 'underline' }}>
                {C.instructions(procedure.title)}
              </Body>
            </Pressable>
          ) : null}
        </Card>

        <View style={{ marginTop: 12 }}>
          {statusLines.map((l, i) => (
            <Body
              key={i}
              size={13.5}
              muted={l.tone !== 'done'}
              color={l.tone === 'done' ? c.accent : undefined}
              style={{ marginTop: 2 }}
            >
              {l.text}
            </Body>
          ))}
        </View>

        {steps.map((s, i) => {
          const d = drafts[s.key] ?? { value: '', note: '' };
          const flagged = missing.has(s.key) || needsNote.has(s.key) || badKey === s.key;
          return (
            <Card
              key={s.key}
              padding={14}
              style={[styles.stepCard, flagged ? { borderColor: c.critText } : {}]}
            >
              <Body size={15} style={{ fontFamily: FONT.display }}>
                {`${i + 1}. ${s.label}`}
              </Body>
              {s.required ? (
                <Body muted size={12.5}>
                  {C.requiredToComplete}
                </Body>
              ) : null}
              {s.help ? (
                <Body muted size={12.5} style={{ marginTop: 2 }}>
                  {s.help}
                </Body>
              ) : null}

              {s.kind === 'check' ? (
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={s.label}
                  style={styles.segment}
                >
                  {CHECK_ANSWER_OPTIONS.map((o) => {
                    const checked = d.value === o.value;
                    // The chosen answer is the ink edge on the recessed fill
                    // with a filled radio mark and the heavier word, so the
                    // choice never rests on a colour alone (the redesign's
                    // radio rows).
                    const Mark = checked ? CircleDot : Circle;
                    return (
                      <Pressable
                        key={o.value}
                        onPress={() => setDraft(s.key, { value: o.value })}
                        disabled={locked}
                        accessibilityRole="radio"
                        accessibilityLabel={o.label}
                        accessibilityState={{ checked, disabled: locked }}
                        style={[
                          styles.segmentOption,
                          {
                            borderColor: checked ? c.ink : c.hair2,
                            backgroundColor: checked ? c.sunk : c.card,
                            opacity: locked && !checked ? 0.6 : 1,
                          },
                        ]}
                      >
                        <Mark size={16} color={checked ? c.ink : c.ink3} strokeWidth={1.8} />
                        <Text
                          style={[
                            styles.segmentText,
                            {
                              color: c.ink,
                              fontFamily: checked ? FONT.displaySemi : FONT.display,
                            },
                          ]}
                          maxFontSizeMultiplier={capTo(14, TYPE_CEILING.control)}
                        >
                          {o.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              {s.kind === 'count' ? (
                <TextInput
                  value={d.value}
                  onChangeText={(v) => setDraft(s.key, { value: v })}
                  editable={!locked}
                  keyboardType="number-pad"
                  placeholder={C.countPlaceholder}
                  placeholderTextColor={c.ink3}
                  accessibilityLabel={s.label}
                  style={[
                    styles.input,
                    { color: c.ink, borderColor: c.hair2, backgroundColor: c.card },
                  ]}
                />
              ) : null}

              {s.kind === 'text' ? (
                <TextInput
                  value={d.value}
                  onChangeText={(v) => setDraft(s.key, { value: v })}
                  editable={!locked}
                  multiline
                  maxLength={CHECKLIST_LIMITS.text}
                  placeholder={C.textPlaceholder}
                  placeholderTextColor={c.ink3}
                  accessibilityLabel={s.label}
                  style={[
                    styles.input,
                    styles.multiline,
                    { color: c.ink, borderColor: c.hair2, backgroundColor: c.card },
                  ]}
                />
              ) : null}

              <FieldLabel style={{ marginTop: 12 }}>
                {s.kind === 'check' && d.value === 'fail' ? C.whatWasWrong : C.notes}
              </FieldLabel>
              <TextInput
                value={d.note}
                onChangeText={(v) => setDraft(s.key, { note: v })}
                editable={!locked}
                multiline
                maxLength={CHECKLIST_LIMITS.note}
                accessibilityLabel={`${s.kind === 'check' && d.value === 'fail' ? C.whatWasWrong : C.notes}, ${s.label}`}
                style={[
                  styles.input,
                  styles.multiline,
                  {
                    color: c.ink,
                    borderColor: needsNote.has(s.key) ? c.critText : c.hair2,
                    backgroundColor: c.card,
                  },
                ]}
              />
            </Card>
          );
        })}

        <FieldLabel style={{ marginTop: 16 }}>{C.runNote}</FieldLabel>
        <TextInput
          value={note}
          onChangeText={setNote}
          editable={!locked}
          multiline
          maxLength={CHECKLIST_LIMITS.runNote}
          accessibilityLabel={C.runNote}
          style={[
            styles.input,
            styles.multiline,
            { color: c.ink, borderColor: c.hair2, backgroundColor: c.card },
          ]}
        />

        {error ? (
          <Card padding={14} style={[styles.errorCard, { borderColor: c.critText }]}>
            <Body size={14} accessibilityRole="alert">
              {error.message}
            </Body>
            {error.kind === 'changed' || error.kind === 'completed' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={reloading || offline}
                onPress={onReload}
                style={{ alignSelf: 'flex-start', marginTop: 10, minHeight: MIN_TAP }}
              >
                {C.reload}
              </Button>
            ) : null}
          </Card>
        ) : null}

        {view.run.status === 'completed' ? (
          <Body muted size={13.5} style={{ marginTop: 16 }}>
            {C.readOnlyCompleted}
          </Body>
        ) : null}

        {!readOnly ? (
          <View style={styles.actions}>
            {offline ? (
              <Body muted size={13.5} accessibilityRole="alert">
                {C.offline}
              </Body>
            ) : null}
            <Button
              variant="outline"
              block
              disabled={busy !== null || offline}
              onPress={() => void send(false)}
              accessibilityHint={offline ? C.offline : undefined}
            >
              {busy === 'save' ? 'Saving…' : C.saveProgress}
            </Button>
            <Button
              block
              disabled={busy !== null || offline}
              onPress={askComplete}
              accessibilityHint={offline ? C.offline : undefined}
            >
              {busy === 'complete' ? 'Completing…' : C.completeChecklist}
            </Button>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The 44pt chip frame, 3pt outside the 38pt chip (the other card screens' bar).
  topbar: { paddingHorizontal: 9, paddingTop: 5, flexDirection: 'row' },
  pad: { padding: 20 },
  scroll: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 48 },
  sectionTitle: { fontFamily: FONT.displaySemi, fontSize: 15, marginBottom: 2 },
  linkRow: { minHeight: MIN_TAP, justifyContent: 'center', marginTop: 6 },
  stepCard: { marginTop: 14 },
  segment: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  segmentOption: {
    minHeight: MIN_TAP,
    minWidth: 88,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    flexGrow: 1,
  },
  segmentText: { fontSize: 14, flexShrink: 1, textAlign: 'center' },
  input: {
    minHeight: MIN_TAP,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 15,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  errorCard: { marginTop: 16 },
  actions: { marginTop: 20, gap: 10 },
});
