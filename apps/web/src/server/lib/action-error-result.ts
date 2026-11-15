import 'server-only';

import { err, ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, type ActionResult } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError, type ErrorContext } from '@/lib/error-reporter';
import { asReportableError } from '@/lib/error-text';
import { ModulesUnavailableError } from '@/lib/modules/module-state';
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
 *   - a check of the caller's access that could not be read (the permission
 *     set, the account status, or a module state: ModulesUnavailableError,
 *     thrown when the action asks about a module withContext() could not
 *     read): its own fixed try-again sentence, reported as a warning, never
 *     the module_disabled a module that is off gets (uncheckedAccessResult
 *     below, which an action module with its own mapping calls too);
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
  const unchecked = uncheckedAccessResult(e, tag, {
    organizationId: opts.organizationId,
    extra: opts.extra,
  });
  if (unchecked) return unchecked;
  return unexpectedActionError(e, tag, opts);
}

/** A check of the caller's access that could not be read: each has one fixed sentence. */
function isUncheckedAccess(
  e: unknown,
): e is PermissionsUnavailableError | AccountStatusUnavailableError | ModulesUnavailableError {
  return (
    e instanceof PermissionsUnavailableError ||
    e instanceof AccountStatusUnavailableError ||
    e instanceof ModulesUnavailableError
  );
}

/**
 * The sentence for a check of the caller's access that could not be read, or
 * null for any other error.
 *
 * The three classes: a module state withContext() could not read
 * (ModulesUnavailableError, thrown when an action asks about that module), a
 * permission set that could not be read, an account status that could not be
 * read. None of them is a refusal and none is a fault of the action: each
 * carries one fixed sentence that says the check could not be made and to try
 * again, and is reported once, at warning level, under the action's tag.
 *
 * FOR AN ACTION MODULE THAT KEEPS ITS OWN ERROR MAPPING (its own result
 * shape, its own words for a failure). Such a mapping answers anything it
 * does not know with its generic sentence, which for these classes is the
 * wrong one: "something went wrong" where the truth is "your access could not
 * be checked". So every such mapping asks here first, right after it has let
 * Next control flow out, and answers this sentence in its own shape:
 *
 *   rethrowControlFlow(e);
 *   const unchecked = uncheckedAccessMessage(e, 'actions.example');
 *   if (unchecked) return { error: { message: unchecked } };
 *
 * server/actions/unchecked-access.guard.test.ts holds every catch in
 * server/actions to it (or to a reviewed reason).
 */
export function uncheckedAccessMessage(
  e: unknown,
  tag: string,
  opts: Pick<ActionErrorOptions, 'organizationId' | 'extra'> = {},
): string | null {
  if (!isUncheckedAccess(e)) return null;
  void reportError(e, reportContext(tag, { ...opts, level: 'warning' }));
  return e.message;
}

/**
 * uncheckedAccessMessage as an ActionResult: `internal_error` with the
 * check's sentence, or null for any other error. `details` are the ones the
 * module puts on its own failures (a reason its screen reads, the
 * organization that answered), so the screen treats this answer as it treats
 * the module's other failures. actionErrorResult answers through this.
 */
export function uncheckedAccessResult(
  e: unknown,
  tag: string,
  opts: Pick<ActionErrorOptions, 'organizationId' | 'extra'> & {
    details?: Record<string, unknown>;
  } = {},
): ActionResult<never> | null {
  const { details, ...reportOpts } = opts;
  const message = uncheckedAccessMessage(e, tag, reportOpts);
  if (message === null) return null;
  return details ? err('internal_error', message, details) : err('internal_error', message);
}

/**
 * The failed rows of one run: an import's rows, a reorder's suppliers (S31).
 * A row's words are a refusal the app wrote (a ServiceError other than
 * internal_error: a duplicate SKU, a plan limit; assertWarehouseAccess's or
 * forcedWarehouseId's ForbiddenError: no warehouse assignment, a read-only
 * auditor), else `opts.message` (ROW_NOT_IMPORTED_MESSAGE by default), never
 * the error's own text. A ForbiddenError from a failed read of the caller's
 * own access says the retryable access sentence, as actionErrorResult does,
 * and so does a check of the caller's access that could not be read (a module
 * state, the permission set, the account status), with its own sentence.
 * The unexpected ones are reported ONCE for the run (recurring pattern 30),
 * with their count and the first of them, by report(); the unreadable-access
 * ones once more, as a warning.
 */
export class RowFailures {
  private first: unknown;
  private unexpected = 0;
  private firstUnreadable: unknown;
  private unreadable = 0;

  constructor(
    private readonly tag: string,
    private readonly opts: Pick<ActionErrorOptions, 'organizationId' | 'message'> = {},
  ) {}

  /** The words for a row that threw `e`. Next control flow is thrown again. */
  message(e: unknown): string {
    rethrowControlFlow(e);
    if (e instanceof ServiceError && e.code !== 'internal_error') return e.message;
    if (e instanceof ForbiddenError) {
      if (!e.accessUnreadable) return e.message;
      this.unreadable += 1;
      if (this.unreadable === 1) this.firstUnreadable = e;
      return ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY;
    }
    // A check of the caller's access that could not be read (a module state,
    // the permission set, the account status): its own sentence, counted with
    // the unreadable-access rows and reported once for the run as a warning.
    if (isUncheckedAccess(e)) {
      this.unreadable += 1;
      if (this.unreadable === 1) this.firstUnreadable = e;
      return e.message;
    }
    this.unexpected += 1;
    if (this.unexpected === 1) this.first = e;
    return this.opts.message ?? ROW_NOT_IMPORTED_MESSAGE;
  }

  /**
   * One report for the run when any row failed for a reason the app did not
   * write, and one warning when any row's warehouse access could not be read.
   */
  report(): void {
    if (this.unreadable > 0) {
      void reportError(
        this.firstUnreadable,
        reportContext(this.tag, {
          organizationId: this.opts.organizationId,
          level: 'warning',
          extra: { failed: this.unreadable },
        }),
      );
    }
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
