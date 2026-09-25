import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Mail,
  MinusCircle,
  PackageOpen,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  RENTAL_EMAILS_RECORD_NOTE,
  rentalEmailLines,
  type RentalEmailTone,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  loadRentalDetail,
  rentalBorrowerView,
  rentalStatusPill,
  rentalTimeLabel,
  rentalWebActionLabel,
  type RentalDetailLoad,
} from '@/lib/rental-view';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useTheme } from '@/lib/use-theme';

const TONE_ICON: Record<RentalEmailTone, typeof Mail> = {
  recorded: CheckCircle2,
  rule: Mail,
  upcoming: Clock,
  none: MinusCircle,
  warn: AlertTriangle,
};

/**
 * One rental on the phone: the twin of web's /dashboard/rentals/[id]
 * (2026-09-25). Before this the list's cards opened the web page in a browser.
 *
 * It says who borrowed it (a team member, or a borrower not linked to an
 * account: a typed name, which is every phone rental before 2026-09-25), the
 * email on file or that there is none, and which emails that borrower gets:
 * the receipt and the return confirmation by their rule (nothing records
 * them), and the overdue reminder's real state (sent, when it will be sent,
 * or why it will not), decided by @stockpilot/core with the daily sweep's own
 * rule. See lib/rental-view.ts for the reads.
 *
 * Returning or cancelling a rental is still done on the web; the button at the
 * bottom opens this rental there, only for a viewer the web page gives an
 * action to, and worded for what they can do there (rentalWebActionLabel).
 */
export default function RentalDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { orgId } = useOrg();
  const { c } = useTheme();
  const enabledModules = useEnabledModules();
  const enabled = enabledModules.has('rentals');
  const perms = useEffectivePermissions();
  const [load, setLoad] = React.useState<RentalDetailLoad | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  // The moment the data describes, taken with it (not during render), so
  // "overdue" and the reminder's state agree until the next refresh.
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!orgId || !id) return;
    let cancelled = false;
    void (async () => {
      const result = await loadRentalDetail(supabase, orgId, id);
      if (cancelled) return;
      setNowMs(Date.now());
      setLoad(result);
      setRefreshing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, id, nonce]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/rentals');
  }

  function reload() {
    setRefreshing(true);
    setNonce((n) => n + 1);
  }

  if (!enabled) {
    return (
      <Gate onBack={goBack}>
        Rentals are not switched on for this workspace. Ask an admin to turn them on in Settings
        {' > '}Modules.
      </Gate>
    );
  }

  if (load === null) {
    return (
      <View style={[styles.root, { backgroundColor: c.paper }]}>
        <TopBar onBack={goBack} />
        <ActivityIndicator color={c.ink4} style={{ marginTop: 40 }} />
      </View>
    );
  }

  if (!load.ok) {
    return (
      <Gate onBack={goBack} onRetry={load.notFound ? undefined : reload} retrying={refreshing}>
        {load.notFound
          ? 'This rental is not available. It may belong to a warehouse you cannot see.'
          : `Could not load this rental. ${load.message}`}
      </Gate>
    );
  }

  const { rental, context } = load;
  const pill = rentalStatusPill(rental, nowMs);
  const borrower = rentalBorrowerView(rental);
  const emails = rentalEmailLines(rental, context.remindersOn, nowMs, context.timeZone);
  const overdue = pill.label === 'OVERDUE';
  const webAction = rentalWebActionLabel(rental.status, perms);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <TopBar onBack={goBack} />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} />}
      >
        <View style={styles.head}>
          <Eyebrow>{rental.warehouseName ? `RENTAL · ${rental.warehouseName}` : 'RENTAL'}</Eyebrow>
          <Display size={28} style={{ marginTop: 8 }}>
            {borrower.name}
          </Display>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <Pill status={pill.status}>{pill.label}</Pill>
          </View>
        </View>

        <Card padding={16}>
          <Eyebrow>BORROWER</Eyebrow>
          <View style={{ marginTop: 10, gap: 4 }}>
            <Body size={15} style={{ fontFamily: FONT.display }}>
              {borrower.name}
            </Body>
            <Body size={13} muted>
              {borrower.kind}
            </Body>
            {borrower.email ? (
              <Body size={14} selectable accessibilityLabel={`Email on file, ${borrower.email}`}>
                {borrower.email}
              </Body>
            ) : null}
            {borrower.note ? (
              <Body size={12.5} color={borrower.email ? undefined : ACCENT.warn} muted={Boolean(borrower.email)}>
                {borrower.note}
              </Body>
            ) : null}
          </View>
        </Card>

        <Card padding={0} style={{ marginTop: 14 }}>
          <View style={{ padding: 16, paddingBottom: 8 }}>
            <Eyebrow>EMAILS TO THE BORROWER</Eyebrow>
          </View>
          {emails.map((line, i) => {
            const Icon = TONE_ICON[line.tone];
            const color =
              line.tone === 'recorded'
                ? ACCENT.mint
                : line.tone === 'warn'
                  ? ACCENT.warn
                  : line.tone === 'upcoming'
                    ? c.ink2
                    : c.ink4;
            return (
              <View key={line.key}>
                {i > 0 ? <Hair /> : null}
                <View style={styles.emailRow} accessible accessibilityLabel={`${line.label}. ${line.detail}`}>
                  <Icon size={16} color={color} strokeWidth={1.75} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Body size={14} style={{ fontFamily: FONT.display }}>
                      {line.label}
                    </Body>
                    <Body size={13} muted>
                      {line.detail}
                    </Body>
                  </View>
                </View>
              </View>
            );
          })}
          {borrower.email ? (
            <>
              <Hair />
              <View style={{ padding: 16 }}>
                <Body size={12} muted>
                  {RENTAL_EMAILS_RECORD_NOTE}
                </Body>
              </View>
            </>
          ) : null}
        </Card>

        <Card padding={16} style={{ marginTop: 14 }}>
          <Eyebrow>DETAILS</Eyebrow>
          <View style={{ marginTop: 10, gap: 12 }}>
            <Detail label="CHECKED OUT" value={rentalTimeLabel(rental.checked_out_at, context.timeZone)} />
            <Detail
              label="EXPECTED RETURN"
              value={rentalTimeLabel(rental.expected_return_at, context.timeZone)}
              color={overdue ? ACCENT.crit : undefined}
            />
            {rental.returned_at ? (
              <Detail label="RETURNED" value={rentalTimeLabel(rental.returned_at, context.timeZone)} />
            ) : null}
            {rental.cancelled_at ? (
              <Detail label="CANCELLED" value={rentalTimeLabel(rental.cancelled_at, context.timeZone)} />
            ) : null}
            {rental.cancellation_reason ? (
              <Detail label="CANCELLATION REASON" value={rental.cancellation_reason} />
            ) : null}
            {rental.return_notes ? <Detail label="RETURN NOTES" value={rental.return_notes} /> : null}
            {rental.notes ? <Detail label="NOTES" value={rental.notes} /> : null}
          </View>
        </Card>

        <Card padding={0} style={{ marginTop: 14 }}>
          <View style={{ padding: 16, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <PackageOpen size={14} color={c.ink} strokeWidth={1.5} />
            <Eyebrow prefix="">{`ITEMS · ${rental.lines.length}`}</Eyebrow>
          </View>
          {rental.lines.length === 0 ? (
            <View style={{ padding: 16, paddingTop: 4 }}>
              <Body size={13} muted>
                No items on this rental.
              </Body>
            </View>
          ) : (
            rental.lines.map((line, i) => (
              <View key={line.id}>
                {i > 0 ? <Hair /> : null}
                <View style={styles.itemRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Body size={14} style={{ fontFamily: FONT.display }}>
                      {line.name}
                    </Body>
                    {line.sku || line.notes ? (
                      <Body size={12} muted>
                        {[line.sku, line.notes].filter(Boolean).join(' · ')}
                      </Body>
                    ) : null}
                  </View>
                  <Mono size={14} color={c.ink}>
                    {`× ${line.quantity}`}
                  </Mono>
                </View>
              </View>
            ))
          )}
        </Card>

        {webAction ? (
          <View style={{ marginTop: 18, gap: 8 }}>
            <Button
              block
              variant="ghost"
              onPress={() => {
                Linking.openURL(`https://stockpilotusa.com/dashboard/rentals/${rental.id}`).catch(() => undefined);
              }}
            >
              {webAction}
            </Button>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function TopBar({ onBack }: { onBack: () => void }) {
  const { c } = useTheme();
  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
      <View style={styles.topbar}>
        <IconChip icon={ChevronLeft} onPress={onBack} />
      </View>
    </SafeAreaView>
  );
}

function Detail({ label, value, color }: { label: string; value: string; color?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Mono size={10} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <Body size={14} color={color}>
        {value}
      </Body>
    </View>
  );
}

function Gate({
  onBack,
  onRetry,
  retrying = false,
  children,
}: {
  onBack: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <TopBar onBack={onBack} />
      <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
        <Card padding={16}>
          <Body size={14.5}>{children}</Body>
          {onRetry ? (
            <Pressable
              onPress={onRetry}
              disabled={retrying}
              accessibilityRole="button"
              accessibilityState={{ disabled: retrying }}
              style={({ pressed }) => [
                styles.chip,
                {
                  marginTop: 12,
                  alignSelf: 'flex-start',
                  borderColor: c.hair,
                  backgroundColor: c.card,
                  opacity: retrying ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Body size={13} color={c.ink2} style={{ fontFamily: FONT.display }}>
                Try again
              </Body>
            </Pressable>
          ) : null}
        </Card>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  head: { paddingTop: 4, paddingBottom: 16 },
  body: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },
  emailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
});
