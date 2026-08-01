export type ActionResult<TData = void> =
  | { ok: true; data: TData }
  | { ok: false; error: ActionError };

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}

export type ActionErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'plan_limit_exceeded'
  | 'module_disabled'
  | 'conflict'
  | 'rate_limited'
  /**
   * The credentials were VALID but the account is disabled by a platform
   * admin. Distinct from `unauthenticated` on purpose: the sign-in form routes
   * this one to the dedicated /account-disabled screen instead of toasting
   * "Invalid email or password", which would send a locked-out user on a
   * password-reset wild goose chase.
   */
  | 'account_disabled'
  | 'internal_error';

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function err(code: ActionErrorCode, message: string, details?: Record<string, unknown>): ActionResult<never> {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}
