'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateTerminologyAction, type TerminologyInput } from '@/server/actions/organization';

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
    toast.success('Labels updated.');
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
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
          Quick presets
        </p>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.value)}
              className="border-line-strong bg-card text-ink-2 hover:bg-muted hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-7 items-center rounded-full border px-3 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:h-11"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="term-charter-singular"
          label="Charter (singular)"
          hint="Top-level grouping. e.g. Charter, Region, Division"
          error={errors.charter_singular?.message}
        >
          <Input
            id="term-charter-singular"
            {...register('charter_singular', { required: true, maxLength: 40 })}
          />
        </Field>
        <Field
          id="term-charter-plural"
          label="Charter (plural)"
          error={errors.charter_plural?.message}
        >
          <Input
            id="term-charter-plural"
            {...register('charter_plural', { required: true, maxLength: 40 })}
          />
        </Field>
        <Field
          id="term-warehouse-singular"
          label="Warehouse (singular)"
          hint="Physical location. e.g. Warehouse, Branch, Site"
          error={errors.warehouse_singular?.message}
        >
          <Input
            id="term-warehouse-singular"
            {...register('warehouse_singular', { required: true, maxLength: 40 })}
          />
        </Field>
        <Field
          id="term-warehouse-plural"
          label="Warehouse (plural)"
          error={errors.warehouse_plural?.message}
        >
          <Input
            id="term-warehouse-plural"
            {...register('warehouse_plural', { required: true, maxLength: 40 })}
          />
        </Field>
      </div>

      <div className="bg-sunk rounded-lg border p-4 text-[13px]">
        <p className="text-muted-foreground mb-2 text-[11px] font-medium uppercase tracking-[0.06em]">
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

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Save labels
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground ml-auto"
          onClick={() => applyPreset(defaults)}
        >
          Reset to factory defaults
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  /** The input's id, so the label names it (it named nothing before). */
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-muted-foreground text-[12px]">{hint}</p>}
      {error && <p className="text-destructive text-[12px]">{error}</p>}
    </div>
  );
}
