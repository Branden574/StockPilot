'use server';

import { z } from 'zod';

import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import {
  PASSKEYS_CONFIRM_WORD,
  PASSKEYS_COPY,
  type PlatformPasskeySetting,
} from '@/lib/platform/passkeys-console';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { actionErrorResult, NOT_SET_UP_MESSAGE } from '@/server/lib/action-error-result';
import { recordPlatformAudit } from '@/server/services/platform/audit';
import { countOrganizationPasskeyHolders } from '@/server/services/platform/passkey-switches';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * THE PLATFORM CONSOLE'S PASSKEY SWITCHES (part 2, plan 2.6 H). Every passkey
 * piece is built and dark; these three actions are how a platform admin turns
 * it on, and nothing else ever does:
 *   - setPasskeysKillSwitchAction: platform_settings.passkeys_on, the kill
 *     switch ("Passkeys for everyone"). Off: no passkey step is offered or
 *     accepted anywhere and none can be added.
 *   - setNewPasskeysSwitchAction: platform_settings.passkey_adds_on, "new
 *     passkeys" (review U6). Off: none can be added; existing ones keep working.
 *   - setOrganizationPasskeysAction: a row in organization_passkey_switches.
 *     A member may add a passkey only when every organization they belong to
 *     has one.
 * All start OFF (0475's defaults; no settings row is off).
 *
 * The order of every press:
 *   1. checkPlatformAdmin({ requireStepUp: true }), first: an allowlisted,
 *      verified account on a session whose authenticator code is fresh, and
 *      no passkey bridge (rule 21). A refusal reads and writes nothing; a
 *      stale step-up answers details.reason 'aal2_required', which is what
 *      lets useStepUp() ask for the code in place and press again.
 *   2. The input, then the typed word PASSKEYS, compared exactly.
 *   3. The current state, read (a failed read refuses; it is never "off").
 *      A press that changes nothing writes nothing and records nothing.
 *   4. The platform_admin_audit row FIRST: passkeys_switched (detail
 *      { setting, from, to }) or org_passkeys_switched (target organization,
 *      detail { from, to }), the actor's email the one Auth verified (the
 *      gate's verifiedEmail, never the profile column). When it does not land,
 *      the press is refused and NOTHING is switched, ON or OFF: a switch never
 *      changes without its record. (Until the migration adding these two
 *      words to platform_admin_audit's check is live, every press is refused
 *      this way.)
 *   5. The write: an UPSERT of the one platform_settings row with only this
 *      column (the row may not exist in production, review F; an upsert
 *      leaves the other settings and the deletion passphrase as they are), or
 *      the organization's switch row inserted or deleted (service_role has
 *      select, insert and delete on that table, no update). A write that
 *      fails after its record landed is refused, and a second row with the
 *      same words and detail not_applied: true says the first did not happen
 *      (best effort: when that row fails too, it is reported).
 *   6. An organization turned off (or already off) answers how many of its
 *      members still hold an active passkey (null when that cannot be read).
 *
 * Two admins pressing at the same moment: each reads, records, then writes;
 * the switch ends in the state of the last write. An organization's second
 * insert is a unique violation: answered "already on", with its record marked
 * not_applied.
 */

export interface PasskeySwitchSaved {
  /** The switch's state now. */
  on: boolean;
  /** False when it already was in that state (nothing written, nothing recorded). */
  changed: boolean;
}

export interface OrganizationPasskeysSaved extends PasskeySwitchSaved {
  /**
   * Turned off, or already off: the organization's members who still hold an
   * active passkey. Null when that could not be counted. Absent when on.
   */
  membersWithPasskeys?: number | null;
}

/** Who pressed: the account id and the email Auth verified for this request. */
interface Actor {
  userId: string;
  email: string;
}

const switchSchema = z.object({
  on: z.boolean(),
  confirm: z.string().max(200),
});

const organizationSchema = switchSchema.extend({
  organizationId: z.string().uuid(),
});

function actorOf(gate: { session: { userId: string }; verifiedEmail: string }): Actor {
  return { userId: gate.session.userId, email: gate.verifiedEmail };
}

function gateRefusal(reason: 'forbidden' | 'aal2_required'): ActionResult<never> {
  return reason === 'aal2_required'
    ? err('forbidden', PASSKEYS_COPY.stepUp, { reason: 'aal2_required' })
    : err('forbidden', PASSKEYS_COPY.notAuthorized);
}

/** The input parsed and the word checked, or the refusal. */
function confirmed<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; result: ActionResult<never> } {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, result: err('validation_error', PASSKEYS_COPY.invalid) };
  if ((parsed.data as { confirm: string }).confirm !== PASSKEYS_CONFIRM_WORD) {
    return { ok: false, result: err('validation_error', PASSKEYS_COPY.wrongWord) };
  }
  return { ok: true, data: parsed.data };
}

function adminClient(
  tag: string,
):
  | { ok: true; admin: ReturnType<typeof createAdminClient> }
  | { ok: false; result: ActionResult<never> } {
  try {
    return { ok: true, admin: createAdminClient() };
  } catch (e) {
    return {
      ok: false,
      result: actionErrorResult(e, tag, { message: NOT_SET_UP_MESSAGE, level: 'warning' }),
    };
  }
}

/** Turn the platform-wide kill switch (platform_settings.passkeys_on) on or off. */
export async function setPasskeysKillSwitchAction(input: {
  on: boolean;
  confirm: string;
}): Promise<ActionResult<PasskeySwitchSaved>> {
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) return gateRefusal(gate.reason);
  return setPlatformSwitch(actorOf(gate), 'passkeys_on', input);
}

/** Turn the platform-wide "new passkeys" switch (platform_settings.passkey_adds_on) on or off. */
export async function setNewPasskeysSwitchAction(input: {
  on: boolean;
  confirm: string;
}): Promise<ActionResult<PasskeySwitchSaved>> {
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) return gateRefusal(gate.reason);
  return setPlatformSwitch(actorOf(gate), 'passkey_adds_on', input);
}

async function setPlatformSwitch(
  actor: Actor,
  setting: PlatformPasskeySetting,
  input: unknown,
): Promise<ActionResult<PasskeySwitchSaved>> {
  const tag = `actions.platform.passkeys.${setting}`;
  const checked = confirmed(switchSchema, input);
  if (!checked.ok) return checked.result;
  const on = checked.data.on;
  const client = adminClient(tag);
  if (!client.ok) return client.result;
  const admin = client.admin;

  const read = await admin
    .from('platform_settings')
    .select('passkeys_on, passkey_adds_on')
    .eq('id', true)
    .maybeSingle();
  if (read.error) {
    await reportError(new Error(read.error.message), { tag: `${tag}.read` });
    return err('internal_error', PASSKEYS_COPY.readFailed);
  }
  const from = (read.data as Record<string, unknown> | null)?.[setting] === true;
  if (from === on) return ok({ on, changed: false });

  const record = (extra: Record<string, unknown> = {}) =>
    recordPlatformAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action: 'passkeys_switched',
      detail: { setting, from, to: on, ...extra },
    });

  if (!(await record())) {
    await reportError(new Error('passkey switch refused: its audit row could not be written'), {
      tag: `${tag}.not_recorded`,
      extra: { to: on },
    });
    return err('internal_error', PASSKEYS_COPY.notRecorded);
  }

  const written = await admin.from('platform_settings').upsert({
    id: true,
    [setting]: on,
    updated_at: new Date().toISOString(),
    updated_by: actor.userId,
  });
  if (written.error) {
    await reportError(new Error(written.error.message), { tag: `${tag}.write`, extra: { to: on } });
    if (!(await record({ not_applied: true }))) {
      await reportError(new Error('a passkey switch record could not be marked not applied'), {
        tag: `${tag}.not_applied_unrecorded`,
        extra: { to: on },
      });
    }
    return err('internal_error', PASSKEYS_COPY.writeFailed);
  }
  return ok({ on, changed: true });
}

/** Turn passkeys on or off for one organization (a row in organization_passkey_switches). */
export async function setOrganizationPasskeysAction(input: {
  organizationId: string;
  on: boolean;
  confirm: string;
}): Promise<ActionResult<OrganizationPasskeysSaved>> {
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) return gateRefusal(gate.reason);
  const actor = actorOf(gate);
  const tag = 'actions.platform.passkeys.organization';

  const checked = confirmed(organizationSchema, input);
  if (!checked.ok) return checked.result;
  const { organizationId, on } = checked.data;
  const client = adminClient(tag);
  if (!client.ok) return client.result;
  const admin = client.admin;

  const org = await admin.from('organizations').select('id').eq('id', organizationId).maybeSingle();
  if (org.error) {
    await reportError(new Error(org.error.message), {
      tag: `${tag}.read_org`,
      extra: { organizationId },
    });
    return err('internal_error', PASSKEYS_COPY.orgReadFailed);
  }
  if (!org.data) return err('not_found', PASSKEYS_COPY.orgNotFound);

  const current = await admin
    .from('organization_passkey_switches')
    .select('organization_id')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (current.error) {
    await reportError(new Error(current.error.message), {
      tag: `${tag}.read`,
      extra: { organizationId },
    });
    return err('internal_error', PASSKEYS_COPY.readFailed);
  }
  const from = current.data !== null;

  /** The answer for an organization that is off now: who still holds a passkey. */
  const offAnswer = async (changed: boolean) =>
    ok({
      on: false,
      changed,
      membersWithPasskeys: await countOrganizationPasskeyHolders(admin, organizationId),
    });

  if (from === on) return on ? ok({ on, changed: false }) : offAnswer(false);

  const record = (extra: Record<string, unknown> = {}) =>
    recordPlatformAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action: 'org_passkeys_switched',
      targetOrganizationId: organizationId,
      detail: { from, to: on, ...extra },
    });
  /** The record already written did not happen: say so in a second row. */
  const markNotApplied = async () => {
    if (!(await record({ not_applied: true }))) {
      await reportError(
        new Error('an organization passkey switch record could not be marked not applied'),
        {
          tag: `${tag}.not_applied_unrecorded`,
          extra: { organizationId, to: on },
        },
      );
    }
  };

  if (!(await record())) {
    await reportError(
      new Error('organization passkey switch refused: its audit row could not be written'),
      {
        tag: `${tag}.not_recorded`,
        extra: { organizationId, to: on },
      },
    );
    return err('internal_error', PASSKEYS_COPY.notRecorded);
  }

  const written = on
    ? await admin.from('organization_passkey_switches').insert({ organization_id: organizationId })
    : await admin
        .from('organization_passkey_switches')
        .delete()
        .eq('organization_id', organizationId);
  if (written.error) {
    if (on && (written.error as { code?: string }).code === '23505') {
      // Another admin turned it on first: this press changed nothing.
      await markNotApplied();
      return ok({ on: true, changed: false });
    }
    await reportError(new Error(written.error.message), {
      tag: `${tag}.write`,
      extra: { organizationId, to: on },
    });
    await markNotApplied();
    return err('internal_error', PASSKEYS_COPY.writeFailed);
  }
  return on ? ok({ on, changed: true }) : offAnswer(true);
}
