'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Loader2, Mail, Plus, Tag, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium tracking-wide uppercase text-muted-foreground">
            Customers · {customers.length}
          </h2>
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!entitled}>
            <Plus className="h-3.5 w-3.5" /> New customer
          </Button>
        </div>

        {customers.length === 0 ? (
          <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            No customers yet. Create one, assign a price list, and invite their
            first portal user.
          </div>
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
              A B2B account that orders through your portal. You can assign a
              price list and invite users after creating it.
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
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy === 'create'}>
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
    <div className="bg-card rounded-xl border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        {expanded ? (
          <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{customer.name}</span>
            {customer.status === 'archived' && (
              <span className="text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]">
                archived
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {customer.price_list_name ?? 'No price list'} · {customer.user_count} user
            {customer.user_count === 1 ? '' : 's'} · {customer.catalog_count} catalog item
            {customer.catalog_count === 1 ? '' : 's'}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="space-y-5 border-t px-4 pt-4 pb-5">
          {/* Price list assignment */}
          <div className="space-y-1.5">
            <Label>Price list</Label>
            <select
              className="border-input bg-background w-full max-w-sm rounded-md border px-3 py-2 text-sm"
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
            <p className="text-muted-foreground text-xs">
              Portal customers only see items priced on their list AND in their
              catalog below.
            </p>
          </div>

          {/* Portal users */}
          <div className="space-y-2">
            <Label>Portal users</Label>
            {users.length > 0 && (
              <ul className="space-y-1">
                {users.map((u) => (
                  <li key={u.user_id} className="flex items-center gap-2 text-sm">
                    <Mail className="text-muted-foreground h-3.5 w-3.5" />
                    <span className="min-w-0 flex-1 truncate">{u.email}</span>
                    <span className="text-muted-foreground text-xs">
                      {u.accepted_at ? 'active' : 'invited'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeUser(u.user_id)}
                      disabled={busy === `rmuser-${u.user_id}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex max-w-sm gap-2">
              <Input
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
              <p role="alert" className="text-destructive text-sm">
                {inviteError}
              </p>
            )}
          </div>

          {/* Catalog allowlist */}
          <div className="space-y-2">
            <Label>Catalog ({catalog.length})</Label>
            {catalog.length > 0 && (
              <ul className="space-y-1">
                {catalog.map((r) => (
                  <li key={r.item_id} className="flex items-center gap-2 text-sm">
                    <Tag className="text-muted-foreground h-3.5 w-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      {r.name ?? r.item_id}
                      {r.sku ? <span className="text-muted-foreground"> · {r.sku}</span> : null}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeFromCatalog(r.item_id)}
                      disabled={busy === `rmcat-${r.item_id}`}
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
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide uppercase text-muted-foreground">
          Price lists · {priceLists.length}
        </h2>
        <div className="flex gap-2">
          <Input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="New price list name"
            className="w-56"
            maxLength={200}
          />
          <Button size="sm" onClick={() => void createList()} disabled={busy === 'newlist' || !newListName.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>

      {priceLists.length === 0 ? (
        <div className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
          No price lists yet. Prices are explicit-only: an item with no price on
          a customer&apos;s list never appears in their portal.
        </div>
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
    <div className="bg-card rounded-xl border">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 p-4 text-left">
        {expanded ? (
          <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <span className="font-medium">{list.name}</span>
          <span className="text-muted-foreground ml-2 text-xs">{prices.length} priced items</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 border-t px-4 pt-4 pb-5">
          {prices.length > 0 && (
            <ul className="space-y-1">
              {prices.map((p) => (
                <li key={p.item_id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {p.name ?? p.item_id}
                    {p.sku ? <span className="text-muted-foreground"> · {p.sku}</span> : null}
                  </span>
                  <span className="font-mono text-sm">${p.unit_price.toFixed(2)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(p.item_id)}
                    disabled={busy === `rmprice-${p.item_id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {pendingItem ? (
            <div className="flex max-w-md items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{pendingItem.name}</span>
              <Input
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className="w-28"
                autoFocus
              />
              <Button size="sm" onClick={() => void savePrice()} disabled={busy === `price-${list.id}`}>
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPendingItem(null)}>
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
    <div className="max-w-md">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {matches.length > 0 && (
        <ul className="bg-popover mt-1 rounded-md border shadow-sm">
          {matches.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                onClick={() => {
                  setQuery('');
                  if (onPickItem) onPickItem(m);
                  else onPick?.(m.id);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {m.sku && <span className="text-muted-foreground text-xs">{m.sku}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
