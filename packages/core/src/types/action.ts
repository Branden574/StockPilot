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
  | 'internal_error';

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function err(code: ActionErrorCode, message: string, details?: Record<string, unknown>): ActionResult<never> {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}
