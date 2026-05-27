import { useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, Menu, type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';

/**
 * Shared chrome for every drawer-surface list screen. Renders a top
 * bar with a hamburger that opens the drawer + optional trailing
 * action, then a header (eyebrow + display title with serif-italic
 * emphasis), then the supplied list. Empty / loading / error states
 * are all standardized so each drawer screen only writes its own
 * data-fetch + row renderer.
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
  ItemSeparator,
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
  ItemSeparator?: React.ComponentType<unknown>;
}) {
  const { c } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip icon={ArrowLeft} onPress={goBack} />
            <IconChip icon={Menu} onPress={openDrawer} />
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
        </View>
      </SafeAreaView>

      {loading ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={data}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={ItemSeparator}
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
            </View>
          }
          renderItem={({ item, index }) => renderItem(item, index)}
        />
      )}
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
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
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
});
