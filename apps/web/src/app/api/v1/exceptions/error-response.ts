import { NextResponse } from 'next/server';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus, type ServiceContext } from '@/server/services/context';

/**
 * The /api/v1/exceptions routes' one error shape:
 * `{ error: <code>, message, details? }`.
 *
 * `details` carries the app-authored reason (occurrence_resolved,
 * note_required, aal2_required, …) that the phone branches on. It is never
 * sent for an internal_error, whose detail is raw database text (S13).
 * Anything that is not a ServiceError is a bug: reported, and answered with
 * a bare 500.
 */
export function exceptionsErrorResponse(
  e: unknown,
  tag: string,
  ctx: Pick<ServiceContext, 'organizationId'>,
): NextResponse {
  if (e instanceof ServiceError) {
    const details = e.code !== 'internal_error' ? e.details : undefined;
    if (e.code === 'internal_error') {
      void reportError(e, { tag, organizationId: ctx.organizationId });
    }
    return NextResponse.json(
      { error: e.code, message: e.message, ...(details ? { details } : {}) },
      { status: serviceErrorStatus(e.code) },
    );
  }
  void reportError(e, { tag, organizationId: ctx.organizationId });
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
