'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import {
  DASHBOARD_WIDGETS,
  err,
  ok,
  type ActionResult,
  type DashboardLayout,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Server-side validation — AUTHORITATIVE.
//
// Mirrors the nav-settings / module-settings actions. The client editor only
// emits known widget ids in a sensible order, but the server is the trust
// boundary: it drops any id NOT in the DASHBOARD_WIDGETS catalog, de-dupes,
// and caps the list size. `null` clears the layout (Reset to default → the
// dashboard falls back to `resolveDashboardWidgets(null, …)` = catalog order).
//
// Unlike nav-settings (which REJECTS unknown payloads outright), the dashboard
// layout is sanitized in place: unknown widget ids are silently DROPPED rather
// than failing the whole save. This matches `resolveDashboardWidgets`, which
// also drops unknown ids at render time — so a stale layout (e.g. a widget that
// was retired) never blocks a save. The widget ids are an internal catalog, not
// user-authored free text, so there is nothing meaningful to surface back.
// ---------------------------------------------------------------------------

const KNOWN_WIDGET_IDS: ReadonlySet<string> = new Set(DASHBOARD_WIDGETS.map((w) => w.id));
// The layout can hold at most one entry per catalog widget; cap defensively a
// little above the catalog size so a forward-compatible client (sending a
// not-yet-shipped id we then drop) is never rejected purely on length.
const MAX_WIDGETS = DASHBOARD_WIDGETS.length + 16;

const widgetSchema = z.object({
  id: z.string().min(1).max(64),
  hidden: z.boolean().optional(),
});

const layoutSchema = z.object({
  v: z.literal(1),
  widgets: z.array(widgetSchema).max(MAX_WIDGETS),
});

/**
 * Persist (or clear) the org's dashboard widget layout. Mirrors the
 * module-settings / nav-settings actions EXACTLY: `withContext()` (so the org
 * MFA policy is honored) → MFA gate (fail CLOSED) → owner/admin gate →
 * validate + sanitize → write → audit → revalidate.
 *
 * `layout === null` resets the org to the default catalog widget layout.
 */
export async function setDashboardLayoutAction(
  layout: DashboardLayout | null,
): Promise<ActionResult<{ dashboardLayout: DashboardLayout | null }>> {
  // Validate + sanitize BEFORE touching context so a malformed payload is cheap
  // to reject. `null` is the explicit reset signal and is always allowed
  // (subject to the auth gates below).
  let value: DashboardLayout | null = null;
  if (layout !== null && layout !== undefined) {
    const parsed = layoutSchema.safeParse(layout);
    if (!parsed.success) {
      return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid dashboard layout.');
    }
    // Drop unknown widget ids and de-dupe (first occurrence wins). The result
    // is exactly what `resolveDashboardWidgets` would honor, so what the editor
    // shows is what the dashboard renders.
    const seen = new Set<string>();
    const widgets: DashboardLayout['widgets'] = [];
    for (const w of parsed.data.widgets) {
      if (!KNOWN_WIDGET_IDS.has(w.id)) continue;
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      widgets.push(w.hidden === true ? { id: w.id, hidden: true } : { id: w.id });
    }
    value = { v: 1, widgets };
  }

  try {
    // `withContext()` (not `requireOrgContext()`) so the org's MFA policy is
    // honored — editing the org-wide dashboard layout is a privileged org
    // mutation that must ride the same MFA gate `assertPermission` enforces
    // inside services. Fail CLOSED for an AAL1 session in an mfa-required org.
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can customize the dashboard.');
    }

    const supabase = ctx.supabase;
    const { error } = await supabase
      .from('organizations')
      .update({ dashboard_layout: value })
      .eq('id', ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'dashboard_layout.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      after: { dashboardLayout: value },
    });

    revalidatePath('/dashboard', 'layout');
    revalidatePath('/dashboard/settings/dashboard');

    return ok({ dashboardLayout: value });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
