import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { noteLoginDevice } from '@/lib/auth/login-device';
import {
  ACCOUNT_NOTE_LIMIT,
  ACCOUNT_NOTE_WINDOW_MS,
  accountNoteKey,
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
 *
 * Body: { installId?, device?: { model?, osName?, osVersion?, appVersion? } },
 * each field checked against an allowlist and a length cap. A field that
 * fails is dropped, never trusted, and the row is still written.
 *
 * What the device is called comes from those fields only, never from the
 * request's User-Agent: noteLoginDevice shows the name as the stored device,
 * in the email and in the organization's Slack or Teams security feed, which
 * renders it as markup. With no model that passed it is "StockPilot app"
 * (security review of S5a: a User-Agent of `<!channel>` and a masked link
 * reached that feed). The User-Agent still goes to the note, where it is
 * only hashed into the device's identity when the install id is missing.
 */

const INSTALL_ID = z.string().uuid();
// expo-device's model name ("iPhone 15 Pro", "iPad Air (5th generation)").
// Never the device's own name, which can carry a person's name: the phone
// does not send it (apps/mobile/src/lib/auth-notes.ts).
const MODEL = z.string().regex(/^[A-Za-z0-9 ()+.,/_-]{1,64}$/);
const OS_NAME = z.string().regex(/^[A-Za-z0-9 ._-]{1,32}$/);
const OS_VERSION = z.string().regex(/^[A-Za-z0-9._-]{1,24}$/);
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

/** The device note's name for a phone that named no model that passed. */
const UNNAMED_PHONE = 'StockPilot app';

/** "StockPilot app on iPhone 15 Pro (iOS 18.1)"; no model, no label. */
function deviceLabel(d: ReturnType<typeof readDevice>): string | null {
  if (!d.model) return null;
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
      'open',
    );
    if (!perAccount.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', message: 'Too many sign-ins from this account. Try again later.' },
        { status: 429 },
      );
    }
    const firstNote = await checkRateLimit(
      sessionNoteKey('in', sessionId),
      1,
      SESSION_NOTE_WINDOW_MS,
      'open',
    );
    if (!firstNote.allowed) return NextResponse.json({ ok: true });

    const device = readDevice(parsed.data.device);
    const label = deviceLabel(device);
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
        device_label: label,
        session_ref: sessionRef(sessionId),
      },
    });

    // After the response (defer: after(), kept alive), like the web's
    // sign-in: the device, and the email when it is new on an account that
    // already has a known one.
    const userId = ctx.userId;
    const email = claims.email;
    const userAgent = req.headers.get('user-agent');
    const ip = requestIp(req);
    const deviceName = label ?? UNNAMED_PHONE;
    defer(() =>
      noteLoginDevice({
        userId,
        email,
        userAgent,
        ip,
        deviceKey: installId,
        deviceLabel: deviceName,
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    return internalErrorResponse(e, 'auth.signed_in');
  }
}
