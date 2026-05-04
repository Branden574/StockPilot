'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ImagePlus, Loader2, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { generateSku, cn } from '@/lib/utils';
import { createItemAction, updateItemAction } from '@/server/actions/inventory';
import { createImageUploadAction, recordImageAction } from '@/server/actions/item-images';

import { createItemSchema, type CreateItemInput } from '@stockpilot/core';

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];

interface StagedImage {
  file: File;
  previewUrl: string;
}

export interface ItemFormDefaults extends Partial<CreateItemInput> {
  id?: string;
}

interface ItemFormProps {
  defaults?: ItemFormDefaults;
  categories: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  /** All warehouses the current user can write to. */
  warehouses: Array<{ id: string; name: string }>;
  /** Every (warehouse_id, charter_id) pair in the org. Used to filter charter options. */
  warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
  /** All charters in the org (for label lookup). */
  charters: Array<{ id: string; name: string }>;
  /** Forced warehouse (for warehouse-scoped users) — picker is hidden when set. */
  forcedWarehouseId?: string | null;
  warehouseLabel: string;
  charterLabel: string;
  onDone?: () => void;
}

export function ItemForm({
  defaults,
  categories,
  locations,
  suppliers,
  warehouses,
  warehouseCharters,
  charters,
  forcedWarehouseId,
  warehouseLabel,
  charterLabel,
  onDone,
}: ItemFormProps) {
  const router = useRouter();
  const isEdit = Boolean(defaults?.id);
  const [staged, setStaged] = React.useState<StagedImage[]>([]);
  const [uploadingImages, setUploadingImages] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);

  // Revoke blob URLs on unmount.
  React.useEffect(() => {
    return () => {
      staged.forEach((s) => URL.revokeObjectURL(s.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    const accepted: StagedImage[] = [];
    for (const file of list) {
      if (!IMAGE_ACCEPT.includes(file.type)) {
        toast.error(`${file.name}: unsupported type`);
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        toast.error(`${file.name}: max 10 MB`);
        continue;
      }
      accepted.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    if (accepted.length > 0) setStaged((s) => [...s, ...accepted]);
  }

  function removeStaged(idx: number) {
    setStaged((s) => {
      const target = s[idx];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return s.filter((_, i) => i !== idx);
    });
  }

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateItemInput>({
    resolver: zodResolver(createItemSchema),
    defaultValues: {
      name: defaults?.name ?? '',
      sku: defaults?.sku ?? '',
      barcode: defaults?.barcode ?? '',
      description: defaults?.description ?? '',
      categoryId: defaults?.categoryId ?? null,
      supplierId: defaults?.supplierId ?? null,
      primaryLocationId: defaults?.primaryLocationId ?? null,
      warehouseId: defaults?.warehouseId ?? forcedWarehouseId ?? null,
      charterId: defaults?.charterId ?? null,
      unitCost: defaults?.unitCost ?? 0,
      retailPrice: defaults?.retailPrice ?? 0,
      quantityOnHand: defaults?.quantityOnHand ?? 0,
      reorderPoint: defaults?.reorderPoint ?? 0,
      reorderQuantity: defaults?.reorderQuantity ?? 0,
      unitOfMeasure: defaults?.unitOfMeasure ?? 'unit',
      binLocation: defaults?.binLocation ?? '',
      status: defaults?.status ?? 'active',
      customFields: defaults?.customFields ?? {},
    },
  });

  const watchedWarehouseId = watch('warehouseId') ?? forcedWarehouseId ?? null;
  const watchedCharterId = watch('charterId') ?? null;
  const charterById = React.useMemo(
    () => new Map(charters.map((c) => [c.id, c.name])),
    [charters],
  );
  const allowedCharterIds = React.useMemo(
    () =>
      new Set(
        watchedWarehouseId
          ? warehouseCharters
              .filter((wc) => wc.warehouse_id === watchedWarehouseId)
              .map((wc) => wc.charter_id)
          : [],
      ),
    [warehouseCharters, watchedWarehouseId],
  );
  const allowedCharters = React.useMemo(
    () =>
      [...allowedCharterIds]
        .map((id) => ({ id, name: charterById.get(id) ?? id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allowedCharterIds, charterById],
  );

  // If the warehouse changes and the current charter no longer fits, clear it.
  React.useEffect(() => {
    if (watchedCharterId && !allowedCharterIds.has(watchedCharterId)) {
      setValue('charterId', null);
    }
  }, [watchedCharterId, allowedCharterIds, setValue]);

  async function uploadStagedImages(itemId: string) {
    if (staged.length === 0) return { uploaded: 0, failed: 0 };
    setUploadingImages(true);
    let uploaded = 0;
    let failed = 0;
    try {
      for (let i = 0; i < staged.length; i++) {
        const item = staged[i];
        if (!item) continue;
        const ext = (item.file.name.split('.').pop() ?? 'jpg').toLowerCase();
        const presign = await createImageUploadAction({ itemId, fileExt: ext });
        if (!presign.ok) {
          failed++;
          continue;
        }
        const put = await fetch(presign.data.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': item.file.type, 'x-upsert': 'true' },
          body: item.file,
        });
        if (!put.ok) {
          failed++;
          continue;
        }
        const record = await recordImageAction({
          itemId,
          storagePath: presign.data.path,
          isFirst: i === 0,
        });
        if (record.ok) uploaded++;
        else failed++;
      }
    } finally {
      setUploadingImages(false);
    }
    return { uploaded, failed };
  }

  const onSubmit = handleSubmit(async (values) => {
    const action = isEdit && defaults?.id ? updateItemAction(defaults.id, values) : createItemAction(values);
    const res = await action;
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }

    // Photo uploads are only staged in the create flow; edit flow uses the
    // ImageUploader on the item detail page directly against an existing id.
    if (!isEdit && staged.length > 0) {
      const { uploaded, failed } = await uploadStagedImages(res.data.id);
      if (failed > 0) {
        toast.warning(`Item created. Uploaded ${uploaded}/${staged.length} photos — ${failed} failed.`);
      } else {
        toast.success(`Item and ${uploaded} photo${uploaded === 1 ? '' : 's'} created`);
      }
    } else {
      toast.success(isEdit ? 'Item updated' : 'Item created');
    }

    onDone?.();
    if (!isEdit) {
      router.push(`/dashboard/inventory/${res.data.id}`);
    } else {
      router.refresh();
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      {!isEdit && (
        <Section title="Photos">
          <p className="text-xs text-muted-foreground">
            Drop photos here. They'll upload after the item is created. PNG, JPG, WebP, AVIF — up to 10 MB each.
          </p>

          {staged.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {staged.map((s, idx) => (
                <div key={s.previewUrl} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.previewUrl} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeStaged(idx)}
                    className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-md bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  {idx === 0 && (
                    <span className="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
                      Primary
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <label
            htmlFor="item-form-photos"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-6 transition-colors hover:border-primary/40 hover:bg-muted/40',
              dragOver && 'border-primary bg-primary/5',
            )}
          >
            <ImagePlus className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">Drop photos, or click to browse</p>
            <input
              id="item-form-photos"
              ref={fileInputRef}
              type="file"
              accept={IMAGE_ACCEPT.join(',')}
              multiple
              className="sr-only"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Choose files
            </Button>
          </label>
        </Section>
      )}

      <Section title="Basics">
        <Field label="Name" error={errors.name?.message} required>
          <Input placeholder="Wireless mouse" autoFocus {...register('name')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU" error={errors.sku?.message}>
            <div className="flex gap-2">
              <Input placeholder="Auto-generated if blank" {...register('sku')} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setValue('sku', generateSku())}
              >
                Auto
              </Button>
            </div>
          </Field>
          <Field label="Barcode" error={errors.barcode?.message}>
            <Input placeholder="Scan or type" {...register('barcode')} />
          </Field>
        </div>
        <Field label="Description" error={errors.description?.message}>
          <Textarea rows={3} {...register('description')} />
        </Field>
      </Section>

      <Section title="Classification">
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Category"
            value={watch('categoryId') ?? ''}
            onChange={(v) => setValue('categoryId', v || null)}
            options={categories}
            placeholder="Uncategorized"
          />
          <SelectField
            label="Supplier"
            value={watch('supplierId') ?? ''}
            onChange={(v) => setValue('supplierId', v || null)}
            options={suppliers}
            placeholder="None"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Primary location"
            value={watch('primaryLocationId') ?? ''}
            onChange={(v) => setValue('primaryLocationId', v || null)}
            options={locations}
            placeholder="None"
          />
          <Field label="Bin / shelf">
            <Input placeholder="A-12, Shelf 3…" {...register('binLocation')} />
          </Field>
        </div>
      </Section>

      <Section title={`${warehouseLabel} & ${charterLabel.toLowerCase()}`}>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>
              {warehouseLabel}
              <span className="ml-0.5 text-destructive">*</span>
            </Label>
            {forcedWarehouseId ? (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {warehouses.find((w) => w.id === forcedWarehouseId)?.name ??
                  'Your assigned warehouse'}
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  You can only create items at your assigned {warehouseLabel.toLowerCase()}.
                </p>
              </div>
            ) : (
              <Select
                value={watchedWarehouseId ?? ''}
                onValueChange={(v: string) => setValue('warehouseId', v || null)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={`Pick a ${warehouseLabel.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{charterLabel}</Label>
            <Select
              value={watchedCharterId ?? '__generic'}
              onValueChange={(v: string) =>
                setValue('charterId', v === '__generic' ? null : v)
              }
              disabled={!watchedWarehouseId}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    watchedWarehouseId
                      ? `Generic (any ${charterLabel.toLowerCase()})`
                      : `Pick a ${warehouseLabel.toLowerCase()} first`
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__generic">
                  Generic — any {charterLabel.toLowerCase()}
                </SelectItem>
                {allowedCharters.length === 0 && watchedWarehouseId ? (
                  <div className="px-3 py-2 text-[12px] text-muted-foreground">
                    No {charterLabel.toLowerCase()}s linked to this {warehouseLabel.toLowerCase()}
                    {' '}yet — admins can configure them in Admin → {warehouseLabel}s.
                  </div>
                ) : (
                  allowedCharters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Generic stock is shared across every {charterLabel.toLowerCase()} the {warehouseLabel.toLowerCase()} services.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Pricing & stock">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit cost" error={errors.unitCost?.message}>
            <Input type="number" step="0.01" min="0" {...register('unitCost', { valueAsNumber: true })} />
          </Field>
          <Field label="Retail price" error={errors.retailPrice?.message}>
            <Input type="number" step="0.01" min="0" {...register('retailPrice', { valueAsNumber: true })} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="On hand" error={errors.quantityOnHand?.message}>
            <Input type="number" step="1" {...register('quantityOnHand', { valueAsNumber: true })} disabled={isEdit} />
          </Field>
          <Field label="Reorder at" error={errors.reorderPoint?.message}>
            <Input type="number" step="1" min="0" {...register('reorderPoint', { valueAsNumber: true })} />
          </Field>
          <Field label="Reorder qty" error={errors.reorderQuantity?.message}>
            <Input type="number" step="1" min="0" {...register('reorderQuantity', { valueAsNumber: true })} />
          </Field>
        </div>
        <Field label="Unit of measure">
          <Input placeholder="unit, kg, lb, hr…" {...register('unitOfMeasure')} />
        </Field>
        {isEdit && (
          <p className="text-xs text-muted-foreground">
            On-hand quantity is read-only here. Use the &ldquo;Adjust stock&rdquo; action on the item page.
          </p>
        )}
      </Section>

      <div className="flex justify-end gap-2">
        {onDone && (
          <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting || uploadingImages}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="gradient" disabled={isSubmitting || uploadingImages}>
          {isSubmitting || uploadingImages ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {uploadingImages ? 'Uploading photos…' : 'Saving…'}
            </>
          ) : isEdit ? (
            'Save changes'
          ) : staged.length > 0 ? (
            `Create item & upload ${staged.length} photo${staged.length === 1 ? '' : 's'}`
          ) : (
            'Create item'
          )}
        </Button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  error,
  required,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value || '__none'} onValueChange={(v: string) => onChange(v === '__none' ? '' : v)}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
