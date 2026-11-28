'use client';

import type { ActionResult } from '@stockpilot/core';

/**
 * A vendor risk write, sent once; when the database (or the service) asks for
 * this session's authenticator code (aal2_required), the step-up modal opens
 * and, once the code is given, the same write is sent once more. Nothing was
 * written by the refused one, so this never sends a write twice.
 */
export async function sendWithStepUp<T>(
  run: () => Promise<ActionResult<T>>,
  ensure: () => Promise<boolean>,
): Promise<ActionResult<T>> {
  const first = await run();
  if (first.ok || first.error.details?.reason !== 'aal2_required') return first;
  if (!(await ensure())) return first;
  return run();
}

/** What the page says about a refused write. */
export interface SupplierRiskOutcome {
  text: string;
  /** The authenticator must be set up first: the page links to set-up. */
  setUp: boolean;
  /**
   * The draft moved since the page read it (another admin, another window):
   * the form keeps the answers and offers the other version beside them.
   */
  conflict: boolean;
}

export function supplierRiskOutcomeOf(error: {
  message: string;
  details?: Record<string, unknown>;
}): SupplierRiskOutcome {
  const reason = error.details?.reason;
  return {
    text: error.message,
    setUp: reason === 'mfa_required',
    conflict: reason === 'draft_moved',
  };
}
