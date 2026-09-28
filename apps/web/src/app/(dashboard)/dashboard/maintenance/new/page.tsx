import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { Button } from '@/components/ui/button';
import { reportError } from '@/lib/error-reporter';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import { ChartersService } from '@/server/services/charters';
import { ExceptionOccurrencesService, type ExceptionOccurrence } from '@/server/services/exception-occurrences';

import {
  can,
  escalateDisabledReason,
  ESCALATE_TO_MAINTENANCE_HELP,
  ESCALATE_TO_MAINTENANCE_LABEL,
  ESCALATION_EXCEPTION_UNAVAILABLE_COPY,
  ESCALATION_FORM_NOTE_COPY,
  escalationOpenRequestLabel,
  escalationPrefill,
  EXCEPTION_RULES,
  MAINTENANCE_CATEGORIES,
  uuidSchema,
  type MaintenanceRequestFormValues,
} from '@stockpilot/core';

import { EscalateRequestClient } from './escalate-request-client';
import { NewMaintenanceRequestClient } from './new-request-client';

export const dynamic = 'force-dynamic';

function readUuidParam(value: string | undefined): string | undefined {
  return value && uuidSchema.safeParse(value).success ? value : undefined;
}

/**
 * The org's configured categories, or the default twelve.
 *
 * Org-configured categories live in organization_modules.settings, the same
 * unconstrained-jsonb reader convention as the mint route's
 * shareLinksEnabled() (api/v1/maintenance-requests/[id]/route.ts) — an absent
 * row/key both mean "never configured", falling back to the brief section 7
 * default twelve.
 */
async function readCategories(ctx: ServiceContext): Promise<string[]> {
  const settingsRow = await ctx.supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'maintenance_requests')
    .maybeSingle();
  const configuredCategories = (settingsRow.data as { settings?: { categories?: unknown } } | null)?.settings
    ?.categories;
  return Array.isArray(configuredCategories) &&
    configuredCategories.length > 0 &&
    configuredCategories.every((c) => typeof c === 'string')
    ? (configuredCategories as string[])
    : [...MAINTENANCE_CATEGORIES];
}

export default async function NewMaintenanceRequestPage({
  searchParams,
}: {
  searchParams: Promise<{
    itemId?: string;
    orderRequestId?: string;
    rentalId?: string;
    charterId?: string;
    locationId?: string;
    subject?: string;
    /** F1-5: escalate this exception (the form saves a linked request). */
    exceptionOccurrenceId?: string;
  }>;
}) {
  const access = await checkModuleAccess('maintenance_requests');
  if (!access.enabled) return <ModuleNotEnabled moduleId="maintenance_requests" canManage={access.canManage} />;

  const ctx = await withContext();
  if (!can(ctx, 'maintenance_requests:submit')) {
    redirect('/dashboard/maintenance');
  }

  const sp = await searchParams;

  // Escalating an exception (F1-5) is its own form: never a plain request
  // with the exception's ids copied into it. A malformed id is a 404, not a
  // silent fall back to an unlinked request.
  if (sp.exceptionOccurrenceId !== undefined) {
    const occurrenceId = readUuidParam(sp.exceptionOccurrenceId);
    if (!occurrenceId) notFound();
    return escalationPage(ctx, occurrenceId);
  }

  const [charters, categories, assignmentRow] = await Promise.all([
    new ChartersService(ctx).list(),
    readCategories(ctx),
    // The employee's own site (brief section 7 — "site defaults from the
    // employee's own profile/site when known"). uwa_select_own RLS (0140)
    // lets any member read their OWN assignment rows; is_primary desc picks
    // the flagged row, or the first assignment if none is flagged.
    ctx.supabase
      .from('user_warehouse_assignments')
      .select('charter_id, warehouse_id, is_primary')
      .eq('organization_id', ctx.organizationId)
      .eq('user_id', ctx.userId)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const sites = charters.map((c) => ({ id: c.id, name: c.name }));

  const assignment = assignmentRow.data as { charter_id: string | null; warehouse_id: string | null } | null;
  const launchCharterId = readUuidParam(sp.charterId);
  // Every related id is a deep-link HINT: create() re-derives each against
  // this organization and drops one that does not belong to it.
  const defaults: Partial<MaintenanceRequestFormValues> = {
    subject: sp.subject?.trim().slice(0, 120) || undefined,
    charterId: launchCharterId ?? assignment?.charter_id ?? undefined,
    warehouseId: assignment?.warehouse_id ?? undefined,
    relatedItemId: readUuidParam(sp.itemId),
    relatedOrderRequestId: readUuidParam(sp.orderRequestId),
    relatedRentalId: readUuidParam(sp.rentalId),
    relatedLocationId: readUuidParam(sp.locationId),
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/maintenance" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to maintenance requests
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New maintenance request</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the issue and StockPilot will prepare an email to the maintenance team on the next screen.
        </p>
      </div>

      <NewMaintenanceRequestClient defaults={defaults} sites={sites} categories={categories} />
    </div>
  );
}

/**
 * ESCALATE AN EXCEPTION TO MAINTENANCE (F1-5).
 *
 * The request form, prefilled from the exception (core escalationPrefill: a
 * subject naming the item and SKU, a description with what is wrong, where,
 * and the EX reference; no person, no cost, no link). It shows only the
 * fields an escalation saves; the item and the location come from the
 * exception on the server, whatever the form sends. Saving goes through
 * escalateExceptionAction, which saves ONE maintenance request linked to the
 * exception and lands on the request's review screen (?review=1), where the
 * email opens only when the person taps it.
 *
 * The exception is read through the reader's own client
 * (ExceptionOccurrencesService.get): not found and not visible are the same
 * 404; a failed read offers no form (a plain request would not be linked);
 * an exception the server says cannot be escalated (resolved, or already
 * escalated to a request that is not cancelled) says why, and an already
 * escalated one offers to open its request to a reader who can open it.
 *
 * Awaited by the page itself (a plain async function, not an async child
 * component), so the page resolves to its finished markup.
 */
async function escalationPage(ctx: ServiceContext, occurrenceId: string) {
  const [read, categories] = await Promise.all([
    new ExceptionOccurrencesService(ctx).get(occurrenceId).then(
      (detail) => ({ ok: true as const, occurrence: detail.occurrence }),
      (e: unknown) => ({ ok: false as const, error: e }),
    ),
    readCategories(ctx),
  ]);
  if (!read.ok) {
    const e = read.error;
    if (e instanceof ServiceError && (e.code === 'not_found' || e.code === 'forbidden')) notFound();
    void reportError(e, { tag: 'maintenance.escalate_form_read' });
  }
  const occurrence = read.ok ? read.occurrence : null;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href={`/dashboard/exceptions/${occurrenceId}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to the exception
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{ESCALATE_TO_MAINTENANCE_LABEL}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{ESCALATE_TO_MAINTENANCE_HELP}</p>
      </div>

      {occurrence === null ? (
        <p
          role="alert"
          className="border-warning/40 bg-warning/5 rounded-md border px-3 py-2 text-sm"
          data-testid="escalation-unavailable"
        >
          {ESCALATION_EXCEPTION_UNAVAILABLE_COPY}
        </p>
      ) : occurrence.canEscalate ? (
        <>
          <LinkedException occurrence={occurrence} />
          <EscalateRequestClient
            occurrenceId={occurrence.id}
            defaults={escalationDefaults(occurrence, categories)}
            categories={categories}
          />
        </>
      ) : (
        <NotEscalatable occurrence={occurrence} />
      )}
    </div>
  );
}

/** The form's prefill. The suggested category only when this organization's
 *  list has it (the Select shows nothing for a value it does not list). */
function escalationDefaults(o: ExceptionOccurrence, categories: string[]): Partial<MaintenanceRequestFormValues> {
  const prefill = escalationPrefill({
    rule: o.rule,
    facts: o.facts,
    itemName: o.item?.name ?? null,
    sku: o.item?.sku ?? null,
    locationName: o.location?.name ?? null,
    reference: o.reference,
    conditionSince: o.conditionSince,
  });
  return {
    subject: prefill.subject,
    description: prefill.description,
    priority: 'normal',
    ...(categories.includes(prefill.category) ? { category: prefill.category } : {}),
  };
}

/** What the request will be linked to: the exception, its item and, for a
 *  condition at a location, that location (the server takes both from the
 *  exception). */
function LinkedException({ occurrence: o }: { occurrence: ExceptionOccurrence }) {
  return (
    <section
      aria-label="Linked exception"
      className="bg-muted/40 mb-6 rounded-md border p-3 text-sm"
      data-testid="escalation-linked-exception"
    >
      <p className="font-medium">
        {o.reference ? <span className="font-mono">{o.reference}</span> : 'Exception'}
        <span className="text-muted-foreground"> · {EXCEPTION_RULES[o.rule].label}</span>
      </p>
      <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[6rem_1fr]">
        {o.item ? (
          <>
            <dt className="text-muted-foreground">Item</dt>
            <dd className="break-words">
              {o.item.name}
              {o.item.sku ? <span className="text-muted-foreground font-mono"> ({o.item.sku})</span> : null}
            </dd>
          </>
        ) : null}
        {o.location ? (
          <>
            <dt className="text-muted-foreground">Location</dt>
            <dd className="break-words">{o.location.name}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-muted-foreground mt-2">{ESCALATION_FORM_NOTE_COPY}</p>
    </section>
  );
}

/** Why this exception cannot be escalated now. An exception already escalated
 *  to a request the reader can open offers that request instead. */
function NotEscalatable({ occurrence: o }: { occurrence: ExceptionOccurrence }) {
  const e = o.escalation;
  const reason = escalateDisabledReason({
    reason: o.escalateUnavailableReason,
    reference: e?.reference ?? null,
    online: true,
  });
  const openHref =
    o.escalateUnavailableReason === 'already_escalated' && e?.requestId && e.visibleToReader === true
      ? `/dashboard/maintenance/${e.requestId}`
      : null;
  return (
    <div className="space-y-3 rounded-md border p-4 text-sm" data-testid="escalation-not-available">
      <p>{reason}</p>
      {openHref ? (
        <Button asChild variant="outline" size="sm">
          <Link href={openHref}>{escalationOpenRequestLabel(e?.reference ?? null)}</Link>
        </Button>
      ) : null}
    </div>
  );
}
