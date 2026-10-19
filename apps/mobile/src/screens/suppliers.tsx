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
 * one plain address (the card then shows the text, not a link). Plain: the
 * text without its outer spaces is one '@' between a name and a dotted domain,
 * with none of the characters that make a mailto: link do more than address
 * one person: '?' and '&' (a query: more recipients, a subject, a body), ','
 * and ';' (another address), '#' and '%' (a fragment, an escape), quotes,
 * brackets, slashes, colons, any space, and any control or invisible
 * formatting character. The address goes out percent-encoded
 * (encodeURIComponent), which the mail app reads back as the same address.
 */
function supplierMailtoUrl(email: string | null): string | null {
  const address = (email ?? '').trim();
  const parts = address.split('@');
  if (parts.length !== 2) return null;
  const [name = '', domain = ''] = parts;
  const plain = /^[^\s?&,;#%"<>()[\]\\/:@]+$/;
  if (!plain.test(name) || !plain.test(domain)) return null;
  // A dotted domain: "b.com", never "b", ".com", "b." or "b..com".
  if (!/^[^.]+(\.[^.]+)+$/.test(domain)) return null;
  for (const ch of address) {
    const code = ch.codePointAt(0) ?? 0;
    // Control characters (C0, DEL, C1) and the invisible formatting ones:
    // the soft hyphen, zero-width marks, direction overrides, word joiners
    // and the byte-order mark.
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xad ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    ) {
      return null;
    }
  }
  return `mailto:${encodeURIComponent(address)}`;
}

/**
 * The tel: link for a supplier's phone, or null when no digit is in it (the
 * card then shows the text, not a link). Only the digits and '+' reach the
 * dialler: letters, spaces, brackets, dashes, '*', '#', ',' and ';' are left
 * out, so the stored text can never dial a service code, add a pause and more
 * digits, or carry a parameter the card does not show.
 */
function supplierTelUrl(phone: string | null): string | null {
  const dial = (phone ?? '').replace(/[^0-9+]/g, '');
  return /[0-9]/.test(dial) ? `tel:${dial}` : null;
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
