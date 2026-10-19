'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  BundleComponentPicker,
  type ComponentSearchItem,
} from '@/components/bundles/bundle-component-picker';
import { DetailSection } from '@/components/patterns/detail-section';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {/* The kit itself: name, SKU, pre-assembly and description, in one card. */}
      <section className="border-border bg-card grid grid-cols-1 gap-4 rounded-lg border p-[18px] sm:grid-cols-2">
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
            <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
          </Label>
          <div className="flex gap-2">
            <Input
              id="bundle-sku"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="KIT-READ-3"
              maxLength={64}
              className="font-mono"
            />
            {/* Same generator and button word as the item form's SKU; the KIT
                prefix matches the placeholder. Unique per organization is
                still enforced by bundles_org_sku_unique on save. */}
            <Button
              type="button"
              variant="outline"
              className="max-sm:h-11"
              title="Generate a SKU"
              onClick={() => setSku(generateSku('KIT'))}
            >
              Auto
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="block">Pre-assembly</Label>
          {/* The whole bordered box is the one checkbox (the label used to
              wrap a native box the same way), so a click anywhere in it
              toggles, once. */}
          <Checkbox
            checked={preassembly}
            onCheckedChange={setPreassembly}
            aria-describedby="bundle-preassembly-help"
            className="border-border bg-card h-8 w-full rounded-md border px-2.5 max-sm:h-11"
          >
            <span>Enable pre-boxing</span>
          </Checkbox>
          <p id="bundle-preassembly-help" className="text-muted-foreground text-[12px]">
            Lets you decrement components ahead of time and hold the kits as
            phantom inventory until distribution.
          </p>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="bundle-desc">
            Description
            <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
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
      </section>

      {/* The recipe: the component search, then one line per component (the
          purchase order line-entry card). */}
      <DetailSection title="Components" bodyClassName="flex flex-col gap-3">
        <p className="text-muted-foreground -mt-1 text-[12px]">
          Items + per-kit quantities. Optional items don't block distribution
          when stock is short.
        </p>

        <BundleComponentPicker addedIds={addedIds} onAdd={addComponent} />

        {components.length === 0 ? (
          <p className="text-muted-foreground border-border rounded-md border border-dashed p-4 text-center text-[12px]">
            No components yet. Search for items above, then click one or press
            Enter to add it.
          </p>
        ) : (
          <div className="border-border min-w-0 overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty / kit</TableHead>
                  <TableHead className="text-center">Optional</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {components.map((c) => (
                  <TableRow key={c.itemId}>
                    <TableCell>
                      <div className="text-foreground font-medium [overflow-wrap:anywhere]">
                        {c.itemName}
                      </div>
                      <div className="text-muted-foreground font-mono text-[11.5px] [overflow-wrap:anywhere]">
                        {c.itemSku}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <BlankZeroNumberInput
                        min={0.0001}
                        step="any"
                        value={c.quantity}
                        onValueChange={(n) =>
                          updateComponent(c.itemId, { quantity: n })
                        }
                        placeholder="1"
                        className="ml-auto w-24 text-right font-mono tabular-nums"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        checked={c.isOptional}
                        onCheckedChange={(checked) =>
                          updateComponent(c.itemId, { isOptional: checked })
                        }
                        label="Mark component as optional"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeComponent(c.itemId)}
                        className="text-muted-foreground hover:text-destructive h-7 w-7"
                        aria-label={`Remove ${c.itemName}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DetailSection>

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
