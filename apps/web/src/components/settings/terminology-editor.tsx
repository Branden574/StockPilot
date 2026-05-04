'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  updateTerminologyAction,
  type TerminologyInput,
} from '@/server/actions/organization';

interface TerminologyEditorProps {
  current: TerminologyInput;
  defaults: TerminologyInput;
}

export function TerminologyEditor({ current, defaults }: TerminologyEditorProps) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { isSubmitting, isDirty, errors },
  } = useForm<TerminologyInput>({ defaultValues: current });

  const charterSingular = watch('charter_singular');
  const warehouseSingular = watch('warehouse_singular');

  const onSubmit = handleSubmit(async (values) => {
    const res = await updateTerminologyAction(values);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Labels updated');
    reset(values);
    router.refresh();
  });

  function applyPreset(preset: TerminologyInput) {
    setValue('charter_singular', preset.charter_singular, { shouldDirty: true });
    setValue('charter_plural', preset.charter_plural, { shouldDirty: true });
    setValue('warehouse_singular', preset.warehouse_singular, { shouldDirty: true });
    setValue('warehouse_plural', preset.warehouse_plural, { shouldDirty: true });
  }

  const presets: Array<{ label: string; value: TerminologyInput }> = [
    {
      label: 'Charter / Warehouse',
      value: {
        charter_singular: 'Charter',
        charter_plural: 'Charters',
        warehouse_singular: 'Warehouse',
        warehouse_plural: 'Warehouses',
      },
    },
    {
      label: 'Region / Branch',
      value: {
        charter_singular: 'Region',
        charter_plural: 'Regions',
        warehouse_singular: 'Branch',
        warehouse_plural: 'Branches',
      },
    },
    {
      label: 'Division / Site',
      value: {
        charter_singular: 'Division',
        charter_plural: 'Divisions',
        warehouse_singular: 'Site',
        warehouse_plural: 'Sites',
      },
    },
    {
      label: 'Program / Depot',
      value: {
        charter_singular: 'Program',
        charter_plural: 'Programs',
        warehouse_singular: 'Depot',
        warehouse_plural: 'Depots',
      },
    },
  ];

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Quick presets
        </Label>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.value)}
              className="rounded-full border border-border bg-card px-3 py-1 text-xs hover:bg-muted"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Charter (singular)"
          hint="Top-level grouping. e.g. Charter, Region, Division"
          error={errors.charter_singular?.message}
        >
          <Input {...register('charter_singular', { required: true, maxLength: 40 })} />
        </Field>
        <Field label="Charter (plural)" error={errors.charter_plural?.message}>
          <Input {...register('charter_plural', { required: true, maxLength: 40 })} />
        </Field>
        <Field
          label="Warehouse (singular)"
          hint="Physical location. e.g. Warehouse, Branch, Site"
          error={errors.warehouse_singular?.message}
        >
          <Input {...register('warehouse_singular', { required: true, maxLength: 40 })} />
        </Field>
        <Field label="Warehouse (plural)" error={errors.warehouse_plural?.message}>
          <Input {...register('warehouse_plural', { required: true, maxLength: 40 })} />
        </Field>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
          Preview
        </p>
        <p>
          Items can be earmarked for a{' '}
          <span className="font-medium">{charterSingular?.toLowerCase()}</span> at a specific{' '}
          <span className="font-medium">{warehouseSingular?.toLowerCase()}</span>, or carried as
          generic stock shared across every {charterSingular?.toLowerCase()} the{' '}
          {warehouseSingular?.toLowerCase()} services.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save labels'}
        </Button>
        {isDirty && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => reset(current)}
            disabled={isSubmitting}
          >
            Discard
          </Button>
        )}
        <button
          type="button"
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          onClick={() => applyPreset(defaults)}
        >
          Reset to factory defaults
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && !error && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
