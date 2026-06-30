import { useNavigation, useRouter } from 'expo-router';
import { ArrowLeft, HelpCircle, Menu } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { connectZendesk } from '@/lib/zendesk-oauth';

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

// ── Org-level connection types ───────────────────────────────────────────────
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

// ── Per-user agent console types ─────────────────────────────────────────────
interface Ticket {
  id: number;
  subject: string;
  status: string;
  priority: string | null;
  description: string;
  createdAt: string;
  updatedAt: string;
  requesterId: number | null;
  assigneeId: number | null;
  url: string;
}

interface Comment {
  id: number;
  authorId: number | null;
  body: string;
  public: boolean;
  createdAt: string;
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function ZendeskScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const modules = useEnabledModules();
  const enabled = modules.has('zendesk');
  const permissions = useEffectivePermissions();
  const isAgent = permissions?.has('zendesk:agent') ?? false;

  // Org-level connection state
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
            Support tickets + an in-app agent console.
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
                Zendesk isn't enabled for this workspace. Ask an admin to enable it in Settings →
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

            {/* ── Per-user agent console — only for zendesk:agent ── */}
            {isAgent ? (
              <AgentConsole />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Agent Console sub-component ───────────────────────────────────────────────

type AgentView = 'me' | 'list' | 'detail';

function AgentConsole() {
  const { c } = useTheme();

  // 'me' = loading/connect state, 'list' = ticket list, 'detail' = single ticket
  const [view, setView] = React.useState<AgentView>('me');
  const [meLoading, setMeLoading] = React.useState(true);
  const [meConnected, setMeConnected] = React.useState(false);
  const [meError, setMeError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState(false);

  const [tickets, setTickets] = React.useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = React.useState(false);
  const [ticketsError, setTicketsError] = React.useState<string | null>(null);

  const [selectedTicket, setSelectedTicket] = React.useState<Ticket | null>(null);
  const [comments, setComments] = React.useState<Comment[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);

  const [disconnecting, setDisconnecting] = React.useState(false);

  // ── /me load ─────────────────────────────────────────────────────────────
  const loadMe = React.useCallback(async () => {
    setMeLoading(true);
    setMeError(null);
    try {
      const res = await api<{ connected: boolean; account?: object }>('/api/v1/zendesk/me');
      setMeConnected(res.connected);
      if (res.connected) {
        setView('list');
      } else {
        setView('me');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number })?.status;
      if (status === 401 || msg.includes('401') || msg.includes('reauth')) {
        setMeConnected(false);
        setView('me');
      } else {
        setMeError("Couldn't load your Zendesk connection.");
      }
    } finally {
      setMeLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadMe();
  }, [loadMe]);

  // ── Ticket list load ──────────────────────────────────────────────────────
  const loadTickets = React.useCallback(async () => {
    setTicketsLoading(true);
    setTicketsError(null);
    try {
      const res = await api<{ tickets: Ticket[] }>('/api/v1/zendesk/me/tickets?view=assigned');
      setTickets(res.tickets);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number })?.status;
      if (status === 401 || msg.includes('401') || msg.includes('reauth')) {
        setMeConnected(false);
        setView('me');
      } else {
        setTicketsError("Couldn't load tickets.");
      }
    } finally {
      setTicketsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (view === 'list' && meConnected) {
      void loadTickets();
    }
  }, [view, meConnected, loadTickets]);

  // ── Ticket detail load ────────────────────────────────────────────────────
  async function openTicket(ticket: Ticket) {
    setSelectedTicket(ticket);
    setView('detail');
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await api<{ ticket: Ticket; comments: Comment[] }>(
        `/api/v1/zendesk/me/tickets/${ticket.id}`,
      );
      setSelectedTicket(res.ticket);
      setComments(res.comments);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number })?.status;
      if (status === 401 || msg.includes('401') || msg.includes('reauth')) {
        setMeConnected(false);
        setView('me');
      } else {
        setDetailError("Couldn't load ticket details.");
      }
    } finally {
      setDetailLoading(false);
    }
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  async function onConnectPress() {
    if (connecting) return;
    setConnecting(true);
    setMeError(null);
    try {
      const result = await connectZendesk();
      if (result.ok) {
        // Browser is closed — clear the "Opening browser…" label immediately
        // so loadMe()'s own loading state takes over, not the connecting label.
        setConnecting(false);
        await loadMe();
        return;
      } else if (result.reason === 'unavailable') {
        setMeError('Update the app to connect Zendesk.');
      } else if (result.reason === 'failed') {
        setMeError('Could not connect your Zendesk account. Try again.');
      }
      // cancelled → do nothing
    } finally {
      setConnecting(false);
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  async function onDisconnectPress() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await api('/api/v1/zendesk/me/disconnect', { method: 'POST' });
      setMeConnected(false);
      setView('me');
      setTickets([]);
    } catch (e) {
      Alert.alert('Could not disconnect', e instanceof Error ? e.message : String(e));
    } finally {
      setDisconnecting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (meLoading) {
    return (
      <Section label="MY TICKETS">
        <Card padding={16}>
          <View style={{ alignItems: 'center', paddingVertical: 16 }}>
            <ActivityIndicator color={c.ink4} />
          </View>
        </Card>
      </Section>
    );
  }

  // connect state
  if (!meConnected) {
    return (
      <Section label="MY TICKETS">
        <Card padding={16}>
          {meError ? (
            <Body size={14} color={c.ink2} style={{ marginBottom: 14 }}>
              {meError}
            </Body>
          ) : (
            <Body muted size={14} style={{ marginBottom: 14 }}>
              Connect your personal Zendesk account to view and manage tickets assigned to you.
            </Body>
          )}
          <Button
            block
            disabled={connecting}
            onPress={() => void onConnectPress()}
          >
            {connecting ? 'Opening browser…' : 'Connect my Zendesk'}
          </Button>
        </Card>
      </Section>
    );
  }

  // ticket list
  if (view === 'list') {
    return (
      <Section label="MY TICKETS">
        {ticketsLoading ? (
          <Card padding={16}>
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <ActivityIndicator color={c.ink4} />
            </View>
          </Card>
        ) : ticketsError ? (
          <Card padding={16}>
            <Body size={14.5}>{ticketsError}</Body>
            <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
              <Button variant="outline" size="sm" onPress={() => void loadTickets()}>
                Try again
              </Button>
            </View>
          </Card>
        ) : tickets.length === 0 ? (
          <Card padding={16}>
            <Body muted size={14.5}>
              No tickets assigned to you.
            </Body>
          </Card>
        ) : (
          <>
            {tickets.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                onPress={() => void openTicket(ticket)}
              />
            ))}
          </>
        )}
        <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
          <Button
            variant="outline"
            size="sm"
            disabled={disconnecting}
            onPress={() => void onDisconnectPress()}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </View>
      </Section>
    );
  }

  // ticket detail
  return (
    <Section label="TICKET">
      <Card padding={16}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              setView('list');
              setSelectedTicket(null);
              setComments([]);
            }}
          />
          <Body size={13} muted>
            Back to tickets
          </Body>
        </View>

        {detailLoading ? (
          <View style={{ alignItems: 'center', paddingVertical: 16 }}>
            <ActivityIndicator color={c.ink4} />
          </View>
        ) : detailError ? (
          <Body size={14.5}>{detailError}</Body>
        ) : selectedTicket ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 14 }}>
              <Body size={15.5} style={{ flex: 1, fontFamily: FONT.display }}>
                {selectedTicket.subject}
              </Body>
              <StatusPill status={selectedTicket.status} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {selectedTicket.priority ? (
                <Pill status={priorityStatus(selectedTicket.priority)}>
                  {selectedTicket.priority.toUpperCase()}
                </Pill>
              ) : null}
              {selectedTicket.requesterId ? (
                <Body muted size={13}>
                  Requester #{selectedTicket.requesterId}
                </Body>
              ) : null}
            </View>
            <Body muted size={13} style={{ marginTop: 12 }}>
              {selectedTicket.description}
            </Body>

            {comments.length > 0 ? (
              <View style={{ marginTop: 20, gap: 12 }}>
                <Eyebrow>COMMENTS</Eyebrow>
                {comments.map((comment) => (
                  <CommentBubble key={comment.id} comment={comment} />
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </Card>
    </Section>
  );
}

// ── Ticket row ────────────────────────────────────────────────────────────────
function TicketRow({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, marginBottom: 8 })}
      accessibilityRole="button"
      accessibilityLabel={`View ticket: ${ticket.subject}`}
    >
      <Card padding={14}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
        >
          <Body
            size={14.5}
            style={{ flex: 1, fontFamily: FONT.display }}
            numberOfLines={2}
          >
            {ticket.subject}
          </Body>
          <StatusPill status={ticket.status} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 }}>
          {ticket.priority ? (
            <Pill status={priorityStatus(ticket.priority)} dot={false}>
              {ticket.priority.toUpperCase()}
            </Pill>
          ) : null}
          {ticket.requesterId ? (
            <Body muted size={12}>
              #{ticket.requesterId}
            </Body>
          ) : null}
        </View>
      </Card>
    </Pressable>
  );
}

// ── Comment bubble ─────────────────────────────────────────────────────────────
function CommentBubble({ comment }: { comment: Comment }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        backgroundColor: c.card,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.hair,
        padding: 12,
      }}
    >
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        {comment.authorId ? (
          <Body muted size={12}>
            Agent #{comment.authorId}
          </Body>
        ) : null}
        <Pill status={comment.public ? 'ok' : 'default'} dot={false}>
          {comment.public ? 'PUBLIC' : 'INTERNAL'}
        </Pill>
      </View>
      <Body size={13.5}>{comment.body}</Body>
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const pillStatus =
    s === 'open' ? 'crit'
    : s === 'pending' ? 'warn'
    : s === 'solved' || s === 'closed' ? 'default'
    : 'default';
  return <Pill status={pillStatus}>{status.toUpperCase()}</Pill>;
}

function priorityStatus(priority: string): 'default' | 'ok' | 'warn' | 'crit' {
  const p = priority.toLowerCase();
  if (p === 'urgent' || p === 'high') return 'crit';
  if (p === 'normal') return 'warn';
  return 'default';
}

// ── Section helper ────────────────────────────────────────────────────────────
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
