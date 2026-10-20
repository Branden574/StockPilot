'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Loader2, Mail, Plus, Tag, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { StatePanel } from '@/components/patterns/state-panel';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  addCatalogItemAction,
  createCustomerAction,
  createPriceListAction,
  inviteCustomerUserAction,
  removeCatalogItemAction,
  removeCustomerUserAction,
  removePriceAction,
  setPriceAction,
  updateCustomerAction,
} from '@/server/actions/customers';
import type { CustomerRow } from '@/server/services/customers';

interface ItemOption {
  id: string;
  name: string;
  sku: string | null;
}
interface PriceListRow {
  id: string;
  name: string;
  item_count: number;
}
interface PortalUser {
  user_id: string;
  email: string;
  invited_at: string;
  accepted_at: string | null;
}
interface CatalogRow {
  item_id: string;
  name: string | null;
  sku: string | null;
}
interface PriceRow {
  item_id: string;
  unit_price: number;
  name: string | null;
  sku: string | null;
}

interface Props {
  customers: CustomerRow[];
  priceLists: PriceListRow[];
  items: ItemOption[];
  usersByCustomer: Record<string, PortalUser[]>;
  catalogByCustomer: Record<string, CatalogRow[]>;
  pricesByList: Record<string, PriceRow[]>;
  entitled: boolean;
}

/** A section's heading row: the h2 on the left, its controls on the right. */
const SECTION_HEAD = 'mb-3 flex flex-wrap items-center justify-between gap-3';
const SECTION_TITLE = 'text-foreground text-[13.5px] font-medium leading-5';
/** An expandable card (DESIGN-SPEC 6.7): radius 8, hairline, the card colour. */
const CARD = 'border-border bg-card overflow-hidden rounded-lg border';
/** The card's toggle row: the whole header is one button. */
const CARD_TOGGLE =
  'hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-3 px-[18px] py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset';
/** A list row inside an open card, 8 x 0 with a hairline between rows. */
const LIST = 'divide-border border-border divide-y rounded-lg border';
const LIST_ROW = 'flex min-h-10 items-center gap-2 px-3 py-1.5 text-[13.5px]';
/** The native select's look: the Input's box (32 px, 44 px with 16 px text on
 *  a phone) on its own line under the label, with the control border (the
 *  stronger hairline the shared Input and Select draw; the plain hairline
 *  nearly vanished on the dark card) and the focus ring. Native, so the
 *  browser's picker stays. */
const NATIVE_SELECT =
  'border-line-strong bg-card text-foreground focus-visible:ring-ring block h-8 w-full max-w-sm rounded-md border px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:text-base';

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        'text-muted-foreground h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none',
        open && 'rotate-90',
      )}
    />
  );
}

/**
 * B2B customers management panel (Phase 1): customers with expandable detail
 * (portal users + catalog allowlist), plus price lists with a per-item price
 * editor. All mutations run server actions and router.refresh() — inline
 * errors via toast + persistent messages on dialogs (bug pattern #20).
 */
export function CustomersPanel({
  customers,
  priceLists,
  items,
  usersByCustomer,
  catalogByCustomer,
  pricesByList,
  entitled,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newNotes, setNewNotes] = React.useState('');
  const [createError, setCreateError] = React.useState<string | null>(null);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createCustomer() {
    setCreateError(null);
    setBusy('create');
    const res = await createCustomerAction({ name: newName, notes: newNotes || null });
    setBusy(null);
    if (!res.ok) {
      setCreateError(res.error.message);
      return;
    }
    setCreateOpen(false);
    setNewName('');
    setNewNotes('');
    toast.success('Customer created.');
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <section>
        <div className={SECTION_HEAD}>
          <h2 className={SECTION_TITLE}>Customers · {customers.length}</h2>
          <Button variant="gradient" onClick={() => setCreateOpen(true)} disabled={!entitled}>
            <Plus className="h-3.5 w-3.5" /> New customer
          </Button>
        </div>

        {customers.length === 0 ? (
          <StatePanel
            kind="empty"
            size="sm"
            headingLevel={3}
            title="No customers yet."
            description={
              <p>Create one, assign a price list, and invite their first portal user.</p>
            }
          />
        ) : (
          <div className="space-y-2">
            {customers.map((c) => (
              <CustomerCard
                key={c.id}
                customer={c}
                expanded={expanded.has(c.id)}
                onToggle={() => toggle(c.id)}
                priceLists={priceLists}
                items={items}
                users={usersByCustomer[c.id] ?? []}
                catalog={catalogByCustomer[c.id] ?? []}
                entitled={entitled}
                busy={busy}
                setBusy={setBusy}
              />
            ))}
          </div>
        )}
      </section>

      <PriceListsSection
        priceLists={priceLists}
        pricesByList={pricesByList}
        items={items}
        busy={busy}
        setBusy={setBusy}
      />

      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          if (busy === 'create') return;
          setCreateOpen(v);
          if (!v) setCreateError(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New customer</DialogTitle>
            <DialogDescription>
              A B2B account that orders through your portal. You can assign a price list and invite
              users after creating it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cust-name">Name</Label>
              <Input
                id="cust-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Acme School District"
                maxLength={200}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cust-notes">Notes (internal)</Label>
              <Input
                id="cust-notes"
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="Optional"
                maxLength={2000}
              />
            </div>
            {createError && (
              <p role="alert" className="text-destructive text-sm">
                {createError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={busy === 'create'}
            >
              Cancel
            </Button>
            <Button onClick={createCustomer} disabled={busy === 'create' || !newName.trim()}>
              {busy === 'create' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Customer card ────────────────────────────────────────────────────────────

function CustomerCard({
  customer,
  expanded,
  onToggle,
  priceLists,
  items,
  users,
  catalog,
  entitled,
  busy,
  setBusy,
}: {
  customer: CustomerRow;
  expanded: boolean;
  onToggle: () => void;
  priceLists: PriceListRow[];
  items: ItemOption[];
  users: PortalUser[];
  catalog: CatalogRow[];
  entitled: boolean;
  busy: string | null;
  setBusy: (v: string | null) => void;
}) {
  const router = useRouter();
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const catalogIds = React.useMemo(() => new Set(catalog.map((r) => r.item_id)), [catalog]);

  async function setPriceList(priceListId: string | null) {
    setBusy(`pl-${customer.id}`);
    const res = await updateCustomerAction({
      id: customer.id,
      name: customer.name,
      notes: customer.notes,
      priceListId,
    });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    router.refresh();
  }

  async function invite() {
    setInviteError(null);
    setBusy(`invite-${customer.id}`);
    const res = await inviteCustomerUserAction({ customerId: customer.id, email: inviteEmail });
    setBusy(null);
    if (!res.ok) {
      setInviteError(res.error.message);
      return;
    }
    setInviteEmail('');
    toast.success('Invite sent.');
    router.refresh();
  }

  async function removeUser(userId: string) {
    setBusy(`rmuser-${userId}`);
    const res = await removeCustomerUserAction({ customerId: customer.id, userId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    router.refresh();
  }

  async function addToCatalog(itemId: string) {
    setBusy(`cat-${customer.id}`);
    const res = await addCatalogItemAction({ customerId: customer.id, itemId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    router.refresh();
  }

  async function removeFromCatalog(itemId: string) {
    setBusy(`rmcat-${itemId}`);
    const res = await removeCatalogItemAction({ customerId: customer.id, itemId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className={CARD}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`customer-${customer.id}-detail`}
        className={CARD_TOGGLE}
      >
        <Chevron open={expanded} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-foreground truncate text-[13.5px] font-medium">
              {customer.name}
            </span>
            {customer.status === 'archived' && <Badge variant="outline">archived</Badge>}
          </div>
          <p className="text-muted-foreground mt-0.5 text-[12.5px]">
            {customer.price_list_name ?? 'No price list'} · {customer.user_count} user
            {customer.user_count === 1 ? '' : 's'} · {customer.catalog_count} catalog item
            {customer.catalog_count === 1 ? '' : 's'}
          </p>
        </div>
      </button>

      {expanded && (
        <div
          id={`customer-${customer.id}-detail`}
          className="border-border space-y-5 border-t px-[18px] pb-5 pt-4"
        >
          {/* Price list assignment */}
          <div className="space-y-1.5">
            <Label htmlFor={`customer-${customer.id}-price-list`}>Price list</Label>
            <select
              id={`customer-${customer.id}-price-list`}
              className={NATIVE_SELECT}
              value={customer.price_list_id ?? ''}
              disabled={busy === `pl-${customer.id}`}
              onChange={(e) => void setPriceList(e.target.value || null)}
            >
              <option value="">No price list (portal shows nothing)</option>
              {priceLists.map((pl) => (
                <option key={pl.id} value={pl.id}>
                  {pl.name} ({pl.item_count} priced)
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-[12px]">
              Portal customers only see items priced on their list AND in their catalog below.
            </p>
          </div>

          {/* Portal users */}
          <div className="space-y-2">
            <Label>Portal users</Label>
            {users.length > 0 && (
              <ul className={cn(LIST, 'max-w-xl')}>
                {users.map((u) => (
                  <li key={u.user_id} className={LIST_ROW}>
                    <Mail aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{u.email}</span>
                    <Badge variant={u.accepted_at ? 'success' : 'secondary'}>
                      {u.accepted_at ? 'active' : 'invited'}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => void removeUser(u.user_id)}
                      disabled={busy === `rmuser-${u.user_id}`}
                      aria-label={`Remove ${u.email}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex max-w-xl flex-wrap gap-2">
              <Input
                className="min-w-0 flex-1 basis-56"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="buyer@customer.com"
                type="email"
              />
              <Button
                onClick={() => void invite()}
                disabled={!entitled || busy === `invite-${customer.id}` || !inviteEmail.trim()}
              >
                {busy === `invite-${customer.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Invite
              </Button>
            </div>
            {inviteError && (
              <p role="alert" className="text-destructive text-[13px]">
                {inviteError}
              </p>
            )}
          </div>

          {/* Catalog allowlist */}
          <div className="space-y-2">
            <Label>Catalog ({catalog.length})</Label>
            {catalog.length > 0 && (
              <ul className={cn(LIST, 'max-w-xl')}>
                {catalog.map((r) => (
                  <li key={r.item_id} className={LIST_ROW}>
                    <Tag aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {r.name ?? r.item_id}
                      {r.sku ? (
                        <span className="text-muted-foreground font-mono text-[12px]">
                          {' '}
                          · {r.sku}
                        </span>
                      ) : null}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => void removeFromCatalog(r.item_id)}
                      disabled={busy === `rmcat-${r.item_id}`}
                      aria-label={`Remove ${r.name ?? r.item_id} from the catalog`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <ItemSearchAdd
              items={items}
              excludeIds={catalogIds}
              disabled={busy === `cat-${customer.id}`}
              onPick={(itemId) => void addToCatalog(itemId)}
              placeholder="Add an item to this customer's catalog…"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Price lists section ──────────────────────────────────────────────────────

function PriceListsSection({
  priceLists,
  pricesByList,
  items,
  busy,
  setBusy,
}: {
  priceLists: PriceListRow[];
  pricesByList: Record<string, PriceRow[]>;
  items: ItemOption[];
  busy: string | null;
  setBusy: (v: string | null) => void;
}) {
  const router = useRouter();
  const [newListName, setNewListName] = React.useState('');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  async function createList() {
    setBusy('newlist');
    const res = await createPriceListAction({ name: newListName });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setNewListName('');
    toast.success('Price list created.');
    router.refresh();
  }

  return (
    <section>
      <div className={SECTION_HEAD}>
        <h2 className={SECTION_TITLE}>Price lists · {priceLists.length}</h2>
        <div className="flex w-full gap-2 sm:w-auto">
          <Input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="New price list name"
            aria-label="New price list name"
            className="min-w-0 flex-1 sm:w-56 sm:flex-none"
            maxLength={200}
          />
          <Button
            variant="outline"
            onClick={() => void createList()}
            disabled={busy === 'newlist' || !newListName.trim()}
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>

      {priceLists.length === 0 ? (
        <StatePanel
          kind="empty"
          size="sm"
          headingLevel={3}
          title="No price lists yet."
          description={
            <p>
              Prices are explicit-only: an item with no price on a customer&apos;s list never
              appears in their portal.
            </p>
          }
        />
      ) : (
        <div className="space-y-2">
          {priceLists.map((pl) => (
            <PriceListCard
              key={pl.id}
              list={pl}
              prices={pricesByList[pl.id] ?? []}
              items={items}
              expanded={expanded.has(pl.id)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(pl.id)) next.delete(pl.id);
                  else next.add(pl.id);
                  return next;
                })
              }
              busy={busy}
              setBusy={setBusy}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PriceListCard({
  list,
  prices,
  items,
  expanded,
  onToggle,
  busy,
  setBusy,
}: {
  list: PriceListRow;
  prices: PriceRow[];
  items: ItemOption[];
  expanded: boolean;
  onToggle: () => void;
  busy: string | null;
  setBusy: (v: string | null) => void;
}) {
  const router = useRouter();
  const [priceInput, setPriceInput] = React.useState('');
  const [pendingItem, setPendingItem] = React.useState<ItemOption | null>(null);
  const pricedIds = React.useMemo(() => new Set(prices.map((p) => p.item_id)), [prices]);

  async function savePrice() {
    if (!pendingItem) return;
    const value = Number(priceInput);
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Enter a price ≥ 0.');
      return;
    }
    setBusy(`price-${list.id}`);
    const res = await setPriceAction({
      priceListId: list.id,
      itemId: pendingItem.id,
      unitPrice: value,
    });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setPendingItem(null);
    setPriceInput('');
    router.refresh();
  }

  async function remove(itemId: string) {
    setBusy(`rmprice-${itemId}`);
    const res = await removePriceAction({ priceListId: list.id, itemId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className={CARD}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`price-list-${list.id}-detail`}
        className={CARD_TOGGLE}
      >
        <Chevron open={expanded} />
        <div className="min-w-0 flex-1">
          <span className="text-foreground text-[13.5px] font-medium">{list.name}</span>
          <span className="text-muted-foreground ml-2 text-[12.5px]">
            {prices.length} priced items
          </span>
        </div>
      </button>

      {expanded && (
        <div
          id={`price-list-${list.id}-detail`}
          className="border-border space-y-3 border-t px-[18px] pb-5 pt-4"
        >
          {prices.length > 0 && (
            <ul className={cn(LIST, 'max-w-xl')}>
              {prices.map((p) => (
                <li key={p.item_id} className={LIST_ROW}>
                  <span className="min-w-0 flex-1 truncate">
                    {p.name ?? p.item_id}
                    {p.sku ? (
                      <span className="text-muted-foreground font-mono text-[12px]">
                        {' '}
                        · {p.sku}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-mono text-[13px] tabular-nums">
                    ${p.unit_price.toFixed(2)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => void remove(p.item_id)}
                    disabled={busy === `rmprice-${p.item_id}`}
                    aria-label={`Remove the price for ${p.name ?? p.item_id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {pendingItem ? (
            <div className="flex max-w-xl flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 basis-40 truncate text-[13.5px]">
                {pendingItem.name}
              </span>
              <Input
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                aria-label={`Price for ${pendingItem.name}`}
                className="w-28 font-mono tabular-nums"
                autoFocus
              />
              <Button
                size="sm"
                onClick={() => void savePrice()}
                disabled={busy === `price-${list.id}`}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setPendingItem(null)}
                aria-label="Cancel"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <ItemSearchAdd
              items={items}
              excludeIds={pricedIds}
              disabled={false}
              onPickItem={(item) => setPendingItem(item)}
              placeholder="Price an item…"
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared: type-to-search item picker ───────────────────────────────────────

/**
 * A match row in the item picker. The hover is the neutral fill with ink text
 * (DESIGN-SPEC 2.3): the accent fill it used read 3.48:1 for the name and
 * 1.21:1 for the SKU on the light teal (1.62 and 1.51 in dark). The keyboard
 * focus ring is drawn inside the row: the list clips its rows to its rounded
 * corners, which cut the global ring (drawn 2 px outside) down to one edge.
 * Exported for the test that pins it.
 */
export const ITEM_MATCH_ROW =
  'hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-ring flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-offset-0';

function ItemSearchAdd({
  items,
  excludeIds,
  disabled,
  onPick,
  onPickItem,
  placeholder,
}: {
  items: ItemOption[];
  excludeIds: Set<string>;
  disabled: boolean;
  onPick?: (itemId: string) => void;
  onPickItem?: (item: ItemOption) => void;
  placeholder: string;
}) {
  const [query, setQuery] = React.useState('');
  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((i) => !excludeIds.has(i.id))
      .filter((i) => i.name.toLowerCase().includes(q) || (i.sku ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, items, excludeIds]);

  return (
    <div className="max-w-xl">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
      />
      {matches.length > 0 && (
        <ul className="border-border bg-popover divide-border mt-1 divide-y overflow-hidden rounded-lg border">
          {matches.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={ITEM_MATCH_ROW}
                onClick={() => {
                  setQuery('');
                  if (onPickItem) onPickItem(m);
                  else onPick?.(m.id);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {m.sku && (
                  <span className="text-muted-foreground font-mono text-[12px]">{m.sku}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
