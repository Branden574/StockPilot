/**
 * The AsyncStorage key holding the active workspace (organization) id.
 *
 * ONE copy (recurring pattern #26). use-workspace.ts writes it, api.ts
 * orgHeader() sends it as X-Organization-Id, and session-scope.ts stamps it on
 * every queued outbox row. Three literals used to exist; renaming one of them
 * would have made the outbox stamp organization NULL on every row, so after a
 * workspace switch rows would be sent under whichever workspace was live at
 * send time (the 404/403 terminal rejection S4a fixed), and no test would
 * have failed. workspace-keys.wiring.test.ts keeps it to this one place.
 *
 * A leaf module with no imports, so api.ts can use it without the cycle that
 * importing use-workspace would create (use-workspace -> sync -> api).
 */
export const ACTIVE_ORG_STORAGE_KEY = 'workspace.activeOrgId';
