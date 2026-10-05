import { type Href, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, Menu, Undo2 } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  availableReturnListFilters,
  RETURNS_COPY,
  returnStatusLabel,
  type ReturnListFilterId,
} from '@stockpilot/core';

import { ReturnWorkbenchView } from '@/components/return-workbench-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { IconChip } from '@/components/ui/row';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { createDebouncedScheduler, createSequenceGuard } from '@/lib/debounced-list-load';
import { useEnabledModules } from '@/lib/enabled-modules';
import { describeReturnError, listReturns, type MobileReturnListRow } from '@/lib/returns-api';
import { returnRowItems, returnRowMeta, returnRowTitle, returnRowWaiting, returnStatusTone } from '@/lib/returns-view';
import { FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useTheme } from '@/lib/use-theme';
import { showWriteCta } from '@/lib/cta-gating';

/**
 * Returns: the phone twin of the web /dashboard/returns list (returns RX-1).
 * The same filters RX-1 offers on the web (core availableReturnListFilters:
 * All, Awaiting approval, Waiting for returned item, Received, not
 * processed, Closed), a search over the RMA number, SO number and requester,
 * and pages of 25 that load as the list scrolls (keyset cursor from GET
 * /api/v1/returns). Pull to refresh starts again from the first page.
 *
 * Gated like the drawer entry: the returns module on, and returns:read or
 * returns:manage. Reading works offline only as far as the last load; no
 * return action lives here (the workbench holds them, online only).
 */
const SEARCH_DEBOUNCE_MS = 250;
/** From this window width the list keeps the RMA beside it (iPad split view). */
const SPLIT_MIN_WIDTH = 900;

export default function ReturnsListScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const enabledModules = useEnabledModules();
  const enabled = enabledModules.has('returns');
  const perms = useEffectivePermissions();
  const canRead = showWriteCta(perms, 'returns:read') || showWriteCta(perms, 'returns:manage');
  const filters = availableReturnListFilters({ exchanges: false });
  // iPad (and any wide window): the list and the selected RMA side by side.
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_MIN_WIDTH;
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const [filter, setFilter] = React.useState<ReturnListFilterId>('all');
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<MobileReturnListRow[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [scheduler] = React.useState(() => createDebouncedScheduler(SEARCH_DEBOUNCE_MS));
  const [guard] = React.useState(() => createSequenceGuard());
  // Page loads: a fresh first-page load invalidates any page still loading.
  const [moreGuard] = React.useState(() => createSequenceGuard());

  const load = React.useCallback(async () => {
    if (!enabled || !canRead) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const seq = guard.next();
    moreGuard.next();
    setLoadError(null);
    try {
      const page = await listReturns({ filter, q });
      if (!guard.isCurrent(seq)) return;
      setRows(page.rows);
      setCursor(page.nextCursor);
    } catch (e) {
      if (!guard.isCurrent(seq)) return;
      setLoadError(describeReturnError(e));
    } finally {
      if (guard.isCurrent(seq)) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled, canRead, filter, q, guard, moreGuard]);

  React.useEffect(() => {
    scheduler.schedule(() => void load());
    return () => scheduler.cancel();
  }, [load, scheduler]);

  // Back from a workbench: the RMA may have moved on.
  useFocusEffect(
    React.useCallback(() => {
      scheduler.schedule(() => void load());
    }, [load, scheduler]),
  );

  async function loadMore() {
    if (!cursor || loadingMore || loading) return;
    setLoadingMore(true);
    const seq = moreGuard.next();
    try {
      const page = await listReturns({ filter, q, cursor });
      if (!moreGuard.isCurrent(seq)) return;
      setRows((prev) => [...prev, ...page.rows.filter((r) => !prev.some((p) => p.id === r.id))]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (moreGuard.isCurrent(seq)) setLoadError(describeReturnError(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={styles.chips}>
            <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
            <IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />
          </View>
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Undo2 size={16} color={c.ink3} strokeWidth={1.5} />
            <Eyebrow>RETURNS</Eyebrow>
          </View>
          <Display size={32} style={{ marginTop: 12 }}>
            Returns <Em>and RMAs.</Em>
          </Display>
        </View>
      </SafeAreaView>

      {!enabled || !canRead ? (
        <View style={{ paddingHorizontal: 20, marginTop: 8 }}>
          <Card padding={16}>
            <Body size={14.5}>
              {!enabled
                ? 'Returns aren’t enabled for this workspace. Ask an admin to enable them in Settings → Modules.'
                : 'You don’t have permission to view returns.'}
            </Body>
          </Card>
        </View>
      ) : (
        <>
          <View style={styles.toolbar}>
            {/* Buttons with a selected state, like the shared Chip: iOS gives
                the "tab" role no trait, so VoiceOver read the filters without
                saying they can be pressed (RX-1 simulator matrix). */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {filters.map((f) => (
                <Pressable
                  key={f.id}
                  onPress={() => setFilter(f.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: filter === f.id }}
                  accessibilityLabel={f.label}
                  hitSlop={6}
                >
                  <Pill status={filter === f.id ? 'ok' : 'default'} dot={false}>
                    {f.label}
                  </Pill>
                </Pressable>
              ))}
            </View>
            <Field
              label="SEARCH"
              value={q}
              onChangeText={setQ}
              placeholder={RETURNS_COPY.listSearchPlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={{ marginTop: 12 }}
            />
          </View>

          {loadError && rows.length === 0 ? (
            <View style={{ paddingHorizontal: 20, marginTop: 8 }}>
              <Card padding={16}>
                <Body size={14.5}>{loadError}</Body>
                <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
                  <Button variant="outline" size="sm" onPress={() => void load()}>
                    Try again
                  </Button>
                </View>
              </Card>
            </View>
          ) : loading ? (
            <ActivityIndicator color={c.ink4} style={{ marginTop: 32 }} />
          ) : (
            <View style={split ? styles.split : { flex: 1 }}>
            <FlatList
              style={split ? styles.splitList : undefined}
              data={rows}
              keyExtractor={(r) => r.id}
              contentContainerStyle={styles.list}
              keyboardDismissMode="on-drag"
              onEndReachedThreshold={0.4}
              onEndReached={() => void loadMore()}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    setRefreshing(true);
                    void load();
                  }}
                  tintColor={c.ink}
                />
              }
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Undo2 size={32} color={c.ink4} strokeWidth={1.3} style={{ marginBottom: 12 }} />
                  <Display size={18}>{RETURNS_COPY.listEmpty}</Display>
                </View>
              }
              ListFooterComponent={
                loadingMore ? <ActivityIndicator color={c.ink4} style={{ marginVertical: 16 }} /> : null
              }
              renderItem={({ item }) => (
                <ReturnRow
                  row={item}
                  selected={split && selectedId === item.id}
                  onPress={() => (split ? setSelectedId(item.id) : router.push(`/returns/${item.id}` as Href))}
                />
              )}
            />
            {split ? (
              <View style={[styles.splitDetail, { borderColor: c.hair }]}>
                {selectedId ? (
                  <ReturnWorkbenchView key={selectedId} returnId={selectedId} compact />
                ) : (
                  <View style={styles.empty}>
                    <Body muted>Choose a return to see it here.</Body>
                  </View>
                )}
              </View>
            ) : null}
            </View>
          )}
        </>
      )}
    </View>
  );
}

function ReturnRow({ row, selected = false, onPress }: { row: MobileReturnListRow; selected?: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const waiting = returnRowWaiting(row);
  const label = `${returnRowTitle(row)}, ${returnStatusLabel(row.status)}, ${returnRowMeta(row)}, ${returnRowItems(row)}${
    waiting ? `, ${waiting.label}` : ''
  }`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={16} style={selected ? { borderColor: c.ink, borderWidth: 1 } : undefined}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
              {returnRowTitle(row)}
            </Mono>
            <Body size={15.5} color={c.ink} numberOfLines={2} style={{ marginTop: 6, fontFamily: FONT.display }}>
              {returnRowMeta(row)}
            </Body>
          </View>
          <Pill status={returnStatusTone(row.status)} dot={false}>
            {returnStatusLabel(row.status)}
          </Pill>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          {row.items.map((it) =>
            it.thumbUrl ? (
              <Image key={it.itemId} source={{ uri: it.thumbUrl }} style={[styles.thumb, { backgroundColor: c.paper2 }]} accessibilityIgnoresInvertColors />
            ) : (
              <View key={it.itemId} style={[styles.thumb, { backgroundColor: c.paper2 }]} />
            ),
          )}
          <Body size={13} muted numberOfLines={2} style={{ flex: 1 }}>
            {returnRowItems(row)}
          </Body>
        </View>
        {waiting ? (
          <Mono size={11} tracking={0.04} color={waiting.overdue ? c.ink : c.ink4} style={{ marginTop: 8 }}>
            {waiting.label}
          </Mono>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: { paddingHorizontal: 12, paddingTop: 5, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -3 },
  head: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 4 },
  toolbar: { paddingHorizontal: 20, paddingTop: 16 },
  list: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24, gap: 10 },
  empty: { paddingTop: 40, paddingHorizontal: 24, alignItems: 'center' },
  thumb: { width: 36, height: 36, borderRadius: 6 },
  split: { flex: 1, flexDirection: 'row' },
  splitList: { width: 380, flexGrow: 0 },
  splitDetail: { flex: 1, borderLeftWidth: 1 },
});
