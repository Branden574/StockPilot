'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import {
  maintenanceRequestFormSchema,
  MAINTENANCE_PRIORITIES,
  type MaintenanceRequestFormValues,
} from '@stockpilot/core';
import { createMaintenanceRequestAction } from '@/server/actions/maintenance-requests';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Props {
  /** Launch-point prefill (site, related record, subject) — never contact
   *  identity. The service ignores any client-supplied requester name/email
   *  regardless of what this object carries (brief section 7 / Task 8). */
  defaults: Partial<MaintenanceRequestFormValues>;
  /** Charters — the house sites-only picker (brief section 28). */
  sites: { id: string; name: string }[];
  /** Org-configured categories, or the default twelve — NEVER hand-typed
   *  here; this component only ever maps the prop it is given. */
  categories: string[];
  onSaved: (id: string) => void;
}

const PRIORITY_LABELS: Record<(typeof MAINTENANCE_PRIORITIES)[number], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export function MaintenanceRequestForm({ defaults, sites, categories, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const form = useForm<MaintenanceRequestFormValues>({
    resolver: zodResolver(maintenanceRequestFormSchema),
    defaultValues: { priority: 'normal', ...defaults },
  });
  const priority = form.watch('priority');
  // C8 (plan): related-record prefill is launch-point only in phase 1 — no
  // in-form picker. The banner just discloses that a link is carried along;
  // it never claims to auto-send anything (brief section 20).
  const hasLinkedRecord = Boolean(
    defaults.relatedItemId || defaults.relatedOrderRequestId || defaults.relatedRentalId,
  );

  async function onSubmit(values: MaintenanceRequestFormValues) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await createMaintenanceRequestAction(values);
      if ('error' in res) {
        // Task 8 ledger: the action's ActionResult drops the ServiceError
        // CODE and returns only a message string — surface it faithfully
        // rather than inventing code-based branching that cannot work here.
        toast.error(res.error.message);
        return;
      }
      onSaved(res.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
      <div className="space-y-2">
        <Label htmlFor="mr-subject">What is the issue?</Label>
        <Input
          id="mr-subject"
          placeholder="Example: Air conditioner is not working in Room 204"
          {...form.register('subject')}
        />
        {form.formState.errors.subject ? (
          <p className="text-sm text-destructive">{form.formState.errors.subject.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="mr-description">Describe the maintenance issue</Label>
        <p className="text-sm text-muted-foreground">
          Explain what is happening, when it started, and anything the maintenance team should know before arriving.
        </p>
        <Textarea id="mr-description" rows={6} {...form.register('description')} />
        {form.formState.errors.description ? (
          <p className="text-sm text-destructive">{form.formState.errors.description.message}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="mr-site">Site</Label>
          {/*
           * A plain native <select>, not the Radix-based Select used below
           * for Category/Priority. Radix's Select always mounts a second,
           * screen-reader-only <select><option> "bubble" for native form
           * association whenever its trigger sits inside a real <form>
           * element (@radix-ui/react-select 2.2.6, select.tsx:75 —
           * `isFormControl = trigger ? form || !!trigger.closest('form') :
           * true`), and that bubble's option text duplicates the visible
           * trigger's text exactly. `getByRole` queries (used by the
           * Category/Priority tests below) correctly ignore that
           * aria-hidden duplicate, but this field is asserted with a plain
           * `getByText`, which does not — a Radix Select here would make
           * "site defaults from the provided default charter" match twice
           * and fail with "multiple elements found". A native select has
           * no such shadow node, keeps identical value/onChange semantics,
           * and needs no dropdown-interaction affordance this field never
           * exercises in the first place.
           */}
          <select
            id="mr-site"
            value={form.watch('charterId') ?? ''}
            onChange={(e) => form.setValue('charterId', e.target.value || null)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm transition-colors sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <option value="">Select a site</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-category">Category</Label>
          <Select value={form.watch('category') ?? ''} onValueChange={(v) => form.setValue('category', v || null)}>
            <SelectTrigger id="mr-category">
              <SelectValue placeholder="Select a category" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-priority">Priority</Label>
          <Select
            value={priority}
            onValueChange={(v) => form.setValue('priority', v as MaintenanceRequestFormValues['priority'])}
          >
            <SelectTrigger id="mr-priority" aria-label="Priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAINTENANCE_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {priority === 'urgent' ? (
            <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
              For emergencies that put people in danger, follow your site emergency procedures first. StockPilot does
              not replace them.
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-phone">Contact phone (optional)</Label>
          <Input id="mr-phone" {...form.register('requesterPhone')} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="mr-building">Building</Label>
          <Input id="mr-building" placeholder="Main building" {...form.register('building')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-room">Room or area</Label>
          <Input id="mr-room" placeholder="Room 204" {...form.register('roomOrArea')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-department">Department</Label>
          <Input id="mr-department" {...form.register('department')} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mr-access">Additional access instructions</Label>
        <Textarea id="mr-access" rows={2} {...form.register('accessInstructions')} />
      </div>

      {hasLinkedRecord ? (
        <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          {/* M3: this banner only reflects what was LAUNCHED WITH, never
              what the server actually kept — create() re-derives the id
              against this org (resolveRelatedId) and silently drops it to
              null on a mismatch, so an unconditional "will be included"
              promise here can be wrong. "If it matches" makes that
              possibility explicit instead of guaranteeing an attach the
              server may not perform. */}
          A related StockPilot record was pre-filled. If it matches a record in your organization, it will be
          included in the email automatically.
        </p>
      ) : null}

      <Button type="submit" disabled={busy}>
        {busy ? 'Saving...' : 'Save request'}
      </Button>
    </form>
  );
}
