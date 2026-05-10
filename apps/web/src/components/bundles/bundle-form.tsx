'use client';

import { Loader2, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  createBundleAction,
  updateBundleAction,
} from '@/server/actions/bundles';

interface ItemSearchResult {
  id: string;
  name: string;
  sku: string;
  quantity: number;
}

interface ComponentRow {
  itemId: string;
  itemName: string;
  itemSku: string;
  quantity: number;
  isOptional: boolean;
}

interface InitialBundle {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  preassemblyEnabled: boolean;
  components: ComponentRow[];
}

export function BundleForm({ initial }: { initial?: InitialBundle }) {
  const router = useRouter();
  const [name, setName] = React.useState(initial?.name ?? '');
  const [sku, setSku] = React.useState(initial?.sku ?? '');
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [preassembly, setPreassembly] = React.useState(
    initial?.preassemblyEnabled ?? false,
  );
  const [components, setComponents] = React.useState<ComponentRow[]>(
    initial?.components ?? [],
  );
  const [search, setSearch] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<ItemSearchResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const isEdit = Boolean(initial);

  React.useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(search)}`, {
          signal: ctrl.signal,
        });
        const data = await res.json();
        setSearchResults((data.items as ItemSearchResult[]) ?? []);
      } catch {
        // Aborted or network failure — ignore.
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [search]);

  function addComponent(item: ItemSearchResult) {
    setComponents((cur) => {
      if (cur.some((c) => c.itemId === item.id)) {
        toast.info(`${item.name} is already a component.`);
        return cur;
      }
      return [
        ...cur,
        {
          itemId: item.id,
          itemName: item.name,
          itemSku: item.sku,
          quantity: 1,
          isOptional: false,
        },
      ];
    });
    setSearch('');
    setSearchResults([]);
  }

  function updateComponent(itemId: string, patch: Partial<ComponentRow>) {
    setComponents((cur) => cur.map((c) => (c.itemId === itemId ? { ...c, ...patch } : c)));
  }

  function removeComponent(itemId: string) {
    setComponents((cur) => cur.filter((c) => c.itemId !== itemId));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Bundle needs a name.');
      return;
    }
    if (components.length === 0) {
      toast.error('Add at least one component.');
      return;
    }
    setSubmitting(true);
    try {
      if (isEdit && initial) {
        const res = await updateBundleAction({
          id: initial.id,
          name: name.trim(),
          sku: sku.trim() || null,
          description: description.trim() || null,
          preassemblyEnabled: preassembly,
          components: components.map((c) => ({
            itemId: c.itemId,
            quantity: c.quantity,
            isOptional: c.isOptional,
          })),
        });
        if (!res.ok) {
          toast.error(res.error.message);
          return;
        }
        toast.success('Bundle saved.');
        router.push(`/dashboard/bundles/${initial.id}`);
        router.refresh();
      } else {
        const res = await createBundleAction({
          name: name.trim(),
          sku: sku.trim() || null,
          description: description.trim() || null,
          preassemblyEnabled: preassembly,
          components: components.map((c) => ({
            itemId: c.itemId,
            quantity: c.quantity,
            isOptional: c.isOptional,
          })),
        });
        if (!res.ok) {
          toast.error(res.error.message);
          return;
        }
        toast.success('Bundle created.');
        router.push(`/dashboard/bundles/${res.data.id}`);
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="bundle-name">Name</Label>
          <Input
            id="bundle-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="3-grade Reading Kit"
            maxLength={200}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bundle-sku">
            SKU
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="bundle-sku"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="KIT-READ-3"
            maxLength={64}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="block">Pre-assembly</Label>
          <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm">
            <input
              type="checkbox"
              checked={preassembly}
              onChange={(e) => setPreassembly(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>Enable pre-boxing</span>
          </label>
          <p className="text-xs text-muted-foreground">
            Lets you decrement components ahead of time and hold the kits as
            phantom inventory until distribution.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bundle-desc">
          Description
          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="bundle-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this kit is for, who it's distributed to, etc."
          rows={2}
          maxLength={2000}
        />
      </div>

      <div className="space-y-3">
        <div>
          <Label>Components</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Items + per-kit quantities. Optional items don't block distribution
            when stock is short.
          </p>
        </div>

        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items by name, SKU, or barcode…"
            className="pl-8"
          />
          {searchResults.length > 0 && (
            <div className="border-border bg-popover absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border shadow-lg">
              {searchResults.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => addComponent(item)}
                  className="hover:bg-muted flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left text-sm last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.name}</div>
                    <div className="text-muted-foreground font-mono text-[11px]">
                      {item.sku}
                    </div>
                  </div>
                  <div className="text-muted-foreground tabular-nums text-xs">
                    {item.quantity} on hand
                  </div>
                </button>
              ))}
            </div>
          )}
          {searching && search.trim().length >= 2 && searchResults.length === 0 && (
            <p className="text-muted-foreground absolute left-0 top-full mt-1 text-xs">
              Searching…
            </p>
          )}
        </div>

        {components.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed border-border p-4 text-center text-xs">
            No components yet. Search for items above and click to add.
          </p>
        ) : (
          <div className="bg-card overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-[11.5px] uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Qty / kit</th>
                  <th className="px-3 py-2 text-center font-medium">Optional</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.itemId} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-medium">{c.itemName}</div>
                      <div className="text-muted-foreground font-mono text-[11px]">
                        {c.itemSku}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="number"
                        min={0.0001}
                        step="any"
                        value={c.quantity}
                        onChange={(e) =>
                          updateComponent(c.itemId, {
                            quantity: Number(e.target.value) || 0,
                          })
                        }
                        className="ml-auto h-8 w-24 text-right tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={c.isOptional}
                        onChange={(e) =>
                          updateComponent(c.itemId, { isOptional: e.target.checked })
                        }
                        className="h-3.5 w-3.5"
                        aria-label="Mark component as optional"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => removeComponent(c.itemId)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${c.itemName}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" variant="gradient" disabled={submitting}>
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isEdit ? 'Save changes' : 'Create bundle'}
        </Button>
      </div>
    </form>
  );
}
