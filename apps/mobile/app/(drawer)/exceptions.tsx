import { useNetworkState } from 'expo-network';
import { type Href, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { AlertTriangle, ArrowLeft, Menu } from 'lucide-react-native';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  EXCEPTION_ALL_CLEAR_TITLE,
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  EXCEPTION_LIST_UNAVAILABLE_COPY,
  EXCEPTION_NONE_RESOLVED_COPY,
  EXCEPTION_RESOLVED_WINDOW_DAYS,
  EXCEPTION_RULES,
  EXCEPTION_SYNC_INTERVAL_MINUTES,
  describeOccurrence,
  groupOccurrences,
  occurrenceState,
  occurrenceStateLabel,
  recurrenceBadge,
  type ExceptionRuleMeta,
  type OccurrenceState,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import {
  EXCEPTIONS_OFFLINE_NOTHING_LOADED_COPY,
  exceptionTimeLabel,
  isOfflineState,
  listExceptions,
  offlineAsOfCopy,
  recalledList,
  rememberList,
  requestExceptionCheck,
  type ExceptionListStatus,
  type MobileExceptionList,
  type MobileExceptionOccurrence,
} from '@/lib/exceptions-api';
import { FONT } from '@/lib/theme';
import { useOrg } from '@/lib/use-org';
import { useTheme } from '@/lib/use-theme';

/**
 * Exceptions: the native twin of the web /dashboard/exceptions page (F1-1).
 *
 * What it shows is STORED state: the system checks every organization every
 * 15 minutes and after each posted or cancelled count, and this screen reads
 * the result through GET /api/v1/exceptions (the same service the web page
 * renders). It never runs a check itself. "Checked at" says when the last one
 * ran; before the first one it says so, and it never shows the all-clear
 * state for a check that has not run or could not complete.
 *
 * A failed read is an error on screen, never an empty list. Offline, the list
 * this app session last loaded is shown "as of" the time it arrived; with none
 * loaded, the screen says it needs a connection. Words come from core
 * (describeOccurrence, occurrenceStateLabel, the EXCEPTION_* copy), so the phone
 * and the browser read the same for the same row.
 */

/** What the screen shows. `key` is the workspace and tab it answers for: a
 *  view for any other key is never shown (the screen shows loading until the
 *  current key's answer lands), so switching tab or workspace can never
 *  flash the previous list under the new heading. */
type View_ =
  | { kind: 'loading'; key: string }
  | { kind: 'live'; key: string; list: MobileExceptionList; receivedAt: string }
  | { kind: 'remembered'; key: string; list: MobileExceptionList; receivedAt: string; banner: string }
  | { kind: 'error'; key: string; message: string };

type ListItem =
  | { type: 'group'; key: string; meta: ExceptionRuleMeta; count: number }
  | { type: 'row'; key: string; occurrence: MobileExceptionOccurrence; title: string; detail: string };

export default function ExceptionsScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const { orgId } = useOrg();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const offline = isOfflineState(useNetworkState());

  const [status, setStatus] = React.useState<ExceptionListStatus>('open');
  const [stored, setView] = React.useState<View_>({ kind: 'loading', key: '' });
  const viewKey = `${orgId ?? ''}:${status}`;
  const [refreshing, setRefreshing] = React.useState(false);
  const [checkNote, setCheckNote] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    // Offline there is nothing to ask; the view below is derived instead.
    if (!orgId || offline) return;
    const key = `${orgId}:${status}`;
    const seq = ++seqRef.current;
    try {
      const list = await listExceptions(status);
      if (seq !== seqRef.current) return;
      if (list.organizationId !== orgId) {
        setView({
          kind: 'error',
          key,
          message:
            'The server answered for a different workspace. Pull down to refresh, or switch workspace from the menu.',
        });
        return;
      }
      const receivedAt = new Date();
      rememberList(userId, orgId, list, receivedAt);
      setView({ kind: 'live', key, list, receivedAt: receivedAt.toISOString() });
    } catch (e) {
      if (seq !== seqRef.current) return;
      const message = e instanceof Error && e.message ? e.message : EXCEPTION_LIST_UNAVAILABLE_COPY;
      // A failed read is never an empty list. A list this session loaded
      // earlier stays readable under the failure, labelled with its time.
      const kept = recalledList(userId, orgId, status);
      setView(
        kept
          ? {
              kind: 'remembered',
              key,
              list: kept.list,
              receivedAt: kept.receivedAt,
              banner: `${EXCEPTION_LIST_UNAVAILABLE_COPY} Showing the list as of ${exceptionTimeLabel(kept.receivedAt)}.`,
            }
          : { kind: 'error', key, message: `${EXCEPTION_LIST_UNAVAILABLE_COPY} ${message}` },
      );
    }
  }, [orgId, userId, status, offline]);

  // Runs on focus (coming back from an exception after acknowledging it shows
  // the new state) and again on a tab, workspace or network change while
  // focused: reconnecting refreshes the list, and going offline switches to
  // the remembered one. One read; it never runs a check.
  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  // What the screen shows. Offline it is DERIVED, never fetched: the list this
  // screen last loaded (or, on a fresh open, the one this session remembered)
  // "as of" its time, or a plain "needs a connection". Never an empty list.
  let view: View_;
  if (offline) {
    const own =
      (stored.kind === 'live' || stored.kind === 'remembered') && stored.key === viewKey
        ? { list: stored.list, receivedAt: stored.receivedAt }
        : null;
    const kept = own ?? recalledList(userId, orgId, status);
    view = kept
      ? {
          kind: 'remembered',
          key: viewKey,
          list: kept.list,
          receivedAt: kept.receivedAt,
          banner: offlineAsOfCopy(kept.receivedAt),
        }
      : { kind: 'error', key: viewKey, message: EXCEPTIONS_OFFLINE_NOTHING_LOADED_COPY };
  } else {
    view = stored.key === viewKey ? stored : { kind: 'loading', key: viewKey };
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function checkNow() {
    setChecking(true);
    setCheckNote(null);
    try {
      const res = await requestExceptionCheck();
      setCheckNote(
        res.scheduled
          ? 'Check started. Pull down in a minute to see the result.'
          : `Checked less than a minute ago. You can check again in ${res.retryAfterSeconds} seconds.`,
      );
    } catch (e) {
      setCheckNote(e instanceof Error && e.message ? e.message : 'Could not start a check. Try again.');
    } finally {
      setChecking(false);
    }
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  const list = view.kind === 'live' || view.kind === 'remembered' ? view.list : null;
  const items = list ? listItems(list) : [];
  const unchecked = list?.syncState
    ? [...new Set([...list.syncState.failedRules, ...list.syncState.truncatedRules])].map(
        (r) => EXCEPTION_RULES[r].label,
      )
    : [];

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip icon={ArrowLeft} onPress={goBack} />
            <IconChip icon={Menu} onPress={openDrawer} />
          </View>
          {list?.canCheckNow ? (
            <Button size="sm" variant="outline" disabled={checking || offline} onPress={() => void checkNow()}>
              {checking ? 'Starting...' : 'Check now'}
            </Button>
          ) : null}
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} color={c.ink3} strokeWidth={1.5} />
            <Eyebrow>INVENTORY · EXCEPTIONS</Eyebrow>
          </View>
          <Display size={32} style={{ marginTop: 12 }}>
            Exceptions<Em>.</Em>
          </Display>
        </View>
        <View style={styles.tabs}>
          <Pressable onPress={() => setStatus('open')} accessibilityRole="button" accessibilityState={{ selected: status === 'open' }}>
            <Pill status={status === 'open' ? 'ok' : 'default'} dot={false}>
              Open
            </Pill>
          </Pressable>
          <Pressable onPress={() => setStatus('resolved')} accessibilityRole="button" accessibilityState={{ selected: status === 'resolved' }}>
            <Pill status={status === 'resolved' ? 'ok' : 'default'} dot={false}>
              {`Resolved, last ${EXCEPTION_RESOLVED_WINDOW_DAYS} days`}
            </Pill>
          </Pressable>
        </View>
      </SafeAreaView>

      {view.kind === 'loading' ? (
        <ActivityIndicator color={c.ink4} style={{ marginTop: 32 }} />
      ) : view.kind === 'error' ? (
        <View style={{ paddingHorizontal: 20, marginTop: 12 }}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {view.message}
            </Body>
            <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
              <Button variant="outline" size="sm" onPress={() => void refresh()}>
                Try again
              </Button>
            </View>
          </Card>
        </View>
      ) : (
        <FlatList
          data={list!.syncState === null ? [] : items}
          keyExtractor={(i) => i.key}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.ink} />}
          ListHeaderComponent={
            <View style={{ gap: 10, marginBottom: 6 }}>
              {view.kind === 'remembered' ? (
                <Card padding={12}>
                  <Body size={13.5} accessibilityRole="alert">
                    {view.banner}
                  </Body>
                </Card>
              ) : null}
              {checkNote ? (
                <Body size={13} muted>
                  {checkNote}
                </Body>
              ) : null}
              {list!.syncState === null ? (
                <Card padding={14}>
                  <Body size={14}>{EXCEPTION_FIRST_CHECK_PENDING_COPY}</Body>
                </Card>
              ) : (
                <Body size={12.5} muted>
                  {`Checked at ${exceptionTimeLabel(list!.syncState.lastSyncedAt)}. The system checks every ${EXCEPTION_SYNC_INTERVAL_MINUTES} minutes and after each posted or cancelled count.`}
                </Body>
              )}
              {unchecked.length > 0 ? (
                <Card padding={12}>
                  <Body size={13.5} accessibilityRole="alert">
                    {`${unchecked.length === 1 ? 'One check' : `${unchecked.length} checks`} could not complete on the last run: ${unchecked.join(', ')}. What ${unchecked.length === 1 ? 'it' : 'they'} would show is unknown, not clean.`}
                  </Body>
                </Card>
              ) : null}
              {list!.truncated ? (
                <Body size={12.5} muted>
                  {`Showing the first ${list!.occurrences.length} exceptions. There are more; the web page lists the same set.`}
                </Body>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            list!.syncState === null || unchecked.length > 0 ? null : (
              <View style={styles.empty}>
                <Display size={18}>
                  {status === 'open' ? EXCEPTION_ALL_CLEAR_TITLE : 'Nothing resolved'}
                </Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 320 }}>
                  {status === 'open'
                    ? 'No archived locations holding stock, nothing over-promised, nothing stranded in Staging or Unplaced, and every rack label agrees with where the stock is.'
                    : EXCEPTION_NONE_RESOLVED_COPY}
                </Body>
              </View>
            )
          }
          renderItem={({ item }) =>
            item.type === 'group' ? (
              <GroupHeader meta={item.meta} count={item.count} />
            ) : (
              <OccurrenceRow
                occurrence={item.occurrence}
                title={item.title}
                detail={item.detail}
                state={occurrenceState(
                  {
                    resolvedAt: item.occurrence.resolvedAt,
                    resolvedReason: item.occurrence.resolvedReason,
                    acknowledgedAt: item.occurrence.acknowledgedAt,
                    acknowledgedBy: item.occurrence.acknowledgedBy?.id ?? null,
                    recount: item.occurrence.recount,
                  },
                  list!.syncState?.lastEvaluatedAt ?? null,
                )}
                onPress={() => router.push(`/exceptions/${item.occurrence.id}` as Href)}
              />
            )
          }
        />
      )}
    </View>
  );
}

/** The Open list grouped like the web page (core groupOccurrences); the
 *  Resolved list newest first, as the server ordered it. */
function listItems(list: MobileExceptionList): ListItem[] {
  if (list.status === 'resolved') {
    return list.occurrences.map((o) => {
      const d = describeOccurrence(o.rule, o.facts, {
        itemName: o.item?.name ?? null,
        conditionSince: o.conditionSince,
        asOf: o.resolvedAt ?? new Date(),
      });
      return { type: 'row', key: o.id, occurrence: o, title: d.title, detail: d.detail };
    });
  }
  const out: ListItem[] = [];
  for (const g of groupOccurrences(list.occurrences)) {
    out.push({ type: 'group', key: `group:${g.meta.rule}`, meta: g.meta, count: g.rows.length });
    for (const r of g.rows) {
      out.push({
        type: 'row',
        key: r.occurrence.id,
        occurrence: r.occurrence,
        title: r.description.title,
        detail: r.description.detail,
      });
    }
  }
  return out;
}

function GroupHeader({ meta, count }: { meta: ExceptionRuleMeta; count: number }) {
  return (
    <View style={{ marginTop: 10, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Body size={15} style={{ fontFamily: FONT.display, flexShrink: 1 }}>
          {meta.label}
        </Body>
        <Pill status={meta.severity === 'critical' ? 'crit' : 'warn'} dot={false}>
          {meta.severity === 'critical' ? 'Critical' : 'Warning'}
        </Pill>
        <Mono size={12}>{String(count)}</Mono>
      </View>
      <Body size={13} muted>
        {meta.action}
      </Body>
    </View>
  );
}

function statePillTone(state: OccurrenceState): 'default' | 'ok' | 'warn' {
  if (state.kind === 'resolved') return 'ok';
  if (state.kind === 'open') return 'warn';
  return 'default';
}

function OccurrenceRow({
  occurrence: o,
  title,
  detail,
  state,
  onPress,
}: {
  occurrence: MobileExceptionOccurrence;
  title: string;
  detail: string;
  state: OccurrenceState;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const recurred = recurrenceBadge(o.recurrenceIndex);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={14}>
        {o.reference ? (
          <Mono size={11} color={c.ink4}>
            {o.reference}
          </Mono>
        ) : null}
        <Body size={15.5} color={c.ink} style={{ marginTop: 4, fontFamily: FONT.display }}>
          {title}
        </Body>
        <Body size={13.5} muted style={{ marginTop: 2 }}>
          {detail}
        </Body>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <Pill status={statePillTone(state)} dot={false}>
            {occurrenceStateLabel(state)}
          </Pill>
          {recurred ? (
            <Pill status="default" dot={false}>
              {recurred}
            </Pill>
          ) : null}
        </View>
        <Mono size={11} color={c.ink4} style={{ marginTop: 8 }}>
          {o.resolvedAt
            ? `Resolved ${exceptionTimeLabel(o.resolvedAt)}`
            : o.presentWhenTrackingBegan
              ? 'Already present when tracking began'
              : `First seen ${exceptionTimeLabel(o.firstSeenAt)}`}
        </Mono>
      </Card>
    </Pressable>
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
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingTop: 14 },
  list: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 32, gap: 10 },
  empty: { paddingTop: 36, paddingHorizontal: 24, alignItems: 'center' },
});
