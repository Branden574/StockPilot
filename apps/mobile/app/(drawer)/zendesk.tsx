import { useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, HelpCircle, Menu } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ZendeskLogo } from '@/components/zendesk-logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow } from '@/components/ui/text';
import { api } from '@/lib/api';
import { useEnabledModules } from '@/lib/enabled-modules';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Zendesk — mobile surface for the support-tickets module. Mirrors the
 * settings.tsx shell (topbar + editorial head + sectioned cards). Shows
 * connection status, lets admins (canManage) connect/disconnect via the
 * Bearer endpoints, and stubs the agent console that ships next.
 *
 * Navigation here is cosmetic; the actual module gate + connect perms are
 * enforced server-side (assertModuleEnabled + RLS), so the permissive
 * default-while-loading module set can't leak anything.
 */
interface ZendeskConnection {
  status: string;
  subdomain: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
}

interface ConnectionResponse {
  connection: ZendeskConnection | null;
  canManage: boolean;
}

export default function ZendeskScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const modules = useEnabledModules();
  const enabled = modules.has('zendesk');

  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [connection, setConnection] = React.useState<ZendeskConnection | null>(null);
  const [canManage, setCanManage] = React.useState(false);

  const [subdomain, setSubdomain] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [apiToken, setApiToken] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const res = await api<ConnectionResponse>('/api/v1/zendesk/connection');
      setConnection(res.connection);
      setCanManage(res.canManage);
    } catch {
      setLoadError("Couldn't load Zendesk status");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const connected = connection?.status === 'active';

  async function onConnect() {
    if (submitting) return;
    const sub = subdomain.trim();
    const mail = email.trim();
    const token = apiToken.trim();
    if (!sub || !mail || !token) {
      Alert.alert('Missing details', 'Enter your subdomain, agent email, and API token.');
      return;
    }
    setSubmitting(true);
    try {
      await api('/api/v1/zendesk/connect', {
        method: 'POST',
        body: { subdomain: sub, email: mail, apiToken: token },
      });
      setApiToken('');
      await load();
      Alert.alert('Connected', `StockPilot is now linked to ${sub}.zendesk.com.`);
    } catch (e) {
      Alert.alert('Could not connect', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDisconnect() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api('/api/v1/zendesk/disconnect', { method: 'POST' });
      await load();
      Alert.alert('Disconnected', 'Zendesk has been disconnected from this workspace.');
    } catch (e) {
      Alert.alert('Could not disconnect', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/');
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <IconChip
              icon={Menu}
              onPress={() => (navigation as { openDrawer?: () => void }).openDrawer?.()}
            />
            <IconChip icon={HelpCircle} />
          </View>
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <ZendeskLogo size={22} color={c.ink} />
            <Eyebrow>ZENDESK</Eyebrow>
          </View>
          <Display size={34} style={{ marginTop: 12 }}>
            Support<Em>.</Em>
          </Display>
          <Body muted size={14} style={{ marginTop: 8 }}>
            Support tickets + (soon) an in-app agent console.
          </Body>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
      >
        {!enabled ? (
          <Section label="MODULE">
            <Card padding={16}>
              <Body size={14.5}>
                Zendesk isn’t enabled for this workspace. Ask an admin to enable it in Settings →
                Modules.
              </Body>
            </Card>
          </Section>
        ) : loading ? (
          <View style={{ paddingTop: 48, alignItems: 'center' }}>
            <ActivityIndicator color={c.ink4} />
          </View>
        ) : loadError ? (
          <Section label="CONNECTION">
            <Card padding={16}>
              <Body size={14.5}>{loadError}</Body>
              <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
                <Button variant="outline" size="sm" onPress={() => void load()}>
                  Try again
                </Button>
              </View>
            </Card>
          </Section>
        ) : (
          <>
            <Section label="CONNECTION">
              <Card padding={16}>
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Body size={15.5} style={{ flex: 1, fontFamily: FONT.display }}>
                    {connected
                      ? `Connected to ${connection?.subdomain ?? 'your account'}.zendesk.com`
                      : connection?.lastError
                        ? connection.lastError
                        : 'Not connected yet.'}
                  </Body>
                  <Pill status={connected ? 'ok' : 'default'}>
                    {connected ? 'ACTIVE' : 'OFFLINE'}
                  </Pill>
                </View>

                {canManage && !connected ? (
                  <View style={{ marginTop: 18, gap: 14 }}>
                    <Field
                      label="Subdomain"
                      value={subdomain}
                      onChangeText={setSubdomain}
                      placeholder="acme"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Field
                      label="Agent email"
                      value={email}
                      onChangeText={setEmail}
                      placeholder="agent@acme.com"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                    />
                    <Field
                      label="API token"
                      value={apiToken}
                      onChangeText={setApiToken}
                      placeholder="••••••••"
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                    />
                    <Button block disabled={submitting} onPress={() => void onConnect()}>
                      {submitting ? 'Connecting…' : 'Connect'}
                    </Button>
                  </View>
                ) : null}

                {canManage && connected ? (
                  <View style={{ marginTop: 18, alignSelf: 'flex-start' }}>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={submitting}
                      onPress={() => void onDisconnect()}
                    >
                      {submitting ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  </View>
                ) : null}

                {!canManage ? (
                  <Body muted size={13.5} style={{ marginTop: 14 }}>
                    Ask an admin to connect Zendesk.
                  </Body>
                ) : null}
              </Card>
            </Section>

            <Section label="AGENT CONSOLE">
              <Card padding={16}>
                <Body muted size={14}>
                  Coming next: view and reply to tickets, set status/priority/assignee, search, and
                  macros — right here, with order context. Once connected, new returns, public
                  requests, and order problems open tickets automatically.
                </Body>
              </Card>
            </Section>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 24 }}>
      <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
        <Eyebrow>{label}</Eyebrow>
      </View>
      {children}
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
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
});
