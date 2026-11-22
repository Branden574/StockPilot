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
 *      lets useStepUp() ask for the code in place and press again. The
 *      actor's id and email are the pair Auth verified (the gate's
 *      verifiedUserId and verifiedEmail); a session whose id is not that id
 *      is refused, and nothing is read or written.
 *   2. The input, then the typed word PASSKEYS, compared exactly.
 *   3. The current state, read (a failed read refuses; it is never "off").
 *      A press that changes nothing writes nothing and records nothing.
 *   4. Turning ON (integrator's decision): the platform_admin_audit row
 *      FIRST: passkeys_switched (detail { setting, from, to }) or
 *      org_passkeys_switched (target organization, detail { from, to }), the
 *      actor's email the one Auth verified (the gate's verifiedEmail, never the
 *      profile column). When it does not land, nothing is switched and the
 *      answer says so. (Until migration 0476 adds these two words to
 *      platform_admin_audit's check, every ON is refused this way.)
 *   5. The write, applied only while the switch still holds the value read
 *      (a compare-and-set): the one platform_settings row UPDATED with only
 *      this column where it still holds the value read, or, when there was no
 *      row (it may not exist in production, review F), the row INSERTED with
 *      only this column (a row another press made first falls back to the
 *      same conditional update). The other settings and the deletion
 *      passphrase are never written. An organization's switch row is inserted
 *      (a second insert is a unique violation) or deleted, the delete
 *      returning the rows it removed (service_role has select, insert and
 *      delete on that table, no update).
 *      A write that changed nothing because the switch moved since the read:
 *      nothing was done, and the answer says someone else changed it; an ON's
 *      record is marked not applied. An organization OFF whose delete removed
 *      nothing: already off, no record.
 *      An ON whose write answers an error after its record landed: the switch
 *      is read again first. On after all (the answer was lost, not the
 *      write): the change stands, recorded. Still off: refused, and a second
 *      row with the same words and detail not_applied: true says the first
 *      did not happen (best effort; reported when it fails too). Unreadable:
 *      the record is left as it is, the unknown is reported at error level,
 *      and the answer says the change could not be confirmed.
 *      Turning OFF always proceeds: off is the safe direction and is never
 *      held back by the audit path in an incident. Its record is written
 *      after the switch; when it cannot be written, that is reported at
 *      error level (ids only, never an email) and the answer says the change
 *      was made but its record could not be written (recorded: false).
 *   6. An organization turned off (or already off) answers how many of its
 *      members still hold an active passkey (null when that cannot be read).
 *
 * Two admins pressing at the same moment: each reads, records (an ON), then
 * writes only if the switch still holds what it read, so the second press
 * changes nothing and says so. An organization's second insert is a unique
 * violation: answered "already on", with its record marked not_applied.
 */

export interface PasskeySwitchSaved {
  /** The switch's state now. */
  on: boolean;
  /** False when it already was in that state (nothing written, nothing recorded). */
  changed: boolean;
  /**
   * Whether the change's audit row landed. Always true for a change to ON
   * (refused without it); false only for an OFF that was made but whose
   * record could not be written (reported at error level). False when
   * nothing changed.
   */
  recorded: boolean;
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

/**
 * The actor: the id and email Auth verified for this request, as one pair.
 * Null when that id is missing or is not the session's (refused).
 */
function actorOf(gate: {
  session: { userId: string };
  verifiedEmail: string;
  verifiedUserId: string;
}): Actor | null {
  if (!gate.verifiedUserId || gate.verifiedUserId !== gate.session.userId) return null;
  return { userId: gate.verifiedUserId, email: gate.verifiedEmail };
}

/** The id Auth verified is not the session's: refused, nothing read or written. */
async function actorRefusal(): Promise<ActionResult<never>> {
  await reportError(new Error('passkey switch refused: the verified id is not the session id'), {
    tag: 'actions.platform.passkeys.actor_mismatch',
  });
  return err('forbidden', PASSKEYS_COPY.notAuthorized);
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

type AdminClient = ReturnType<typeof createAdminClient>;

/** The one platform_settings row's two passkey switches (null data: no row). */
function readSettings(admin: AdminClient) {
  return admin
    .from('platform_settings')
    .select('passkeys_on, passkey_adds_on')
    .eq('id', true)
    .maybeSingle();
}

/**
 * Write one platform-wide switch, only while it still holds the value read.
 * Only this column (with updated_at and updated_by) is written, on the one
 * row. No row when read: insert it; a row another press made first (23505)
 * falls back to the conditional update. `applied` is false when the update
 * matched no row: the switch moved since the read.
 */
async function writeSetting(
  admin: AdminClient,
  setting: PlatformPasskeySetting,
  w: { from: boolean; on: boolean; rowExists: boolean; userId: string },
): Promise<{ error: { message: string } | null; applied: boolean }> {
  const values = {
    [setting]: w.on,
    updated_at: new Date().toISOString(),
    updated_by: w.userId,
  };
  if (!w.rowExists) {
    const inserted = await admin.from('platform_settings').insert({ id: true, ...values });
    if (!inserted.error) return { error: null, applied: true };
    if ((inserted.error as { code?: string }).code !== '23505') {
      return { error: inserted.error, applied: false };
    }
  }
  const updated = await admin
    .from('platform_settings')
    .update(values)
    .eq('id', true)
    .eq(setting, w.from)
    .select('id');
  if (updated.error) return { error: updated.error, applied: false };
  return { error: null, applied: (updated.data ?? []).length > 0 };
}

/** Turn the platform-wide kill switch (platform_settings.passkeys_on) on or off. */
export async function setPasskeysKillSwitchAction(input: {
  on: boolean;
  confirm: string;
}): Promise<ActionResult<PasskeySwitchSaved>> {
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) return gateRefusal(gate.reason);
  const actor = actorOf(gate);
  if (!actor) return actorRefusal();
  return setPlatformSwitch(actor, 'passkeys_on', input);
}

/** Turn the platform-wide "new passkeys" switch (platform_settings.passkey_adds_on) on or off. */
export async function setNewPasskeysSwitchAction(input: {
  on: boolean;
  confirm: string;
}): Promise<ActionResult<PasskeySwitchSaved>> {
  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) return gateRefusal(gate.reason);
  const actor = actorOf(gate);
  if (!actor) return actorRefusal();
  return setPlatformSwitch(actor, 'passkey_adds_on', input);
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

  const read = await readSettings(admin);
  if (read.error) {
    await reportError(new Error(read.error.message), { tag: `${tag}.read` });
    return err('internal_error', PASSKEYS_COPY.readFailed);
  }
  const row = read.data as Record<string, unknown> | null;
  const from = row?.[setting] === true;
  if (from === on) return ok({ on, changed: false, recorded: false });

  const record = (extra: Record<string, unknown> = {}) =>
    recordPlatformAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action: 'passkeys_switched',
      detail: { setting, from, to: on, ...extra },
    });
  /** The record already written did not happen: say so in a second row. */
  const markNotApplied = async () => {
    if (!(await record({ not_applied: true }))) {
      await reportError(new Error('a passkey switch record could not be marked not applied'), {
        tag: `${tag}.not_applied_unrecorded`,
        extra: { to: on },
      });
    }
  };

  // ON: the record first; without it nothing is switched.
  if (on && !(await record())) {
    await reportError(new Error('passkey switch refused: its audit row could not be written'), {
      tag: `${tag}.not_recorded`,
      extra: { to: on },
    });
    return err('internal_error', PASSKEYS_COPY.notRecorded);
  }

  const written = await writeSetting(admin, setting, {
    from,
    on,
    rowExists: row !== null,
    userId: actor.userId,
  });
  if (written.error) {
    await reportError(new Error(written.error.message), { tag: `${tag}.write`, extra: { to: on } });
    if (on) {
      // Its record landed: read again before saying it did not happen.
      const again = await readSettings(admin);
      if (!again.error && (again.data as Record<string, unknown> | null)?.[setting] === true) {
        return ok({ on, changed: true, recorded: true });
      }
      if (again.error) {
        await reportError(
          new Error('a passkey switch write answered an error and could not be read again'),
          { tag: `${tag}.write_unconfirmed`, level: 'error', extra: { setting, to: on } },
        );
        return err('internal_error', PASSKEYS_COPY.writeUnconfirmed);
      }
      await markNotApplied();
    }
    return err('internal_error', PASSKEYS_COPY.writeFailed);
  }
  if (!written.applied) {
    // The switch moved between the read and the write: nothing was done.
    if (on) await markNotApplied();
    return err('conflict', PASSKEYS_COPY.changedElsewhere);
  }
  // OFF: switched first, never held back by the audit path; then recorded.
  if (!on && !(await record())) {
    await reportError(new Error('passkey switch turned off without its audit row'), {
      tag: `${tag}.off_not_recorded`,
      level: 'error',
      extra: { setting, to: on },
    });
    return ok({ on, changed: true, recorded: false });
  }
  return ok({ on, changed: true, recorded: true });
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
  if (!actor) return actorRefusal();
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

  const readSwitch = () =>
    admin
      .from('organization_passkey_switches')
      .select('organization_id')
      .eq('organization_id', organizationId)
      .maybeSingle();
  const current = await readSwitch();
  if (current.error) {
    await reportError(new Error(current.error.message), {
      tag: `${tag}.read`,
      extra: { organizationId },
    });
    return err('internal_error', PASSKEYS_COPY.readFailed);
  }
  const from = current.data !== null;

  /** The answer for an organization that is off now: who still holds a passkey. */
  const offAnswer = async (changed: boolean, recorded: boolean) =>
    ok({
      on: false,
      changed,
      recorded,
      membersWithPasskeys: await countOrganizationPasskeyHolders(admin, organizationId),
    });

  if (from === on)
    return on ? ok({ on, changed: false, recorded: false }) : offAnswer(false, false);

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

  // ON: the record first; without it nothing is switched.
  if (on && !(await record())) {
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
        .eq('organization_id', organizationId)
        .select('organization_id');
  if (written.error) {
    if (on && (written.error as { code?: string }).code === '23505') {
      // Another admin turned it on first: this press changed nothing.
      await markNotApplied();
      return ok({ on: true, changed: false, recorded: false });
    }
    await reportError(new Error(written.error.message), {
      tag: `${tag}.write`,
      extra: { organizationId, to: on },
    });
    if (on) {
      // Its record landed: read again before saying it did not happen.
      const again = await readSwitch();
      if (!again.error && again.data !== null) return ok({ on, changed: true, recorded: true });
      if (again.error) {
        await reportError(
          new Error(
            'an organization passkey switch write answered an error and could not be read again',
          ),
          { tag: `${tag}.write_unconfirmed`, level: 'error', extra: { organizationId, to: on } },
        );
        return err('internal_error', PASSKEYS_COPY.writeUnconfirmed);
      }
      await markNotApplied();
    }
    return err('internal_error', PASSKEYS_COPY.writeFailed);
  }
  if (on) return ok({ on, changed: true, recorded: true });
  // OFF: another admin's delete went first, so this one removed nothing.
  if (((written.data as unknown[] | null) ?? []).length === 0) return offAnswer(false, false);
  // OFF: switched first, never held back by the audit path; then recorded.
  if (!(await record())) {
    await reportError(new Error('organization passkey switch turned off without its audit row'), {
      tag: `${tag}.off_not_recorded`,
      level: 'error',
      extra: { organizationId, to: on },
    });
    return offAnswer(true, false);
  }
  return offAnswer(true, true);
}
