'use client';

import { Loader2, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  ORDER_CATALOG_TYPE_FILTERS,
  ORDER_ITEMS_CLEAR_SELECTION_COPY,
  ORDER_ITEMS_HIDE_ACTION_COPY,
  ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY,
  ORDER_ITEMS_HIDE_SELECTED_COPY,
  ORDER_ITEMS_KITS_NOTE_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_ITEMS_REVIEW_SELECTION_COPY,
  ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY,
  ORDER_ITEMS_SELECT_FAMILY_COPY,
  ORDER_ITEMS_SELECTION_CAP_COPY,
  ORDER_ITEMS_SHOW_ACTION_COPY,
  ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY,
  ORDER_ITEMS_SHOW_SELECTED_COPY,
  ORDER_ITEMS_STATE_EXPECTED_COPY,
  ORDER_ITEMS_STATE_HIDDEN_COPY,
  ORDER_ITEMS_STATE_SHOWN_COPY,
  ORDER_ITEMS_TYPE_FILTER_LABELS,
  ORDER_ITEMS_VISIBILITY_FILTER_LABELS,
  ORDER_CATALOG_VISIBILITY_FILTERS,
  orderCatalogManageQueryString,
  orderItemsEmptyCopy,
  orderItemsHiddenSinceCopy,
  orderItemsHideConfirmTitle,
  orderItemsRowActionLabel,
  orderItemsSelectedCopy,
  orderItemsShowConfirmTitle,
  type OrderCatalogFamilyAnswer,
  type OrderCatalogManageListAnswer,
  type OrderCatalogManageQuery,
  type OrderCatalogManageRow,
} from '@stockpilot/core';

import { useStepUp } from '@/components/auth/step-up-modal';
import { FilterBar } from '@/components/patterns/filter-bar';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatePanel } from '@/components/patterns/state-panel';
import { Thumb } from '@/components/patterns/thumb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { isControlFlow } from '@/lib/control-flow';
import { markOwnVisibilityWrite, OWN_VISIBILITY_WRITE_MS } from '@/lib/orders/ordering-tab-signal';
import { setOrderCatalogVisibilityAction } from '@/server/actions/order-catalog-visibility';

import { writeOutcome, type WriteOutcome } from './outcome';
import {
  afterWrite,
  clearSelection,
  deselect,
  emptySelection,
  inScope,
  pageSelection,
  select,
  selectedIds,
  selectionScope,
  type SelectableRecord,
  type SelectionState,
} from './selection';

/** How long a sent write counts as this tab's own before it settles (a
 *  bound for a slow action; the settle shortens it to OWN_VISIBILITY_WRITE_MS). */
const OWN_WRITE_PENDING_MS = 60_000;

/**
 * MANAGE ORDER ITEMS, the web page's interactive part (ordering visibility,
 * migration 0413; design 8.2 and 3.7).
 *
 * The server page reads one page of the authorized full dataset (25 rows,
 * exact total) through the service and hands it here. Filters, search and the
 * page live in the URL (router.push), so Back and Forward work and every view
 * is a fresh server read. This part owns:
 *
 * - THE SELECTION: explicit ids only, across pages (selection.ts), listed in
 *   full in the review sheet, capped at 500. The header box selects this
 *   page's rows only. A family is added only through its disclosure (the
 *   family route), record by record, pre-checked and editable. The selection,
 *   the review sheet and a kept operation are cleared when the page's
 *   organization or user changes (a workspace switch can keep client state).
 * - THE WRITE: setOrderCatalogVisibilityAction with one operationId per
 *   change. A change whose outcome is not known, or that nothing changed and
 *   may be sent again (busy, rate limited, a step-up), keeps its operationId,
 *   so a resend is idempotent: no second audit row. Hide (one row or many)
 *   and Show selected confirm first, in core's words. One request at a time.
 * - THE OUTCOMES (outcome.ts): saved says exactly what changed; a final
 *   refusal (forbidden, switch off, module off) locks the page: every control
 *   is disabled and the list stays readable, so there are no repeated failed
 *   clicks; unavailable ids are deselected; a step-up prompts and resends.
 */

export interface ManageOrderItemsProps {
  /** The organization and user the server page rendered for: the selection's scope. */
  organizationId: string;
  userId: string;
  answer: OrderCatalogManageListAnswer;
  filters: OrderCatalogManageQuery;
  /** The caller's warehouses (getWarehousesForRequest). */
  warehouses: ReadonlyArray<{ id: string; name: string }>;
  /** Categories the caller can read. */
  categories: ReadonlyArray<{ id: string; name: string }>;
  /** organizations.timezone, for "Hidden since". */
  orgTimezone: string;
}

const BASE_PATH = '/dashboard/orders/manage-items';
const SEARCH_DEBOUNCE_MS = 300;
const ALL = 'all';

/** A step-up the person dismissed: nothing was sent. */
const STEP_UP_CANCELLED_COPY =
  'Confirm with your authenticator to save this change. Nothing was changed.';
const TRY_AGAIN_COPY = 'Try again';
const FAMILY_ADD_COPY = 'Add to selection';
const FAMILY_TRUNCATED_COPY = 'Showing the first 200 records of this family.';
const REMOVE_FROM_SELECTION_COPY = 'Remove';

type WriteSource = 'row' | 'bulk';

interface PendingWrite {
  ids: string[];
  visible: boolean;
  source: WriteSource;
  operationId: string;
  /** The selection scope it was made under: an answer for another scope only
   *  re-reads the page. */
  scope: string;
}

interface ConfirmState {
  ids: string[];
  visible: boolean;
  source: WriteSource;
  error: string | null;
}

interface FamilyState {
  familyId: string;
  familyName: string | null;
  status: 'loading' | 'ready' | 'failed';
  rows: OrderCatalogManageRow[];
  truncated: boolean;
  checked: ReadonlySet<string>;
}

type RowPatch = { visible: boolean; hiddenSince: string | null };

function hrefFor(filters: OrderCatalogManageQuery): string {
  const qs = orderCatalogManageQueryString(filters);
  return qs ? `${BASE_PATH}?${qs}` : BASE_PATH;
}

function newOperationId(): string {
  return crypto.randomUUID();
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function formatDay(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    }).format(d);
  } catch {
    return null;
  }
}

/** SKU, plus ISBN or barcode when it is not the SKU itself. */
function identifierOf(row: OrderCatalogManageRow): string {
  return row.identifier && row.identifier !== row.sku ? `${row.sku} · ${row.identifier}` : row.sku;
}

function recordOf(row: OrderCatalogManageRow): SelectableRecord {
  return { id: row.id, name: row.name, identifier: identifierOf(row), visible: row.visible };
}

/** The line under a record's name: its family and its size (or a book's author). */
function detailLine(row: OrderCatalogManageRow): string | null {
  const parts = [row.familyName, row.sizeOrEdition].filter(
    (p): p is string => typeof p === 'string' && p.trim() !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

function StateBadges({
  visible,
  expected,
  hiddenSince,
  orgTimezone,
}: {
  visible: boolean;
  expected: boolean;
  hiddenSince: string | null;
  orgTimezone: string;
}) {
  const since = !visible && hiddenSince ? formatDay(hiddenSince, orgTimezone) : null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={visible ? 'success' : 'secondary'} dot>
          {visible ? ORDER_ITEMS_STATE_SHOWN_COPY : ORDER_ITEMS_STATE_HIDDEN_COPY}
        </Badge>
        {expected ? <Badge variant="outline">{ORDER_ITEMS_STATE_EXPECTED_COPY}</Badge> : null}
      </div>
      {since ? (
        <span className="text-muted-foreground text-[12px]">
          {orderItemsHiddenSinceCopy(since)}
        </span>
      ) : null}
    </div>
  );
}

export function ManageOrderItems({
  organizationId,
  userId,
  answer,
  filters,
  warehouses,
  categories,
  orgTimezone,
}: ManageOrderItemsProps) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [navigating, startNavigation] = React.useTransition();

  const scope = selectionScope(organizationId, userId);
  const scopeRef = React.useRef(scope);
  React.useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  /* --- state --- */
  const [selectionState, setSelection] = React.useState<SelectionState>(() =>
    emptySelection(scope),
  );
  const selection = inScope(selectionState, scope);
  const [kept, setKept] = React.useState<PendingWrite | null>(null);
  const [inFlight, setInFlight] = React.useState<PendingWrite | null>(null);
  const sendingRef = React.useRef(false);
  const [confirm, setConfirm] = React.useState<ConfirmState | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [family, setFamily] = React.useState<FamilyState | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [alert, setAlert] = React.useState<{ message: string; retry: boolean } | null>(null);
  const [locked, setLocked] = React.useState<string | null>(null);
  const [patches, setPatches] = React.useState<ReadonlyMap<string, RowPatch>>(new Map());

  // A workspace switch (another organization or user) clears everything this
  // page held for the previous one, in the render that sees it.
  const [seenScope, setSeenScope] = React.useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setSelection(emptySelection(scope));
    setKept(null);
    setConfirm(null);
    setReviewOpen(false);
    setFamily(null);
    setStatus(null);
    setAlert(null);
    setLocked(null);
  }
  // A new server answer is the truth: local row updates are dropped.
  const [seenAnswer, setSeenAnswer] = React.useState(answer);
  if (seenAnswer !== answer) {
    setSeenAnswer(answer);
    setPatches(new Map());
  }

  const rows = React.useMemo(
    () =>
      answer.rows.map((row) => {
        const patch = patches.get(row.id);
        return patch ? { ...row, visible: patch.visible, hiddenSince: patch.hiddenSince } : row;
      }),
    [answer.rows, patches],
  );

  /* --- navigation (filters and page live in the URL) --- */
  const navigate = React.useCallback(
    (next: Partial<OrderCatalogManageQuery>) => {
      const target = hrefFor({ ...filters, page: 1, ...next });
      startNavigation(() => router.push(target));
    },
    [filters, router],
  );

  const [search, setSearch] = React.useState(filters.q);
  const [seenQuery, setSeenQuery] = React.useState(filters.q);
  if (seenQuery !== filters.q) {
    setSeenQuery(filters.q);
    setSearch(filters.q);
  }
  React.useEffect(() => {
    if (search.trim() === filters.q.trim()) return;
    const t = setTimeout(() => navigate({ q: search.trim(), page: 1 }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, filters.q, navigate]);

  /* --- selection --- */
  const add = (records: readonly SelectableRecord[]) => {
    const r = select(selection, records);
    setSelection(r.state);
    if (r.capped) setAlert({ message: ORDER_ITEMS_SELECTION_CAP_COPY, retry: false });
  };
  const pageState = pageSelection(selection, rows);
  const count = selection.entries.size;

  /* --- the write --- */
  function writeFor(ids: string[], visible: boolean, source: WriteSource): PendingWrite {
    if (kept && kept.scope === scope && kept.visible === visible && sameIds(kept.ids, ids)) {
      return { ...kept, source };
    }
    return { ids, visible, source, operationId: newOperationId(), scope };
  }

  async function call(write: PendingWrite): Promise<WriteOutcome> {
    try {
      return writeOutcome(
        await setOrderCatalogVisibilityAction({
          itemIds: write.ids,
          visible: write.visible,
          operationId: write.operationId,
        }),
      );
    } catch (e) {
      if (isControlFlow(e)) throw e;
      return writeOutcome(null);
    }
  }

  async function send(write: PendingWrite, fromConfirm: boolean) {
    if (sendingRef.current || locked) return;
    sendingRef.current = true;
    setInFlight(write);
    setStatus(null);
    setAlert(null);
    if (fromConfirm) setConfirm((c) => (c ? { ...c, error: null } : c));
    // This tab's own write: its realtime events are not a reason to render
    // again (the action's response carries the page). Until the write
    // settles, then for a few seconds after (review F2).
    markOwnVisibilityWrite(write.ids, Date.now() + OWN_WRITE_PENDING_MS);
    let outcome: WriteOutcome;
    try {
      outcome = await call(write);
      if (outcome.kind === 'step_up') {
        outcome = (await stepUp.ensure())
          ? await call(write)
          : { kind: 'retry', message: STEP_UP_CANCELLED_COPY };
        if (outcome.kind === 'step_up')
          outcome = { kind: 'retry', message: STEP_UP_CANCELLED_COPY };
      }
    } finally {
      sendingRef.current = false;
      setInFlight(null);
      markOwnVisibilityWrite(write.ids, Date.now() + OWN_VISIBILITY_WRITE_MS);
    }
    if (write.scope !== scopeRef.current) {
      // The page moved to another organization while this was out.
      router.refresh();
      return;
    }
    settle(outcome, write, fromConfirm);
  }

  function settle(outcome: WriteOutcome, write: PendingWrite, fromConfirm: boolean) {
    switch (outcome.kind) {
      case 'saved': {
        const now = new Date().toISOString();
        const changed = new Set(outcome.changed.map((id) => id.toLowerCase()));
        setPatches((prev) => {
          const next = new Map(prev);
          for (const row of rows) {
            if (!write.ids.includes(row.id)) continue;
            const wasChanged = changed.has(row.id.toLowerCase());
            next.set(row.id, {
              visible: outcome.visible,
              hiddenSince: outcome.visible ? null : wasChanged ? now : row.hiddenSince,
            });
          }
          return next;
        });
        setSelection((s) =>
          afterWrite(inScope(s, write.scope), {
            source: write.source,
            visible: outcome.visible,
            ids: write.ids,
          }),
        );
        setKept(null);
        setConfirm(null);
        setReviewOpen(false);
        setStatus(outcome.message);
        toast.success(outcome.message);
        // No router.refresh() here (review F2): the write expired the catalog
        // tags inside the Server Action, so Next rendered this page into the
        // action's response and the client has already applied it. A refresh
        // was a second full render, and the tab's own realtime event a third.
        return;
      }
      case 'locked':
        setKept(null);
        setConfirm(null);
        setReviewOpen(false);
        setFamily(null);
        setLocked(outcome.message);
        return;
      case 'unavailable':
        setKept(null);
        setSelection((s) => deselect(inScope(s, write.scope), outcome.itemIds));
        setConfirm(null);
        setAlert({ message: outcome.message, retry: false });
        router.refresh();
        return;
      case 'retry':
      case 'unconfirmed':
        // Nothing changed, or not known: the same operation may be sent
        // again (idempotent), from the dialog or from the page.
        setKept(write);
        if (outcome.kind === 'unconfirmed') router.refresh();
        if (fromConfirm) {
          setConfirm((c) => (c ? { ...c, error: outcome.message } : c));
        } else {
          setAlert({ message: outcome.message, retry: true });
        }
        return;
      case 'failed':
      case 'step_up': {
        // step_up never reaches here (send prompts first); kept for the
        // exhaustive switch.
        const message = outcome.kind === 'failed' ? outcome.message : STEP_UP_CANCELLED_COPY;
        setKept(null);
        if (fromConfirm) setConfirm((c) => (c ? { ...c, error: message } : c));
        else setAlert({ message, retry: false });
        return;
      }
    }
  }

  /** Hide (one or many) and Show selected confirm first; a single Show does not. */
  function request(ids: string[], visible: boolean, source: WriteSource) {
    if (locked || ids.length === 0) return;
    if (!visible || source === 'bulk') {
      setConfirm({ ids, visible, source, error: null });
      return;
    }
    void send(writeFor(ids, visible, source), false);
  }

  function retryFromPage() {
    if (kept) void send(kept, false);
  }

  /* --- family disclosure --- */
  async function openFamily(row: OrderCatalogManageRow) {
    if (!row.familyId || locked) return;
    const familyId = row.familyId;
    setFamily({
      familyId,
      familyName: row.familyName,
      status: 'loading',
      rows: [],
      truncated: false,
      checked: new Set(),
    });
    try {
      const res = await fetch(
        `/api/v1/orders/catalog-visibility/family/${encodeURIComponent(familyId)}`,
        {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        },
      );
      const body = (await res.json().catch(() => null)) as
        (OrderCatalogFamilyAnswer & { details?: { reason?: unknown } }) | null;
      if (!res.ok || !body || body.organizationId !== organizationId || !Array.isArray(body.rows)) {
        const refusal = writeOutcome(
          body && typeof body === 'object' && 'details' in body && body.details
            ? {
                ok: false,
                error: {
                  code: 'forbidden',
                  message: '',
                  details: body.details as Record<string, unknown>,
                },
              }
            : null,
        );
        if (refusal.kind === 'locked') {
          setFamily(null);
          setLocked(refusal.message);
          return;
        }
        setFamily((f) => (f && f.familyId === familyId ? { ...f, status: 'failed' } : f));
        return;
      }
      setFamily((f) =>
        f && f.familyId === familyId
          ? {
              ...f,
              familyName: body.familyName ?? f.familyName,
              status: 'ready',
              rows: body.rows,
              truncated: body.truncated === true,
              checked: new Set(body.rows.map((r) => r.id)),
            }
          : f,
      );
    } catch {
      setFamily((f) => (f && f.familyId === familyId ? { ...f, status: 'failed' } : f));
    }
  }

  function confirmFamily() {
    if (!family || family.status !== 'ready') return;
    add(family.rows.filter((r) => family.checked.has(r.id)).map(recordOf));
    setFamily(null);
  }

  /* --- render --- */
  const busy = inFlight !== null;
  const disabled = locked !== null;
  const saving = (id: string) => inFlight !== null && inFlight.ids.includes(id);

  const visibilityTabs = ORDER_CATALOG_VISIBILITY_FILTERS.map((v) => ({
    id: v,
    label: ORDER_ITEMS_VISIBILITY_FILTER_LABELS[v],
    href: hrefFor({ ...filters, visibility: v, page: 1 }),
  }));

  const confirmTitle = confirm
    ? confirm.visible
      ? orderItemsShowConfirmTitle(confirm.ids.length)
      : orderItemsHideConfirmTitle(confirm.ids.length)
    : '';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {locked ? (
        <div
          role="alert"
          className="border-border bg-destructive-wash text-destructive rounded-lg border px-4 py-3 text-[13.5px]"
        >
          {locked}{' '}
          <Link href="/dashboard/orders" className="underline underline-offset-4">
            Back to orders
          </Link>
        </div>
      ) : null}

      <FilterBar
        aria-label="Filter order items"
        leading={
          <SegmentedTabs
            aria-label="Ordering visibility"
            items={visibilityTabs}
            activeId={filters.visibility}
          />
        }
      >
        <div className="relative w-full min-w-0 sm:w-72">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={search}
            disabled={disabled}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY}
            aria-label={ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY}
            className="pl-8"
          />
        </div>
        <Select
          value={filters.type}
          disabled={disabled}
          onValueChange={(v) => navigate({ type: v as OrderCatalogManageQuery['type'] })}
        >
          <SelectTrigger className="w-full sm:w-36" aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORDER_CATALOG_TYPE_FILTERS.map((t) => (
              <SelectItem key={t} value={t}>
                {ORDER_ITEMS_TYPE_FILTER_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {warehouses.length > 1 ? (
          <Select
            value={filters.warehouseId ?? ALL}
            disabled={disabled}
            onValueChange={(v) => navigate({ warehouseId: v === ALL ? null : v })}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Warehouse">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All warehouses</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {categories.length > 0 ? (
          <Select
            value={filters.categoryId ?? ALL}
            disabled={disabled}
            onValueChange={(v) => navigate({ categoryId: v === ALL ? null : v })}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </FilterBar>

      <p className="text-muted-foreground text-[12.5px]">{ORDER_ITEMS_KITS_NOTE_COPY}</p>

      <div role="status" aria-live="polite" className="text-[13.5px]">
        {status ? <span className="text-foreground">{status}</span> : null}
      </div>
      {alert ? (
        <div
          role="alert"
          className="border-border bg-warning-wash text-foreground flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-[13.5px]"
        >
          <span>{alert.message}</span>
          {alert.retry && kept ? (
            <Button size="sm" variant="outline" disabled={busy || disabled} onClick={retryFromPage}>
              {TRY_AGAIN_COPY}
            </Button>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 && !navigating ? (
        <StatePanel
          kind={filters.q.trim() !== '' ? 'no-match' : 'empty'}
          title={orderItemsEmptyCopy({
            visibility: filters.visibility,
            hasQuery: filters.q.trim() !== '',
          })}
        />
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <Table
            scrollLabel="Order items"
            className="min-w-[820px]"
            aria-busy={navigating || undefined}
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">
                  <Checkbox
                    checked={pageState === 'all'}
                    indeterminate={pageState === 'some'}
                    disabled={disabled || busy || rows.length === 0}
                    label="Select every item on this page"
                    onCheckedChange={(next) => {
                      if (next) add(rows.map(recordOf));
                      else
                        setSelection(
                          deselect(
                            selection,
                            rows.map((r) => r.id),
                          ),
                        );
                    }}
                  />
                </TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Identifier</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Ordering visibility</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {navigating
                ? Array.from({ length: 6 }, (_, i) => (
                    <TableRow key={`sk-${i}`} aria-hidden>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : rows.map((row) => {
                    const rowSaving = saving(row.id);
                    const detail = detailLine(row);
                    return (
                      <TableRow
                        key={row.id}
                        data-row-id={row.id}
                        aria-busy={rowSaving || undefined}
                      >
                        <TableCell>
                          <Checkbox
                            checked={selection.entries.has(row.id)}
                            disabled={disabled || busy}
                            label={`Select ${row.name}`}
                            onCheckedChange={(next) => {
                              if (next) add([recordOf(row)]);
                              else setSelection(deselect(selection, [row.id]));
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 items-center gap-3">
                            <Thumb size={34} src={row.thumbUrl} alt="" />
                            <div className="min-w-0">
                              <div className="text-foreground text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]">
                                {row.name}
                              </div>
                              {detail ? (
                                <div className="text-muted-foreground text-[12px] leading-[18px]">
                                  {detail}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-[12px] [overflow-wrap:anywhere]">
                          {identifierOf(row)}
                        </TableCell>
                        <TableCell className="text-ink-2">{row.warehouseName ?? '—'}</TableCell>
                        <TableCell>
                          <StateBadges
                            visible={row.visible}
                            expected={row.expected}
                            hiddenSince={row.hiddenSince}
                            orgTimezone={orgTimezone}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {row.familyId ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={disabled || busy}
                                aria-label={`${ORDER_ITEMS_SELECT_FAMILY_COPY}: ${row.familyName ?? row.name}`}
                                onClick={() => void openFamily(row)}
                              >
                                {ORDER_ITEMS_SELECT_FAMILY_COPY}
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={disabled || busy}
                              aria-label={orderItemsRowActionLabel(row.visible, row.name)}
                              onClick={() => request([row.id], !row.visible, 'row')}
                            >
                              {rowSaving ? <Loader2 className="animate-spin" aria-hidden /> : null}
                              {row.visible
                                ? ORDER_ITEMS_HIDE_ACTION_COPY
                                : ORDER_ITEMS_SHOW_ACTION_COPY}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
            </TableBody>
          </Table>
          <div className="border-border border-t px-4 py-2.5">
            <Pagination
              page={answer.page}
              pageSize={answer.pageSize}
              total={answer.total}
              hrefForPage={(n) => hrefFor({ ...filters, page: n })}
              className="justify-end"
            />
          </div>
        </div>
      )}

      {count > 0 ? (
        <div
          role="region"
          aria-label="Selection"
          className="border-border bg-card sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-lg border px-4 py-2.5 shadow-sm"
        >
          <span className="text-foreground mr-auto text-[13.5px] font-medium tabular-nums">
            {orderItemsSelectedCopy(count)}
          </span>
          {busy && inFlight?.source === 'bulk' ? (
            <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReviewOpen(true)}>
            {ORDER_ITEMS_REVIEW_SELECTION_COPY}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => request(selectedIds(selection), true, 'bulk')}
          >
            {ORDER_ITEMS_SHOW_SELECTED_COPY}
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={disabled || busy}
            onClick={() => request(selectedIds(selection), false, 'bulk')}
          >
            {ORDER_ITEMS_HIDE_SELECTED_COPY}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setSelection(clearSelection(selection))}
          >
            {ORDER_ITEMS_CLEAR_SELECTION_COPY}
          </Button>
        </div>
      ) : null}

      {/* Review selection: every selected record, off-page ones included. */}
      <Sheet open={reviewOpen && count > 0} onOpenChange={(open) => !busy && setReviewOpen(open)}>
        <SheetContent side="right" className="flex flex-col p-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{ORDER_ITEMS_REVIEW_SELECTION_COPY}</SheetTitle>
            <SheetDescription>{orderItemsSelectedCopy(count)}</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <ul aria-label="Selected items" className="flex flex-col gap-2">
              {[...selection.entries].map(([id, entry]) => (
                <li
                  key={id}
                  className="border-border flex items-start justify-between gap-3 border-b pb-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-foreground text-[13.5px] font-medium [overflow-wrap:anywhere]">
                      {entry.name}
                    </div>
                    {entry.identifier ? (
                      <div className="text-muted-foreground font-mono text-[11.5px]">
                        {entry.identifier}
                      </div>
                    ) : null}
                    <div className="mt-1">
                      <Badge variant={entry.visible ? 'success' : 'secondary'} dot>
                        {entry.visible
                          ? ORDER_ITEMS_STATE_SHOWN_COPY
                          : ORDER_ITEMS_STATE_HIDDEN_COPY}
                      </Badge>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`${REMOVE_FROM_SELECTION_COPY} ${entry.name} from the selection`}
                    onClick={() => setSelection(deselect(selection, [id]))}
                  >
                    {REMOVE_FROM_SELECTION_COPY}
                  </Button>
                </li>
              ))}
            </ul>
          </SheetBody>
          <SheetFooter>
            <Button
              variant="outline"
              disabled={disabled || busy}
              onClick={() => request(selectedIds(selection), true, 'bulk')}
            >
              {ORDER_ITEMS_SHOW_SELECTED_COPY}
            </Button>
            <Button
              variant="default"
              disabled={disabled || busy}
              onClick={() => request(selectedIds(selection), false, 'bulk')}
            >
              {ORDER_ITEMS_HIDE_SELECTED_COPY}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Select family: exactly the records listed and checked are added. */}
      <Dialog open={family !== null} onOpenChange={(open) => !open && setFamily(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{ORDER_ITEMS_SELECT_FAMILY_COPY}</DialogTitle>
            <DialogDescription>{family?.familyName ?? ''}</DialogDescription>
          </DialogHeader>
          {family?.status === 'loading' ? (
            <div className="flex flex-col gap-2" aria-busy>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : family?.status === 'failed' ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-[13.5px]">
              <span>{ORDER_ITEMS_LOAD_FAILED_COPY}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const f = family;
                  const row = answer.rows.find((r) => r.familyId === f.familyId);
                  if (row) void openFamily(row);
                }}
              >
                {TRY_AGAIN_COPY}
              </Button>
            </div>
          ) : family?.status === 'ready' ? (
            family.rows.length === 0 ? (
              <p className="text-muted-foreground text-[13.5px]">
                {orderItemsEmptyCopy({ visibility: 'all', hasQuery: false })}
              </p>
            ) : (
              <ul
                aria-label="Family records"
                className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto"
              >
                {family.rows.map((r) => {
                  const detail = [r.sizeOrEdition, r.warehouseName]
                    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
                    .join(' · ');
                  return (
                    <li key={r.id} className="flex items-start justify-between gap-3">
                      <Checkbox
                        checked={family.checked.has(r.id)}
                        onCheckedChange={(next) =>
                          setFamily((f) => {
                            if (!f) return f;
                            const checked = new Set(f.checked);
                            if (next) checked.add(r.id);
                            else checked.delete(r.id);
                            return { ...f, checked };
                          })
                        }
                      >
                        <span className="min-w-0">
                          <span className="text-foreground block font-medium">{r.name}</span>
                          {detail ? (
                            <span className="text-muted-foreground block text-[12px]">
                              {detail}
                            </span>
                          ) : null}
                        </span>
                      </Checkbox>
                      <Badge variant={r.visible ? 'success' : 'secondary'} dot>
                        {r.visible ? ORDER_ITEMS_STATE_SHOWN_COPY : ORDER_ITEMS_STATE_HIDDEN_COPY}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
          {family?.status === 'ready' && family.truncated ? (
            <p className="text-muted-foreground text-[12.5px]">{FAMILY_TRUNCATED_COPY}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFamily(null)}>
              Cancel
            </Button>
            <Button
              disabled={family?.status !== 'ready' || family.checked.size === 0}
              onClick={confirmFamily}
            >
              {FAMILY_ADD_COPY}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirm
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
        title={confirmTitle}
        description={
          confirm?.visible ? ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY : ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY
        }
        confirmLabel={
          confirm?.visible ? ORDER_ITEMS_SHOW_ACTION_COPY : ORDER_ITEMS_HIDE_ACTION_COPY
        }
        tone={confirm?.visible ? 'primary' : 'destructive'}
        pending={busy}
        error={confirm?.error ?? null}
        onConfirm={() => {
          if (!confirm) return;
          void send(writeFor(confirm.ids, confirm.visible, confirm.source), true);
        }}
      />

      {stepUp.modal}
    </div>
  );
}
