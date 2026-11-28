import 'server-only';

import { notFound, redirect } from 'next/navigation';

import { AUTHENTICATOR_SET_UP_URL } from '@stockpilot/core';

import { ServiceError } from '@/server/services/context';

/**
 * Where a vendor risk page sends a refusal (the sign-in alerts page's rule,
 * with Page not found for everyone else, as the admin-only pages here do):
 *   - the authenticator step owed: to set-up (mfa_required), or to the code
 *     page and back here (aal2_required);
 *   - any other refusal (not an owner or admin, the Suppliers module off):
 *     Page not found, so a member who may not see the reviews learns nothing
 *     about them.
 * Anything that is not a refusal is thrown on (the could-not-check errors
 * reach the dashboard's "couldn't check your access" card).
 */
export function sendSupplierRiskRefusalAway(e: unknown, here: string): never {
  if (e instanceof ServiceError && e.code === 'forbidden') {
    const reason = e.details?.reason;
    if (reason === 'mfa_required') redirect(AUTHENTICATOR_SET_UP_URL);
    if (reason === 'aal2_required') redirect(`/signin/mfa?redirect=${encodeURIComponent(here)}`);
    notFound();
  }
  if (e instanceof ServiceError && e.code === 'module_disabled') notFound();
  throw e;
}
