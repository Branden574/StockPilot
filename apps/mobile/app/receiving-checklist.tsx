import { useNetworkState } from 'expo-network';
import { type Href, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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
  CHECKLIST_PUBLISHABLE_KINDS,
  checklistEditorStepsFrom,
  checklistKindLabel,
  checklistPublishPayload,
  checklistVersionMetaLine,
  describeChecklistInvalid,
  moveChecklistStep,
  normalizeChecklistSteps,
  normalizeChecklistTitle,
  randomRequestUuid,
  RECEIVING_CHECKLIST_COPY,
  SUGGESTED_RECEIVING_STEPS,
  type ChecklistEditorStep,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, FieldLabel } from '@/components/ui/text';
import { isOfflineState } from '@/lib/exceptions-api';
import {
  checklistErrorReason,
  checklistInvalidStep,
  describeChecklistError,
  getChecklistEditor,
  publishChecklist,
  retireChecklist,
  type PhoneChecklistEditor,
  type PhoneChecklistVersion,
} from '@/lib/receiving-checks-api';
import { ACCENT, capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const C = RECEIVING_CHECKLIST_COPY;

/** The owner's minimum for a new control. */
const MIN_TAP = 44;

/**
 * THE RECEIVING CHECKLIST (F4-1): the native twin of
 * /dashboard/purchase-orders/receiving-checklist, reached from the Receive
 * tab (managers), a row on Procedures, or a web link (web-path-rewrite.ts;
 * the cold-start shim is app/dashboard/purchase-orders/receiving-checklist.tsx).
 *
 * Reads GET /api/v1/receiving-checklist: the live version, the earlier ones,
 * and what this person may do (core receivingGate, from the server). Anyone
 * who can read purchase orders sees it read only; a manager who manages
 * purchase orders prepares the next version as a staged list (title; each
 * step's label, answer kind, required and help; moved up and down, added and
 * removed; optional instructions from Procedures), publishes it with a
 * confirmation, or turns the checklist off with one. Every rule is checked
 * again by the service and the database.
 *
 * Online only: offline, publishing and turning off are disabled with the
 * reason. Leaving a version being prepared asks first.
 */
export default function ReceivingChecklistScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const offline = isOfflineState(useNetworkState());
  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'failed'; message: string }
    | { kind: 'ready'; editor: PhoneChecklistEditor; at: number }
  >({ kind: 'loading' });
  const [reloading, setReloading] = React.useState(false);
  const seqRef = React.useRef(0);

  const load = React.useCallback(async (): Promise<string | null> => {
    const seq = ++seqRef.current;
    try {
      const editor = await getChecklistEditor();
      if (seq === seqRef.current) setState({ kind: 'ready', editor, at: Date.now() });
      return null;
    } catch (e) {
      const message = describeChecklistError(e, C.loadFailed);
      if (seq === seqRef.current) {
        setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'failed', message }));
      }
      return message;
    }
  }, []);

  const haveEditor = state.kind === 'ready';
  React.useEffect(() => {
    if (offline || haveEditor) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set in load() is post-await; the effect synchronizes with the server
    void load();
  }, [load, offline, haveEditor]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  }

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

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
      <View style={styles.topbar}>
        <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
      </View>
      {state.kind === 'ready' ? (
        <Editor
          // A new read (after a publish, a turn off or Reload) starts the
          // screen over from what the server holds.
          key={state.at}
          editor={state.editor}
          offline={offline}
          reloading={reloading}
          onChanged={() => void reload()}
        />
      ) : offline ? (
        <View style={styles.pad}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {C.editorOffline}
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
        <ActivityIndicator color={c.ink4} style={{ marginTop: 40 }} />
      )}
    </SafeAreaView>
  );
}

type EditorError = { message: string; step: number | null; changed: boolean };

function Editor({
  editor,
  offline,
  reloading,
  onChanged,
}: {
  editor: PhoneChecklistEditor;
  offline: boolean;
  reloading: boolean;
  onChanged: () => void;
}) {
  const { c } = useTheme();
  const navigation = useNavigation();
  const canPublish = editor.gate.canPublishChecklist;
  const live = editor.live;
  const next = editor.nextVersionNumber;

  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [steps, setSteps] = React.useState<ChecklistEditorStep[]>([]);
  const [procedureId, setProcedureId] = React.useState<string>('');
  const [error, setError] = React.useState<EditorError | null>(null);
  const [busy, setBusy] = React.useState(false);
  // One publish id per payload: a resend of the same version after a lost
  // reply is answered as that publish, never a second version.
  const pending = React.useRef<{ payload: string; clientPublishId: string } | null>(null);

  usePreventRemove(editing, ({ data }) => {
    Alert.alert(C.leaveTitle, C.leaveEditorBody, [
      { text: C.stay, style: 'cancel' },
      { text: C.leave, style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  function begin(from: 'suggested' | 'blank' | 'live') {
    setError(null);
    if (from === 'live' && live) {
      setTitle(live.title);
      setSteps(checklistEditorStepsFrom(live.steps));
      setProcedureId(live.procedureId ?? '');
    } else if (from === 'suggested') {
      setTitle(live?.title ?? C.editorTitle);
      setSteps(checklistEditorStepsFrom(SUGGESTED_RECEIVING_STEPS));
      setProcedureId('');
    } else {
      setTitle(live?.title ?? C.editorTitle);
      setSteps(checklistEditorStepsFrom([{ kind: 'check', label: '', required: true }]));
      setProcedureId('');
    }
    setEditing(true);
  }

  const update = (uid: string, patch: Partial<ChecklistEditorStep>) =>
    setSteps((list) => list.map((s) => (s.uid === uid ? { ...s, ...patch } : s)));

  /** Checked here in the server's words before anything is sent. */
  function askPublish() {
    setError(null);
    const t = normalizeChecklistTitle(title);
    if (!t.ok) {
      setError({ message: describeChecklistInvalid(t.detail), step: null, changed: false });
      return;
    }
    const r = normalizeChecklistSteps(checklistPublishPayload(steps));
    if (!r.ok) {
      setError({
        message: describeChecklistInvalid(r.detail),
        step: r.detail.step ?? null,
        changed: false,
      });
      return;
    }
    Alert.alert(C.publishVersion(next), C.publishConfirm(next), [
      { text: 'Cancel', style: 'cancel' },
      { text: C.publishVersion(next), onPress: () => void publish() },
    ]);
  }

  async function publish() {
    if (busy || offline) return;
    const body = {
      title,
      steps: checklistPublishPayload(steps),
      procedureId: procedureId || null,
      expectedCurrentId: live?.id ?? null,
    };
    const payload = JSON.stringify(body);
    if (!pending.current || pending.current.payload !== payload) {
      pending.current = { payload, clientPublishId: randomRequestUuid() };
    }
    setBusy(true);
    try {
      const res = await publishChecklist({
        ...body,
        clientPublishId: pending.current.clientPublishId,
      });
      pending.current = null;
      setBusy(false);
      setEditing(false);
      Alert.alert(C.published(res.versionNumber));
      onChanged();
    } catch (e) {
      setBusy(false);
      const reason = checklistErrorReason(e);
      setError({
        message: describeChecklistError(e, C.didNotGoThrough),
        step: checklistInvalidStep(e),
        changed: reason === 'checklist_changed',
      });
    }
  }

  function askTurnOff() {
    if (!live) return;
    Alert.alert(C.turnOff, C.turnOffConfirm, [
      { text: 'Cancel', style: 'cancel' },
      { text: C.turnOff, style: 'destructive', onPress: () => void turnOff(live.id) },
    ]);
  }

  async function turnOff(versionId: string) {
    if (busy || offline) return;
    setError(null);
    setBusy(true);
    try {
      await retireChecklist(versionId);
      setBusy(false);
      Alert.alert(C.turnedOff);
      onChanged();
    } catch (e) {
      setBusy(false);
      const reason = checklistErrorReason(e);
      setError({
        message: describeChecklistError(e, C.didNotGoThrough),
        step: null,
        changed: reason === 'checklist_changed',
      });
    }
  }

  const errorCard = error ? (
    <Card padding={14} style={[styles.block, { borderColor: ACCENT.crit }]}>
      <Body size={14} accessibilityRole="alert">
        {error.message}
      </Body>
      {error.changed ? (
        <Button
          size="sm"
          variant="outline"
          disabled={reloading || offline}
          onPress={onChanged}
          style={{ alignSelf: 'flex-start', marginTop: 10, minHeight: MIN_TAP }}
        >
          {C.reload}
        </Button>
      ) : null}
    </Card>
  ) : null;

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
        <Eyebrow>PURCHASING</Eyebrow>
        <Display size={30} style={{ marginTop: 10 }}>
          {C.editorTitle}
        </Display>
        <Body muted size={13.5} style={{ marginTop: 6 }}>
          {C.procedureCardBody}
        </Body>

        {!editing ? (
          <>
            <Card padding={14} style={styles.block}>
              {live ? (
                <>
                  <Text
                    accessibilityRole="header"
                    style={[styles.sectionTitle, { color: c.ink }]}
                    maxFontSizeMultiplier={capTo(15, TYPE_CEILING.display)}
                  >
                    {`${C.liveVersion(live.versionNumber)} ${live.title}`}
                  </Text>
                  <VersionBody version={live} timeZone={editor.timeZone} />
                </>
              ) : (
                <>
                  <Text
                    accessibilityRole="header"
                    style={[styles.sectionTitle, { color: c.ink }]}
                    maxFontSizeMultiplier={capTo(15, TYPE_CEILING.display)}
                  >
                    {C.noLiveVersion}
                  </Text>
                  <Body muted size={13.5} style={{ marginTop: 4 }}>
                    {C.editorEmpty}
                  </Body>
                </>
              )}
              {!canPublish ? (
                <Body muted size={13} style={{ marginTop: 10 }}>
                  {C.readOnlyEditor}
                </Body>
              ) : null}
            </Card>

            {canPublish ? (
              <View style={styles.actions}>
                {offline ? (
                  <Body muted size={13.5} accessibilityRole="alert">
                    {C.editorOffline}
                  </Body>
                ) : null}
                {live ? (
                  <>
                    <Button block disabled={busy || offline} onPress={() => begin('live')}>
                      {C.prepareVersion(next)}
                    </Button>
                    <Button block variant="outline" disabled={busy || offline} onPress={askTurnOff}>
                      {busy ? 'Turning off…' : C.turnOff}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button block disabled={offline} onPress={() => begin('suggested')}>
                      {C.startSuggested}
                    </Button>
                    <Button
                      block
                      variant="outline"
                      disabled={offline}
                      onPress={() => begin('blank')}
                    >
                      {C.startBlank}
                    </Button>
                  </>
                )}
              </View>
            ) : null}

            {errorCard}

            {editor.history.length > 0 ? (
              <View style={styles.block}>
                <Text
                  accessibilityRole="header"
                  style={[styles.sectionTitle, { color: c.ink }]}
                  maxFontSizeMultiplier={capTo(15, TYPE_CEILING.display)}
                >
                  {C.history}
                </Text>
                {editor.history.map((v) => (
                  <HistoryVersion key={v.id} version={v} timeZone={editor.timeZone} />
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <>
            <FieldLabel style={{ marginTop: 20 }}>{C.titleLabel}</FieldLabel>
            <TextInput
              value={title}
              onChangeText={setTitle}
              maxLength={CHECKLIST_LIMITS.title}
              accessibilityLabel={C.titleLabel}
              editable={!busy}
              style={[styles.input, { color: c.ink, borderColor: c.hair, backgroundColor: c.card }]}
            />

            {steps.map((s, i) => (
              <Card
                key={s.uid}
                padding={14}
                style={[styles.block, error?.step === i + 1 ? { borderColor: ACCENT.crit } : {}]}
              >
                <FieldLabel>{`${C.stepLabel} ${i + 1}`}</FieldLabel>
                <TextInput
                  value={s.label}
                  onChangeText={(v) => update(s.uid, { label: v })}
                  maxLength={CHECKLIST_LIMITS.label}
                  accessibilityLabel={`${C.stepLabel} ${i + 1}`}
                  editable={!busy}
                  style={[
                    styles.input,
                    { color: c.ink, borderColor: c.hair, backgroundColor: c.card },
                  ]}
                />

                <FieldLabel style={{ marginTop: 12 }}>{C.stepKind}</FieldLabel>
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={`${C.stepKind}, ${C.stepLabel.toLowerCase()} ${i + 1}`}
                  style={styles.segment}
                >
                  {CHECKLIST_PUBLISHABLE_KINDS.map((k) => {
                    const checked = s.kind === k;
                    return (
                      <Pressable
                        key={k}
                        onPress={() => update(s.uid, { kind: k })}
                        disabled={busy}
                        accessibilityRole="radio"
                        accessibilityLabel={checklistKindLabel(k)}
                        accessibilityState={{ checked, disabled: busy }}
                        style={[
                          styles.option,
                          {
                            borderColor: checked ? c.ink : c.hair,
                            backgroundColor: checked ? c.paper2 : c.card,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.optionText,
                            { color: c.ink, fontWeight: checked ? '700' : '500' },
                          ]}
                          maxFontSizeMultiplier={capTo(14, TYPE_CEILING.control)}
                        >
                          {checklistKindLabel(k)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Pressable
                  onPress={() => update(s.uid, { required: !s.required })}
                  disabled={busy}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${C.stepRequired}, ${C.stepLabel.toLowerCase()} ${i + 1}`}
                  accessibilityState={{ checked: s.required, disabled: busy }}
                  style={styles.checkboxRow}
                >
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: c.ink,
                        backgroundColor: s.required ? c.ink : 'transparent',
                      },
                    ]}
                  />
                  <Body size={14}>{C.stepRequired}</Body>
                </Pressable>

                <FieldLabel style={{ marginTop: 12 }}>{C.stepHelp}</FieldLabel>
                <TextInput
                  value={s.help}
                  onChangeText={(v) => update(s.uid, { help: v })}
                  maxLength={CHECKLIST_LIMITS.help}
                  multiline
                  accessibilityLabel={`${C.stepHelp}, ${C.stepLabel.toLowerCase()} ${i + 1}`}
                  editable={!busy}
                  style={[
                    styles.input,
                    styles.multiline,
                    { color: c.ink, borderColor: c.hair, backgroundColor: c.card },
                  ]}
                />

                <View style={styles.rowButtons}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || i === 0}
                    onPress={() => setSteps((l) => moveChecklistStep(l, i, -1))}
                    accessibilityLabel={C.moveStepUp(i + 1)}
                    style={{ minHeight: MIN_TAP }}
                  >
                    Move up
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || i === steps.length - 1}
                    onPress={() => setSteps((l) => moveChecklistStep(l, i, 1))}
                    accessibilityLabel={C.moveStepDown(i + 1)}
                    style={{ minHeight: MIN_TAP }}
                  >
                    Move down
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || steps.length <= 1}
                    onPress={() => setSteps((l) => l.filter((x) => x.uid !== s.uid))}
                    accessibilityLabel={C.removeStep(i + 1)}
                    style={{ minHeight: MIN_TAP }}
                  >
                    Remove
                  </Button>
                </View>
              </Card>
            ))}

            <Button
              variant="outline"
              block
              disabled={busy || steps.length >= CHECKLIST_LIMITS.maxSteps}
              onPress={() =>
                setSteps((l) => [
                  ...l,
                  ...checklistEditorStepsFrom([{ kind: 'check', label: '', required: false }]),
                ])
              }
              style={{ marginTop: 14 }}
            >
              {C.addStep}
            </Button>

            {editor.proceduresUnavailable ? (
              <Body muted size={13.5} style={{ marginTop: 16 }}>
                {C.proceduresUnavailable}
              </Body>
            ) : null}
            {editor.procedures && editor.procedures.length > 0 ? (
              <>
                <FieldLabel style={{ marginTop: 20 }}>{C.procedureLabel}</FieldLabel>
                <View accessibilityRole="radiogroup" accessibilityLabel={C.procedureLabel}>
                  {[{ id: '', title: C.procedureNone }, ...editor.procedures].map((p) => {
                    const checked = procedureId === p.id;
                    return (
                      <Pressable
                        key={p.id || 'none'}
                        onPress={() => setProcedureId(p.id)}
                        disabled={busy}
                        accessibilityRole="radio"
                        accessibilityLabel={p.title}
                        accessibilityState={{ checked, disabled: busy }}
                        style={styles.checkboxRow}
                      >
                        <View
                          style={[
                            styles.radio,
                            {
                              borderColor: c.ink,
                              backgroundColor: checked ? c.ink : 'transparent',
                            },
                          ]}
                        />
                        <Body size={14} style={{ flexShrink: 1 }}>
                          {p.title}
                        </Body>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            {errorCard}

            <View style={styles.actions}>
              {offline ? (
                <Body muted size={13.5} accessibilityRole="alert">
                  {C.editorOffline}
                </Body>
              ) : null}
              <Button block disabled={busy || offline} onPress={askPublish}>
                {busy ? 'Publishing…' : C.publishVersion(next)}
              </Button>
              <Button
                block
                variant="outline"
                disabled={busy}
                onPress={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A version's steps, instructions and who published it, read only. */
function VersionBody({ version, timeZone }: { version: PhoneChecklistVersion; timeZone: string }) {
  return (
    <View style={{ marginTop: 8 }}>
      {version.steps.map((s, i) => (
        <View key={s.key} style={{ marginTop: 6 }}>
          <Body size={14}>{`${i + 1}. ${s.label}`}</Body>
          <Body muted size={12.5}>
            {`${checklistKindLabel(s.kind)}${s.required ? ` · ${C.stepRequired}` : ''}`}
          </Body>
          {s.help ? (
            <Body muted size={12.5}>
              {s.help}
            </Body>
          ) : null}
        </View>
      ))}
      {version.procedureTitle ? (
        <Body muted size={13} style={{ marginTop: 8 }}>
          {C.instructions(version.procedureTitle)}
        </Body>
      ) : null}
      <Body muted size={12.5} style={{ marginTop: 8 }}>
        {checklistVersionMetaLine(version, timeZone)}
      </Body>
    </View>
  );
}

/** An earlier version: its line, and its steps when opened. */
function HistoryVersion({
  version,
  timeZone,
}: {
  version: PhoneChecklistVersion;
  timeZone: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card padding={14} style={{ marginTop: 10 }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.historyToggle}
      >
        <Body size={14} style={{ flexShrink: 1 }}>
          {C.versionLine(version.versionNumber, version.title)}
        </Body>
      </Pressable>
      {open ? <VersionBody version={version} timeZone={timeZone} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The 44pt chip frame, 3pt outside the 38pt chip (the other card screens' bar).
  topbar: { paddingHorizontal: 9, paddingTop: 5, flexDirection: 'row' },
  pad: { padding: 20 },
  scroll: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 48 },
  block: { marginTop: 16 },
  sectionTitle: { fontFamily: FONT.display, fontSize: 15, fontWeight: '600' },
  actions: { marginTop: 16, gap: 10 },
  input: {
    minHeight: MIN_TAP,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 15,
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  segment: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  option: {
    minHeight: MIN_TAP,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
  },
  optionText: { fontSize: 14, fontFamily: FONT.display, flexShrink: 1, textAlign: 'center' },
  checkboxRow: {
    minHeight: MIN_TAP,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  checkbox: { width: 22, height: 22, borderRadius: 5, borderWidth: 1.5 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5 },
  rowButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  historyToggle: { minHeight: MIN_TAP, justifyContent: 'center' },
});
