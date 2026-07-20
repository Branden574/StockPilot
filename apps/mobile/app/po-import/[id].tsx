import { can, type Role } from '@stockpilot/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { listWarehouses, type CachedWarehouse } from '@/lib/db-reads';
import {
  actionsForStatus,
  buildLineOverrides,
  createLineIds,
  isSiteLocation,
  normalizeExpectedAt,
  unmatchedLineIds,
  validateApprove,
  type LineDecision,
  type MatchCandidate,
} from '@/lib/po-import-approve';
import {
  approvePoImport,
  cancelPoImport,
  createItemsFromLines,
  fetchLineMatches,
  parsePoImport,
} from '@/lib/po-imports-api';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, SHADOW } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';

// Same partition the PO List screen uses — keep the two in sync.
const STATUS_META: Record<string, { label: string; status: 'ok' | 'warn' | 'crit' | 'default' }> = {
  uploaded: { label: 'UPLOADED', status: 'default' },
  parsing: { label: 'PARSING', status: 'warn' },
  parsed: { label: 'PARSED', status: 'ok' },
  needs_review: { label: 'REVIEW', status: 'warn' },
  approved: { label: 'APPROVED', status: 'ok' },
  failed: { label: 'FAILED', status: 'crit' },
  duplicate: { label: 'DUPLICATE', status: 'crit' },
  canceled: { label: 'CANCELLED', status: 'default' },
};

interface ImportHeader {
  id: string;
  status: string;
  source_type: string;
  file_name: string;
  parse_error: string | null;
  approved_po_id: string | null;
  vendor_id: string | null;
  warehouse_id: string | null;
  created_at: string;
  vendor_name: string | null;
  /** Defensive extract of parsed_json's header block (may be entirely null). */
  po_number: string | null;
  po_date: string | null;
  total_amount: number | null;
}

interface ImportLine {
  id: string;
  line_number: number;
  line_type: string;
  qty: number | null;
  uom: string | null;
  description: string | null;
  unit_cost: number | null;
  line_total: number | null;
  vendor_item_number: string | null;
  item_id: string | null;
  suggested_item_id: string | null;
  exception_reason: string | null;
}

interface ItemRef {
  id: string;
  name: string;
  sku: string;
}

/** parsed_json is untrusted (AI/parser output) — read the header fields defensively. */
function readParsedHeader(raw: unknown): {
  poNumber: string | null;
  poDate: string | null;
  totalAmount: number | null;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { poNumber: null, poDate: null, totalAmount: null };
  }
  const r = raw as Record<string, unknown>;
  return {
    poNumber: typeof r.poNumber === 'string' && r.poNumber.trim() ? r.poNumber.trim() : null,
    poDate: typeof r.poDate === 'string' && r.poDate.trim() ? r.poDate.trim() : null,
    totalAmount:
      typeof r.totalAmount === 'number' && Number.isFinite(r.totalAmount) ? r.totalAmount : null,
  };
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

/**
 * Native PO-import detail — parity for the web review page at
 * /dashboard/purchase-orders/imports/[id]. READS via Supabase under RLS
 * (org-scoped, same convention as every detail screen); WRITES via the
 * Bearer /api/v1/po-imports/[id]/* routes (po-imports-api.ts), which
 * re-assert 'purchase_orders:manage' server-side — the can() gate here is
 * cosmetic, exactly like the item screen's transfer/restore gates.
 */
export default function PoImportDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { orgId } = useOrg();
  const { c } = useTheme();
  const { role } = useRole();
  const permissions = useEffectivePermissions();

  const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);
  const canManage =
    isManager ||
    (role !== null && can({ role: role as Role, permissions }, 'purchase_orders:manage'));

  const [header, setHeader] = React.useState<ImportHeader | null>(null);
  const [lines, setLines] = React.useState<ImportLine[]>([]);
  const [itemsById, setItemsById] = React.useState<Record<string, ItemRef>>({});
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionBusy, setActionBusy] = React.useState<'parse' | 'cancel' | null>(null);
  const [approveOpen, setApproveOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id || !orgId) return;
    setLoadError(null);
    const [{ data: head, error: hErr }, { data: lineRows, error: lErr }] = await Promise.all([
      supabase
        .from('po_imports')
        .select(
          `id, status, source_type, file_name, parse_error, approved_po_id,
           vendor_id, warehouse_id, created_at, parsed_json,
           vendor:suppliers!vendor_id (name)`,
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('po_import_lines')
        .select(
          `id, line_number, line_type, qty_ordered_original, uom_original,
           description, unit_cost, line_total, vendor_item_number, item_id,
           suggested_item_id, exception_reason`,
        )
        .eq('po_import_id', id)
        .order('line_number', { ascending: true })
        .limit(500),
    ]);

    if (hErr || lErr) {
      setLoadError(hErr?.message ?? lErr?.message ?? 'Could not load this import.');
      setLoading(false);
      return;
    }
    if (!head) {
      // Not found OR not visible under RLS — same message either way.
      setHeader(null);
      setLines([]);
      setLoading(false);
      return;
    }

    const r = head as Record<string, unknown>;
    const vendorField = r.vendor as { name: string | null } | { name: string | null }[] | null;
    const vendor = Array.isArray(vendorField) ? (vendorField[0] ?? null) : vendorField;
    const parsed = readParsedHeader(r.parsed_json);
    setHeader({
      id: r.id as string,
      status: (r.status as string) ?? 'uploaded',
      source_type: (r.source_type as string) ?? 'pdf',
      file_name: (r.file_name as string) ?? '',
      parse_error: (r.parse_error as string | null) ?? null,
      approved_po_id: (r.approved_po_id as string | null) ?? null,
      vendor_id: (r.vendor_id as string | null) ?? null,
      warehouse_id: (r.warehouse_id as string | null) ?? null,
      created_at: (r.created_at as string) ?? '',
      vendor_name: vendor?.name ?? null,
      po_number: parsed.poNumber,
      po_date: parsed.poDate,
      total_amount: parsed.totalAmount,
    });

    const flat: ImportLine[] = (lineRows ?? []).map((row) => {
      const lr = row as Record<string, unknown>;
      return {
        id: lr.id as string,
        line_number: Number(lr.line_number) || 0,
        line_type: (lr.line_type as string) ?? 'unknown',
        qty: lr.qty_ordered_original == null ? null : Number(lr.qty_ordered_original),
        uom: (lr.uom_original as string | null) ?? null,
        description: (lr.description as string | null) ?? null,
        unit_cost: lr.unit_cost == null ? null : Number(lr.unit_cost),
        line_total: lr.line_total == null ? null : Number(lr.line_total),
        vendor_item_number: (lr.vendor_item_number as string | null) ?? null,
        item_id: (lr.item_id as string | null) ?? null,
        suggested_item_id: (lr.suggested_item_id as string | null) ?? null,
        exception_reason: (lr.exception_reason as string | null) ?? null,
      };
    });
    setLines(flat);

    // Resolve linked + suggested item names in one org-scoped lookup.
    const refIds = Array.from(
      new Set(
        flat
          .flatMap((l) => [l.item_id, l.suggested_item_id])
          .filter((v): v is string => Boolean(v)),
      ),
    );
    if (refIds.length > 0) {
      const { data: items } = await supabase
        .from('inventory_items')
        .select('id, name, sku')
        .eq('organization_id', orgId)
        .in('id', refIds);
      const map: Record<string, ItemRef> = {};
      for (const it of (items ?? []) as ItemRef[]) map[it.id] = it;
      setItemsById(map);
    } else {
      setItemsById({});
    }
    setLoading(false);
  }, [id, orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(drawer)/po-imports' as never);
  };

  const actions = header && canManage ? actionsForStatus(header.status) : [];
  const unmatched = React.useMemo(() => unmatchedLineIds(lines), [lines]);

  // Fallback total when the parser didn't extract one: sum of line totals.
  const lineTotalSum = React.useMemo(() => {
    let sum = 0;
    let any = false;
    for (const l of lines) {
      if (l.line_total != null && Number.isFinite(l.line_total)) {
        sum += l.line_total;
        any = true;
      }
    }
    return any ? sum : null;
  }, [lines]);

  async function runParse() {
    if (!header || actionBusy) return;
    setActionBusy('parse');
    setActionError(null);
    try {
      await parsePoImport(header.id);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not re-parse this import.');
    } finally {
      setActionBusy(null);
    }
  }

  function confirmCancel() {
    if (!header || actionBusy) return;
    Alert.alert(
      'Cancel this import?',
      'The import is discarded and any items it auto-created (still unused) are archived. This cannot be undone.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel import',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setActionBusy('cancel');
              setActionError(null);
              try {
                await cancelPoImport(header.id);
                await load();
              } catch (e) {
                setActionError(e instanceof Error ? e.message : 'Could not cancel this import.');
              } finally {
                setActionBusy(null);
              }
            })();
          },
        },
      ],
    );
  }

  function handleApproved(poId: string) {
    setApproveOpen(false);
    Alert.alert('Approved', 'Purchase order created — it now expects receiving.', [
      {
        text: 'View PO',
        onPress: () => router.replace({ pathname: '/po/[id]', params: { id: poId } }),
      },
    ]);
  }

  const meta = header
    ? (STATUS_META[header.status] ?? { label: header.status.toUpperCase(), status: 'default' as const })
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View
          style={{
            paddingHorizontal: 12,
            paddingTop: 8,
            paddingBottom: 4,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <IconChip icon={ArrowLeft} onPress={goBack} />
        </View>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
          <Eyebrow>PROCUREMENT · PO IMPORT</Eyebrow>
          <Display size={28} style={{ marginTop: 10 }}>
            Review <Em>import.</Em>
          </Display>
        </View>
      </SafeAreaView>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.ink} />
        </View>
      ) : !header ? (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <Body muted style={{ textAlign: 'center' }}>
            {loadError ?? 'This import was not found, or you no longer have access to it.'}
          </Body>
        </View>
      ) : (
        <>
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 160, gap: 10 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
          >
            <Card padding={14}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
                    — {header.source_type}
                  </Mono>
                  <Body size={15} color={c.ink} style={{ marginTop: 6, fontFamily: FONT.display }}>
                    {header.po_number ?? header.file_name}
                  </Body>
                  <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                    {header.vendor_name ? `${header.vendor_name} · ` : ''}
                    {header.created_at
                      ? new Date(header.created_at).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : ''}
                  </Mono>
                </View>
                {meta ? (
                  meta.status === 'default' ? (
                    <Pill>{meta.label}</Pill>
                  ) : (
                    <Pill status={meta.status}>{meta.label}</Pill>
                  )
                ) : null}
              </View>

              <View style={{ flexDirection: 'row', gap: 18, marginTop: 12 }}>
                <HeaderStat label="LINES" value={String(lines.length)} />
                <HeaderStat label="PO DATE" value={header.po_date ?? '—'} />
                <HeaderStat
                  label="TOTAL"
                  value={
                    header.total_amount != null
                      ? money(header.total_amount)
                      : lineTotalSum != null
                        ? money(lineTotalSum)
                        : '—'
                  }
                />
              </View>

              {header.parse_error ? (
                <Mono size={11.5} color={ACCENT.crit} style={{ marginTop: 10, lineHeight: 16 }}>
                  {header.parse_error}
                </Mono>
              ) : null}
            </Card>

            {header.status === 'approved' && header.approved_po_id ? (
              <Button
                block
                variant="outline"
                onPress={() =>
                  router.push({ pathname: '/po/[id]', params: { id: header.approved_po_id! } })
                }
              >
                View created PO
              </Button>
            ) : null}

            <View style={{ marginTop: 8 }}>
              <Eyebrow>PARSED LINES</Eyebrow>
            </View>
            {lines.length === 0 ? (
              <Body muted size={13} style={{ marginTop: 4 }}>
                {header.status === 'uploaded' || header.status === 'parsing'
                  ? 'No lines yet — parse the file to extract them.'
                  : 'No lines were extracted from this file.'}
              </Body>
            ) : (
              lines.map((l) => (
                <LineCard key={l.id} line={l} itemsById={itemsById} />
              ))
            )}
          </ScrollView>

          {actions.length > 0 ? (
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                paddingHorizontal: 20,
                paddingTop: 12,
                paddingBottom: 28,
                backgroundColor: c.paper,
                borderTopWidth: 1,
                borderTopColor: c.hair,
                gap: 8,
              }}
            >
              {actionError ? (
                <Mono size={11.5} color={ACCENT.crit} style={{ lineHeight: 16 }}>
                  {actionError}
                </Mono>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {actions.includes('cancel') ? (
                  <View style={{ flex: 1 }}>
                    <Button
                      block
                      variant="ghost"
                      disabled={actionBusy !== null}
                      onPress={confirmCancel}
                    >
                      {actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel import'}
                    </Button>
                  </View>
                ) : null}
                {actions.includes('parse') ? (
                  <View style={{ flex: 1 }}>
                    <Button block disabled={actionBusy !== null} onPress={() => void runParse()}>
                      {actionBusy === 'parse'
                        ? 'Parsing…'
                        : header.status === 'failed'
                          ? 'Retry parse'
                          : 'Parse file'}
                    </Button>
                  </View>
                ) : null}
                {actions.includes('approve') ? (
                  <View style={{ flex: 1 }}>
                    <Button
                      block
                      disabled={actionBusy !== null}
                      onPress={() => {
                        setActionError(null);
                        setApproveOpen(true);
                      }}
                    >
                      Approve…
                    </Button>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          {orgId ? (
            <ApproveSheet
              visible={approveOpen}
              importId={header.id}
              orgId={orgId}
              defaultWarehouseId={header.warehouse_id}
              defaultVendorId={header.vendor_id}
              unmatchedLines={lines.filter((l) => unmatched.includes(l.id))}
              itemsById={itemsById}
              onClose={() => setApproveOpen(false)}
              onApproved={handleApproved}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  const { c } = useTheme();
  return (
    <View>
      <Mono size={9.5} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <Body size={14} color={c.ink} style={{ marginTop: 3, fontFamily: FONT.display }}>
        {value}
      </Body>
    </View>
  );
}

function LineCard({
  line,
  itemsById,
}: {
  line: ImportLine;
  itemsById: Record<string, ItemRef>;
}) {
  const { c } = useTheme();
  const isInventory = line.line_type === 'inventory';
  const matched = line.item_id ? itemsById[line.item_id] : undefined;
  const suggested = line.suggested_item_id ? itemsById[line.suggested_item_id] : undefined;

  const qtyText = line.qty != null && Number.isFinite(line.qty) ? String(line.qty) : '—';
  const costText =
    line.unit_cost != null && Number.isFinite(line.unit_cost) ? money(line.unit_cost) : '—';
  const totalText =
    line.line_total != null && Number.isFinite(line.line_total) ? money(line.line_total) : null;

  return (
    <Card padding={14}>
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono size={9.5} tracking={0.12} upper color={c.ink4}>
            LINE {line.line_number}
            {!isInventory ? ` · ${line.line_type}` : ''}
          </Mono>
          <Body size={14} color={c.ink} style={{ marginTop: 5 }} numberOfLines={3}>
            {line.description?.trim() || 'No description'}
          </Body>
          <Mono size={11} tracking={0.02} color={c.ink4} style={{ marginTop: 4 }}>
            {qtyText}
            {line.uom ? ` ${line.uom}` : ''} × {costText}
            {totalText ? ` · ${totalText}` : ''}
            {line.vendor_item_number ? ` · #${line.vendor_item_number}` : ''}
          </Mono>
          {isInventory ? (
            matched ? (
              <Mono size={11} color={c.ink3} style={{ marginTop: 6 }}>
                → {matched.name} ({matched.sku})
              </Mono>
            ) : suggested ? (
              <Mono size={11} color={c.ink4} style={{ marginTop: 6 }}>
                Suggested: {suggested.name} ({suggested.sku})
              </Mono>
            ) : line.exception_reason ? (
              <Mono size={11} color={c.ink4} style={{ marginTop: 6 }}>
                {line.exception_reason}
              </Mono>
            ) : null
          ) : null}
        </View>
        {isInventory ? (
          line.item_id ? (
            <Pill status="ok">MATCHED</Pill>
          ) : (
            <Pill status="warn">UNMATCHED</Pill>
          )
        ) : (
          <Pill>{line.line_type.toUpperCase()}</Pill>
        )}
      </View>
    </Card>
  );
}

// ── Approve sheet ───────────────────────────────────────────────────────────

interface PickerOption {
  id: string;
  name: string;
}

interface SiteLocationRow extends PickerOption {
  type: string | null;
  kind: string | null;
  warehouse_id: string | null;
}

/**
 * Bottom-sheet approve flow (MoveStockModal conventions). Collects the
 * REQUIRED warehouse / vendor / destination location (sites-only, scoped to
 * the chosen warehouse — approve's resolveDestinationLocation rejects any
 * location outside it), the optional bill-to charter + expected date, then a
 * decision for every UNMATCHED inventory line (use a suggested existing item /
 * create a new one / skip). Submission batches the create decisions through
 * create-items first, then approves with the built lineOverrides.
 */
function ApproveSheet({
  visible,
  importId,
  orgId,
  defaultWarehouseId,
  defaultVendorId,
  unmatchedLines,
  itemsById,
  onClose,
  onApproved,
}: {
  visible: boolean;
  importId: string;
  orgId: string;
  defaultWarehouseId: string | null;
  defaultVendorId: string | null;
  unmatchedLines: ImportLine[];
  itemsById: Record<string, ItemRef>;
  onClose: () => void;
  onApproved: (poId: string) => void;
}) {
  const { c, mode } = useTheme();
  const [loading, setLoading] = React.useState(true);
  const [warehouses, setWarehouses] = React.useState<CachedWarehouse[]>([]);
  const [vendors, setVendors] = React.useState<PickerOption[]>([]);
  const [charters, setCharters] = React.useState<PickerOption[]>([]);
  const [siteLocations, setSiteLocations] = React.useState<SiteLocationRow[]>([]);
  const [suggestions, setSuggestions] = React.useState<Record<string, MatchCandidate[]>>({});
  const [suggestionsNote, setSuggestionsNote] = React.useState<string | null>(null);

  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [vendorId, setVendorId] = React.useState<string | null>(null);
  const [locationId, setLocationId] = React.useState<string | null>(null);
  const [charterId, setCharterId] = React.useState<string | null>(null);
  const [expectedAtText, setExpectedAtText] = React.useState('');
  const [decisions, setDecisions] = React.useState<Record<string, LineDecision>>({});

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Synchronous re-entry guard (double-tap can't fire two approves before the
  // disabled state re-renders) — same pattern as the PO receive screen.
  const submittingRef = React.useRef(false);

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSuggestionsNote(null);
    setWarehouseId(defaultWarehouseId);
    setVendorId(defaultVendorId);
    setLocationId(null);
    setCharterId(null);
    setExpectedAtText('');
    setDecisions({});
    void (async () => {
      const [whs, vendorsRes, chartersRes, locationsRes] = await Promise.all([
        listWarehouses(),
        supabase
          .from('suppliers')
          .select('id, name')
          .eq('organization_id', orgId)
          .is('deleted_at', null)
          .order('name', { ascending: true }),
        supabase
          .from('charters')
          .select('id, name')
          .eq('organization_id', orgId)
          .order('name', { ascending: true }),
        supabase
          .from('locations')
          .select('id, name, type, kind, warehouse_id')
          .eq('organization_id', orgId)
          .is('deleted_at', null)
          .order('name', { ascending: true }),
      ]);
      if (cancelled) return;
      setWarehouses(whs);
      // Keep the header's warehouse when it exists, else default to the only/first.
      setWarehouseId((cur) => cur ?? (whs.length === 1 ? (whs[0]?.id ?? null) : null));
      setVendors((vendorsRes.data ?? []) as PickerOption[]);
      setCharters((chartersRes.data ?? []) as PickerOption[]);
      setSiteLocations(
        ((locationsRes.data ?? []) as SiteLocationRow[]).filter((l) => isSiteLocation(l)),
      );
      setLoading(false);

      // Suggestions load AFTER the pickers render — a slow/failed fetch only
      // degrades the "use existing" chips, never blocks the sheet.
      if (unmatchedLines.length > 0) {
        try {
          const matches = await fetchLineMatches(
            importId,
            unmatchedLines.map((l) => l.id),
          );
          if (!cancelled) setSuggestions(matches);
        } catch (e) {
          if (!cancelled) {
            setSuggestions({});
            setSuggestionsNote(
              e instanceof Error
                ? `Suggestions unavailable — ${e.message}`
                : 'Suggestions unavailable.',
            );
          }
        }
      } else {
        setSuggestions({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, importId, orgId, defaultWarehouseId, defaultVendorId, unmatchedLines]);

  // Destination must live inside the chosen warehouse (server-enforced).
  const locationChoices = React.useMemo(
    () => siteLocations.filter((l) => !warehouseId || l.warehouse_id === warehouseId),
    [siteLocations, warehouseId],
  );

  function pickWarehouse(id: string) {
    setWarehouseId(id);
    // A location from another warehouse would be rejected server-side — clear it.
    setLocationId((cur) => {
      if (!cur) return cur;
      const still = siteLocations.find((l) => l.id === cur);
      return still && still.warehouse_id === id ? cur : null;
    });
  }

  /** Candidates for one line: server matches + the line's own advisory suggestion. */
  function candidatesFor(line: ImportLine): MatchCandidate[] {
    const fromServer = suggestions[line.id] ?? [];
    const merged: MatchCandidate[] = [...fromServer];
    if (line.suggested_item_id && !merged.some((m) => m.id === line.suggested_item_id)) {
      const ref = itemsById[line.suggested_item_id];
      merged.push({
        id: line.suggested_item_id,
        name: ref?.name ?? 'Suggested item',
        sku: ref?.sku ?? '',
        barcode: null,
        quantityOnHand: 0,
        matchType: 'barcode',
      });
    }
    return merged;
  }

  const unmatchedIds = React.useMemo(
    () => unmatchedLines.map((l) => l.id),
    [unmatchedLines],
  );
  const validation = validateApprove({ warehouseId, vendorId, locationId }, unmatchedIds, decisions);
  const expected = normalizeExpectedAt(expectedAtText);
  const canSubmit = validation.ok && expected.ok && !submitting && !loading;

  async function submit() {
    if (!canSubmit || !validation.ok || !expected.ok) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // 1) Batch-create items for every "create" decision. The server maps
      //    those lines to the new items, so approve sees them resolved.
      const toCreate = createLineIds(decisions);
      if (toCreate.length > 0) {
        await createItemsFromLines(importId, {
          lineIds: toCreate,
          vendorId: vendorId!,
          warehouseId,
          charterId: charterId ?? null,
          locationId: locationId ?? null,
        });
      }
      // 2) Approve with the remaining per-line overrides (use-existing/skip).
      const { poId } = await approvePoImport(importId, {
        warehouseId: warehouseId!,
        vendorId: vendorId!,
        locationId: locationId!,
        charterId: charterId ?? null,
        expectedAt: expected.value,
        lineOverrides: buildLineOverrides(decisions),
      });
      onApproved(poId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not approve this import.');
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  function Chip({
    label,
    active,
    onPress,
  }: {
    label: string;
    active: boolean;
    onPress: () => void;
  }) {
    return (
      <Pressable
        onPress={onPress}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 9,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: active ? c.ink : c.hair,
          backgroundColor: active ? c.ink : c.paper2,
        }}
      >
        <Mono size={12.5} color={active ? c.card : c.ink}>
          {label}
        </Mono>
      </Pressable>
    );
  }

  function FieldLabel({ children }: { children: React.ReactNode }) {
    return (
      <Mono size={10} tracking={0.12} upper color={c.ink4}>
        {children}
      </Mono>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={[
              {
                backgroundColor: c.card,
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                paddingTop: 12,
                paddingBottom: 36,
                paddingHorizontal: 22,
                maxHeight: '90%',
              },
              SHADOW.sheet,
            ]}
          >
            <View style={{ alignItems: 'center', marginBottom: 18 }}>
              <View
                style={{
                  width: 36,
                  height: 5,
                  borderRadius: 100,
                  backgroundColor:
                    mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
                }}
              />
            </View>

            <Eyebrow>APPROVE IMPORT</Eyebrow>
            <Display size={24} style={{ marginTop: 10 }}>
              Create the PO
            </Display>

            {loading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color={c.ink4} />
              </View>
            ) : (
              <ScrollView
                style={{ marginTop: 18 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={{ gap: 6, marginBottom: 16 }}>
                  <FieldLabel>WAREHOUSE *</FieldLabel>
                  {warehouses.length === 0 ? (
                    <Mono size={11} color={c.ink4}>
                      No warehouses — create one on the web first.
                    </Mono>
                  ) : (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {warehouses.map((w) => (
                        <Chip
                          key={w.id}
                          label={w.name}
                          active={w.id === warehouseId}
                          onPress={() => pickWarehouse(w.id)}
                        />
                      ))}
                    </View>
                  )}
                </View>

                <View style={{ gap: 6, marginBottom: 16 }}>
                  <FieldLabel>VENDOR *</FieldLabel>
                  {vendors.length === 0 ? (
                    <Mono size={11} color={c.ink4}>
                      No suppliers yet — add the vendor on the web first.
                    </Mono>
                  ) : (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {vendors.map((v) => (
                        <Chip
                          key={v.id}
                          label={v.name}
                          active={v.id === vendorId}
                          onPress={() => setVendorId(v.id)}
                        />
                      ))}
                    </View>
                  )}
                </View>

                <View style={{ gap: 6, marginBottom: 16 }}>
                  <FieldLabel>RECEIVE INTO (SITE) *</FieldLabel>
                  {!warehouseId ? (
                    <Mono size={11} color={c.ink4}>
                      Pick a warehouse first.
                    </Mono>
                  ) : locationChoices.length === 0 ? (
                    <Mono size={11} color={c.ink4}>
                      No site locations in this warehouse — add one on the web first.
                    </Mono>
                  ) : (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {locationChoices.map((l) => (
                        <Chip
                          key={l.id}
                          label={l.name}
                          active={l.id === locationId}
                          onPress={() => setLocationId(l.id)}
                        />
                      ))}
                    </View>
                  )}
                </View>

                <View style={{ gap: 6, marginBottom: 16 }}>
                  <FieldLabel>BILL-TO CHARTER (OPTIONAL)</FieldLabel>
                  {charters.length === 0 ? (
                    <Mono size={11} color={c.ink4}>
                      No charters configured — the PO stays generic.
                    </Mono>
                  ) : (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      <Chip
                        label="Generic"
                        active={charterId === null}
                        onPress={() => setCharterId(null)}
                      />
                      {charters.map((ch) => (
                        <Chip
                          key={ch.id}
                          label={ch.name}
                          active={ch.id === charterId}
                          onPress={() => setCharterId(ch.id)}
                        />
                      ))}
                    </View>
                  )}
                </View>

                <View style={{ gap: 6, marginBottom: 16 }}>
                  <FieldLabel>EXPECTED DATE (OPTIONAL · YYYY-MM-DD)</FieldLabel>
                  <TextInput
                    value={expectedAtText}
                    onChangeText={setExpectedAtText}
                    placeholder="2026-08-01"
                    placeholderTextColor={c.ink5}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="numbers-and-punctuation"
                    style={{
                      fontFamily: FONT.displayRegular,
                      fontSize: 15,
                      height: 46,
                      paddingHorizontal: 12,
                      borderWidth: 1,
                      borderColor: !expected.ok ? ACCENT.crit : c.hair,
                      borderRadius: 8,
                      color: c.ink,
                      backgroundColor: c.paper2,
                    }}
                  />
                  {!expected.ok ? (
                    <Mono size={11} color={ACCENT.crit}>
                      Use YYYY-MM-DD (or leave blank).
                    </Mono>
                  ) : null}
                </View>

                {unmatchedLines.length > 0 ? (
                  <View style={{ gap: 6, marginBottom: 6 }}>
                    <FieldLabel>UNMATCHED LINES *</FieldLabel>
                    <Mono size={11} color={c.ink4} style={{ lineHeight: 16 }}>
                      Decide each line: link an existing item, create a new one, or skip it.
                    </Mono>
                    {suggestionsNote ? (
                      <Mono size={11} color={c.ink4} style={{ lineHeight: 16 }}>
                        {suggestionsNote}
                      </Mono>
                    ) : null}
                    {unmatchedLines.map((l) => {
                      const d = decisions[l.id];
                      const candidates = candidatesFor(l);
                      return (
                        <View
                          key={l.id}
                          style={{
                            borderWidth: 1,
                            borderColor: c.hair,
                            borderRadius: 10,
                            padding: 12,
                            marginTop: 6,
                            gap: 8,
                          }}
                        >
                          <Body size={13} color={c.ink} numberOfLines={2}>
                            {l.description?.trim() || `Line ${l.line_number}`}
                          </Body>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {candidates.map((cand) => (
                              <Chip
                                key={cand.id}
                                label={`Use · ${cand.name}${cand.sku ? ` (${cand.sku})` : ''}`}
                                active={d?.mode === 'use_existing' && d.itemId === cand.id}
                                onPress={() =>
                                  setDecisions((cur) => ({
                                    ...cur,
                                    [l.id]: { mode: 'use_existing', itemId: cand.id },
                                  }))
                                }
                              />
                            ))}
                            <Chip
                              label="Create new"
                              active={d?.mode === 'create'}
                              onPress={() =>
                                setDecisions((cur) => ({ ...cur, [l.id]: { mode: 'create' } }))
                              }
                            />
                            <Chip
                              label="Skip"
                              active={d?.mode === 'skip'}
                              onPress={() =>
                                setDecisions((cur) => ({ ...cur, [l.id]: { mode: 'skip' } }))
                              }
                            />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                {error ? (
                  <Mono size={11.5} color={ACCENT.crit} style={{ marginTop: 12, lineHeight: 16 }}>
                    {error}
                  </Mono>
                ) : null}
                {!validation.ok && !error ? (
                  <Mono size={11} color={c.ink4} style={{ marginTop: 12 }}>
                    {validation.reason}
                  </Mono>
                ) : null}
              </ScrollView>
            )}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <View style={{ flex: 1 }}>
                <Button block variant="ghost" onPress={onClose} disabled={submitting}>
                  Cancel
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button block onPress={() => void submit()} disabled={!canSubmit}>
                  {submitting ? 'Approving…' : 'Approve'}
                </Button>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
