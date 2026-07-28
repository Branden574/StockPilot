import { useFocusEffect, useRouter } from 'expo-router';
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Plug,
  RefreshCcw,
  XCircle,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  disconnect as disconnectConnection,
  getConnections,
  isForbiddenError,
  saveAccountMapping,
  type ConnectionView,
  type ConnectionStatus,
  type SyncHealthRow,
  type SyncHealthStatus,
} from '@/lib/integrations-api';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { useRole } from '@/lib/use-role';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const PROVIDER = 'quickbooks';

/**
 * Settings → Integrations. Mobile parity for the QuickBooks Online connection:
 * monitor status + sync health, disconnect, and edit the chart-of-accounts
 * mapping. CONNECT IS WEB-ONLY (no connect button) — an inactive connection
 * shows a hint pointing to the web app.
 *
 * Gating is belt-and-suspenders: the row that links here is already gated, but
 * we re-check `integrations` module + admin role and render an empty state
 * otherwise. The server is the source of truth — a 403 from any call surfaces a
 * friendly inline message regardless of what the client thinks.
 */
export default function IntegrationsScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { isAdmin, loading: roleLoading } = useRole();
  const enabled = useEnabledModules();

  const allowed = enabled.has('integrations') && isAdmin;

  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [forbidden, setForbidden] = React.useState(false);
  const [connection, setConnection] = React.useState<ConnectionView | null>(null);
  const [health, setHealth] = React.useState<SyncHealthRow[]>([]);

  // Mapping form
  const [billExpense, setBillExpense] = React.useState('');
  const [inventoryAsset, setInventoryAsset] = React.useState('');
  const [valuationOffset, setValuationOffset] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const applyConnection = React.useCallback((conn: ConnectionView | null) => {
    setConnection(conn);
    setBillExpense(conn?.accountIds.billExpense ?? '');
    setInventoryAsset(conn?.accountIds.inventoryAsset ?? '');
    setValuationOffset(conn?.accountIds.valuationOffset ?? '');
  }, []);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await getConnections(signal);
        if (signal?.aborted) return;
        const qbo = data.connections.find((x) => x.providerId === PROVIDER) ?? null;
        applyConnection(qbo);
        setHealth(data.health);
        setError(null);
        setForbidden(false);
      } catch (e) {
        if (signal?.aborted) return;
        if (isForbiddenError(e)) {
          setForbidden(true);
          setError(null);
        } else {
          setError(e instanceof Error ? e.message : 'Could not load integrations.');
        }
      }
    },
    [applyConnection],
  );

  useFocusEffect(
    React.useCallback(() => {
      if (roleLoading || !allowed) {
        setLoading(false);
        return;
      }
      const controller = new AbortController();
      setLoading(true);
      void (async () => {
        await load(controller.signal);
        if (!controller.signal.aborted) setLoading(false);
      })();
      return () => controller.abort();
    }, [load, allowed, roleLoading]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function onSave() {
    if (saving) return;
    if (!billExpense.trim() || !inventoryAsset.trim() || !valuationOffset.trim()) {
      Alert.alert('All three fields required', 'Paste each account id from your QuickBooks Chart of Accounts.');
      return;
    }
    setSaving(true);
    try {
      await saveAccountMapping(PROVIDER, {
        billExpense: billExpense.trim(),
        inventoryAsset: inventoryAsset.trim(),
        valuationOffset: valuationOffset.trim(),
      });
      Alert.alert('Mapping saved', 'The QuickBooks account mapping was updated.');
      await load();
    } catch (e) {
      if (isForbiddenError(e)) {
        setForbidden(true);
      } else {
        Alert.alert('Could not save', e instanceof Error ? e.message : 'Unknown error');
      }
    } finally {
      setSaving(false);
    }
  }

  function onDisconnect() {
    Alert.alert(
      'Disconnect QuickBooks?',
      'This tears down the connection and deletes the stored credentials. Your inventory data is untouched. You can reconnect from the web app at any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            try {
              await disconnectConnection(PROVIDER);
              await load();
            } catch (e) {
              if (isForbiddenError(e)) {
                setForbidden(true);
              } else {
                Alert.alert('Could not disconnect', e instanceof Error ? e.message : 'Unknown error');
              }
            }
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
              else router.replace('/settings');
            }}
          />
          {allowed ? <IconChip icon={RefreshCcw} onPress={refresh} /> : null}
        </View>
        <View style={styles.head}>
          <Eyebrow>SETTINGS · INTEGRATIONS</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            QuickBooks<Em>.</Em>
          </Display>
        </View>
      </SafeAreaView>

      {!allowed ? (
        <EmptyState
          title={!enabled.has('integrations') ? 'Integrations isn’t enabled.' : 'Admins only.'}
          body={
            !enabled.has('integrations')
              ? 'The Integrations module is off for this workspace. An owner can enable it from the web app.'
              : 'Integrations are managed by owners and admins. Ask your org owner if you need access.'
          }
        />
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.ink4} />
        </View>
      ) : forbidden ? (
        <EmptyState
          title="Access denied."
          body="The server rejected this request (the module may be off or your role changed). Reopen this screen after an admin updates access."
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}
          showsVerticalScrollIndicator={false}
        >
          {error ? (
            <Card padding={14} style={{ marginTop: 14, borderColor: 'rgba(176,58,58,0.3)' }}>
              <Body size={13.5} color={ACCENT.crit}>
                {error}
              </Body>
            </Card>
          ) : null}

          <StatusCard connection={connection} />

          {connection && connection.status === 'active' ? (
            <MappingForm
              billExpense={billExpense}
              inventoryAsset={inventoryAsset}
              valuationOffset={valuationOffset}
              onBill={setBillExpense}
              onInventory={setInventoryAsset}
              onValuation={setValuationOffset}
              onSave={onSave}
              saving={saving}
            />
          ) : null}

          {connection && connection.status !== 'disconnected' ? (
            <View style={{ marginTop: 20, paddingHorizontal: 4 }}>
              <Button variant="destructive" onPress={onDisconnect}>
                Disconnect QuickBooks
              </Button>
            </View>
          ) : null}

          <HealthList health={health} />
        </ScrollView>
      )}
    </View>
  );
}

const STATUS_PILL: Record<ConnectionStatus, { label: string; status: 'ok' | 'warn' | 'crit' | 'default' }> = {
  active: { label: 'CONNECTED', status: 'ok' },
  pending: { label: 'PENDING', status: 'warn' },
  error: { label: 'ERROR', status: 'crit' },
  disconnected: { label: 'DISCONNECTED', status: 'default' },
};

function StatusCard({ connection }: { connection: ConnectionView | null }) {
  const { c } = useTheme();

  if (!connection || connection.status === 'disconnected') {
    return (
      <Card padding={16} style={{ marginTop: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Plug size={18} color={c.ink4} strokeWidth={1.5} />
          <Pill>NOT CONNECTED</Pill>
        </View>
        <Body size={13.5} muted style={{ marginTop: 12 }}>
          Connect QuickBooks from the web app (Settings → Integrations). Once connected, you can monitor
          sync health, edit the account mapping, and disconnect from here.
        </Body>
      </Card>
    );
  }

  const pill = STATUS_PILL[connection.status];
  return (
    <Card padding={16} style={{ marginTop: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Plug size={18} color={c.ink} strokeWidth={1.5} />
          <Body size={15.5} style={{ fontFamily: FONT.display }}>
            QuickBooks Online
          </Body>
        </View>
        {pill.status === 'default' ? <Pill>{pill.label}</Pill> : <Pill status={pill.status}>{pill.label}</Pill>}
      </View>

      <Hair style={{ marginVertical: 14 }} />

      <DetailRow label="REALM" value={connection.externalAccountId ?? '—'} />
      <DetailRow label="LAST SYNCED" value={formatDateTime(connection.lastSyncedAt)} />
      {connection.lastError ? (
        <View style={{ marginTop: 10 }}>
          <Mono size={9.5} tracking={0.18} upper color={c.ink4}>
            LAST ERROR
          </Mono>
          <Body size={13} color={ACCENT.crit} style={{ marginTop: 4 }}>
            {connection.lastError}
          </Body>
        </View>
      ) : null}
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  // REALM / LAST SYNCED against a realm id or a timestamp: `space-between`
  // gives neither side room, and the value is the half that was losing (it
  // carries numberOfLines={1}). Past the shared threshold it stacks under its
  // label and takes the card's full width; below it, nothing moves.
  const stacked = shouldStackRow(fontScale);
  return (
    <View
      style={[
        { gap: stacked ? 2 : 12, marginTop: 4 },
        stacked
          ? null
          : { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
      ]}
    >
      <Mono
        size={9.5}
        tracking={0.18}
        upper
        color={c.ink4}
        // The label is a fixed micro-marker; the value it names is not capped.
        maxFontSizeMultiplier={capTo(9.5, TYPE_CEILING.chrome)}
        style={{ flexShrink: 1 }}
      >
        {label}
      </Mono>
      <Mono
        size={12.5}
        tracking={0.02}
        color={c.ink}
        numberOfLines={stacked ? 2 : 1}
        style={{ flexShrink: 1, minWidth: 0, textAlign: stacked ? 'left' : 'right' }}
      >
        {value}
      </Mono>
    </View>
  );
}

function MappingForm({
  billExpense,
  inventoryAsset,
  valuationOffset,
  onBill,
  onInventory,
  onValuation,
  onSave,
  saving,
}: {
  billExpense: string;
  inventoryAsset: string;
  valuationOffset: string;
  onBill: (v: string) => void;
  onInventory: (v: string) => void;
  onValuation: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <View style={{ marginTop: 24 }}>
      <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
        <Eyebrow>ACCOUNT MAPPING</Eyebrow>
      </View>
      <Card padding={16}>
        <Field
          label="Bill expense account id"
          value={billExpense}
          onChangeText={onBill}
          placeholder="e.g. 63"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
        />
        <Field
          label="Inventory asset account id"
          value={inventoryAsset}
          onChangeText={onInventory}
          placeholder="e.g. 81"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          style={{ marginTop: 14 }}
        />
        <Field
          label="Valuation offset account id"
          value={valuationOffset}
          onChangeText={onValuation}
          placeholder="e.g. 90"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          style={{ marginTop: 14 }}
        />
        <Button onPress={onSave} disabled={saving} block style={{ marginTop: 18 }}>
          {saving ? 'Saving…' : 'Save mapping'}
        </Button>
      </Card>
    </View>
  );
}

const HEALTH_ICON: Record<SyncHealthStatus, { Icon: typeof CheckCircle2; color: string }> = {
  success: { Icon: CheckCircle2, color: ACCENT.mintInk },
  pending: { Icon: CircleDashed, color: ACCENT.warn },
  error: { Icon: XCircle, color: ACCENT.crit },
  dead: { Icon: XCircle, color: ACCENT.crit },
};

function HealthList({ health }: { health: SyncHealthRow[] }) {
  const { c } = useTheme();
  return (
    <View style={{ marginTop: 24 }}>
      <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
        <Eyebrow>SYNC HEALTH</Eyebrow>
      </View>
      <Card padding={0}>
        {health.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Body size={13.5} muted>
              No sync activity yet. Exported documents and their status will appear here.
            </Body>
          </View>
        ) : (
          health.map((row, i) => {
            const { Icon, color } = HEALTH_ICON[row.status] ?? HEALTH_ICON.pending;
            return (
              <View key={`${row.topic}-${row.createdAt}-${i}`}>
                {i > 0 ? <Hair inset={16} /> : null}
                <View style={styles.healthRow}>
                  <Icon size={16} color={color} strokeWidth={1.6} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }} numberOfLines={2}>
                      {row.topic}
                    </Body>
                    <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }} numberOfLines={2}>
                      {row.externalId ? `${row.externalId} · ` : ''}
                      {row.attempts} attempt{row.attempts === 1 ? '' : 's'} · {formatDateTime(row.completedAt ?? row.createdAt)}
                    </Mono>
                    {row.lastError ? (
                      <Body size={12} color={ACCENT.crit} style={{ marginTop: 3 }} numberOfLines={2}>
                        {row.lastError}
                      </Body>
                    ) : null}
                  </View>
                  {/* The status word duplicates the icon to its left and is
                      the only non-shrinking sibling of the flex: 1 column;
                      capped so the topic and its meta keep their width. */}
                  <Mono
                    size={9.5}
                    tracking={0.12}
                    upper
                    color={color}
                    numberOfLines={1}
                    maxFontSizeMultiplier={capTo(9.5, TYPE_CEILING.chrome)}
                    style={{ flexShrink: 0 }}
                  >
                    {row.status}
                  </Mono>
                </View>
              </View>
            );
          })
        )}
      </Card>
    </View>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  const { c } = useTheme();
  return (
    <View style={styles.center}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: c.hair,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Plug size={24} color={c.ink4} strokeWidth={1.5} />
      </View>
      <Body size={16} color={c.ink} style={{ marginTop: 16, fontFamily: FONT.display, textAlign: 'center' }}>
        {title}
      </Body>
      <Body size={13.5} muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 300 }}>
        {body}
      </Body>
    </View>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  healthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
});
