import { type Href, useRouter } from 'expo-router';
import { ChevronRight, MapPin } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Pill } from '@/components/ui/pill';
import { Body } from '@/components/ui/text';
import {
  LOCATIONS_LIST_CEILING_COPY,
  LOCATIONS_LIST_UNAVAILABLE_COPY,
  readLocationList,
  type LocationListRow,
} from '@/lib/locations-list';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { retryWorkspace } from '@/lib/use-workspace';
import { LOCATION_WORKSPACE_UNAVAILABLE } from '@/lib/verification-api';

/**
 * Locations screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/locations.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/locations-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 *
 * Each row opens the location (app/location/[id].tsx, F1-3): what is held
 * there and what each item's last physical count says about it.
 *
 * A failed read is said, never shown as "No locations yet." (lib/locations-list.ts
 * throws on any failed page); a refresh that fails keeps the list on screen
 * and says so above it.
 */
/** What the screen last read, for which workspace. */
type ListState = {
  orgId: string;
  rows: LocationListRow[];
  atCeiling: boolean;
  /** The last read failed (the rows, if any, are from an earlier read). */
  error: boolean;
};

export default function LocationsScreen() {
  const router = useRouter();
  const { orgId, loading: workspaceLoading } = useOrg();
  const [stored, setStored] = React.useState<ListState | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    try {
      const res = await readLocationList(supabase, orgId);
      if (seq !== seqRef.current) return;
      setStored({ orgId, rows: res.rows, atCeiling: res.atCeiling, error: false });
    } catch (e) {
      if (seq !== seqRef.current) return;
      console.warn('[locations] load failed:', e instanceof Error ? e.message : e);
      // A failed refresh keeps this workspace's rows; another workspace's
      // rows are never kept.
      setStored((prev) =>
        prev && prev.orgId === orgId
          ? { ...prev, error: true }
          : { orgId, rows: [], atCeiling: false, error: true },
      );
    }
  }, [orgId]);

  // Only rows read for the workspace on screen (a switch shows the spinner
  // until the new workspace's rows arrive, never the old workspace's).
  const list = stored && stored.orgId === orgId ? stored : null;
  const rows = list?.rows ?? [];
  const error = list?.error ?? false;
  const atCeiling = list?.atCeiling ?? false;

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  // No workspace could be loaded: the read never starts, so say so (a pull
  // loads the workspace again, as the rental screens' Try again does).
  const noWorkspace = !orgId && !workspaceLoading;

  async function refresh() {
    setRefreshing(true);
    try {
      await (noWorkspace ? retryWorkspace() : load());
    } finally {
      setRefreshing(false);
    }
  }

  const failedEmpty = noWorkspace || (error && rows.length === 0);
  const notice = noWorkspace
    ? null
    : error && rows.length > 0
      ? 'Could not refresh the locations. Pull down to try again.'
      : atCeiling
        ? LOCATIONS_LIST_CEILING_COPY
        : null;

  return (
    <DataListScreen
      eyebrow={failedEmpty ? 'WAREHOUSE · LOCATIONS' : `WAREHOUSE · ${rows.length} LOCATIONS`}
      title="Locations"
      italic="& bins."
      emptyTitle={failedEmpty ? LOCATIONS_LIST_UNAVAILABLE_COPY : 'No locations yet.'}
      emptyBody={
        noWorkspace
          ? `${LOCATION_WORKSPACE_UNAVAILABLE} Pull down to try again.`
          : failedEmpty
            ? 'Check your connection and pull down to try again.'
            : 'Locations group inventory by site, rack, row, or bin. Create them on the web.'
      }
      emptyIcon={MapPin}
      data={failedEmpty ? [] : rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      header={
        notice ? (
          <Body
            size={12.5}
            color={error ? ACCENT.warn : undefined}
            muted={!error}
            accessibilityRole={error ? 'alert' : undefined}
          >
            {notice}
          </Body>
        ) : undefined
      }
      keyExtractor={(l) => l.id}
      renderItem={(l) => (
        <LocationCard loc={l} onPress={() => router.push(`/location/${l.id}` as Href)} />
      )}
    />
  );
}

function LocationCard({ loc, onPress }: { loc: LocationListRow; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint="Opens the location"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: c.hair,
              backgroundColor: c.card,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MapPin size={16} color={c.ink} strokeWidth={1.5} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
              {loc.name}
            </Body>
            {loc.notes ? (
              <Body muted size={12.5} style={{ marginTop: 3 }}>
                {loc.notes}
              </Body>
            ) : null}
          </View>
          {loc.type ? <Pill>{loc.type.toUpperCase()}</Pill> : null}
          <ChevronRight size={16} color={c.ink4} strokeWidth={1.5} />
        </View>
      </Card>
    </Pressable>
  );
}
