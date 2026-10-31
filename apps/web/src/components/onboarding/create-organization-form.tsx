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

import {
  createOrganizationSchema,
  type CreateOrganizationInput,
  CreateOrganizationFormInput,
  isStorableOrgTimezone,
} from '@stockpilot/core';

// A native select drawn like the shared Input on these external forms: the
// stronger hairline, 40 px on desktop, and 44 px with 16 px text below sm.
const SELECT_CLASS =
  'bg-card focus-visible:ring-ring focus-visible:ring-offset-background flex h-10 w-full rounded-md border border-line-strong px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:h-11 max-sm:text-base';

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
  // The creator's browser zone, offered only when the create check would take
  // it (B41: a zone the app and the Book Order Totals report both use); else
  // UTC, so the box never starts on a value it would refuse.
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationFormInput, unknown, CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: {
      name: '',
      timezone: isStorableOrgTimezone(browserZone) ? browserZone : 'UTC',
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
          className="sm:h-10"
          {...register('name')}
          aria-invalid={!!errors.name}
        />
        {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="industry">Industry</Label>
          <select id="industry" {...register('industry')} className={SELECT_CLASS}>
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
          <select id="size" {...register('size')} className={SELECT_CLASS}>
            <option value="">Select…</option>
            <option value="1">Just me</option>
            <option value="2-5">2-5</option>
            <option value="6-25">6-25</option>
            <option value="26-100">26-100</option>
            <option value="100+">100+</option>
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="timezone">Timezone</Label>
          <Input
            id="timezone"
            className="sm:h-10"
            {...register('timezone')}
            aria-invalid={!!errors.timezone}
          />
          {errors.timezone && <p className="text-destructive text-xs">{errors.timezone.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Input id="currency" maxLength={3} className="sm:h-10" {...register('currency')} />
        </div>
      </div>

      <Button
        type="submit"
        className="h-11 w-full text-[14px]"
        variant="gradient"
        size="lg"
        disabled={isSubmitting}
      >
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create workspace'}
      </Button>
    </form>
  );
}
