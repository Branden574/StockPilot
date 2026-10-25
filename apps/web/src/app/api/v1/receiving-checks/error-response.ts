import { NextResponse } from 'next/server';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus, type ServiceContext } from '@/server/services/context';

/**
 * The receiving checklist routes' one error shape (F4-1):
 * `{ error: <code>, message, details? }`, status by code (403 forbidden and
 * module_disabled, 404, 409 conflict with details.reason, 400 validation with
 * the step or keys it names). `details` is app-authored only and never sent
 * for an internal_error, whose detail is database text (S13). Anything that is
 * not a ServiceError is a bug: reported, and answered with a bare 500.
 */
export function checklistErrorResponse(
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
  return NextResponse.json(
    { error: 'internal_error', message: 'Something went wrong. Please try again.' },
    { status: 500 },
  );
}

/** A 400 in the routes' error shape. */
export function checklistBadRequest(message: string): NextResponse {
  return NextResponse.json({ error: 'validation_error', message }, { status: 400 });
}
