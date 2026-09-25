'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  BundleComponentPicker,
  type ComponentSearchItem,
} from '@/components/bundles/bundle-component-picker';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { generateSku } from '@/lib/utils';
import {
  createBundleAction,
  updateBundleAction,
} from '@/server/actions/bundles';

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
  const [submitting, setSubmitting] = React.useState(false);
  const isEdit = Boolean(initial);
  const addedIds = React.useMemo(
    () => new Set(components.map((c) => c.itemId)),
    [components],
  );

  function addComponent(item: ComponentSearchItem) {
    setComponents((cur) => {
      if (cur.some((c) => c.itemId === item.id)) {
        toast.info(`"${item.name}" is already a component.`);
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
      toast.error('Enter a bundle name.');
      return;
    }
    if (components.length === 0) {
      toast.error('Add at least one component to the bundle.');
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
        toast.success('Bundle updated.');
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
          <div className="flex gap-2">
            <Input
              id="bundle-sku"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="KIT-READ-3"
              maxLength={64}
            />
            {/* Same generator and button word as the item form's SKU; the KIT
                prefix matches the placeholder. Unique per organization is
                still enforced by bundles_org_sku_unique on save. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              title="Generate a SKU"
              onClick={() => setSku(generateSku('KIT'))}
            >
              Auto
            </Button>
          </div>
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

        <BundleComponentPicker addedIds={addedIds} onAdd={addComponent} />

        {components.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed border-border p-4 text-center text-xs">
            No components yet. Search for items above, then click one or press
            Enter to add it.
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
                      <BlankZeroNumberInput
                        min={0.0001}
                        step="any"
                        value={c.quantity}
                        onValueChange={(n) =>
                          updateComponent(c.itemId, { quantity: n })
                        }
                        placeholder="1"
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
