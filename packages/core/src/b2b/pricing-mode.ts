/**
 * How an organisation's B2B portal treats money. Some orgs sell to their
 * customers; others (L4L North Region distributing to its schools) hand stock
 * out at no cost, where a price column, a request-quote action and an order
 * total are all meaningless.
 *
 * Stored per org in organization_modules.settings jsonb under `pricingMode`
 * for the b2b_portal module — the same per-module settings pattern as
 * autoArchiveOnZeroStock.
 */
export type PortalPricingMode = 'no_charge' | 'priced';

const MODES: readonly string[] = ['no_charge', 'priced'];

/**
 * Read the mode out of a module settings jsonb. Anything absent, malformed or
 * unrecognised resolves to `no_charge` — the safe direction, because a
 * misconfigured org must never accidentally display prices to a customer.
 */
export function resolvePortalPricingMode(settings: unknown): PortalPricingMode {
  if (!settings || typeof settings !== 'object') return 'no_charge';
  const raw = (settings as Record<string, unknown>).pricingMode;
  return typeof raw === 'string' && MODES.includes(raw) ? (raw as PortalPricingMode) : 'no_charge';
}
