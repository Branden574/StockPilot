'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
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
import { generateSku } from '@/lib/utils';
import { createItemAction, updateItemAction } from '@/server/actions/inventory';

import { createItemSchema, type CreateItemInput } from '@stockpilot/core';

export interface ItemFormDefaults extends Partial<CreateItemInput> {
  id?: string;
}

interface ItemFormProps {
  defaults?: ItemFormDefaults;
  categories: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  onDone?: () => void;
}

export function ItemForm({ defaults, categories, locations, suppliers, onDone }: ItemFormProps) {
  const router = useRouter();
  const isEdit = Boolean(defaults?.id);

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

  const onSubmit = handleSubmit(async (values) => {
    const action = isEdit && defaults?.id ? updateItemAction(defaults.id, values) : createItemAction(values);
    const res = await action;
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(isEdit ? 'Item updated' : 'Item created');
    onDone?.();
    if (!isEdit) {
      router.push(`/dashboard/inventory/${res.data.id}`);
    } else {
      router.refresh();
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
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
          <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="gradient" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : isEdit ? 'Save changes' : 'Create item'}
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
