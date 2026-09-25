import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Hair } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { isUnconfirmedAdjustRow } from '@/lib/adjust-outbox';
import { discardHeldAction } from '@/lib/cycle-count-cache';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { clearRejected, listHeld, listRejected, type PendingActionRow } from '@/lib/queue';
import {
  pendingActionLabel,
  REJECTED_KEEP_MAX,
  REJECTED_RETENTION_DAYS,
  rejectedWhen,
} from '@/lib/rejected-work';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Settings → Unsent work.
 *
 * The one surface that renders TERMINALLY REJECTED offline rows. The eviction
 * that follows an account disable parks the whole outbox as 'rejected' — kept
 * on purpose, never re-sent — but until this screen nothing read those rows:
 * `pendingCount` excludes them (correctly, no drain will touch them again), the
 * header badge answered "All synced" over the top of them, and the operator was
 * left believing a dozen stock adjustments had landed. That is the silent loss
 * the rejection design existed to prevent, one layer out.
 *
 * Deliberately a RECORD, not a queue. There is no per-row retry: re-arming work
 * that the server refused — most often because the account was disabled
 * mid-shift — is a decision for a person with the current facts, not a button
 * on a phone. What the screen owes the user is the truth about what was not
 * sent, in their own vocabulary, with the reason and the date attached.
 *
 * SECOND SECTION: work HELD for another account (outbox-scope.ts). A change
 * queued on this device by someone else is never sent under the account
 * signed in now; it waits, untouched, for its owner to sign in here again.
 * It is listed as "Queued by another account" (kind and age only, never the
 * payload) with Discard, the one way to remove it when its owner is not
 * coming back. The rejected record, by contrast, is this account's own.
 *
 * THIRD KIND: stock adjustments NOT CONFIRMED (adjust-outbox.ts). An
 * adjustment queued offline is sent at most once, because its route cannot
 * recognise a replay; when that one send got no answer, the row is parked
 * here although it MAY have been applied. Those rows are listed apart, under
 * "Not confirmed", and this screen never says they were not applied: each
 * row's message names the item and the change to check.
 */
export default function RejectedWorkScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const [rows, setRows] = React.useState<PendingActionRow[] | null>(null);
  const [held, setHeld] = React.useState<PendingActionRow[] | null>(null);

  const [now, setNow] = React.useState(() => Date.now());
  const load = React.useCallback(async () => {
    // Snapshot the clock with the data (compiler purity rule): the relative
    // "when" labels refresh when the list does - every focus - not on
    // arbitrary re-renders.
    setNow(Date.now());
    try {
      // Match the true retention ceiling (REJECTED_KEEP_MAX, pruned to at cold
      // launch), not listRejected's smaller internal default — otherwise the
      // Settings row's unbounded countRejected() and this list disagree
      // anywhere between 101 and 200 rejected rows: a header reading "187
      // never sent" over a list capped at 100.
      setRows(await listRejected(REJECTED_KEEP_MAX));
    } catch (e) {
      console.warn('[rejected-work] could not read the outbox', e);
      setRows([]);
    }
    try {
      setHeld(await listHeld(REJECTED_KEEP_MAX));
    } catch (e) {
      console.warn('[rejected-work] could not read the held work', e);
      setHeld([]);
    }
  }, []);

  // Re-read on focus: the list changes underneath this screen (an eviction can
  // land while it is open) and it is cheap — one indexed SELECT.
  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );


  function confirmClear() {
    Alert.alert(
      'Clear this list?',
      'This removes the record of these changes. It does not send them. Make sure anything still needed has been re-entered first, and that each stock adjustment marked "Not confirmed" was checked on its item.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await clearRejected();
              } catch (e) {
                console.warn('[rejected-work] clear failed', e);
              }
              await load();
              // Repaint the header badge, which counts these rows.
              void cycleCountSync.refreshPendingCount();
            })();
          },
        },
      ],
    );
  }

  function confirmDiscard(row: PendingActionRow) {
    Alert.alert(
      'Discard this change?',
      'It was saved on this device by another account and has not been sent. Discarding removes it for good: it will not be sent when that account signs in here again.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await discardHeldAction(row.id);
              } catch (e) {
                console.warn('[rejected-work] discard failed', e);
              }
              await load();
              void cycleCountSync.refreshPendingCount();
            })();
          },
        },
      ],
    );
  }

  const nothing = rows !== null && held !== null && rows.length === 0 && held.length === 0;
  // The adjustments that MAY have been applied, listed apart from the rest.
  const unconfirmedRows = (rows ?? []).filter(isUnconfirmedAdjustRow);
  const neverSentRows = (rows ?? []).filter((r) => !isUnconfirmedAdjustRow(r));

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/settings' as never);
            }}
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>SETTINGS · OFFLINE WORK</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Unsent <Em>work.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
      >
        <Body muted size={14} style={{ marginTop: 6 }}>
          Changes saved on this device that the server did not accept. They were not applied to
          your inventory. If they still matter, enter them again. A stock adjustment listed as not
          confirmed is different: it may have been applied, so check the item first.
        </Body>

        {held !== null && held.length > 0 ? (
          <View style={{ marginTop: 18 }}>
            <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
              <Eyebrow>{`QUEUED BY ANOTHER ACCOUNT · ${held.length}`}</Eyebrow>
            </View>
            <Card padding={0}>
              {held.map((row, idx) => (
                <View key={row.id}>
                  {idx > 0 ? <Hair /> : null}
                  <View style={styles.row}>
                    <View style={styles.rowHead}>
                      <Body size={15.5} style={{ fontFamily: FONT.display, flexShrink: 1 }}>
                        {pendingActionLabel(row.kind)}
                      </Body>
                      <Mono size={11} color={c.ink4}>
                        {rejectedWhen(row.createdAt, now)}
                      </Mono>
                    </View>
                    <Body muted size={13.5} style={{ marginTop: 4 }}>
                      Queued by another account. It sends when that account signs in on this device.
                    </Body>
                    <Pressable
                      onPress={() => confirmDiscard(row)}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel={`Discard ${pendingActionLabel(row.kind)} queued by another account`}
                      style={({ pressed }) => [styles.discard, { opacity: pressed ? 0.7 : 1 }]}
                    >
                      <Body size={14} color={ACCENT.crit} style={{ fontFamily: FONT.display }}>
                        Discard
                      </Body>
                    </Pressable>
                  </View>
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {rows === null || held === null ? (
          <Card padding={0} style={{ marginTop: 18 }}>
            <View style={styles.empty}>
              <Body muted>Checking…</Body>
            </View>
          </Card>
        ) : nothing ? (
          <Card padding={0} style={{ marginTop: 18 }}>
            <View style={styles.empty}>
              <Body>Nothing was left unsent.</Body>
              <Body muted size={13.5} style={{ marginTop: 6 }}>
                Everything you have saved on this device has either synced or is still queued to
                sync.
              </Body>
            </View>
          </Card>
        ) : rows.length === 0 ? null : (
          <View style={{ marginTop: 18 }}>
            {unconfirmedRows.length > 0 ? (
              <View style={{ marginBottom: 18 }}>
                <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
                  <Eyebrow>{`NOT CONFIRMED · ${unconfirmedRows.length}`}</Eyebrow>
                </View>
                <Card padding={0}>
                  {unconfirmedRows.map((row, idx) => (
                    <View key={row.id}>
                      {idx > 0 ? <Hair /> : null}
                      <View style={styles.row}>
                        <View style={styles.rowHead}>
                          <Body size={15.5} style={{ fontFamily: FONT.display, flexShrink: 1 }}>
                            {pendingActionLabel(row.kind)}
                          </Body>
                          <Mono size={11} color={c.ink4}>
                            {rejectedWhen(row.lastAttemptAt ?? row.createdAt, now)}
                          </Mono>
                        </View>
                        {/* Warn, not crit: this may have worked. The message
                            names the item and the change to check. */}
                        <Body size={13.5} color={ACCENT.warn} style={{ marginTop: 4 }}>
                          {row.lastError}
                        </Body>
                        <Mono size={10} tracking={0.1} color={c.ink4} style={{ marginTop: 6 }}>
                          {row.idempotencyKey.slice(0, 8).toUpperCase()}
                        </Mono>
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}
            {neverSentRows.length > 0 ? (
              <>
                <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
                  <Eyebrow>{`NEVER SENT · ${neverSentRows.length}`}</Eyebrow>
                </View>
                <Card padding={0}>
                  {neverSentRows.map((row, idx) => (
                    <View key={row.id}>
                      {idx > 0 ? <Hair /> : null}
                      <View style={styles.row}>
                        <View style={styles.rowHead}>
                          <Body size={15.5} style={{ fontFamily: FONT.display, flexShrink: 1 }}>
                            {pendingActionLabel(row.kind)}
                          </Body>
                          <Mono size={11} color={c.ink4}>
                            {rejectedWhen(row.lastAttemptAt ?? row.createdAt, now)}
                          </Mono>
                        </View>
                        {row.lastError ? (
                          <Body size={13.5} color={ACCENT.crit} style={{ marginTop: 4 }}>
                            {row.lastError}
                          </Body>
                        ) : null}
                        <Mono size={10} tracking={0.1} color={c.ink4} style={{ marginTop: 6 }}>
                          {row.idempotencyKey.slice(0, 8).toUpperCase()}
                        </Mono>
                      </View>
                    </View>
                  ))}
                </Card>
              </>
            ) : null}

            <Pressable
              onPress={confirmClear}
              hitSlop={10}
              style={({ pressed }) => [styles.clear, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Body size={14.5} color={ACCENT.crit} style={{ fontFamily: FONT.display }}>
                Clear this list
              </Body>
            </Pressable>
          </View>
        )}

        <Mono size={10} tracking={0.1} color={c.ink4} style={{ marginTop: 18 }}>
          {/* Retention applies to this account's record only (never sent and
              not confirmed): work held for another account is never removed
              except by Discard. */}
          {`THESE RECORDS ARE KEPT FOR ${REJECTED_RETENTION_DAYS} DAYS, THEN REMOVED AUTOMATICALLY`}
        </Mono>
      </ScrollView>
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
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  empty: { paddingVertical: 22, paddingHorizontal: 16 },
  row: { paddingVertical: 14, paddingHorizontal: 16 },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
  },
  clear: { paddingVertical: 14, paddingHorizontal: 4, alignSelf: 'flex-start' },
  discard: { paddingTop: 10, alignSelf: 'flex-start' },
});
