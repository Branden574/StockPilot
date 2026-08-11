import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Hair } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { clearRejected, listRejected, type PendingActionRow } from '@/lib/queue';
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
 */
export default function RejectedWorkScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const [rows, setRows] = React.useState<PendingActionRow[] | null>(null);

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
      'This removes the record of the changes that were never sent. It does not send them — those changes were never applied. Make sure anything still needed has been re-entered first.',
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
          Changes saved on this device that could never be sent to the server. They were not applied
          to your inventory. If they still matter, enter them again.
        </Body>

        {rows === null ? (
          <Card padding={0} style={{ marginTop: 18 }}>
            <View style={styles.empty}>
              <Body muted>Checking…</Body>
            </View>
          </Card>
        ) : rows.length === 0 ? (
          <Card padding={0} style={{ marginTop: 18 }}>
            <View style={styles.empty}>
              <Body>Nothing was left unsent.</Body>
              <Body muted size={13.5} style={{ marginTop: 6 }}>
                Everything you have saved on this device has either synced or is still queued to
                sync.
              </Body>
            </View>
          </Card>
        ) : (
          <View style={{ marginTop: 18 }}>
            <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
              <Eyebrow>{`NEVER SENT · ${rows.length}`}</Eyebrow>
            </View>
            <Card padding={0}>
              {rows.map((row, idx) => (
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
          {`KEPT FOR ${REJECTED_RETENTION_DAYS} DAYS, THEN REMOVED AUTOMATICALLY`}
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
});
