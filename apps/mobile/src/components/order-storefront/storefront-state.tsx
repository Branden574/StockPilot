import * as React from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Body, Display } from '@/components/ui/text';
import type { SetupState } from '@/lib/order-storefront/session';
import { STOREFRONT_GUTTER } from '@/lib/order-storefront/layout';
import { ACCENT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The storefront before it can be used (phone ordering PO-4): loading, the
 * kill switch or an old server ("Placing orders from the app is turned off
 * right now. Use the web." / "...isn't available right now..."), a refusal
 * (signed out, no permission, the module off) or a read that failed (pull
 * down to read it again). Core's words; nothing to submit is offered, but
 * a send that is not settled still gets its unconfirmed panel.
 */
export function StorefrontState({
  topBar,
  title,
  setup,
  refreshing,
  onRefresh,
  panel,
}: {
  topBar: React.ReactNode;
  title: string;
  setup: Exclude<SetupState, { status: 'ready' }> | { status: 'loading' };
  refreshing: boolean;
  onRefresh: () => void;
  /** A send not settled still settles with no storefront (the unconfirmed
   *  panel: the kill switch keeps create and settle up). */
  panel?: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        {topBar}
      </SafeAreaView>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: STOREFRONT_GUTTER, paddingBottom: 24, gap: 14 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} />}
      >
        <Display size={30} accessibilityRole="header">
          {title}
        </Display>
        {panel ?? null}
        {setup.status === 'loading' ? (
          <ActivityIndicator color={c.ink} style={{ marginTop: 24 }} />
        ) : (
          <Body size={15} color={setup.status === 'failed' ? ACCENT.warn : c.ink} accessibilityRole="alert">
            {setup.message}
          </Body>
        )}
      </ScrollView>
    </View>
  );
}
