'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createOrgForCustomerAction } from '@/server/actions/platform-admin';

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'Pacific/Honolulu',
  'America/Anchorage',
  'UTC',
];

export function CreateOrgForForm() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState({
    email: '',
    name: '',
    slug: '',
    timezone: 'America/Los_Angeles',
    industry: '',
    size: '',
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await createOrgForCustomerAction({
        email: form.email,
        name: form.name,
        slug: form.slug || undefined,
        timezone: form.timezone,
        industry: form.industry || null,
        size: form.size || null,
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success(
        `Created "${form.name}". Magic-link invite sent to ${form.email}.`,
      );
      router.push('/dashboard/admin');
    });
  };

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="email">Customer email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="off"
          placeholder="founder@acmecharter.org"
          value={form.email}
          onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
        />
        <p className="text-muted-foreground text-xs">
          Supabase will send them a magic-link invite to this address.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="name">Organization name</Label>
        <Input
          id="name"
          name="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="Acme Charter Schools"
          value={form.name}
          onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="slug">URL slug (optional)</Label>
        <Input
          id="slug"
          name="slug"
          pattern="[a-z0-9\-]+"
          minLength={2}
          maxLength={60}
          placeholder="acme-charter (auto from name if blank)"
          value={form.slug}
          onChange={(e) => setForm((s) => ({ ...s, slug: e.target.value }))}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="timezone">Timezone</Label>
          <select
            id="timezone"
            name="timezone"
            className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
            value={form.timezone}
            onChange={(e) => setForm((s) => ({ ...s, timezone: e.target.value }))}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="size">Size (optional)</Label>
          <Input
            id="size"
            name="size"
            maxLength={32}
            placeholder="1-10, 11-50, etc."
            value={form.size}
            onChange={(e) => setForm((s) => ({ ...s, size: e.target.value }))}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="industry">Industry (optional)</Label>
        <Input
          id="industry"
          name="industry"
          maxLength={64}
          placeholder="Education"
          value={form.industry}
          onChange={(e) => setForm((s) => ({ ...s, industry: e.target.value }))}
        />
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Provisioning…
            </>
          ) : (
            'Create org + send invite'
          )}
        </Button>
      </div>
    </form>
  );
}
