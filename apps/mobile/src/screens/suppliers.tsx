import { Truck } from 'lucide-react-native';
import * as React from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { retryWorkspace } from '@/lib/use-workspace';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface SupplierRow {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

/** What the list shows, and the workspace it was read for. */
interface ListState<Row> {
  orgId: string;
  rows: Row[];
  /** The last read failed; any rows are an earlier read of this workspace's. */
  failed: boolean;
}

/**
 * The list after one read for `orgId` (`rows` null: the read failed). A failed
 * read is never "No suppliers yet." (redesign defect D25): it keeps the rows
 * this workspace already shows, marked failed so the screen says so above
 * them, or with none it is the failure itself. Another workspace's rows are
 * never kept.
 */
function settleList<Row>(
  prev: ListState<Row> | null,
  orgId: string,
  rows: Row[] | null,
): ListState<Row> {
  if (rows) return { orgId, rows, failed: false };
  return { orgId, rows: prev && prev.orgId === orgId ? prev.rows : [], failed: true };
}

/**
 * Suppliers screen. Lives in src/screens (not inline in a route file) so
 * TWO thin routes can render the same component: the drawer destination
 * app/(drawer)/suppliers.tsx and the optional bottom tab
 * app/(drawer)/(tabs)/suppliers-tab.tsx (Settings → Customize tab bar). The
 * tab-bar content inset comes from DataListScreen, which reads
 * BottomTabBarHeightContext and pads only when rendered inside the tabs
 * navigator — the drawer rendering is unchanged.
 *
 * A failed read says so (DataListScreen's `failed`), never "No suppliers
 * yet."; a refresh that fails keeps the list and says so above it; with no
 * workspace a pull loads it again.
 */
export default function SuppliersScreen() {
  const { orgId, loading: workspaceLoading } = useOrg();
  const [stored, setStored] = React.useState<ListState<SupplierRow> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Only the newest read may land (a refresh, or a workspace switch).
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let rows: SupplierRow[] | null = null;
    try {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, name, contact_name, email, phone, website')
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        .order('name', { ascending: true });
      // Only the message travels on (and into the warning below): never the
      // whole PostgREST error object.
      if (error) throw new Error(error.message);
      rows = (data ?? []) as SupplierRow[];
    } catch (e) {
      console.warn('[suppliers] load failed:', e instanceof Error ? e.message : e);
    }
    if (seq !== seqRef.current) return;
    setStored((prev) => settleList(prev, orgId, rows));
  }, [orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Only rows read for the workspace on screen.
  const list = stored && stored.orgId === orgId ? stored : null;
  const rows = React.useMemo(() => list?.rows ?? [], [list]);
  // No workspace could be loaded: the read never starts, so say so (a pull
  // loads the workspace again).
  const noWorkspace = !orgId && !workspaceLoading;
  const failedEmpty = noWorkspace || (list !== null && list.failed && rows.length === 0);

  async function refresh() {
    setRefreshing(true);
    try {
      await (noWorkspace ? retryWorkspace() : load());
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <DataListScreen
      eyebrow={
        list === null || failedEmpty
          ? 'DIRECTORY · SUPPLIERS'
          : `DIRECTORY · ${rows.length} SUPPLIERS`
      }
      title="Suppliers"
      italic="& carriers."
      emptyTitle="No suppliers yet."
      emptyBody="Add vendors on the web to attach them to purchase orders here."
      emptyIcon={Truck}
      failed={
        noWorkspace
          ? {
              title: 'Could not load your workspace.',
              body: 'Check your connection and pull down to try again.',
            }
          : list?.failed
            ? {
                title: 'Could not load suppliers.',
                body: 'Check your connection and pull down to try again.',
                reloadNote: 'Could not refresh the suppliers. Pull down to try again.',
              }
            : null
      }
      data={rows}
      loading={!noWorkspace && list === null}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      keyExtractor={(s) => s.id}
      renderItem={(s) => <SupplierCard supplier={s} />}
    />
  );
}

/**
 * THE LINKS ON A SUPPLIER CARD OPEN ONLY WHAT THE CARD SHOWS (security fix,
 * redesign package P5.8). The card shows the stored email and phone exactly as
 * they were typed; a link is made from them only when it cannot open anything
 * else. Before, `mailto:${email}` and `tel:${phone}` went out as typed, so an
 * email such as "a@b.com?bcc=x@y.z" opened a message copied to someone the
 * card never names, and a phone with letters or symbols dialled something
 * other than the number shown.
 *
 * The mailto: link for a supplier's email, or null when the stored text is not
 * one plain address (the card then shows the text, not a link). Plain is an
 * allow-list, so anything not named here fails closed: the text without its
 * outer spaces is one '@' between a name and a domain, both ASCII only. The
 * name is dot-separated runs of letters, digits and ! $ ' * + = ^ _ ` { | } ~ -
 * (never '?', '&', ',', ';', '#', '%', '/', quotes, brackets, colons or
 * spaces, which make a mailto: link do more than address one person). The
 * domain is two or more dot-separated labels of letters, digits and inner
 * hyphens. The name is at most 64 characters, each domain label at most 63
 * and the whole address at most 254 (RFC 5321). So no control, invisible,
 * look-alike or other non-ASCII character, and no over-long address, can
 * reach the link. The name and the domain go out percent-encoded
 * (encodeURIComponent) on either side of a literal '@': RFC 6068 keeps the
 * separating '@' literal (addr-spec = local-part "@" domain), and an encoded
 * %40 would be a character inside the name, leaving no domain.
 */
function supplierMailtoUrl(email: string | null): string | null {
  const address = (email ?? '').trim();
  if (address.length > 254) return null;
  const parts = address.split('@');
  if (parts.length !== 2) return null;
  const [name = '', domain = ''] = parts;
  const atom = "[A-Za-z0-9!$'*+=^_`{|}~-]+";
  const label = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
  if (!new RegExp(`^${atom}(?:\\.${atom})*$`).test(name) || name.length > 64) return null;
  if (!new RegExp(`^${label}(?:\\.${label})+$`).test(domain)) return null;
  return `mailto:${encodeURIComponent(name)}@${encodeURIComponent(domain)}`;
}

/**
 * The tel: link for a supplier's phone, or null when the stored text is not
 * one plain phone number (the card then shows the text, not a link). Plain is
 * an allow-list that fails closed. The text, with its outer spaces trimmed and
 * any non-breaking space read as a space, holds only ASCII digits, spaces,
 * dots, dashes and round brackets, with at most one '+' and only at the start.
 * Without a '+', and after '+1', the text must be grouped as one North
 * American number: 555-0100, (555) 010-0100, 555.010.0100 or 1-555-010-0100,
 * never a number with a trailing group such as '555-0100 123'. After '+7' it
 * is 11 digits. After any other '+' it is 8 to 15 digits (E.164), and a
 * bracketed trunk 0 right after the country code, as in '+44 (0)20 7946
 * 0958', is not dialled. A number written with a dialling prefix such as 011
 * instead of '+' is shown as text. So an extension, a second number,
 * letters, a service code ('*', '#'), a pause (',', ';') or a parameter never
 * becomes a link. Only the digits and the leading '+' reach the dialler. One
 * case a pattern cannot tell apart: an international '+' number followed by
 * an unmarked extension that still totals 15 digits or fewer is linked as one
 * longer number; the digits dialled are still the digits shown.
 */
function supplierTelUrl(phone: string | null): string | null {
  const text = (phone ?? '').replace(/[\u00a0\u2007\u202f]/g, ' ').trim();
  if (!/^\+?[0-9 .()-]+$/.test(text)) return null;
  const digits = (t: string) => t.replace(/[^0-9]/g, '');
  // North American shapes: a 7-digit local number, a 10-digit one with its
  // area code, and the 10-digit one after a leading 1 or +1.
  const local = '[0-9]{3}[ .-]?[0-9]{4}';
  const withArea = `(?:\\([0-9]{3}\\) ?|[0-9]{3}[ .-]?)${local}`;
  if (!text.startsWith('+')) {
    const northAmerican = new RegExp(`^(?:${local}|${withArea}|1[ .-]?${withArea})$`);
    return northAmerican.test(text) ? `tel:${digits(text)}` : null;
  }
  if (text.startsWith('+1')) {
    return new RegExp(`^\\+1[ .-]?${withArea}$`).test(text) ? `tel:+${digits(text)}` : null;
  }
  const dialled = digits(text.replace(/^(\+[0-9]{1,3})[ .-]*\(0\)/, '$1 '));
  if (dialled.startsWith('7')) return dialled.length === 11 ? `tel:+${dialled}` : null;
  return dialled.length >= 8 && dialled.length <= 15 ? `tel:+${dialled}` : null;
}

/**
 * One contact line, its words exactly as stored: a link to VoiceOver when
 * `url` is set, in a frame at least 44pt tall (it was the height of its 11.5pt
 * line); otherwise the same words, as plain text in the same frame, so the
 * card reads the same either way.
 */
function ContactLine({ text, url }: { text: string; url: string | null }) {
  const { c } = useTheme();
  const words = (
    <Mono size={11.5} tracking={0.04} color={c.ink2}>
      {text}
    </Mono>
  );
  if (!url) return <View style={styles.link}>{words}</View>;
  return (
    <Pressable
      onPress={() => Linking.openURL(url).catch(() => undefined)}
      accessibilityRole="link"
      style={({ pressed }) => [styles.link, { opacity: pressed ? 0.7 : 1 }]}
    >
      {words}
    </Pressable>
  );
}

function SupplierCard({ supplier }: { supplier: SupplierRow }) {
  const { c } = useTheme();

  return (
    <Card padding={14}>
      <View style={styles.row}>
        {/* The truck sits in a recessed well (sunk: paper2 and the card are
            one colour in dark, so a card-coloured well drew nothing). */}
        <View style={[styles.well, { borderColor: c.hair, backgroundColor: c.sunk }]}>
          <Truck size={18} color={c.ink} strokeWidth={1.5} />
        </View>
        <View style={styles.body}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {supplier.name}
          </Body>
          {supplier.contact_name ? (
            <Mono size={11.5} tracking={0.04} color={c.ink3} style={{ marginTop: 4 }}>
              {supplier.contact_name}
            </Mono>
          ) : null}
          {/* Each opens Mail or the phone, and only with a link made from a
              plain address or the number's digits (supplierMailtoUrl,
              supplierTelUrl); the words shown are the stored text. */}
          {supplier.email ? (
            <ContactLine text={supplier.email} url={supplierMailtoUrl(supplier.email)} />
          ) : null}
          {supplier.phone ? (
            <ContactLine text={supplier.phone} url={supplierTelUrl(supplier.phone)} />
          ) : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  well: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, minWidth: 0 },
  link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
});
