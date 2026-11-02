import 'server-only';

import { err, ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, type ActionResult } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError, type ErrorContext } from '@/lib/error-reporter';
import { asReportableError } from '@/lib/error-text';
import { reportContext, UNEXPECTED_ERROR_MESSAGE } from '@/server/lib/api-error-response';
import { ServiceError } from '@/server/services/context';

/** A feature whose server setting is missing (a local or preview server). Never names the setting. */
export const NOT_SET_UP_MESSAGE = 'This feature is not set up yet.';

/** An email the provider did not take, whatever it said. */
export const EMAIL_NOT_SENT_MESSAGE = 'Could not send the email. Try again.';

/** One row of an import that failed for a reason the app did not write. */
export const ROW_NOT_IMPORTED_MESSAGE = 'Could not import this row.';

export interface ActionErrorOptions {
  /** The organization the action acted in, for the report. */
  organizationId?: string | null;
  /** The sentence for a failure the action did not expect: a constant the app wrote. */
  message?: string;
  /**
   * What a refusal the app wrote keeps of its details: 'all' (the default, as
   * the actions forwarded them), 'reason' (only `details.reason`, the email
   * routing panel's step-up), or 'none'.
   */
  details?: 'all' | 'reason' | 'none';
  level?: ErrorContext['level'];
  extra?: ErrorContext['extra'];
}

/**
 * The answer to a failure a Server Action did not expect (S31): the error goes
 * to reportError with the action's tag, and the person reads one fixed
 * sentence (`opts.message`, else "Something went wrong. Please try again.").
 *
 * Next.js control flow (redirect(), notFound()) is thrown again first, for
 * Next to act on (lib/control-flow.ts); action-catch.guard.test.ts accepts a
 * catch whose first statement calls this.
 */
export function unexpectedActionError(
  e: unknown,
  tag: string,
  opts: ActionErrorOptions = {},
): ActionResult<never> {
  rethrowControlFlow(e);
  void reportError(asReportableError(e), reportContext(tag, opts));
  return err('internal_error', opts.message ?? UNEXPECTED_ERROR_MESSAGE);
}

/**
 * The one translation from a thrown error to a Server Action's result (S31).
 *
 * A Server Action's returned result reaches the browser as it is, and the
 * actions' catches used to answer `e instanceof Error ? e.message : ...`: the
 * person read Postgres text naming tables, columns and policies, a vendor's
 * words, a setting's name, and none of those errors was reported. Now:
 *
 *   - Next control flow: thrown again, never answered or reported;
 *   - a ServiceError other than internal_error: its code and words (the app
 *     wrote them) and its details per `opts.details`, unreported;
 *   - an internal_error ServiceError: its generic words (S13) or
 *     `opts.message`, never its details; reported with its internalDetail;
 *   - assertWarehouseAccess's ForbiddenError: 'forbidden' with its words; when
 *     the caller's own access could not be read, the order service's
 *     retryable conflict (services/order-requests.ts), reported as a warning;
 *   - a permission or account-status check that could not run: its own fixed
 *     sentence, reported as a warning;
 *   - anything else: unexpectedActionError.
 *
 * The guard app/api/no-raw-error-text.guard.test.ts fails a Server Action that
 * answers an error's own text again.
 */
export function actionErrorResult(
  e: unknown,
  tag: string,
  opts: ActionErrorOptions = {},
): ActionResult<never> {
  rethrowControlFlow(e);
  if (e instanceof ServiceError) {
    if (e.code === 'internal_error') {
      void reportError(
        e,
        reportContext(tag, { ...opts, extra: { ...opts.extra, detail: e.internalDetail } }),
      );
      return err('internal_error', opts.message ?? e.message);
    }
    const details = refusalDetails(e.details, opts.details ?? 'all');
    return err(e.code, e.message, details);
  }
  if (e instanceof ForbiddenError) {
    if (e.accessUnreadable) {
      void reportError(e, reportContext(tag, { ...opts, level: 'warning' }));
      return err('conflict', ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, {
        reason: 'failed',
        retryable: true,
      });
    }
    return err('forbidden', e.message);
  }
  if (e instanceof PermissionsUnavailableError || e instanceof AccountStatusUnavailableError) {
    void reportError(e, reportContext(tag, { ...opts, level: 'warning' }));
    return err('internal_error', e.message);
  }
  return unexpectedActionError(e, tag, opts);
}

/**
 * The failed rows of one run: an import's rows, a reorder's suppliers (S31).
 * A row's words are a refusal the app wrote (a ServiceError other than
 * internal_error: a duplicate SKU, a plan limit), else `opts.message`
 * (ROW_NOT_IMPORTED_MESSAGE by default), never the error's own text. The
 * unexpected ones are reported ONCE for the run (recurring pattern 30), with
 * their count and the first of them, by report().
 */
export class RowFailures {
  private first: unknown;
  private unexpected = 0;

  constructor(
    private readonly tag: string,
    private readonly opts: Pick<ActionErrorOptions, 'organizationId' | 'message'> = {},
  ) {}

  /** The words for a row that threw `e`. Next control flow is thrown again. */
  message(e: unknown): string {
    rethrowControlFlow(e);
    if (e instanceof ServiceError && e.code !== 'internal_error') return e.message;
    this.unexpected += 1;
    if (this.unexpected === 1) this.first = e;
    return this.opts.message ?? ROW_NOT_IMPORTED_MESSAGE;
  }

  /** One report for the run, when any row failed for a reason the app did not write. */
  report(): void {
    if (this.unexpected === 0) return;
    const detail = this.first instanceof ServiceError ? this.first.internalDetail : undefined;
    void reportError(
      asReportableError(this.first),
      reportContext(this.tag, {
        organizationId: this.opts.organizationId,
        extra: { failed: this.unexpected, ...(detail ? { detail } : {}) },
      }),
    );
  }
}

function refusalDetails(
  details: Record<string, unknown> | undefined,
  keep: NonNullable<ActionErrorOptions['details']>,
): Record<string, unknown> | undefined {
  if (!details || keep === 'none') return undefined;
  if (keep === 'all') return details;
  return typeof details.reason === 'string' ? { reason: details.reason } : undefined;
}
