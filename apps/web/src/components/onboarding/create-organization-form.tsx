'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createOrganizationAction } from '@/server/actions/organization';

import { createOrganizationSchema, type CreateOrganizationInput } from '@stockpilot/core';

const INDUSTRIES = [
  'Ecommerce',
  'Retail',
  'Warehouse / 3PL',
  'Field service',
  'Manufacturing',
  'Construction',
  'Education',
  'Nonprofit',
  'Medical / Dental',
  'Auto / Detailing',
  'Other',
];

export function CreateOrganizationForm() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: {
      name: '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      currency: 'USD',
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    const res = await createOrganizationAction(values);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Workspace created.');
    router.replace('/dashboard');
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <Label htmlFor="name">Workspace name</Label>
        <Input
          id="name"
          placeholder="Acme Co."
          autoComplete="organization"
          {...register('name')}
          aria-invalid={!!errors.name}
        />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="industry">Industry</Label>
          <select
            id="industry"
            {...register('industry')}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Select…</option>
            {INDUSTRIES.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="size">Team size</Label>
          <select
            id="size"
            {...register('size')}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Select…</option>
            <option value="1">Just me</option>
            <option value="2-5">2-5</option>
            <option value="6-25">6-25</option>
            <option value="26-100">26-100</option>
            <option value="100+">100+</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="timezone">Timezone</Label>
          <Input id="timezone" {...register('timezone')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Input id="currency" maxLength={3} {...register('currency')} />
        </div>
      </div>

      <Button type="submit" className="w-full" variant="gradient" size="lg" disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create workspace'}
      </Button>
    </form>
  );
}
