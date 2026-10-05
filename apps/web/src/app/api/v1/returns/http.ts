import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus, type ServiceContext } from '@/server/services/context';

/**
 * The /api/v1/returns routes' shared plumbing (returns RX-1): cookie or
 * Bearer context, per-user limits, `Cache-Control: private, no-store`, the
 * organization echoed, and ONE error shape `{ error, message, details? }`
 * whose `details.reason` is the database hint the phone and web branch on
 * (core return-error-map). An internal error never carries its raw detail;
 * it answers `details.reason: 'failed'` (the phone drops ApiError.details
 * for internal_error, so the route's own body names the fault).
 */

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/** Reads: 120 a minute per user. Writes: 60 a minute per user. */
const READ_LIMIT = 120;
const WRITE_LIMIT = 60;

export const RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';

export async function returnsContext(
  req: NextRequest,
  kind: 'read' | 'write',
): Promise<{ ctx: ServiceContext } | { response: NextResponse }> {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return {
      response: NextResponse.json(
        { error: 'unauthenticated', message: 'Sign in again.' },
        { status: 401, headers: NO_STORE },
      ),
    };
  }
  const limit = kind === 'read' ? READ_LIMIT : WRITE_LIMIT;
  const rl = await checkRateLimit(`returns-${kind}:${ctx.userId}`, limit, 60_000);
  if (!rl.allowed) {
    return {
      response: NextResponse.json(
        { error: 'rate_limited', message: RATE_LIMITED_MESSAGE },
        {
          status: 429,
          headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) },
        },
      ),
    };
  }
  return { ctx };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function invalidReturnId(id: string): NextResponse | null {
  if (UUID_RE.test(id)) return null;
  return NextResponse.json(
    { error: 'validation_error', message: 'That return id is not valid.', details: { reason: 'return_invalid' } },
    { status: 400, headers: NO_STORE },
  );
}

export async function readJson(req: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'validation_error', message: 'The request body is not valid JSON.', details: { reason: 'return_invalid' } },
        { status: 400, headers: NO_STORE },
      ),
    };
  }
}

export function badBody(message: string): NextResponse {
  return NextResponse.json(
    { error: 'validation_error', message, details: { reason: 'return_invalid' } },
    { status: 400, headers: NO_STORE },
  );
}

export function returnsErrorResponse(e: unknown, tag: string, ctx: Pick<ServiceContext, 'organizationId'>): NextResponse {
  if (e instanceof ServiceError) {
    if (e.code === 'internal_error') {
      void reportError(e, { tag, organizationId: ctx.organizationId });
      return NextResponse.json(
        { error: 'internal_error', message: 'Something went wrong. Try again.', details: { reason: 'failed' } },
        { status: 500, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      { status: serviceErrorStatus(e.code), headers: NO_STORE },
    );
  }
  void reportError(e, { tag, organizationId: ctx.organizationId });
  return NextResponse.json(
    { error: 'internal_error', message: 'Something went wrong. Try again.', details: { reason: 'failed' } },
    { status: 500, headers: NO_STORE },
  );
}
