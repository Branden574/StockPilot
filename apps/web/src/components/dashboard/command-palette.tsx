'use client';

import { Command } from 'cmdk';
import {
  BookOpen,
  Boxes,
  ClipboardList,
  Home,
  LayoutGrid,
  Loader2,
  Package,
  Plus,
  Receipt,
  Search,
  Settings,
  Tags,
  Truck,
  Users,
  Warehouse,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { ItemThumb } from '@/components/items/item-thumb';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface SearchResult {
  items: Array<{
    id: string;
    name: string;
    sku: string;
    quantity: number;
    imageUrl: string | null;
  }>;
  purchaseOrders: Array<{ id: string; poNumber: string; status: string }>;
  suppliers: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
}

interface PaletteCommand {
  id: string;
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
}

const NAV_COMMANDS: PaletteCommand[] = [
  { id: 'nav-dashboard', label: 'Overview', href: '/dashboard', Icon: Home, keywords: 'home dashboard' },
  { id: 'nav-inventory', label: 'Inventory items', href: '/dashboard/inventory', Icon: Boxes, keywords: 'items stock' },
  { id: 'nav-books', label: 'Books', href: '/dashboard/books', Icon: Package, keywords: 'textbooks isbn' },
  { id: 'nav-categories', label: 'Categories', href: '/dashboard/categories', Icon: LayoutGrid },
  { id: 'nav-movements', label: 'Movements', href: '/dashboard/movements', Icon: Truck, keywords: 'stock movements log' },
  { id: 'nav-pos', label: 'Purchase orders', href: '/dashboard/purchase-orders', Icon: ClipboardList, keywords: 'po purchase orders' },
  { id: 'nav-suppliers', label: 'Suppliers', href: '/dashboard/suppliers', Icon: Truck, keywords: 'vendors' },
  { id: 'nav-locations', label: 'Locations', href: '/dashboard/locations', Icon: Warehouse },
  { id: 'nav-cycle-counts', label: 'Cycle counts', href: '/dashboard/cycle-counts', Icon: Receipt, keywords: 'count audit' },
  { id: 'nav-procedures', label: 'Procedures', href: '/dashboard/procedures', Icon: BookOpen, keywords: 'sop knowledge how-to guide procedure' },
  { id: 'nav-reports', label: 'Reports', href: '/dashboard/reports', Icon: Tags },
  { id: 'nav-team', label: 'Team', href: '/dashboard/team', Icon: Users, keywords: 'members invites' },
  { id: 'nav-settings', label: 'Settings', href: '/dashboard/settings', Icon: Settings },
];

// Action commands — direct shortcuts to "create new" flows. Only includes
// destinations backed by a real /new route; supplier and team creation
// happen via dialogs on the list page, so they live under "Jump to" and
// the user picks the affordance there.
const ACTION_COMMANDS: PaletteCommand[] = [
  { id: 'act-new-item', label: 'New item', href: '/dashboard/inventory/new', Icon: Plus, keywords: 'create add sku product' },
  { id: 'act-new-po', label: 'New purchase order', href: '/dashboard/purchase-orders/new', Icon: Plus, keywords: 'create add po order' },
  { id: 'act-new-cycle-count', label: 'New cycle count', href: '/dashboard/cycle-counts/new', Icon: Plus, keywords: 'create add count audit' },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [results, setResults] = React.useState<SearchResult>({
    items: [],
    purchaseOrders: [],
    suppliers: [],
    warehouses: [],
  });

  // ⌘K / Ctrl+K toggle. Skip when an input/textarea is focused so users
  // typing into a form don't get hijacked.
  React.useEffect(() => {
    function down(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === 'k') {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') {
          // Allow ⌘K from the topbar search button (active focus there is fine)
          // but never steal from real text inputs.
          if ((document.activeElement as HTMLElement)?.dataset.cmdk !== 'true') {
            return;
          }
        }
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  // Debounced search. < 2 chars = nav-only mode.
  React.useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
      setResults({ items: [], purchaseOrders: [], suppliers: [], warehouses: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          setResults({ items: [], purchaseOrders: [], suppliers: [], warehouses: [] });
          return;
        }
        const data = (await res.json()) as SearchResult;
        setResults(data);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setResults({ items: [], purchaseOrders: [], suppliers: [], warehouses: [] });
        }
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [value]);

  function go(href: string) {
    setOpen(false);
    setValue('');
    router.push(href);
  }

  const showSearchHits =
    value.trim().length >= 2 &&
    (results.items.length > 0 ||
      results.purchaseOrders.length > 0 ||
      results.suppliers.length > 0 ||
      results.warehouses.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-[640px]"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Command
          shouldFilter={value.trim().length < 2}
          className="flex h-full flex-col"
        >
          <div className="border-border flex items-center gap-2 border-b px-4">
            <Search className="text-muted-foreground h-4 w-4" />
            <Command.Input
              data-cmdk="true"
              placeholder="Search items, POs, suppliers, or jump to…"
              value={value}
              onValueChange={setValue}
              className="placeholder:text-muted-foreground flex h-12 w-full bg-transparent text-sm outline-none"
            />
            {loading && (
              <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
            )}
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto p-2">
            <Command.Empty className="text-muted-foreground py-8 text-center text-sm">
              No matches.
            </Command.Empty>

            {showSearchHits && results.items.length > 0 && (
              <Command.Group heading="Items" className={GROUP}>
                {results.items.map((i) => (
                  <Command.Item
                    key={`item-${i.id}`}
                    value={`item ${i.name} ${i.sku}`}
                    onSelect={() => go(`/dashboard/inventory/${i.id}`)}
                    className={ROW}
                  >
                    <ItemThumb
                      imageUrl={i.imageUrl}
                      alt={i.name}
                      size="sm"
                      itemId={i.id}
                    />
                    <span className="flex-1 truncate">{i.name}</span>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {i.sku}
                    </span>
                    <span className="text-muted-foreground tabular-nums text-[11px]">
                      {i.quantity}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {showSearchHits && results.purchaseOrders.length > 0 && (
              <Command.Group heading="Purchase orders" className={GROUP}>
                {results.purchaseOrders.map((p) => (
                  <Command.Item
                    key={`po-${p.id}`}
                    value={`po ${p.poNumber}`}
                    onSelect={() => go(`/dashboard/purchase-orders/${p.id}`)}
                    className={ROW}
                  >
                    <ClipboardList className="text-muted-foreground h-3.5 w-3.5" />
                    <span className="flex-1 truncate">{p.poNumber}</span>
                    <span className="text-muted-foreground text-[11px] capitalize">
                      {p.status}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {showSearchHits && results.suppliers.length > 0 && (
              <Command.Group heading="Suppliers" className={GROUP}>
                {results.suppliers.map((s) => (
                  <Command.Item
                    key={`sup-${s.id}`}
                    value={`supplier ${s.name}`}
                    onSelect={() => go(`/dashboard/suppliers`)}
                    className={ROW}
                  >
                    <Truck className="text-muted-foreground h-3.5 w-3.5" />
                    <span className="flex-1 truncate">{s.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {showSearchHits && results.warehouses.length > 0 && (
              <Command.Group heading="Warehouses" className={GROUP}>
                {results.warehouses.map((w) => (
                  <Command.Item
                    key={`wh-${w.id}`}
                    value={`warehouse ${w.name}`}
                    onSelect={() => go(`/dashboard/warehouses/${w.id}`)}
                    className={ROW}
                  >
                    <Warehouse className="text-muted-foreground h-3.5 w-3.5" />
                    <span className="flex-1 truncate">{w.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="Quick actions" className={GROUP}>
              {ACTION_COMMANDS.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`${c.label} ${c.keywords ?? ''}`}
                  onSelect={() => go(c.href)}
                  className={ROW}
                >
                  <c.Icon className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="flex-1 truncate">{c.label}</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Jump to" className={GROUP}>
              {NAV_COMMANDS.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`${c.label} ${c.keywords ?? ''}`}
                  onSelect={() => go(c.href)}
                  className={ROW}
                >
                  <c.Icon className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="flex-1 truncate">{c.label}</span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>

          <div className="border-border bg-muted/40 text-muted-foreground flex items-center justify-between border-t px-4 py-2 text-[11px]">
            <span>
              <kbd className={KBD}>↑</kbd> <kbd className={KBD}>↓</kbd> navigate
            </span>
            <span>
              <kbd className={KBD}>↵</kbd> open · <kbd className={KBD}>esc</kbd> close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

const GROUP = cn(
  '[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider',
);

const ROW = cn(
  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
);

const KBD = cn(
  'border-border bg-card rounded border px-1.5 py-px font-mono text-[10px]',
);
