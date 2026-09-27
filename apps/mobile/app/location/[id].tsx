import { useNetworkState } from 'expo-network';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY,
  LOCATION_RECOUNT_LABEL,
  VERIFICATION_UNAVAILABLE_COPY,
  locationOpenIssuesEmptyCopy,
  locationRowVerificationCopy,
  locationVerificationTotalsCopy,
  verificationIssueChipCopy,
} from '@stockpilot/core';

import { ExceptionRecountSheet } from '@/components/exception-recount-sheet';
import { IssueChip } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { isOfflineState } from '@/lib/exceptions-api';
import { ACCENT, FONT } from '@/lib/theme';
import { useOrg } from '@/lib/use-org';
import { useTheme } from '@/lib/use-theme';
import { retryWorkspace } from '@/lib/use-workspace';
import {
  LOCATION_HOLDINGS_TRUNCATED_COPY,
  LOCATION_WORKSPACE_UNAVAILABLE,
  VERIFICATION_ISSUES_TRUNCATED_COPY,
  describeVerificationError,
  gatherRecountItemIds,
  getLocationVerification,
  locationKindLabel,
  locationRecountState,
  locationRowAccessibilityLabel,
  locationRowQuantityCopy,
  verificationCheckedAtCopy,
  verificationFailure,
  verificationKey,
  verificationView,
  type MobileLocationVerification,
  type MobileLocationVerificationRow,
  type StoredVerification,
} from '@/lib/verification-api';

/**
 * One location (F1-3): the native twin of /dashboard/locations/[id], reached
 * from a row of the Locations screen, an exception's location, or a web link
 * (web-path-rewrite.ts). Reads GET /api/v1/locations/[id]/verification, the
 * service the web page renders, 50 items a page:
 *
 *   - the location's name, kind, warehouse and whether it is archived;
 *   - the open exceptions recorded here, with when they were last checked;
 *   - every item held here that this reader can open, by name, with the units
 *     here and what the item's latest physical count says about THIS place
 *     (core locationRowVerificationCopy, the web's words), and a totals line
 *     across EVERY row, not just the page;
 *   - "Recount items here" for a reader the server says may start one,
 *     disabled with the reason when nothing here can be counted, too many
 *     items can, or the phone is offline.
 *
 * A failed read says "Couldn't load verification" with why and Try again;
 * never an empty location. When the reader's warehouses do not cover this
 * location, the stock and the open exceptions are not listed and the screen
 * says why (never "nothing here", never "none recorded"); with items here the
 * reader cannot open, no chips is "none you can see" (core
 * locationOpenIssuesEmptyCopy, the web page's words). Offline, the page
 * already on screen stays with its time.
 */

type Gather =
  | { kind: 'idle' }
  | { kind: 'gathering' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; itemIds: string[] };

export default function LocationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { orgId, loading: workspaceLoading } = useOrg();
  const offline = isOfflineState(useNetworkState());
  const [page, setPage] = React.useState(1);
  const [stored, setStored] = React.useState<StoredVerification<MobileLocationVerification> | null>(
    null,
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const [retryingWorkspace, setRetryingWorkspace] = React.useState(false);
  const [gather, setGather] = React.useState<Gather>({ kind: 'idle' });
  // Only the newest read may land: one for another page, location or
  // workspace, or one overtaken by a refresh, is dropped.
  const seqRef = React.useRef(0);
  const key = verificationKey(id, orgId, page);

  const load = React.useCallback(async () => {
    // Offline there is nothing to ask; the view below is derived instead.
    if (!id || !orgId || key === null || offline) return;
    const seq = ++seqRef.current;
    try {
      const data = await getLocationVerification(id, { orgId, page });
      if (seq !== seqRef.current) return;
      setStored({ key, kind: 'ready', data, receivedAt: new Date().toISOString(), banner: null });
    } catch (e) {
      if (seq !== seqRef.current) return;
      setStored((prev) => verificationFailure(prev, key, e, 'location', (d) => d.timeZone));
    }
  }, [id, orgId, page, key, offline]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const view = verificationView(stored, key, offline, (d) => d.timeZone);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/locations' as Href);
  }

  // Pull to refresh and Try again: the spinner ends when THIS read ends.
  async function reload() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  // No workspace could be loaded (a launch offline, or a failed first read
  // after signing in): the read above never starts. Try again loads the
  // workspace again, as the rental screens do (use-workspace.ts).
  async function reloadWorkspace() {
    setRetryingWorkspace(true);
    try {
      await retryWorkspace();
    } finally {
      setRetryingWorkspace(false);
    }
  }

  async function recountHere(data: MobileLocationVerification) {
    setGather({ kind: 'gathering' });
    try {
      const res = await gatherRecountItemIds(data, (p) =>
        getLocationVerification(data.location.id, { orgId: data.organizationId, page: p }),
      );
      setGather(
        res.ok ? { kind: 'ready', itemIds: res.itemIds } : { kind: 'failed', message: res.message },
      );
    } catch (e) {
      setGather({
        kind: 'failed',
        message: `The items here could not be gathered. ${describeVerificationError(e, 'location').detail}`,
      });
    }
  }

  if (!orgId && !workspaceLoading) {
    return (
      <View style={[styles.root, { backgroundColor: c.paper }]}>
        <TopBar onBack={goBack} />
        <View style={styles.pad}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {LOCATION_WORKSPACE_UNAVAILABLE}
            </Body>
            <Button
              size="sm"
              variant="outline"
              disabled={retryingWorkspace}
              onPress={() => void reloadWorkspace()}
              style={{ alignSelf: 'flex-start', marginTop: 12 }}
            >
              Try again
            </Button>
          </Card>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <TopBar onBack={goBack} />

      {view.kind === 'loading' ? (
        <ActivityIndicator
          color={c.ink4}
          style={{ marginTop: 32 }}
          accessibilityLabel="Loading this location"
        />
      ) : view.kind === 'error' ? (
        <View style={styles.pad}>
          <Card padding={16}>
            <Body size={15} accessibilityRole="alert" style={{ fontFamily: FONT.display }}>
              {VERIFICATION_UNAVAILABLE_COPY}
            </Body>
            <Body size={13.5} muted style={{ marginTop: 6 }}>
              {view.error.detail}
            </Body>
            {view.error.retry ? (
              <Button
                size="sm"
                variant="outline"
                disabled={refreshing}
                onPress={() => void reload()}
                style={{ alignSelf: 'flex-start', marginTop: 12 }}
              >
                Try again
              </Button>
            ) : null}
          </Card>
        </View>
      ) : (
        <LocationBody
          data={view.data}
          banner={view.banner}
          offline={offline}
          refreshing={refreshing}
          gather={gather}
          onRefresh={() => void reload()}
          onPage={(p) => {
            setGather({ kind: 'idle' });
            setPage(p);
          }}
          onRecount={() => void recountHere(view.data)}
          onNavigate={(href) => router.push(href as Href)}
        />
      )}

      {view.kind === 'ready' ? (
        <ExceptionRecountSheet
          visible={gather.kind === 'ready'}
          title={LOCATION_RECOUNT_LABEL}
          itemIds={gather.kind === 'ready' ? gather.itemIds : []}
          orgId={orgId ?? null}
          online={!offline}
          timeZone={view.data.timeZone}
          onClose={() => setGather({ kind: 'idle' })}
          onDone={() => {
            setGather({ kind: 'idle' });
            // Re-read, so the rows show the count now holding them.
            void load();
          }}
          onOpenCount={(cycleCountId) => {
            setGather({ kind: 'idle' });
            router.push(`/cycle-count/${cycleCountId}` as Href);
          }}
        />
      ) : null}
    </View>
  );
}

function LocationBody({
  data,
  banner,
  offline,
  refreshing,
  gather,
  onRefresh,
  onPage,
  onRecount,
  onNavigate,
}: {
  data: MobileLocationVerification;
  banner: string | null;
  offline: boolean;
  refreshing: boolean;
  gather: Gather;
  onRefresh: () => void;
  onPage: (page: number) => void;
  onRecount: () => void;
  onNavigate: (href: string) => void;
}) {
  const { c } = useTheme();
  const loc = data.location;
  const recount = locationRecountState(data, !offline);
  const rangeStart = (data.page - 1) * data.pageSize + 1;
  // Read under the reader's RLS: "none" only when nothing here is hidden.
  const noIssues = locationOpenIssuesEmptyCopy({
    holdingsVisible: data.holdingsVisible,
    hiddenItems: data.totals?.hiddenItems ?? 0,
    checkedAt: data.checkedAt,
  });

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} />
      }
    >
      {banner ? (
        <Card padding={12}>
          <Body size={13.5} accessibilityRole="alert">
            {banner}
          </Body>
        </Card>
      ) : null}

      <View style={{ gap: 8 }}>
        <Eyebrow>
          {[locationKindLabel(loc.kind, loc.type), loc.warehouseName]
            .filter(Boolean)
            .join(' · ')
            .toUpperCase()}
        </Eyebrow>
        {/* The name is content: no Dynamic Type cap (Display's default
            ceiling is for chrome headings). */}
        <Display size={28} maxFontSizeMultiplier={0}>
          {loc.name}
        </Display>
        {loc.archived ? (
          <Pill status="default" dot={false}>
            ARCHIVED
          </Pill>
        ) : null}
      </View>

      {/* Open issues here: the chips; none only after a check has run (before
          the first one, that it has not run: never an all-clear), and only
          when nothing here is hidden from the reader. */}
      <View style={{ gap: 8 }}>
        <Eyebrow>OPEN ISSUES HERE</Eyebrow>
        {data.openIssues.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {data.openIssues.map((issue) => (
              <IssueChip
                key={issue.id}
                text={verificationIssueChipCopy(issue)}
                onPress={() => onNavigate(`/exceptions/${issue.id}`)}
              />
            ))}
          </View>
        ) : (
          <Body size={14} muted>
            {noIssues.text}
          </Body>
        )}
        {data.openIssuesTruncated ? (
          <Body size={12.5} muted>
            {VERIFICATION_ISSUES_TRUNCATED_COPY}
          </Body>
        ) : null}
        {data.checkedAt !== null ? (
          <Body size={12.5} muted>
            {verificationCheckedAtCopy(data.checkedAt, data.timeZone)}
          </Body>
        ) : null}
      </View>

      {!data.holdingsVisible || !data.totals ? (
        <Card padding={16}>
          <Eyebrow>STOCK HERE</Eyebrow>
          <Body size={14.5} style={{ marginTop: 8 }}>
            {LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY}
          </Body>
        </Card>
      ) : (
        <>
          <Card padding={16}>
            <Eyebrow>STOCK HERE</Eyebrow>
            <Body size={14.5} style={{ marginTop: 8 }}>
              {locationVerificationTotalsCopy(data.totals, {
                locationKind: loc.kind,
                locationType: loc.type,
              })}
            </Body>
            {data.truncated ? (
              <Body size={13} color={ACCENT.warn} style={{ marginTop: 6 }}>
                {LOCATION_HOLDINGS_TRUNCATED_COPY}
              </Body>
            ) : null}
            {recount.show ? (
              <View style={{ marginTop: 14, gap: 8 }}>
                <Button
                  block
                  variant="outline"
                  disabled={recount.disabledReason !== null || gather.kind === 'gathering'}
                  onPress={onRecount}
                >
                  {gather.kind === 'gathering' ? 'Gathering the items...' : LOCATION_RECOUNT_LABEL}
                </Button>
                {recount.disabledReason ? (
                  <Body size={13} muted>
                    {recount.disabledReason}
                  </Body>
                ) : null}
                {gather.kind === 'failed' ? (
                  <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
                    {gather.message}
                  </Body>
                ) : null}
              </View>
            ) : null}
          </Card>

          <View style={{ gap: 10 }}>
            {data.rows.map((row) => (
              <LocationRow
                key={row.itemId}
                row={row}
                locationId={loc.id}
                locationKind={loc.kind}
                locationType={loc.type}
                timeZone={data.timeZone}
                onPress={() => onNavigate(`/item/${row.itemId}`)}
              />
            ))}
          </View>

          <Paginator
            page={data.page}
            pageCount={data.pageCount}
            rangeStart={rangeStart}
            rangeEnd={rangeStart + data.rows.length - 1}
            total={data.totalRows}
            onPageChange={onPage}
          />
        </>
      )}
    </ScrollView>
  );
}

/**
 * One item held here. The whole row opens the item; its exception chips are
 * words inside the row (a touchable inside a touchable is unreachable with
 * VoiceOver), and the row reads as one element with every line in order.
 */
function LocationRow({
  row,
  locationId,
  locationKind,
  locationType,
  timeZone,
  onPress,
}: {
  row: MobileLocationVerificationRow;
  locationId: string;
  locationKind: string | null;
  locationType: string | null;
  timeZone: string | null;
  onPress: () => void;
}) {
  const { c } = useTheme();
  // Past the AX threshold the name and the units stack (both are content, so
  // neither is capped; side by side the units squeezed the name to a sliver).
  const stacked = shouldStackRow(useWindowDimensions().fontScale);
  const copy = locationRowVerificationCopy(row.summary, locationId, {
    timeZone,
    locationKind,
    locationType,
  });
  const chips = row.issues.map((i) => verificationIssueChipCopy(i));
  const unavailable = row.summary === null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={locationRowAccessibilityLabel(row, copy, chips)}
      accessibilityHint="Opens the item"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View
          style={{
            flexDirection: stacked ? 'column' : 'row',
            alignItems: 'flex-start',
            gap: stacked ? 4 : 12,
          }}
        >
          <View style={stacked ? undefined : { flex: 1, minWidth: 0 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
              {row.name}
            </Body>
            {row.sku ? (
              <Mono size={11} color={c.ink4} style={{ marginTop: 2 }}>
                {row.sku}
              </Mono>
            ) : null}
          </View>
          <Mono size={13} color={c.ink}>
            {locationRowQuantityCopy(row.quantity)}
          </Mono>
        </View>
        <View style={{ marginTop: 8, gap: 3 }}>
          <Body size={13.5} color={unavailable ? ACCENT.warn : c.ink}>
            {copy.count}
          </Body>
          {copy.movementsSince ? (
            <Body size={13} muted>
              {copy.movementsSince}
            </Body>
          ) : null}
          {copy.beingCounted ? (
            <Body size={13} muted>
              {copy.beingCounted.text}
            </Body>
          ) : null}
          {copy.notCountable ? (
            <Body size={13} muted>
              {copy.notCountable}
            </Body>
          ) : null}
          {row.issues.map((issue, i) => (
            <Body key={issue.id} size={12.5} color={ACCENT.warn}>
              {chips[i]}
            </Body>
          ))}
        </View>
      </Card>
    </Pressable>
  );
}

function TopBar({ onBack }: { onBack: () => void }) {
  const { c } = useTheme();
  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
      <View style={styles.topbar}>
        <IconChip icon={ChevronLeft} onPress={onBack} accessibilityLabel="Back" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: { paddingHorizontal: 12, paddingTop: 8, flexDirection: 'row', alignItems: 'center' },
  pad: { paddingHorizontal: 20, marginTop: 12 },
  body: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40, gap: 18 },
});
