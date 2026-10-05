import * as React from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Body, Display } from '@/components/ui/text';
import { outcomeBesideSetup, storefrontStateMessage, type StorefrontOutcome } from '@/lib/order-storefront/outcome';
import type { SetupState } from '@/lib/order-storefront/session';
import { STOREFRONT_GUTTER } from '@/lib/order-storefront/layout';
import { useTheme } from '@/lib/use-theme';

/**
 * The storefront before it can be used (phone ordering PO-4): loading, the
 * kill switch or an old server ("Placing orders from the app is turned off
 * right now. Use the web." / "...isn't available right now..."), a refusal
 * (signed out, no permission, the module off) or a read that failed (pull
 * down to read it again). Core's words; nothing to submit is offered, but
 * a send that is not settled still gets its unconfirmed panel, and how it
 * ended is said here (lib/order-storefront/outcome.ts; the catalog screen
 * announces it).
 */
export function StorefrontState({
  topBar,
  title,
  setup,
  refreshing,
  onRefresh,
  panel,
  outcome,
  offline = false,
}: {
  topBar: React.ReactNode;
  title: string;
  setup: Exclude<SetupState, { status: 'ready' }> | { status: 'loading' };
  refreshing: boolean;
  onRefresh: () => void;
  /** A send not settled still settles with no storefront (the unconfirmed
   *  panel: the kill switch keeps create and settle up). */
  panel?: React.ReactNode;
  /** How that send ended (withdrawn, refused, the device could not save). */
  outcome?: StorefrontOutcome | null;
  /** The phone is offline: a read that failed says so (simulator walk D12). */
  offline?: boolean;
}) {
  const { c } = useTheme();
  // The same sentence as the setup message is said once (simulator walk D10).
  const shown = outcomeBesideSetup(outcome ?? null, setup);
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
        {shown ? (
          <Body size={14} color={shown.tone === 'calm' ? c.ink : c.critText} accessibilityRole="alert">
            {shown.text}
          </Body>
        ) : null}
        {setup.status === 'loading' ? (
          <ActivityIndicator color={c.ink} style={{ marginTop: 24 }} />
        ) : (
          <Body size={15} color={setup.status === 'failed' ? c.warnText : c.ink} accessibilityRole="alert">
            {storefrontStateMessage(setup, offline)}
          </Body>
        )}
      </ScrollView>
    </View>
  );
}
