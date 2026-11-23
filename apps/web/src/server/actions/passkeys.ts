'use server';

import { revalidatePath } from 'next/cache';

import { actionErrorResult } from '@/server/lib/action-error-result';
import {
  completeSecondStep,
  finishAddPasskey,
  finishPasskeySetup,
  removePasskey,
  renamePasskey,
  startAddPasskey,
  startConfirmAdd,
  startFinishSetup,
  startSecondStep,
  type PasskeyFailure,
  type SecondStepStart,
} from '@/server/security/passkeys';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * The passkey Server Actions (plan 2.6). Each is a thin wrapper: it calls
 * into server/security/passkeys.ts inside its own body (never a re-export,
 * events guard rule 2), takes nothing that names an account, a factor, a
 * session or a PURPOSE (rule 20: each fixes its own), and answers plain
 * words. Every rule is checked in the security module; this file only maps
 * its answer to an ActionResult and keeps a thrown error out of the reply.
 */

const COULD_NOT_FINISH = 'Could not finish just now. Try again.';

function refused(f: PasskeyFailure): ActionResult<never> {
  return err(f.code, f.message);
}

/**
 * A thrown error: the shared mapping (server/lib/action-error-result.ts:
 * Next control flow thrown again, a check of the caller's access that could
 * not be read answered with its own sentence, anything else reported and
 * answered with our fixed words, never the error's text: an Auth or library
 * message can name ids).
 */
function unexpected(e: unknown, where: string): ActionResult<never> {
  return actionErrorResult(e, 'passkeys.action', { message: COULD_NOT_FINISH, extra: { where } });
}

/** The second step's device prompt options (sign-in page, step-up modal). */
export async function startSecondStepAction(): Promise<ActionResult<SecondStepStart>> {
  try {
    const r = await startSecondStep();
    return r.ok ? ok(r.start) : refused(r);
  } catch (e) {
    return unexpected(e, 'start_second_step');
  }
}

/** The second step's answer: raises THIS session to aal2 (purpose second_step only). */
export async function finishSecondStepAction(input: {
  challengeId: string;
  response: unknown;
}): Promise<ActionResult<void>> {
  try {
    const r = await completeSecondStep({
      challengeId: input?.challengeId,
      response: input?.response,
    });
    return r.ok ? ok(undefined) : refused(r);
  } catch (e) {
    return unexpected(e, 'finish_second_step');
  }
}

/** The confirm_add prompt: a member with a passkey proves it before adding another. */
export async function startConfirmAddAction(): Promise<ActionResult<SecondStepStart>> {
  try {
    const r = await startConfirmAdd();
    return r.ok ? ok(r.start) : refused(r);
  } catch (e) {
    return unexpected(e, 'start_confirm_add');
  }
}

/** Adding: the fresh proof, then the device prompt's options (purpose register). */
export async function startAddPasskeyAction(input: {
  proof: unknown;
  phoneConfirmation?: string;
}): Promise<ActionResult<{ challengeId: string; optionsJSON: unknown }>> {
  try {
    const r = await startAddPasskey({
      proof: input?.proof,
      phoneConfirmation: input?.phoneConfirmation,
    });
    return r.ok ? ok({ challengeId: r.challengeId, optionsJSON: r.optionsJSON }) : refused(r);
  } catch (e) {
    return unexpected(e, 'start_add');
  }
}

/** Adding: the device's new passkey, stored with its bridge. */
export async function finishAddPasskeyAction(input: {
  challengeId: string;
  response: unknown;
  name: string;
}): Promise<ActionResult<{ firstPasskey: boolean }>> {
  try {
    const r = await finishAddPasskey({
      challengeId: input?.challengeId,
      response: input?.response,
      name: input?.name,
    });
    if (!r.ok) return refused(r);
    revalidatePath('/dashboard/settings/security');
    return ok({ firstPasskey: r.firstPasskey });
  } catch (e) {
    return unexpected(e, 'finish_add');
  }
}

/** Finish: the finish_setup prompt for a passkey whose setup is not finished. */
export async function startPasskeySetupAction(): Promise<ActionResult<SecondStepStart>> {
  try {
    const r = await startFinishSetup();
    return r.ok ? ok(r.start) : refused(r);
  } catch (e) {
    return unexpected(e, 'start_finish_setup');
  }
}

/** Finish: the answer, then a new bridge put in place. */
export async function finishPasskeySetupAction(input: {
  challengeId: string;
  response: unknown;
}): Promise<ActionResult<void>> {
  try {
    const r = await finishPasskeySetup({
      challengeId: input?.challengeId,
      response: input?.response,
    });
    if (!r.ok) return refused(r);
    revalidatePath('/dashboard/settings/security');
    return ok(undefined);
  } catch (e) {
    return unexpected(e, 'finish_setup');
  }
}

/** Remove one of the member's passkeys (aal2); the other sessions end. */
export async function removePasskeyAction(input: {
  passkeyId: string;
}): Promise<ActionResult<{ finishing: boolean }>> {
  try {
    const r = await removePasskey({ passkeyId: input?.passkeyId });
    if (!r.ok) return refused(r);
    revalidatePath('/dashboard/settings/security');
    return ok({ finishing: r.finishing });
  } catch (e) {
    return unexpected(e, 'remove');
  }
}

/** Rename one of the member's passkeys (aal2). */
export async function renamePasskeyAction(input: {
  passkeyId: string;
  name: string;
}): Promise<ActionResult<void>> {
  try {
    const r = await renamePasskey({ passkeyId: input?.passkeyId, name: input?.name });
    if (!r.ok) return refused(r);
    revalidatePath('/dashboard/settings/security');
    return ok(undefined);
  } catch (e) {
    return unexpected(e, 'rename');
  }
}
