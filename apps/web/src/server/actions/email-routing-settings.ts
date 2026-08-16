'use server';

import { revalidatePath } from 'next/cache';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import {
  brandDeliveryRecipients,
  brandMaintenanceRecipients,
  can,
  err,
  ok,
  ORG_EMAIL_ROUTING_FEATURES,
  type ActionResult,
  type OrgEmailRoutingFeature,
  type OrgEmailRoutingRecipientsDto,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Per-org compose-email routing (organizations.email_routing, migration
// 0337): validate THROUGH THE SAME branded factories every reader runs →
// withContext (honor org MFA policy) → MFA gate (fail CLOSED) →
// organization:update gate (matches the RLS floor: organizations_update =
// admin) → MERGE into the jsonb (never clobber the other feature's key) →
// 0-row-update fails CLOSED (pattern #22: .update().eq() "succeeds" with 0
// rows under RLS) → audit → revalidate.
//
// STEP-UP: the settings panel prompts TOTP via useStepUp() before calling
// this — that modal is UX; the `mfaRequired && !mfaSatisfied` check below is
// the guarantee (the inventory-cleanup action's exact posture). Rerouting
// warehouse mail is the highest-value write this panel exposes: a hijacked
// admin session could silently divert every delivery/maintenance request —
// requester names and emails included — to an attacker mailbox, and the
// failure would be invisible because mail "still sends".
//
// REJECT AT WRITE TIME WHAT WOULD FAIL AT READ TIME: a value is saved only
// if the reader-side factory accepts it, and the guard messages surface
// verbatim as the error so the admin sees the same words the read path
// would log. DB state 'invalid' therefore only ever arises from
// out-of-band PostgREST writes, which the fail-closed read path already
// covers.
// ---------------------------------------------------------------------------

export interface EmailRoutingRecipientsInput {
  to: string;
  cc: string;
  toName?: string;
  ccName?: string;
}

export interface SetOrgEmailRoutingInput {
  feature: OrgEmailRoutingFeature;
  /** null clears the feature's routing — the email action hides for the org. */
  recipients: EmailRoutingRecipientsInput | null;
}

/** Trim every field; empty display names become "absent" rather than being
 *  stored as '' (the factory would reject nothing about '', but an empty
 *  chip name is noise the compose url should simply not carry). */
function normalize(input: EmailRoutingRecipientsInput): OrgEmailRoutingRecipientsDto {
  const dto: OrgEmailRoutingRecipientsDto = {
    to: input.to.trim(),
    cc: input.cc.trim(),
  };
  const toName = typeof input.toName === 'string' ? input.toName.trim() : '';
  const ccName = typeof input.ccName === 'string' ? input.ccName.trim() : '';
  if (toName) dto.toName = toName;
  if (ccName) dto.ccName = ccName;
  return dto;
}

export async function setOrgEmailRoutingAction(
  input: SetOrgEmailRoutingInput,
): Promise<ActionResult<{ feature: OrgEmailRoutingFeature; recipients: OrgEmailRoutingRecipientsDto | null }>> {
  if (!ORG_EMAIL_ROUTING_FEATURES.includes(input.feature)) {
    return err('validation_error', 'Unknown email-routing feature.');
  }

  // Validate BEFORE any I/O, through the exact factory the read path runs —
  // never a parallel schema that could drift from the real acceptance gate.
  let recipients: OrgEmailRoutingRecipientsDto | null = null;
  if (input.recipients !== null) {
    if (
      typeof input.recipients !== 'object' ||
      typeof input.recipients.to !== 'string' ||
      typeof input.recipients.cc !== 'string'
    ) {
      return err('validation_error', 'Both a To and a CC address are required.');
    }
    recipients = normalize(input.recipients);
    try {
      if (input.feature === 'delivery_request') {
        brandDeliveryRecipients(recipients);
      } else {
        brandMaintenanceRecipients(recipients);
      }
    } catch (e) {
      // The guard's message, verbatim — the admin sees the same words the
      // read path would have logged for this value.
      return err('validation_error', e instanceof Error ? e.message : 'Invalid recipients.');
    }
  }

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    // organization:update mirrors the RLS floor exactly (organizations_update
    // = admin role); no new permission and no 0207 pgTAP count bump.
    if (!can(ctx, 'organization:update')) {
      return err('forbidden', 'You do not have permission to configure email routing.');
    }

    const supabase = ctx.supabase;

    // MERGE into the column (never clobber the sibling feature's key).
    const { data: existing, error: readError } = await supabase
      .from('organizations')
      .select('email_routing')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    if (readError) throw new ServiceError('internal_error', readError.message);

    const prevRaw = (existing as { email_routing?: unknown } | null)?.email_routing;
    const prev =
      prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
        ? (prevRaw as Record<string, unknown>)
        : {};
    const next: Record<string, unknown> = { ...prev };
    if (recipients === null) {
      delete next[input.feature];
    } else {
      next[input.feature] = recipients;
    }
    const nextValue = Object.keys(next).length > 0 ? next : null;

    const { data: updated, error } = await supabase
      .from('organizations')
      .update({ email_routing: nextValue })
      .eq('id', ctx.organizationId)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail CLOSED on a 0-row update (pattern #22): under RLS a non-admin's
    // update "succeeds" with 0 rows — the permission gate above should make
    // this unreachable, but the write proof is the returned row, not the
    // absence of an error.
    if (!updated) {
      throw new ServiceError('forbidden', 'Your role cannot update this organization.');
    }

    await audit({
      event: 'email_routing.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      // The addresses are printed in the email UI to every member — they are
      // not secrets, and the audit row is what makes a silent reroute
      // reconstructable after the fact.
      after: { feature: input.feature, recipients },
    });

    revalidatePath('/dashboard/settings/email-routing');
    return ok({ feature: input.feature, recipients });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
