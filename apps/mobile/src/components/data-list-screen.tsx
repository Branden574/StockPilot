import { BottomTabBarHeightContext } from 'expo-router/js-tabs';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, Menu, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  dataListEmptyKind,
  dataListReloadNote,
  type DataListFailure,
} from '@/components/ui/data-list-state';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';

export type { DataListFailure } from '@/components/ui/data-list-state';

/**
 * Shared chrome for every drawer-surface list screen. Renders a top
 * bar with a hamburger that opens the drawer + optional trailing
 * action, then a header (eyebrow + display title with serif-italic
 * emphasis), then the supplied list. Loading, empty, failed-read and
 * offline states are standardized (ui/data-list-state.ts has the table) so
 * each drawer screen only writes its own data-fetch + row renderer, and a
 * failed read is never shown as an empty list.
 */
export function DataListScreen<T>({
  eyebrow,
  title,
  italic,
  emptyTitle,
  emptyBody,
  emptyIcon: EmptyIcon,
  data,
  keyExtractor,
  renderItem,
  loading,
  refreshing,
  onRefresh,
  trailing,
  header,
  emptyAction,
  failed,
  ItemSeparator,
  footer,
}: {
  eyebrow: string;
  title: string;
  italic?: string;
  emptyTitle: string;
  emptyBody: string;
  emptyIcon?: LucideIcon;
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactElement;
  loading: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  trailing?: React.ReactNode;
  /** Controls under the title (a view switch, say). Stays put while the list
   *  scrolls and while it loads, so switching never makes it jump. */
  header?: React.ReactNode;
  /** A control under the empty state's words (the Orders list's "Place an
   *  order", or "Load again" after a failed read). */
  emptyAction?: React.ReactNode;
  /** The last read failed: with no rows, its words replace the empty state
   *  (with a warning glyph, or a no-connection one when `offline`); with
   *  rows from an earlier read, the rows stay and the failure is always said
   *  above them (`reloadNote`, or `title` when there is none), so they never
   *  look current. Null or absent: the read succeeded. */
  failed?: DataListFailure | null;
  ItemSeparator?: React.ComponentType<unknown>;
  /** Under the last row (the Rentals list's "Showing the newest 100 of N
   *  returned or cancelled rentals"). Not shown while the list is empty. */
  footer?: React.ReactNode;
}) {
  const { c } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  // Some screens (Orders, Movements) are ALSO reachable as customizable
  // bottom tabs. Inside the tabs navigator the translucent bar overlays the
  // list, so pad the scroll content past it; in the drawer this context is
  // undefined → 0 → byte-for-byte the old padding.
  const tabBarInset = React.useContext(BottomTabBarHeightContext) ?? 0;
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  // Drawer-to-drawer pushes don't reliably build a back-stack in
  // expo-router (drawer screens share a navigator state that doesn't
  // track history the way a stack does). Callers that need a specific
  // back target pass it explicitly via `?return=/path` — same pattern
  // the web app uses. Fall back to canGoBack/back when no return param
  // is set, then Home as the ultimate safety net.
  const { return: returnPath } = useLocalSearchParams<{ return?: string }>();
  const goBack = () => {
    if (typeof returnPath === 'string' && returnPath.length > 0) {
      router.replace(returnPath as never);
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const emptyKind = dataListEmptyKind(failed);
  const reloadNote = dataListReloadNote(failed, data.length);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={styles.chips}>
            {/* Icon-only: without a label VoiceOver read each as an unnamed
                element (re-walk 2026-09-26, on every list screen that uses
                this header). A label also makes IconChip a button. */}
            <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
            <IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />
          </View>
          {trailing}
        </View>
        <View style={styles.head}>
          <Eyebrow>{eyebrow}</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            {italic ? (
              <>
                {title} <Em>{italic}</Em>
              </>
            ) : (
              title
            )}
          </Display>
          {header ? <View style={{ marginTop: 14 }}>{header}</View> : null}
        </View>
      </SafeAreaView>

      {loading ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={data}
          keyExtractor={keyExtractor}
          contentContainerStyle={[
            styles.list,
            tabBarInset > 0 && { paddingBottom: 24 + tabBarInset },
          ]}
          ItemSeparatorComponent={ItemSeparator}
          ListHeaderComponent={
            reloadNote ? (
              <View style={styles.reloadNote}>
                {/* Rows from an earlier read stay on screen; say they may be
                    out of date rather than dropping them. */}
                <Body size={13} color={c.warnText} accessibilityRole="alert">
                  {reloadNote}
                </Body>
                {failed?.action ? <View>{failed.action}</View> : null}
              </View>
            ) : undefined
          }
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing ?? false}
                onRefresh={onRefresh}
                tintColor={c.ink}
              />
            ) : undefined
          }
          ListEmptyComponent={
            failed ? (
              // The read failed: its own words, never "No X yet." (D25).
              <View style={styles.empty}>
                <View style={{ marginBottom: 12 }}>
                  {emptyKind === 'offline' ? (
                    <WifiOff size={32} color={c.ink3} strokeWidth={1.3} />
                  ) : (
                    <TriangleAlert size={32} color={c.warnText} strokeWidth={1.3} />
                  )}
                </View>
                <Display size={18} accessibilityRole="alert">
                  {failed.title}
                </Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 320 }}>
                  {failed.body}
                </Body>
                {failed.action ? <View style={{ marginTop: 14 }}>{failed.action}</View> : null}
              </View>
            ) : (
              <View style={styles.empty}>
                {EmptyIcon ? (
                  <View style={{ marginBottom: 12 }}>
                    <EmptyIcon size={32} color={c.ink4} strokeWidth={1.3} />
                  </View>
                ) : null}
                <Display size={18}>
                  {emptyTitle}
                </Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 320 }}>
                  {emptyBody}
                </Body>
                {emptyAction ? <View style={{ marginTop: 14 }}>{emptyAction}</View> : null}
              </View>
            )
          }
          ListFooterComponent={footer && data.length > 0 ? <View>{footer}</View> : undefined}
          renderItem={({ item, index }) => renderItem(item, index)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The chips' 44pt frames (IconChip minTap) are 3pt wider than the 38pt chip
  // on every side: the chip group takes 3pt off the bar's left padding
  // (marginLeft), the gap between the chips 6pt (8 -> 2), the bar 3pt off its
  // top and the head 3pt off its top, so the chips and the title sit where
  // they did. The bar's right padding stays 12 for the callers' `trailing`
  // (a pill, a tour button, or an IconChip, which takes its own 3pt).
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -3 },
  head: {
    paddingHorizontal: 20,
    paddingTop: 9,
    paddingBottom: 4,
  },
  list: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    gap: 10,
  },
  empty: {
    paddingTop: 40,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  reloadNote: {
    gap: 10,
  },
});
