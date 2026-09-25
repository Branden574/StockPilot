import { useNetworkState } from 'expo-network';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  EXCEPTION_ACTION_LABELS,
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  EXCEPTION_RULES,
  describeOccurrence,
  describeOccurrenceEvent,
  exceptionActDisabledReason,
  occurrenceState,
  occurrenceStateLabel,
  recurrenceBadge,
  OCCURRENCE_RESOLVED_REASON_COPY,
  type OccurrenceState,
} from '@stockpilot/core';

import { ExceptionNoteSheet } from '@/components/exception-note-sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import {
  describeExceptionsRequestError,
  exceptionActionRoute,
  exceptionActionsFor,
  exceptionTimeLabel,
  getException,
  isOfflineState,
  recalledDetail,
  rememberDetail,
  type ExceptionSheetMode,
  type MobileExceptionDetail,
} from '@/lib/exceptions-api';
import { useOrg } from '@/lib/use-org';
import { useTheme } from '@/lib/use-theme';

/**
 * One exception (F1-1): the native twin of /dashboard/exceptions/[id]. Reads
 * GET /api/v1/exceptions/[id] (the service the web page renders): the
 * condition in core's words, possible causes, what clears it, the timeline
 * and every earlier occurrence of the same condition.
 *
 * Acknowledge and Add note open ExceptionNoteSheet. Both are offered only when
 * the server says this reader may act (canAct), and both are DISABLED, with
 * the reason, while the phone is offline (core exceptionActDisabledReason,
 * fed the live network state). Nothing here resolves an exception.
 *
 * A failed read is an error on screen, never a blank page; offline, the copy
 * this session last loaded is shown with its time.
 */

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: MobileExceptionDetail; receivedAt: string; banner: string | null }
  | { kind: 'error'; message: string };

export default function ExceptionDetailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { orgId } = useOrg();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const offline = isOfflineState(useNetworkState());

  const [stored, setState] = React.useState<Loaded>({ kind: 'loading' });
  const [refreshing, setRefreshing] = React.useState(false);
  const [sheet, setSheet] = React.useState<ExceptionSheetMode | null>(null);
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    // Offline there is nothing to ask; the view below is derived instead.
    if (!id || !orgId || offline) return;
    const seq = ++seqRef.current;
    try {
      const detail = await getException(id);
      if (seq !== seqRef.current) return;
      if (detail.organizationId !== orgId) {
        setState({
          kind: 'error',
          message: 'The server answered for a different workspace. Go back and switch workspace from the menu.',
        });
        return;
      }
      const receivedAt = new Date();
      rememberDetail(userId, orgId, detail, receivedAt);
      setState({ kind: 'ready', detail, receivedAt: receivedAt.toISOString(), banner: null });
    } catch (e) {
      if (seq !== seqRef.current) return;
      const status = (e as { status?: unknown }).status;
      const kept = recalledDetail(userId, orgId, id);
      if (status === 404) {
        setState({ kind: 'error', message: 'This exception is not available to you, or it no longer exists.' });
        return;
      }
      // Worded by status for a 429 or 5xx, so a bare code never shows.
      const message = describeExceptionsRequestError(e, 'Could not load this exception.');
      setState(
        kept
          ? {
              kind: 'ready',
              detail: kept.detail,
              receivedAt: kept.receivedAt,
              banner: `Could not refresh. Showing this exception as of ${exceptionTimeLabel(kept.receivedAt, kept.detail.timeZone)}.`,
            }
          : { kind: 'error', message },
      );
    }
  }, [id, orgId, userId, offline]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await (offline returns before any set; that view is derived); the effect synchronizes with the server
    void load();
  }, [load]);

  // Offline the view is DERIVED, never fetched: the copy on screen (or the
  // one this session remembered) with its time, or a plain "needs a
  // connection". The act buttons are disabled below either way.
  // Only ever an answer for THIS id (a view for another occurrence is never
  // shown under this one's heading).
  const mine = stored.kind === 'ready' && stored.detail.occurrence.id !== id ? null : stored;
  let state: Loaded;
  if (offline) {
    const kept =
      mine?.kind === 'ready'
        ? { detail: mine.detail, receivedAt: mine.receivedAt }
        : id
          ? recalledDetail(userId, orgId, id)
          : null;
    state = kept
      ? {
          kind: 'ready',
          detail: kept.detail,
          receivedAt: kept.receivedAt,
          banner: `You are offline. Showing this exception as of ${exceptionTimeLabel(kept.receivedAt, kept.detail.timeZone)}.`,
        }
      : {
          kind: 'error',
          message:
            'You are offline. This exception needs a connection to load. Reconnect and pull down to try again.',
        };
  } else {
    state = mine ?? { kind: 'loading' };
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/exceptions' as Href);
  };

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} />
        </View>
      </SafeAreaView>

      {state.kind === 'loading' ? (
        <ActivityIndicator color={c.ink4} style={{ marginTop: 32 }} />
      ) : state.kind === 'error' ? (
        <View style={{ paddingHorizontal: 20, marginTop: 12 }}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {state.message}
            </Body>
            <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
              <Button variant="outline" size="sm" onPress={() => void refresh()}>
                Try again
              </Button>
            </View>
          </Card>
        </View>
      ) : (
        <Detail
          detail={state.detail}
          banner={state.banner}
          offline={offline}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onOpenSheet={setSheet}
          onNavigate={(href) => router.push(href as Href)}
        />
      )}

      {state.kind === 'ready' ? (
        <ExceptionNoteSheet
          visible={sheet !== null}
          mode={sheet ?? 'note'}
          occurrence={state.detail.occurrence}
          online={!offline}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            // Re-read, so the chip and the timeline show what was just saved.
            void load();
          }}
        />
      ) : null}
    </View>
  );
}

function statePillTone(state: OccurrenceState): 'default' | 'ok' | 'warn' {
  if (state.kind === 'resolved') return 'ok';
  if (state.kind === 'open') return 'warn';
  return 'default';
}

function Detail({
  detail,
  banner,
  offline,
  refreshing,
  onRefresh,
  onOpenSheet,
  onNavigate,
}: {
  detail: MobileExceptionDetail;
  banner: string | null;
  offline: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSheet: (mode: ExceptionSheetMode) => void;
  onNavigate: (href: string) => void;
}) {
  const { c } = useTheme();
  const o = detail.occurrence;
  const meta = EXCEPTION_RULES[o.rule];
  const d = describeOccurrence(o.rule, o.facts, {
    itemName: o.item?.name ?? null,
    conditionSince: o.conditionSince,
    asOf: o.resolvedAt ?? new Date(),
  });
  const state = occurrenceState(
    {
      resolvedAt: o.resolvedAt,
      resolvedReason: o.resolvedReason,
      acknowledgedAt: o.acknowledgedAt,
      acknowledgedBy: o.acknowledgedBy?.id ?? null,
      recount: o.recount,
    },
    detail.syncState?.lastEvaluatedAt ?? null,
  );
  const recurred = recurrenceBadge(o.recurrenceIndex);
  const resolved = o.resolvedAt !== null;
  // Resolved or not permitted: the reason, and no buttons. Offline: the
  // buttons stay, DISABLED, with the reason.
  const disabledReason = exceptionActDisabledReason({ resolved, canAct: o.canAct, online: !offline });
  const showActButtons = !resolved && o.canAct;

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} />}
    >
      {banner ? (
        <Card padding={12}>
          <Body size={13.5} accessibilityRole="alert">
            {banner}
          </Body>
        </Card>
      ) : null}

      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          {o.reference ? (
            <Mono size={12} color={c.ink4}>
              {o.reference}
            </Mono>
          ) : null}
          <Pill status={meta.severity === 'critical' ? 'crit' : 'warn'} dot={false}>
            {meta.severity === 'critical' ? 'Critical' : 'Warning'}
          </Pill>
        </View>
        <Eyebrow>{meta.label.toUpperCase()}</Eyebrow>
        {/* The title is the item name (content): no cap, per the Dynamic Type
            policy. Display's default ceiling is for chrome headings. */}
        <Display size={26} maxFontSizeMultiplier={0}>
          {d.title}
        </Display>
        <Body size={15}>{d.detail}</Body>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          <Pill status={statePillTone(state)} dot={false}>
            {occurrenceStateLabel(state)}
          </Pill>
          {recurred ? (
            <Pill status="default" dot={false}>
              {recurred}
            </Pill>
          ) : null}
        </View>
      </View>

      <Card padding={14}>
        <Fact label="ITEM" value={o.item ? `${o.item.name}${o.item.sku ? ` (${o.item.sku})` : ''}` : 'Not visible to you'} />
        {o.location ? (
          <Fact label="LOCATION" value={`${o.location.name}${o.location.archived ? ' (archived)' : ''}`} />
        ) : null}
        <Fact
          label="FIRST SEEN"
          value={
            o.presentWhenTrackingBegan
              ? `Already present when tracking began, ${exceptionTimeLabel(o.firstSeenAt, detail.timeZone)}`
              : exceptionTimeLabel(o.firstSeenAt, detail.timeZone)
          }
        />
        {!resolved ? <Fact label="LAST SEEN BY A CHECK" value={exceptionTimeLabel(o.lastSeenAt, detail.timeZone)} /> : null}
        {o.acknowledgedAt ? (
          <Fact
            label="ACKNOWLEDGED"
            value={`${o.acknowledgedBy?.label ?? 'Former member'}, ${exceptionTimeLabel(o.acknowledgedAt, detail.timeZone)}`}
          />
        ) : null}
        {o.resolvedAt ? (
          <Fact
            label="RESOLVED"
            value={`${exceptionTimeLabel(o.resolvedAt, detail.timeZone)}: ${OCCURRENCE_RESOLVED_REASON_COPY[o.resolvedReason ?? 'cleared']}`}
          />
        ) : null}
      </Card>

      <View style={{ gap: 8 }}>
        {exceptionActionsFor(o.rule).map((kind) => (
          <Button key={kind} variant="outline" block onPress={() => onNavigate(exceptionActionRoute(kind, o.itemId))}>
            {EXCEPTION_ACTION_LABELS[kind]}
          </Button>
        ))}
      </View>

      <View style={{ gap: 8 }}>
        {showActButtons ? (
          <View style={{ gap: 8 }}>
            {o.acknowledgedAt === null ? (
              <Button block disabled={disabledReason !== null} onPress={() => onOpenSheet('acknowledge')}>
                Acknowledge
              </Button>
            ) : null}
            <Button
              block
              variant="outline"
              disabled={disabledReason !== null}
              onPress={() => onOpenSheet('note')}
            >
              Add note
            </Button>
          </View>
        ) : null}
        {disabledReason ? (
          <Body size={13} muted>
            {disabledReason}
          </Body>
        ) : null}
      </View>

      <Section title="WHAT CAN CAUSE THIS">
        {meta.explanations.map((e) => (
          <Body key={e} size={14}>
            {`• ${e}`}
          </Body>
        ))}
      </Section>

      <Section title="WHAT CLEARS THIS">
        <Body size={14}>{meta.clearedBy}</Body>
      </Section>

      <Section title="TIMELINE">
        {detail.timeline.length === 0 ? (
          <Body size={14} muted>
            No events yet.
          </Body>
        ) : (
          detail.timeline.map((e) => (
            <View key={e.id} style={{ gap: 2 }}>
              <Body size={14} color={c.ink}>
                {describeOccurrenceEvent({
                  kind: e.kind,
                  actorLabel: e.actor?.label ?? null,
                  cycleCountNumber: e.cycleCount?.countNumber ?? null,
                  resolvedReason: o.resolvedReason,
                })}
              </Body>
              <Mono size={11} color={c.ink4}>
                {exceptionTimeLabel(e.at, detail.timeZone)}
              </Mono>
              {e.note ? (
                <Body size={14} muted>
                  {e.note}
                </Body>
              ) : null}
            </View>
          ))
        )}
      </Section>

      {detail.history.length > 1 ? (
        <Section title="THIS CONDITION OVER TIME">
          {detail.history.map((h) => (
            <Pressable
              key={h.id}
              disabled={h.isCurrent}
              accessibilityRole={h.isCurrent ? 'text' : 'link'}
              onPress={() => onNavigate(`/exceptions/${h.id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, gap: 2 })}
            >
              <Body size={14} color={c.ink}>
                {`${h.reference ?? 'Exception'}${h.isCurrent ? ' (this one)' : ''}`}
              </Body>
              <Mono size={11} color={c.ink4}>
                {h.resolvedAt
                  ? `First seen ${exceptionTimeLabel(h.firstSeenAt, detail.timeZone)}, resolved ${exceptionTimeLabel(h.resolvedAt, detail.timeZone)}: ${OCCURRENCE_RESOLVED_REASON_COPY[h.resolvedReason ?? 'cleared']}`
                  : `First seen ${exceptionTimeLabel(h.firstSeenAt, detail.timeZone)}, still open`}
              </Mono>
            </Pressable>
          ))}
          {detail.historyTruncated ? (
            <Body size={12.5} muted>
              Only the most recent occurrences are shown.
            </Body>
          ) : null}
        </Section>
      ) : null}

      <Body size={12.5} muted>
        {detail.syncState
          ? `Checked at ${exceptionTimeLabel(detail.syncState.lastSyncedAt, detail.timeZone)}.`
          : EXCEPTION_FIRST_CHECK_PENDING_COPY}
      </Body>
    </ScrollView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2, paddingVertical: 6 }}>
      <Eyebrow prefix="">{label}</Eyebrow>
      <Body size={14.5}>{value}</Body>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: { paddingHorizontal: 12, paddingTop: 8, flexDirection: 'row', alignItems: 'center' },
  body: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40, gap: 18 },
});
