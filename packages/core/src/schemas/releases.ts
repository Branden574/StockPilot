import { z } from 'zod';

import { PERMISSIONS, type Permission } from '../constants/permissions';
import { ROLES, type Role } from '../constants/roles';
import { MODULE_REGISTRY, type ModuleId } from '../modules/registry';

/**
 * Product releases ("What's New").
 *
 * A RELEASE is a user-facing announcement. A DEPLOYMENT is a build going live.
 * They are related and deliberately separate: StockPilot deploys roughly ten
 * times for every change worth telling anyone about, and one release may span
 * several deployments. Nothing here knows about deployments; the update
 * detector (apps/web/src/lib/updates) carries that half.
 *
 * Content is REPOSITORY-MANAGED: a typed registry in
 * apps/web/src/lib/releases/registry.ts, validated by these schemas in a test
 * that fails the build on bad content. There is no editor and no database of
 * release text, so a release can only be published by a reviewed pull request.
 * docs/releases/PUBLISHING.md is the workflow.
 *
 * Every entry must answer four questions, because "bug fixes and improvements"
 * tells a person nothing they can act on:
 *   whatChanged     the concrete change, in plain language
 *   whyItMatters    the problem it removes or the benefit it adds
 *   howItAffectsYou the effect on the reader's own work
 *   whatToDo        an action, or an explicit "No action needed."
 */

const MODULE_IDS = Object.keys(MODULE_REGISTRY) as [ModuleId, ...ModuleId[]];

/** kebab-case, stable forever: it is the key of every user's read state. */
const slug = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case');

/** One sentence to a short paragraph of plain text. Never markup. */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[<>]/.test(s), 'plain text only: no markup');

/**
 * Links stay inside the dashboard. Two reasons, both load-bearing:
 *   - old mobile binaries push a non-/dashboard href straight into the native
 *     router and land on "Unmatched Route"; an unknown /dashboard path is
 *     rewritten to home and the button is hidden, which is safe;
 *   - release content must never be able to send someone off-site.
 */
const dashboardHref = z
  .string()
  .max(200)
  .regex(
    /^\/dashboard(?:\/[A-Za-z0-9\-._~%/]*)?(?:\?[A-Za-z0-9\-._~%=&]*)?$/,
    'must be a /dashboard path',
  );

export const RELEASE_CATEGORIES = ['new', 'improved', 'fixed', 'action'] as const;
export type ReleaseCategory = (typeof RELEASE_CATEGORIES)[number];

/** Shown to the reader. Never colour alone: the label is always rendered. */
export const RELEASE_CATEGORY_LABELS: Record<ReleaseCategory, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  action: 'Action needed',
};

/**
 * Who may be told. EVERY listed dimension must pass (AND); inside a dimension
 * any value passes (OR). Omitted means everyone.
 *
 * `roles` alone is a weak proxy for reach: permissions are configurable per
 * organization and most features sit behind an optional module. An entry that
 * links to a page should name the permission and the module that page checks,
 * so nobody is told about something that would bounce them to the dashboard.
 */
export const releaseAudienceSchema = z
  .object({
    roles: z.array(z.enum(ROLES)).min(1).optional(),
    anyPermission: z.array(z.enum(PERMISSIONS)).min(1).optional(),
    modules: z.array(z.enum(MODULE_IDS)).min(1).optional(),
  })
  .strict();
export type ReleaseAudience = z.infer<typeof releaseAudienceSchema>;

export const releaseEntrySchema = z
  .object({
    id: slug,
    category: z.enum(RELEASE_CATEGORIES),
    /** The part of StockPilot affected, as the reader knows it ("Orders"). */
    area: plainText(40).optional(),
    title: plainText(120),
    whatChanged: plainText(600),
    whyItMatters: plainText(600),
    howItAffectsYou: plainText(600),
    whatToDo: plainText(400),
    link: z
      .object({ href: dashboardHref, label: plainText(40) })
      .strict()
      .optional(),
    audience: releaseAudienceSchema.optional(),
  })
  .strict();
export type ReleaseEntry = z.infer<typeof releaseEntrySchema>;

export const RELEASE_STATUSES = ['draft', 'published', 'withdrawn'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const releaseSchema = z
  .object({
    id: slug,
    /**
     * Announcement identity. Editing a typo does NOT bump it, so nobody who
     * already read the release is told again. Bump it only to deliberately
     * re-announce; read state is recorded against (id, revision).
     */
    revision: z.number().int().min(1),
    status: z.enum(RELEASE_STATUSES),
    /** Human-facing label, e.g. "2026.09". Optional; never a deployment id. */
    version: plainText(24).optional(),
    title: plainText(120),
    /**
     * One plain paragraph. It is ALSO what old mobile builds render as the
     * announcement body through GET /api/v1/me/announcements, so it must make
     * sense on its own.
     */
    summary: plainText(500),
    /** A full instant with an offset. A bare date parses as UTC midnight and
     *  shows as the previous day to anyone west of Greenwich. */
    publishedAt: z.string().datetime({ offset: true }),
    /** Shown in place of the entries when status is 'withdrawn'. */
    withdrawnNote: plainText(300).optional(),
    audience: releaseAudienceSchema.optional(),
    entries: z.array(releaseEntrySchema).min(1).max(12),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    for (const [i, e] of r.entries.entries()) {
      if (seen.has(e.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'id'],
          message: `duplicate entry id "${e.id}"`,
        });
      }
      seen.add(e.id);
    }
    if (r.status === 'withdrawn' && !r.withdrawnNote) {
      ctx.addIssue({
        code: 'custom',
        path: ['withdrawnNote'],
        message: 'a withdrawn release must say why',
      });
    }
  });
export type Release = z.infer<typeof releaseSchema>;

/**
 * The whole registry. Newest first, and ORDER IS MEANINGFUL: it is never
 * re-sorted by date, so two releases on the same day keep the order the author
 * chose. Dates must still not increase going down, so the list cannot lie.
 */
export const releaseRegistrySchema = z.array(releaseSchema).superRefine((list, ctx) => {
  const ids = new Set<string>();
  for (const [i, r] of list.entries()) {
    if (ids.has(r.id))
      ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate release id "${r.id}"` });
    ids.add(r.id);
    const prev = list[i - 1];
    if (prev && Date.parse(r.publishedAt) > Date.parse(prev.publishedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'publishedAt'],
        message: 'releases must be newest first',
      });
    }
  }
});

// ── Audience ────────────────────────────────────────────────────────────────

/** What the server knows about the reader. Built from the ServiceContext. */
export interface ReleaseViewer {
  role: Role;
  /** Effective permissions (role defaults + org and user overrides). */
  permissions: ReadonlySet<Permission> | readonly Permission[];
  enabledModules: ReadonlySet<ModuleId> | readonly ModuleId[];
}

function has<T>(set: ReadonlySet<T> | readonly T[], value: T): boolean {
  return Array.isArray(set)
    ? (set as readonly T[]).includes(value)
    : (set as ReadonlySet<T>).has(value);
}

/** PURE. True when every dimension the audience names is satisfied. */
export function audienceIncludes(
  audience: ReleaseAudience | undefined,
  viewer: ReleaseViewer,
): boolean {
  if (!audience) return true;
  if (audience.roles && !audience.roles.includes(viewer.role)) return false;
  if (audience.anyPermission && !audience.anyPermission.some((p) => has(viewer.permissions, p)))
    return false;
  if (audience.modules && !audience.modules.some((m) => has(viewer.enabledModules, m)))
    return false;
  return true;
}

// ── What leaves the server ──────────────────────────────────────────────────
//
// `audience` is STRIPPED before anything is sent: gating data is not the
// reader's business, and an entry the reader cannot reach is not sent at all.
// Clients parse these leniently (unknown keys are ignored), because an old tab
// must be able to read a release served by a NEWER deployment.

export const clientReleaseEntrySchema = z.object({
  id: z.string(),
  category: z.enum(RELEASE_CATEGORIES).catch('improved'),
  area: z.string().optional(),
  title: z.string(),
  whatChanged: z.string(),
  whyItMatters: z.string(),
  howItAffectsYou: z.string(),
  whatToDo: z.string(),
  link: z.object({ href: z.string(), label: z.string() }).optional(),
});
export type ClientReleaseEntry = z.infer<typeof clientReleaseEntrySchema>;

export const clientReleaseStateSchema = z.object({
  /** Read at the CURRENT revision. */
  read: z.boolean(),
  /** The notification for the current revision was closed. */
  dismissed: z.boolean(),
});

export const clientReleaseSummarySchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: z.enum(['published', 'withdrawn']).catch('published'),
  version: z.string().optional(),
  title: z.string(),
  summary: z.string(),
  publishedAt: z.string(),
  entryCount: z.number(),
  state: clientReleaseStateSchema,
});
export type ClientReleaseSummary = z.infer<typeof clientReleaseSummarySchema>;

export const clientReleaseSchema = clientReleaseSummarySchema.extend({
  withdrawnNote: z.string().optional(),
  entries: z.array(clientReleaseEntrySchema),
});
export type ClientRelease = z.infer<typeof clientReleaseSchema>;

export const clientReleaseListSchema = z.object({
  releases: z.array(clientReleaseSummarySchema),
  unreadCount: z.number(),
  /** The newest unread release the notification should offer, if any. */
  latestUnread: clientReleaseSummarySchema.nullable(),
  /**
   * False when the reader's state could not be loaded. Releases are then sent
   * as READ with nothing offered: an outage must not turn into a notification
   * for every release to every person. Absent on older servers = true.
   */
  stateAvailable: z.boolean().catch(true).default(true),
});
export type ClientReleaseList = z.infer<typeof clientReleaseListSchema>;

export const releaseStateActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss'), releaseId: slug }).strict(),
  z.object({ action: z.literal('open'), releaseId: slug }).strict(),
  z.object({ action: z.literal('read'), releaseId: slug }).strict(),
  z.object({ action: z.literal('read_all') }).strict(),
]);
export type ReleaseStateAction = z.infer<typeof releaseStateActionSchema>;
