import 'server-only';

import { NextResponse } from 'next/server';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

/** Exports are never cached anywhere, answers or refusals. */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The report export routes' error answer (CSV, PDF, XLSX).
 *
 * A ServiceError keeps its REAL status: 401 signed out, 403 forbidden (a
 * missing permission, the MFA step-up, a module that is off), 404 not found,
 * 400 a bad request, 409 a conflict. Its `details` travel with it, so a
 * caller can tell `aal2_required` from `mfa_required`. These routes used to
 * answer every ServiceError with 500, which read as an outage and hid a
 * refusal. An internal error (whose message is already generic, the raw text
 * kept server-side) and anything else are reported and answered 500.
 * (429 is not a ServiceError: exportRateLimited answers it itself.)
 */
export function reportExportErrorResponse(
  e: unknown,
  tag: string,
  organizationId?: string,
): NextResponse {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return NextResponse.json(
      { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      { status: serviceErrorStatus(e.code), headers: NO_STORE },
    );
  }
  void reportError(e, { tag, ...(organizationId ? { organizationId } : {}) });
  return NextResponse.json(
    { error: 'internal_error', message: 'An internal error occurred. Please try again.' },
    { status: 500, headers: NO_STORE },
  );
}

/** No session: 401 in the same shape. */
export function reportExportUnauthenticated(): NextResponse {
  return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE });
}

/** A report the dispatcher does not serve: 404, one shape for the CSV and
 *  PDF dispatchers, never cached. */
export function reportExportNotFound(): NextResponse {
  return NextResponse.json(
    { error: 'not_found', message: 'Unknown report' },
    { status: 404, headers: NO_STORE },
  );
}
