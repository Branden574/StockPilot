import { useWorkspace } from './use-workspace';

interface OrgState {
  orgId: string | null;
  orgName: string | null;
  loading: boolean;
}

/**
 * Resolves the ACTIVE workspace org — the one chosen in the drawer's org
 * switcher — and stays in sync when the user switches.
 *
 * Thin adapter over useWorkspace so every list screen that consumes useOrg()
 * (movements, purchase-orders, orders, suppliers, locations, reports, tags,
 * procedures, po-imports, schedule, rentals, categories, …) follows the
 * switcher. It previously resolved the user's FIRST accepted membership and
 * cached it for the whole app session — which made org switching a no-op on
 * mobile/iPad (web switched fine because it derives the org per request). The
 * returned shape is unchanged, so no consumer needs to change.
 */
export function useOrg(): OrgState {
  const { activeOrgId, activeOrgName, loading } = useWorkspace();
  return { orgId: activeOrgId, orgName: activeOrgName, loading };
}
