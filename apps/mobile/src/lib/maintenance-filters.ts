import {
  MAINTENANCE_STATUS_LABELS,
  type MaintenanceAttachmentKind,
  type MaintenanceStatus,
} from '@stockpilot/core';

/**
 * Pure decision helpers behind the maintenance list's status-filter chips
 * and the detail screen's status pill / resolution-card / photo-kind split
 * (Task 9). Extracted here — rather than left inline in
 * app/(drawer)/maintenance.tsx or app/maintenance/[id].tsx — because this
 * repo's vitest cannot render app/ screens (they import native modules at
 * module load; see vitest.config.ts). Same "source-pin honesty" posture
 * debounced-list-load.ts established for Task 18: every DECISION a screen
 * makes from these fields is delegated to a function below and gets a real
 * behavioral test, so a screen edit that breaks the logic fails a test here
 * rather than only a text pin that can't prove runtime behavior.
 */

export interface MaintenanceStatusChip {
  /** The route's own `status` query value for this chip — `undefined` for
   *  "All" (the param is simply omitted), `'active'` for the synthetic
   *  saved-or-draft_opened shorthand the service already understands, or one
   *  of the five real statuses. */
  value: MaintenanceStatus | 'active' | undefined;
  label: string;
}

/**
 * All · Active · one chip per real status, in `MAINTENANCE_STATUS_LABELS`'s
 * own insertion order (saved, draft_opened, resolved, archived, cancelled —
 * spec §1.1: that order is load-bearing). Mirrors the web list page's
 * `STATUS_FILTERS` (apps/web/src/app/(dashboard)/dashboard/maintenance/
 * page.tsx:32-42), which derives the same five from the same record plus a
 * hand-typed `'active'` entry; web then renders an "All statuses" link
 * OUTSIDE that array as a separate JSX element, but mobile's chip row has no
 * such split, so "All" is folded into this ONE derived list instead of
 * being hand-typed a second time in the screen.
 */
export const MAINTENANCE_STATUS_CHIPS: MaintenanceStatusChip[] = [
  { value: undefined, label: 'All' },
  { value: 'active', label: 'Active' },
  ...(Object.entries(MAINTENANCE_STATUS_LABELS) as [MaintenanceStatus, string][]).map(
    ([status, label]) => ({ value: status, label }),
  ),
];

/**
 * Maps a tapped chip's LABEL (what the list screen keeps as its selection
 * state — the Pill children the user actually tapped) back to the
 * `status` query value `listMaintenanceRequests` expects. An unrecognized
 * label (should never happen — every chip the screen renders comes from
 * `MAINTENANCE_STATUS_CHIPS` itself) degrades to `undefined`, the same as
 * "All", rather than throwing.
 */
export function statusQueryParam(selected: string): MaintenanceStatus | 'active' | undefined {
  return MAINTENANCE_STATUS_CHIPS.find((chip) => chip.label === selected)?.value;
}

export type MaintenanceStatusPillTone = 'default' | 'ok' | 'warn' | 'crit';

/**
 * Status -> Pill tone (T2's mapping). Extracted so the list row and the
 * detail header share ONE tested source instead of two hand-typed
 * `Record<MaintenanceStatus, ...>` copies that could silently drift apart —
 * exactly the class of bug an unused/stale duplicate invites.
 */
const STATUS_PILL_TONE: Record<MaintenanceStatus, MaintenanceStatusPillTone> = {
  saved: 'default',
  draft_opened: 'warn',
  resolved: 'ok',
  archived: 'default',
  cancelled: 'default',
};

export function statusPillTone(status: MaintenanceStatus): MaintenanceStatusPillTone {
  return STATUS_PILL_TONE[status] ?? 'default';
}

/**
 * Resolution-card visibility (detail screen). Gated on the ONE fact that
 * actually means "resolved" — `resolvedAt` — never on `resolutionNote`
 * being non-empty or on any resolution photo existing, matching web's own
 * adjudicated posture (page.tsx's fix-wave comment): a manager can stage
 * resolution proof photos before ever confirming the Resolve dialog, so
 * photo presence alone must never claim the request was actually resolved.
 */
export function shouldShowResolutionCard(detail: { resolvedAt: string | null }): boolean {
  return Boolean(detail.resolvedAt);
}

export interface SplitPhotosByKind<T> {
  requester: T[];
  resolution: T[];
}

/**
 * Splits a request's photos into the requester-attached set and the
 * resolution-proof set, mirroring web's page.tsx exactly:
 * `requesterPhotos = photos.filter((p) => (p.kind ?? 'requester') ===
 * 'requester')` / `resolutionPhotos = photos.filter((p) => p.kind ===
 * 'resolution')`. The `?? 'requester'` fallback on the requester side (not
 * mirrored on the resolution side) is deliberate and matches web
 * byte-for-byte: a row with a missing/null `kind` — legacy data, or a
 * caller on a stale cached response shape — must default to "requester",
 * never silently vanish from both buckets and never silently count as
 * resolution proof it never was.
 *
 * Generic over `T` (not hard-typed to `MobileMaintenancePhoto`) so this
 * module never needs to import from `./maintenance-api` — avoids even the
 * possibility of a future circular import between the two files.
 */
export function splitPhotosByKind<T extends { kind?: MaintenanceAttachmentKind | null }>(
  photos: T[],
): SplitPhotosByKind<T> {
  return {
    requester: photos.filter((p) => (p.kind ?? 'requester') === 'requester'),
    resolution: photos.filter((p) => p.kind === 'resolution'),
  };
}
