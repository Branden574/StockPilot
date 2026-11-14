import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { noteLoginDevice } from '@/lib/auth/login-device';
import {
  ACCOUNT_NOTE_LIMIT,
  ACCOUNT_NOTE_WINDOW_MS,
  accountNoteKey,
  admitUncountedNote,
  reportUncountedNote,
  requestIp,
  SESSION_NOTE_WINDOW_MS,
  sessionNoteKey,
  sessionRef,
  verifiedBearerClaims,
} from '@/lib/auth/session-note';
import { checkRateLimit } from '@/lib/rate-limit';
import { internalErrorResponse, unreadableRequestResponse } from '@/server/lib/api-error-response';
import { emitAuthAudit } from '@/server/services/auth-audit';
import { defer } from '@/server/services/lib/defer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The phone's sign-in, in the Audit log, with the new-device email (S5,
 * plans/S5.md 3.4 step 10).
 *
 * The phone signs in against the Auth server directly, so a phone sign-in
 * wrote no user.signed_in row and sent no new-device email: noteLoginDevice
 * had one caller, the web's sign-in (server/actions/auth.ts). The phone now
 * sends this note right after the password is accepted, before the
 * authenticator code, where the web notes a device too: a stolen password
 * used on a new phone still alerts the account's owner.
 *
 * Who may write: a verified bearer token of the account the request
 * authenticated as (lib/auth/session-note.ts). An AAL1 token is accepted, as
 * on the web, and the row says whether the code is still owed: the note goes
 * out before the code screen, so withApiContext is asked with
 * allowStepUpPending (S43a; AAL1_ROUTES in src/test/api-step-up.guard.test.ts).
 * Refused there, a stolen password used on a phone would write no row and send
 * no email for exactly the accounts that have an authenticator. The context it
 * gets is labelled unsatisfied, so no permission check passes it; the route
 * needs none.
 *
 * Once per session: a second note for the same session (a retry, a relaunch)
 * writes nothing, by a hash of the session id, for a day. 30 notes an hour per
 * account. A token with no session id writes nothing (nothing to count by).
 * A count either bucket refuses is answered as above. A limiter that cannot
 * answer (lib/rate-limit's `failed`), for either bucket, is answered the same
 * way: the user.signed_in row is still written (with limiter_unavailable),
 * the device is not noted, so no new-device email or organization event goes
 * out without a count and the device is still new at its next sign-in, and
 * the hold is reported (at most once in five minutes on an instance,
 * lib/auth/session-note.ts). The phone's sign-in itself has already happened
 * at the Auth server, so the row is kept. Meanwhile the instance counts in
 * memory (admitUncountedNote): a session's row once, and 30 an hour per
 * account, past which the answer is the same 429 with no row. The note counts
 * new-device alerts per account and per organization (lib/auth/login-device.ts).
 *
 * Body: { installId?, device?: { model?, osName?, osVersion?, appVersion? } },
 * each field checked against an allowlist and a length cap. A field that
 * fails is dropped, never trusted, and the row is still written.
 *
 * What the device is called comes from those fields only, never from the
 * request's User-Agent (security review of S5a). Two names (integrator
 * decision, device label 2026-11-02):
 *   - the label, "StockPilot app on iPhone 15 Pro (iOS 18.1)", only in the
 *     person's own device list and their own new-device email;
 *   - the family, "StockPilot app on iPhone", "on iPad", "on Android" or
 *     "StockPilot app", in the Audit row and the organization's activity
 *     (noteLoginDevice's security.new_device_login event): the sign-in note
 *     keeps only the device family there.
 * With no model that passed, the label is the family too. The User-Agent
 * still goes to the note, where it is only hashed into the device's identity
 * when the install id is missing.
 */

const INSTALL_ID = z.string().uuid();
// expo-device's model name ("iPhone 15 Pro", "iPad Air (5th generation)"):
// letters, digits, spaces, parentheses, '+' and '-', at most 48. No '.', '/',
// ',' or '_': a model is never an address or a sentence. Never the device's
// own name, which can carry a person's name: the phone does not send it
// (apps/mobile/src/lib/auth-notes.ts).
const MODEL = z.string().regex(/^[A-Za-z0-9 ()+-]{1,48}$/);
// expo-device's osName, exactly one of these.
const OS_NAME = z.enum(['iOS', 'iPadOS', 'Android']);
const OS_VERSION = z.string().regex(/^[0-9.]{1,16}$/);
const APP_VERSION = z.string().regex(/^[A-Za-z0-9.+_-]{1,32}$/);

const noteSchema = z.object({
  installId: z.unknown().optional(),
  device: z.unknown().optional(),
});

/** The field when it passes its check, else null. */
function checked<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readDevice(raw: unknown) {
  const d =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    model: checked(MODEL, d.model),
    osName: checked(OS_NAME, d.osName),
    osVersion: checked(OS_VERSION, d.osVersion),
    appVersion: checked(APP_VERSION, d.appVersion),
  };
}

type CheckedDevice = ReturnType<typeof readDevice>;

/**
 * The family, from fixed words only: "StockPilot app on iPhone" or "on iPad"
 * when the model's first word is iPhone or iPad, "on Android" when the system
 * is Android, else "StockPilot app". What the Audit row and the organization's
 * activity call the phone.
 */
function deviceFamily(d: CheckedDevice): string {
  const firstWord = d.model?.split(' ')[0];
  if (firstWord === 'iPhone') return 'StockPilot app on iPhone';
  if (firstWord === 'iPad') return 'StockPilot app on iPad';
  if (d.osName === 'Android') return 'StockPilot app on Android';
  return 'StockPilot app';
}

/**
 * "StockPilot app on iPhone 15 Pro (iOS 18.1)": the person's own name for the
 * phone, in their device list and their email. With no model, the family.
 */
function deviceLabel(d: CheckedDevice): string {
  if (!d.model) return deviceFamily(d);
  const system = d.osName ? ` (${d.osName}${d.osVersion ? ` ${d.osVersion}` : ''})` : '';
  return `StockPilot app on ${d.model}${system}`;
}

const unauthenticated = () => NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

export async function POST(req: Request) {
  try {
    const ctx = await withApiContext(req, { allowStepUpPending: true });
    if (!ctx) return unauthenticated();
    const claims = await verifiedBearerClaims(req, ctx);
    if (!claims) return unauthenticated();
    const sessionId = claims.sessionId;
    if (!sessionId) return NextResponse.json({ ok: true });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return unreadableRequestResponse();
    }
    const parsed = noteSchema.safeParse(body);
    if (!parsed.success) return unreadableRequestResponse('validation_error');

    const perAccount = await checkRateLimit(
      accountNoteKey(ctx.userId),
      ACCOUNT_NOTE_LIMIT,
      ACCOUNT_NOTE_WINDOW_MS,
      'closed',
    );
    if (!perAccount.allowed && !perAccount.failed) {
      return NextResponse.json(
        { error: 'rate_limited', message: 'Too many sign-ins from this account. Try again later.' },
        { status: 429 },
      );
    }
    const firstNote = await checkRateLimit(
      sessionNoteKey('in', sessionId),
      1,
      SESSION_NOTE_WINDOW_MS,
      'closed',
    );
    if (!firstNote.allowed && !firstNote.failed) return NextResponse.json({ ok: true });
    // The limiter could not answer for a bucket: the row is written, the
    // device is not noted (no email, no event), and the hold is reported.
    const uncounted =
      perAccount.failed && firstNote.failed
        ? 'both'
        : perAccount.failed
          ? 'account'
          : firstNote.failed
            ? 'session'
            : null;

    if (uncounted) {
      // No count from the limiter: this instance's own bound decides.
      const admitted = admitUncountedNote(ctx.userId, sessionId);
      if (admitted !== 'write') {
        reportUncountedNote(uncounted);
        if (admitted === 'repeat') return NextResponse.json({ ok: true });
        return NextResponse.json(
          {
            error: 'rate_limited',
            message: 'Too many sign-ins from this account. Try again later.',
          },
          { status: 429 },
        );
      }
    }

    const device = readDevice(parsed.data.device);
    const label = deviceLabel(device);
    const family = deviceFamily(device);
    const installId = checked(INSTALL_ID, parsed.data.installId);

    await emitAuthAudit({
      event: 'user.signed_in',
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      extra: {
        client: 'mobile',
        platform: device.osName,
        app_version: device.appVersion,
        email: claims.email,
        role: ctx.role,
        // The code is still owed: an AAL1 session of an account with an
        // authenticator (the web's mfa_required, actions/auth.ts).
        mfa_required: claims.aal === 'aal1' && ctx.mfaEnrolled === true,
        // The family only (integrator decision, device label 2026-11-02).
        device_label: family,
        session_ref: sessionRef(sessionId),
        ...(uncounted ? { limiter_unavailable: true } : {}),
      },
    });

    if (uncounted) {
      reportUncountedNote(uncounted);
      return NextResponse.json({ ok: true });
    }

    // After the response (defer: after(), kept alive), like the web's
    // sign-in: the device, and the email when it is new on an account that
    // already has a known one. The label goes to the person's own device
    // list and email; the organization's activity gets the family.
    const userId = ctx.userId;
    const email = claims.email;
    const userAgent = req.headers.get('user-agent');
    const ip = requestIp(req);
    defer(() =>
      noteLoginDevice({
        userId,
        email,
        userAgent,
        ip,
        deviceKey: installId,
        deviceLabel: label,
        deviceFamily: family,
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    return internalErrorResponse(e, 'auth.signed_in');
  }
}
