'use client';

import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  addPublicLinkEntriesAction,
  deletePublicLinkAction,
  getPublicLinkEffectiveCountAction,
  removePublicLinkEntriesAction,
  rotatePublicLinkTokenAction,
  searchPublicLinkCandidatesAction,
  setPublicLinkEntryMaxQtyAction,
  updatePublicLinkAction,
} from '@/server/actions/public-links';
import type {
  EffectiveCatalogCount,
  PublicLinkCandidateRow,
  PublicLinkRow,
} from '@/server/services/public-links';

const PAGE_SIZE = 25;

interface NamedRow {
  id: string;
  name: string;
}

// ── datetime-local <-> ISO helpers ──────────────────────────────────────────

function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function VisibilityBadge({ visibility }: { visibility: PublicLinkCandidateRow['public_visibility'] }) {
  if (visibility === 'public') return <Badge variant="success">Public</Badge>;
  if (visibility === 'hidden') {
    return (
      <Badge
        variant="destructive"
        title="Hidden items never appear publicly — even with an entry on this link."
      >
        Hidden
      </Badge>
    );
  }
  return <Badge variant="outline">Internal only</Badge>;
}

/**
 * Per-link editor for /dashboard/settings/public-requests/[linkId]:
 * link settings form, the searchable catalog editor with checkbox
 * multi-select + confirmed bulk add/remove, per-entry qty caps, and the
 * read-only "what the public sees" count sourced from the eligibility RPC.
 * All mutations go through the public-links server actions (never raw
 * supabase from here).
 */
export function PublicLinkEditor({
  appUrl,
  link,
  categories,
  warehouses,
  initialEffective,
  initialRows,
  initialTotal,
}: {
  appUrl: string;
  link: PublicLinkRow;
  categories: NamedRow[];
  warehouses: NamedRow[];
  initialEffective: EffectiveCatalogCount;
  initialRows: PublicLinkCandidateRow[];
  initialTotal: number;
}) {
  const router = useRouter();
  const base = appUrl.replace(/\/$/, '');

  const categoryNameById = React.useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );
  const warehouseNameById = React.useMemo(
    () => new Map(warehouses.map((w) => [w.id, w.name])),
    [warehouses],
  );

  // ── Link header (URL / status / rotate / delete) ──────────────────────────
  const [token, setToken] = React.useState(link.token);
  const [copied, setCopied] = React.useState(false);
  const [headerError, setHeaderError] = React.useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const publicUrl = `${base}/r/${token}`;

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setHeaderError("Couldn't copy the link. Copy it manually from the field above.");
    }
  }

  async function performRotate() {
    setRotating(true);
    setHeaderError(null);
    const res = await rotatePublicLinkTokenAction({ id: link.id });
    setRotating(false);
    if (!res.ok) {
      setHeaderError(res.error.message);
      return;
    }
    setToken(res.data.token);
    setRotateOpen(false);
    router.refresh();
  }

  async function performDelete() {
    setDeleting(true);
    setHeaderError(null);
    const res = await deletePublicLinkAction({ id: link.id });
    setDeleting(false);
    if (!res.ok) {
      setHeaderError(res.error.message);
      return;
    }
    router.push('/dashboard/settings/public-requests');
  }

  // ── Settings form ──────────────────────────────────────────────────────────
  const [name, setName] = React.useState(link.name);
  const [purpose, setPurpose] = React.useState(link.purpose ?? '');
  const [instructions, setInstructions] = React.useState(link.instructions ?? '');
  const [active, setActive] = React.useState(link.active);
  const [expiresAt, setExpiresAt] = React.useState(isoToLocalInput(link.expires_at));
  const [availableFrom, setAvailableFrom] = React.useState(
    isoToLocalInput(link.available_from),
  );
  const [availableUntil, setAvailableUntil] = React.useState(
    isoToLocalInput(link.available_until),
  );
  const [availabilityDisplay, setAvailabilityDisplay] = React.useState<
    'exact' | 'bucket' | 'none'
  >(link.availability_display);
  const [booksEnabled, setBooksEnabled] = React.useState(link.books_enabled);
  const [itemsEnabled, setItemsEnabled] = React.useState(link.items_enabled);
  const [includePublicPool, setIncludePublicPool] = React.useState(
    link.include_public_pool,
  );
  const [defaultMaxQty, setDefaultMaxQty] = React.useState(
    link.default_max_qty != null ? String(link.default_max_qty) : '',
  );
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  async function saveSettings() {
    setSaveError(null);
    setSavedAt(null);
    if (!name.trim()) {
      setSaveError('The link needs a name.');
      return;
    }
    const qtyTrimmed = defaultMaxQty.trim();
    const qty = qtyTrimmed === '' ? null : Number(qtyTrimmed);
    if (qty !== null && (!Number.isInteger(qty) || qty <= 0)) {
      setSaveError('Default max quantity must be a positive whole number (or blank for no limit).');
      return;
    }
    setSaving(true);
    const res = await updatePublicLinkAction({
      id: link.id,
      name: name.trim(),
      purpose: purpose.trim() ? purpose.trim() : null,
      instructions: instructions.trim() ? instructions.trim() : null,
      active,
      expiresAt: localInputToIso(expiresAt),
      availableFrom: localInputToIso(availableFrom),
      availableUntil: localInputToIso(availableUntil),
      availabilityDisplay,
      booksEnabled,
      itemsEnabled,
      includePublicPool,
      defaultMaxQty: qty,
    });
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error.message);
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
    void refreshEffective();
  }

  // ── Effective ("what the public sees") count ──────────────────────────────
  const [effective, setEffective] = React.useState<EffectiveCatalogCount>(initialEffective);
  const [effectiveLoading, setEffectiveLoading] = React.useState(false);
  const [effectiveError, setEffectiveError] = React.useState<string | null>(null);

  const refreshEffective = React.useCallback(async () => {
    setEffectiveLoading(true);
    setEffectiveError(null);
    const res = await getPublicLinkEffectiveCountAction({ linkId: link.id });
    setEffectiveLoading(false);
    if (!res.ok) {
      setEffectiveError(res.error.message);
      return;
    }
    setEffective(res.data);
  }, [link.id]);

  // ── Catalog editor state ──────────────────────────────────────────────────
  const [rows, setRows] = React.useState<PublicLinkCandidateRow[]>(initialRows);
  const [total, setTotal] = React.useState(initialTotal);
  const [page, setPage] = React.useState(1);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [categoryFilter, setCategoryFilter] = React.useState('all');
  const [typeFilter, setTypeFilter] = React.useState<'all' | 'book' | 'item'>('all');
  const [warehouseFilter, setWarehouseFilter] = React.useState('all');
  const [membershipFilter, setMembershipFilter] = React.useState<'all' | 'on'>('all');
  const [sortKey, setSortKey] = React.useState<
    'name-asc' | 'name-desc' | 'sku-asc' | 'created-desc'
  >('name-asc');

  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Debounce the free-text search.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadRows = React.useCallback(async () => {
    setListLoading(true);
    setListError(null);
    const [sort, sortDir] =
      sortKey === 'name-desc'
        ? (['name', 'desc'] as const)
        : sortKey === 'sku-asc'
          ? (['sku', 'asc'] as const)
          : sortKey === 'created-desc'
            ? (['created', 'desc'] as const)
            : (['name', 'asc'] as const);
    const res = await searchPublicLinkCandidatesAction({
      linkId: link.id,
      search: search || undefined,
      categoryId: categoryFilter === 'all' ? undefined : categoryFilter,
      itemType: typeFilter === 'all' ? undefined : typeFilter,
      warehouseId: warehouseFilter === 'all' ? undefined : warehouseFilter,
      onLinkOnly: membershipFilter === 'on' ? true : undefined,
      page,
      pageSize: PAGE_SIZE,
      sort,
      sortDir,
    });
    setListLoading(false);
    if (!res.ok) {
      setListError(res.error.message);
      return;
    }
    setRows(res.data.rows);
    setTotal(res.data.total);
  }, [
    link.id,
    search,
    categoryFilter,
    typeFilter,
    warehouseFilter,
    membershipFilter,
    page,
    sortKey,
  ]);

  // Refetch on any filter/page/sort change. The first render uses the
  // server-provided page, so skip the initial run.
  const firstLoad = React.useRef(true);
  React.useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    void loadRows();
  }, [loadRows]);

  function resetToFirstPage() {
    setPage(1);
  }

  const pageAllSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function togglePageSelection() {
    setSelected((cur) => {
      const next = new Set(cur);
      if (pageAllSelected) {
        for (const r of rows) next.delete(r.id);
      } else {
        for (const r of rows) next.add(r.id);
      }
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Bulk add / remove with confirmation summary ───────────────────────────
  const [addOpen, setAddOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [bulkPending, setBulkPending] = React.useState(false);
  const [bulkError, setBulkError] = React.useState<string | null>(null);
  const [addMaxQty, setAddMaxQty] = React.useState('');

  async function afterBulkChange() {
    setSelected(new Set());
    await Promise.all([loadRows(), refreshEffective()]);
    router.refresh();
  }

  async function confirmBulkAdd() {
    const qtyTrimmed = addMaxQty.trim();
    const qty = qtyTrimmed === '' ? null : Number(qtyTrimmed);
    if (qty !== null && (!Number.isInteger(qty) || qty <= 0)) {
      setBulkError('Max quantity must be a positive whole number (or blank for the link default).');
      return;
    }
    setBulkPending(true);
    setBulkError(null);
    const res = await addPublicLinkEntriesAction({
      linkId: link.id,
      itemIds: [...selected],
      maxQtyPerRequest: qty,
    });
    setBulkPending(false);
    if (!res.ok) {
      setBulkError(res.error.message);
      return;
    }
    setAddOpen(false);
    setAddMaxQty('');
    await afterBulkChange();
  }

  async function confirmBulkRemove() {
    setBulkPending(true);
    setBulkError(null);
    const res = await removePublicLinkEntriesAction({
      linkId: link.id,
      itemIds: [...selected],
    });
    setBulkPending(false);
    if (!res.ok) {
      setBulkError(res.error.message);
      return;
    }
    setRemoveOpen(false);
    await afterBulkChange();
  }

  // ── Per-entry max qty edit ────────────────────────────────────────────────
  const [capDrafts, setCapDrafts] = React.useState<Record<string, string>>({});
  const [capPendingId, setCapPendingId] = React.useState<string | null>(null);
  const [capError, setCapError] = React.useState<string | null>(null);

  async function commitCap(row: PublicLinkCandidateRow) {
    const draft = capDrafts[row.id];
    if (draft === undefined) return;
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next <= 0)) {
      setCapError('Quantity limit must be a positive whole number (or blank for the link default).');
      return;
    }
    if (next === row.max_qty_per_request) {
      setCapDrafts((d) => {
        const { [row.id]: _gone, ...rest } = d;
        return rest;
      });
      return;
    }
    setCapPendingId(row.id);
    setCapError(null);
    const res = await setPublicLinkEntryMaxQtyAction({
      linkId: link.id,
      itemId: row.id,
      maxQtyPerRequest: next,
    });
    setCapPendingId(null);
    if (!res.ok) {
      setCapError(res.error.message);
      return;
    }
    setRows((cur) =>
      cur.map((r) => (r.id === row.id ? { ...r, max_qty_per_request: next } : r)),
    );
    setCapDrafts((d) => {
      const { [row.id]: _gone, ...rest } = d;
      return rest;
    });
  }

  const selectedCount = selected.size;

  return (
    <div className="space-y-6">
      {/* ── Link URL + status ─────────────────────────────────────────────── */}
      <section className="bg-card space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Public URL</h2>
            {active ? (
              <Badge variant="success">Active</Badge>
            ) : (
              <Badge variant="outline">Disabled</Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setRotateOpen(true)}>
              <RefreshCw className="h-3.5 w-3.5" />
              Regenerate URL
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete link
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input value={publicUrl} readOnly className="font-mono text-xs" />
          <Button type="button" variant="outline" onClick={copyUrl}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button asChild type="button" variant="outline">
            <a href={publicUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              Preview
            </a>
          </Button>
        </div>
        {headerError ? (
          <p role="alert" className="text-destructive text-xs">
            {headerError}
          </p>
        ) : null}
      </section>

      {/* ── What the public sees ──────────────────────────────────────────── */}
      <section className="bg-card rounded-xl border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">What the public sees</h2>
            <p className="text-muted-foreground mt-0.5 text-[11.5px]">
              Live count from the same eligibility check the public page and
              submit API use: explicit entries plus the public pool, minus
              hidden or archived items, disabled types, closed warehouses, and
              the link&apos;s own window.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshEffective()}
            disabled={effectiveLoading}
          >
            {effectiveLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">{effective.total}</span>
          <span className="text-muted-foreground text-sm">
            item{effective.total === 1 ? '' : 's'} visible right now
            {link.entry_count !== effective.total
              ? ` (${link.entry_count} explicit entr${link.entry_count === 1 ? 'y' : 'ies'} on this link)`
              : ''}
          </span>
        </div>
        {effective.byWarehouse.length > 1 ? (
          <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
            {effective.byWarehouse.map((w) => (
              <li key={w.warehouseId}>
                {warehouseNameById.get(w.warehouseId) ?? 'Warehouse'}:{' '}
                <span className="tabular-nums">{w.count}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {effective.total === 0 ? (
          <p className="text-muted-foreground mt-2 text-xs">
            Nothing is publicly visible. Check that the link is active and in
            its date window, at least one warehouse is public-orderable, the
            right item types are enabled, and the catalog below has entries.
          </p>
        ) : null}
        {effectiveError ? (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {effectiveError}
          </p>
        ) : null}
      </section>

      {/* ── Link settings ─────────────────────────────────────────────────── */}
      <section className="bg-card space-y-4 rounded-xl border p-4">
        <div>
          <h2 className="text-sm font-medium">Link settings</h2>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">
            Name and purpose are internal; instructions are shown to public
            requesters at the top of the page.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="link-name">Name</Label>
            <Input
              id="link-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={160}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-purpose">Purpose (internal)</Label>
            <Input
              id="link-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              maxLength={500}
              placeholder="e.g. Teacher requests for the fall term"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="link-instructions">Instructions for requesters</Label>
          <Textarea
            id="link-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Shown on the public page. Explain who may order and how fulfillment works."
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="link-expires">Expires</Label>
            <Input
              id="link-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-muted-foreground text-[11px]">Blank = never expires.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-from">Available from</Label>
            <Input
              id="link-from"
              type="datetime-local"
              value={availableFrom}
              onChange={(e) => setAvailableFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-until">Available until</Label>
            <Input
              id="link-until"
              type="datetime-local"
              value={availableUntil}
              onChange={(e) => setAvailableUntil(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Stock shown to the public</Label>
            <Select
              value={availabilityDisplay}
              onValueChange={(v) =>
                setAvailabilityDisplay(v as 'exact' | 'bucket' | 'none')
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="exact">Exact counts</SelectItem>
                <SelectItem value="bucket">Buckets (in stock / low / out)</SelectItem>
                <SelectItem value="none">No stock signal</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-default-qty">Default max quantity per request</Label>
            <Input
              id="link-default-qty"
              type="number"
              min={1}
              inputMode="numeric"
              value={defaultMaxQty}
              onChange={(e) => setDefaultMaxQty(e.target.value)}
              placeholder="No limit"
            />
            <p className="text-muted-foreground text-[11px]">
              Per line. Individual catalog entries can override it below.
            </p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>
              Link is active
              <span className="text-muted-foreground block text-[11.5px]">
                Turning this off hides the page and blocks submissions
                immediately.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includePublicPool}
              onChange={(e) => setIncludePublicPool(e.target.checked)}
            />
            <span>
              Include the public pool
              <span className="text-muted-foreground block text-[11.5px]">
                Also show every item marked “Public” (in public categories)
                without adding it here explicitly.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={booksEnabled}
              onChange={(e) => setBooksEnabled(e.target.checked)}
            />
            <span>
              Books
              <span className="text-muted-foreground block text-[11.5px]">
                Allow book requests on this link.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={itemsEnabled}
              onChange={(e) => setItemsEnabled(e.target.checked)}
            />
            <span>
              Items
              <span className="text-muted-foreground block text-[11.5px]">
                Allow non-book item requests on this link.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void saveSettings()} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save settings
          </Button>
          {saveError ? (
            <p role="alert" className="text-destructive text-xs">
              {saveError}
            </p>
          ) : savedAt ? (
            <p className="text-muted-foreground text-xs">Saved.</p>
          ) : null}
        </div>
      </section>

      {/* ── Catalog editor ────────────────────────────────────────────────── */}
      <section className="bg-card rounded-xl border">
        <div className="border-border border-b px-4 py-3">
          <h2 className="text-sm font-medium">Catalog</h2>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">
            Pick exactly which items and books this link exposes. Select rows,
            then add or remove them in bulk — nothing changes until you
            confirm.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className="relative min-w-52 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search name or SKU…"
              className="pl-8"
              aria-label="Search items by name or SKU"
            />
          </div>
          <Select
            value={categoryFilter}
            onValueChange={(v) => {
              setCategoryFilter(v);
              resetToFirstPage();
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              <SelectItem value="none">Uncategorized</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={typeFilter}
            onValueChange={(v) => {
              setTypeFilter(v as 'all' | 'book' | 'item');
              resetToFirstPage();
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="book">Books</SelectItem>
              <SelectItem value="item">Items</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={warehouseFilter}
            onValueChange={(v) => {
              setWarehouseFilter(v);
              resetToFirstPage();
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Warehouse" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All warehouses</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={membershipFilter}
            onValueChange={(v) => {
              setMembershipFilter(v as 'all' | 'on');
              resetToFirstPage();
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All items</SelectItem>
              <SelectItem value="on">On this link</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sortKey}
            onValueChange={(v) => {
              setSortKey(v as typeof sortKey);
              resetToFirstPage();
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name-asc">Name A→Z</SelectItem>
              <SelectItem value="name-desc">Name Z→A</SelectItem>
              <SelectItem value="sku-asc">SKU</SelectItem>
              <SelectItem value="created-desc">Newest first</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {selectedCount > 0 ? (
          <div className="border-border bg-muted/40 flex flex-wrap items-center gap-2 border-y px-4 py-2 text-sm">
            <span className="font-medium tabular-nums">{selectedCount} selected</span>
            <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
              Add to link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRemoveOpen(true)}
            >
              Remove from link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </Button>
          </div>
        ) : null}

        {listError ? (
          <p role="alert" className="text-destructive px-4 py-2 text-xs">
            {listError}
          </p>
        ) : null}
        {capError ? (
          <p role="alert" className="text-destructive px-4 py-2 text-xs">
            {capError}
          </p>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all items on this page"
                  checked={pageAllSelected}
                  onChange={togglePageSelection}
                />
              </TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead>On this link</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listLoading && rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center text-sm">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                  Loading items…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center text-sm">
                  No items match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} className={listLoading ? 'opacity-60' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.name}`}
                      checked={selected.has(row.id)}
                      onChange={() => toggleRow(row.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{row.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {row.sku ?? 'No SKU'}
                      {row.status !== 'active' ? ' · not active (never public)' : ''}
                    </p>
                  </TableCell>
                  <TableCell className="text-xs capitalize">
                    {row.item_type ?? 'product'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {row.category_id
                      ? categoryNameById.get(row.category_id) ?? '—'
                      : 'Uncategorized'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {row.warehouse_id ? warehouseNameById.get(row.warehouse_id) ?? '—' : '—'}
                  </TableCell>
                  <TableCell>
                    <VisibilityBadge visibility={row.public_visibility} />
                  </TableCell>
                  <TableCell>
                    {row.on_link ? (
                      <div className="flex items-center gap-2">
                        <Badge variant="success">On link</Badge>
                        <Input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          aria-label={`Max quantity per request for ${row.name}`}
                          className="h-7 w-24 text-xs"
                          placeholder={
                            link.default_max_qty != null
                              ? `Default (${link.default_max_qty})`
                              : 'No limit'
                          }
                          value={capDrafts[row.id] ?? (row.max_qty_per_request != null ? String(row.max_qty_per_request) : '')}
                          disabled={capPendingId === row.id}
                          onChange={(e) =>
                            setCapDrafts((d) => ({ ...d, [row.id]: e.target.value }))
                          }
                          onBlur={() => void commitCap(row)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void commitCap(row);
                            }
                          }}
                        />
                        {capPendingId === row.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <div className="px-4 py-3">
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        </div>
      </section>

      {/* ── Bulk add confirmation ─────────────────────────────────────────── */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setBulkError(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add items to this link?</DialogTitle>
            <DialogDescription>
              You are about to make {selectedCount} item
              {selectedCount === 1 ? '' : 's'} available on “{link.name}”.
              Anyone with the link can request them while it is active. Items
              marked Hidden stay hidden even with an entry.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulk-max-qty">Max quantity per request (optional)</Label>
            <Input
              id="bulk-max-qty"
              type="number"
              min={1}
              inputMode="numeric"
              value={addMaxQty}
              onChange={(e) => setAddMaxQty(e.target.value)}
              placeholder={
                link.default_max_qty != null
                  ? `Link default (${link.default_max_qty})`
                  : 'Link default (no limit)'
              }
            />
            {bulkError ? (
              <p role="alert" className="text-destructive text-xs">
                {bulkError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddOpen(false)}
              disabled={bulkPending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void confirmBulkAdd()} disabled={bulkPending}>
              {bulkPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Add {selectedCount} item{selectedCount === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk remove confirmation ──────────────────────────────────────── */}
      <Dialog
        open={removeOpen}
        onOpenChange={(open) => {
          setRemoveOpen(open);
          if (!open) setBulkError(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove items from this link?</DialogTitle>
            <DialogDescription>
              You are about to remove {selectedCount} item
              {selectedCount === 1 ? '' : 's'} from “{link.name}”. Public
              visitors will no longer see or be able to request them here
              (unless they remain visible through the public pool).
            </DialogDescription>
          </DialogHeader>
          {bulkError ? (
            <p role="alert" className="text-destructive text-xs">
              {bulkError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveOpen(false)}
              disabled={bulkPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmBulkRemove()}
              disabled={bulkPending}
            >
              {bulkPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Remove {selectedCount} item{selectedCount === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirm
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        title="Regenerate this link's URL?"
        description="The current public URL stops working immediately — anyone using the old link (bookmarks, emails, printed flyers) will see a 404. The catalog and settings are kept; only the URL changes."
        confirmLabel="Regenerate URL"
        pending={rotating}
        onConfirm={performRotate}
      />

      <DestructiveConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete “${link.name}”?`}
        description="The public page stops working immediately and this link's catalog configuration is permanently removed. Past orders submitted through it are kept."
        confirmLabel="Delete link"
        pending={deleting}
        onConfirm={performDelete}
      />
    </div>
  );
}
