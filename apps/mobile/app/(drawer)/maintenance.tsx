import { type Href, useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, Menu, Plus, Wrench } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  formatMaintenanceRequestNumber,
  MAINTENANCE_STATUS_LABELS,
  type MaintenanceStatus,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { IconChip } from '@/components/ui/row';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { showWriteCta } from '@/lib/cta-gating';
import {
  createDebouncedScheduler,
  createSequenceGuard,
  type DebouncedScheduler,
  type SequenceGuard,
} from '@/lib/debounced-list-load';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  listMaintenanceRequests,
  type MobileMaintenanceListRow,
} from '@/lib/maintenance-api';
import { FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useTheme } from '@/lib/use-theme';

/**
 * Maintenance requests — mobile twin of the web /dashboard/maintenance list
 * (Task 11's `/api/v1/maintenance-requests` route). Module + permission
 * gating go through the shared registry mechanisms mobile already uses
 * (useEnabledModules / useEffectivePermissions), never a bespoke check — the
 * placement itself (MODULE_REGISTRY.maintenance_requests, mobile_drawer at
 * '/maintenance') shipped in Task 3, so this file is the last piece needed
 * for a tap on "Maintenance" in the drawer to land anywhere at all.
 *
 * Brief §22 (mirrored verbatim from the web page, page.tsx): search + the
 * all-org scope are a read_all/manage affordance only — a submit-only
 * requester sees just their own list with no search box, and the list
 * itself carries the same informational note the web page does, saying
 * plainly that ticket state lives in Outlook/Zendesk and is not
 * synchronized here.
 *
 * Route contract (Task 11, fixed): the list route accepts no limit/offset,
 * so this always shows the newest 50 rows — there is no "load more" to
 * build, and this screen does not pretend otherwise.
 */
const STATUS_PILL: Record<MaintenanceStatus, 'default' | 'warn' | 'ok' | 'crit'> = {
  saved: 'default',
  draft_opened: 'warn',
  resolved: 'ok',
  archived: 'default',
  cancelled: 'default',
};

const SECTION_22_NOTE =
  'Ticket updates and replies are handled through the Outlook/Zendesk email conversation and are not synchronized into StockPilot.';

// Same 250ms window inventory.tsx / books.tsx already debounce their own
// search effects by — a scope toggle rides the same delay too (masked by the
// loading skeleton), matching how those screens also debounce a filter tap,
// not just typed characters.
const SEARCH_DEBOUNCE_MS = 250;

export default function MaintenanceListScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const enabledModules = useEnabledModules();
  const enabled = enabledModules.has('maintenance_requests');
  const perms = useEffectivePermissions();
  const canReadAll =
    showWriteCta(perms, 'maintenance_requests:read_all') ||
    showWriteCta(perms, 'maintenance_requests:manage');
  const canSubmit = showWriteCta(perms, 'maintenance_requests:submit');

  const [scope, setScope] = React.useState<'mine' | 'all'>('mine');
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<MobileMaintenanceListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // `q` changes on every keystroke; without the debounce below that fires a
  // fresh GET per character. The sequence guard is a second, independent
  // safeguard the debounce alone does not provide: even with debouncing, a
  // slow response for an older call can still land after a fast response for
  // a newer one, and only the guard — not timing — stops it from overwriting
  // rows a newer call already owns. Same two idioms this app already uses
  // inline elsewhere (see debounced-list-load.ts's own doc comment).
  const schedulerRef = React.useRef<DebouncedScheduler | null>(null);
  if (!schedulerRef.current) schedulerRef.current = createDebouncedScheduler(SEARCH_DEBOUNCE_MS);
  const guardRef = React.useRef<SequenceGuard | null>(null);
  if (!guardRef.current) guardRef.current = createSequenceGuard();

  const load = React.useCallback(async () => {
    // Invisible when off, not just unreachable: a disabled org never fires
    // the request at all, matching the drawer entry that never appears.
    if (!enabled) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const seq = guardRef.current!.next();
    setLoadError(null);
    try {
      const res = await listMaintenanceRequests({ scope, q: q.trim() || undefined });
      if (!guardRef.current!.isCurrent(seq)) return; // stale — a newer load owns the list now
      setRows(res);
    } catch (e) {
      if (!guardRef.current!.isCurrent(seq)) return;
      setLoadError(
        e instanceof Error ? e.message : "Couldn't load maintenance requests. Try again.",
      );
    } finally {
      if (guardRef.current!.isCurrent(seq)) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled, scope, q]);

  React.useEffect(() => {
    const scheduler = schedulerRef.current!;
    scheduler.schedule(() => void load());
    return () => scheduler.cancel();
  }, [load]);

  function onRefresh() {
    setRefreshing(true);
    void load();
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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip icon={ArrowLeft} onPress={goBack} />
            <IconChip icon={Menu} onPress={openDrawer} />
          </View>
          {enabled && canSubmit ? (
            <Pressable
              onPress={() => router.push('/maintenance/new' as Href)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.newBtn,
                { borderColor: c.hair, backgroundColor: c.card, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Plus size={14} color={c.ink} strokeWidth={1.8} />
              <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.display }}>
                New
              </Mono>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Wrench size={16} color={c.ink3} strokeWidth={1.5} />
            <Eyebrow>MAINTENANCE · {scope === 'all' ? 'ALL REQUESTS' : 'MY REQUESTS'}</Eyebrow>
          </View>
          <Display size={32} style={{ marginTop: 12 }}>
            Maintenance <Em>requests.</Em>
          </Display>
        </View>
      </SafeAreaView>

      {!enabled ? (
        <View style={{ paddingHorizontal: 20, marginTop: 8 }}>
          <Card padding={16}>
            <Body size={14.5}>
              Maintenance requests aren’t enabled for this workspace. Ask an admin to enable it in
              Settings → Modules.
            </Body>
          </Card>
        </View>
      ) : (
        <>
          <View style={styles.toolbar}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable onPress={() => setScope('mine')}>
                <Pill status={scope === 'mine' ? 'ok' : 'default'} dot={false}>
                  My requests
                </Pill>
              </Pressable>
              {canReadAll ? (
                <Pressable onPress={() => setScope('all')}>
                  <Pill status={scope === 'all' ? 'ok' : 'default'} dot={false}>
                    All requests
                  </Pill>
                </Pressable>
              ) : null}
            </View>
            {scope === 'all' ? (
              <Field
                label="SEARCH"
                value={q}
                onChangeText={setQ}
                placeholder="Search request #, subject, description, requester…"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={{ marginTop: 12 }}
              />
            ) : null}
          </View>

          {loadError ? (
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
            <FlatList
              data={rows}
              keyExtractor={(r) => r.id}
              contentContainerStyle={styles.list}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} />
              }
              ListHeaderComponent={
                <Body muted size={12.5} style={{ marginBottom: 12 }}>
                  {SECTION_22_NOTE}
                </Body>
              }
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Wrench size={32} color={c.ink4} strokeWidth={1.3} style={{ marginBottom: 12 }} />
                  <Display size={18}>No maintenance requests</Display>
                  <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 320 }}>
                    {canSubmit
                      ? 'Report a facilities or equipment issue and StockPilot will prepare the email for you.'
                      : 'Nothing to show yet.'}
                  </Body>
                </View>
              }
              renderItem={({ item }) => (
                <MaintenanceRow
                  row={item}
                  showRequester={scope === 'all'}
                  onPress={() => router.push(`/maintenance/${item.id}` as Href)}
                />
              )}
            />
          )}
        </>
      )}
    </View>
  );
}

function MaintenanceRow({
  row,
  showRequester,
  onPress,
}: {
  row: MobileMaintenanceListRow;
  showRequester: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const handle = formatMaintenanceRequestNumber(row.requestNumber, row.createdAt) ?? `#${row.requestNumber}`;
  const pillStatus = STATUS_PILL[row.status] ?? 'default';

  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card padding={16}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
              {handle}
            </Mono>
            <Body
              size={15.5}
              color={c.ink}
              numberOfLines={2}
              style={{ marginTop: 6, fontFamily: FONT.display }}
            >
              {row.subject}
            </Body>
          </View>
          <Pill status={pillStatus} dot={false}>
            {MAINTENANCE_STATUS_LABELS[row.status]}
          </Pill>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          <Mono size={11} tracking={0.04} upper color={c.ink4}>
            {row.priority}
          </Mono>
          {row.category ? (
            <Mono size={11} tracking={0.04} color={c.ink4}>
              {row.category}
            </Mono>
          ) : null}
          {row.siteName ? (
            <Mono size={11} tracking={0.04} color={c.ink4}>
              {row.siteName}
            </Mono>
          ) : null}
          {showRequester ? (
            <Mono size={11} tracking={0.04} color={c.ink4}>
              {row.requesterName}
            </Mono>
          ) : null}
          <Mono size={11} tracking={0.04} color={c.ink4}>
            {row.photoCount} photo{row.photoCount === 1 ? '' : 's'}
          </Mono>
        </View>
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
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  toolbar: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  list: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 10,
  },
  empty: {
    paddingTop: 40,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
});
