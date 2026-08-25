import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Settings' };
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';

import { can } from '@stockpilot/core';
import { PageTour } from '@/components/onboarding/page-tour';
import { SETTINGS_TOUR } from '@/lib/onboarding/tours';

const BASE_SECTIONS = [
  { href: '/dashboard/settings/organization', title: 'Organization', description: 'Name, labels for charters and warehouses.' },
  { href: '/dashboard/settings/security', title: 'Security', description: 'Two-factor authentication and org MFA policy.' },
  { href: '/dashboard/settings/profile', title: 'Profile', description: 'Your name, avatar, and sign-in email.' },
  { href: '/dashboard/settings/notifications', title: 'Notifications', description: 'Weekly digest email and preferences.' },
  { href: '/dashboard/settings/roles', title: 'Roles & permissions', description: 'Reference for what each role can see and do across StockPilot.' },
];

// Billing is gated on the `billing:read` permission — staff/viewer
// roles can't visit /dashboard/settings/billing (the underlying page
// redirects them), so the tile was previously visible-but-broken.
// Show it only when the role actually has access.
const BILLING_SECTIONS = [
  { href: '/dashboard/settings/billing', title: 'Billing', description: 'Plan, invoices, payment method.' },
];

// Manager-and-above sections. Gated by can(ctx, 'orders:approve')
// so warehouse-scoped members don't see tiles they can't actually use —
// the underlying page redirects them anyway, but the tile is the
// discoverable surface.
const MANAGER_SECTIONS = [
  {
    href: '/dashboard/settings/public-requests',
    title: 'Public requests',
    description:
      'Shareable link external partners use to submit order requests — no account required.',
  },
];

const ADMIN_SECTIONS = [
  { href: '/dashboard/audit', title: 'Audit log', description: 'Every privileged action across the org.' },
];

// AI settings (embeddings backfill, etc.) — gated on the explicit
// `ai:manage` permission (admin+ in the matrix). Embedding backfill
// burns Gemini API quota and shouldn't be a manager-level toggle.
const AI_SECTIONS = [
  { href: '/dashboard/settings/ai', title: 'AI', description: 'Semantic-search embeddings and AI assistant configuration.' },
];

// Recovery (restoring soft-deleted rows) is a destructive admin action;
// gate on `items:delete` so manager can't restore items they couldn't
// delete in the first place. Owners and admins only.
const RECOVERY_SECTIONS = [
  { href: '/dashboard/settings/recovery', title: 'Recovery', description: 'Restore soft-deleted items, categories, suppliers, and locations.' },
  { href: '/dashboard/settings/restore-points', title: 'Backups & restore', description: 'Point-in-time snapshots of your inventory you can roll back to. Business plan.' },
  { href: '/dashboard/settings/inventory-cleanup', title: 'Archived item cleanup', description: 'Automatically delete items that have stayed archived past a set time. Recoverable.' },
];

// Industry template — one-click "set up as this industry" that turns on the
// pack's module set + suggests labels (non-destructive). Same
// `organization:update` gate as Modules; the underlying page redirects anyone
// without that permission.
const INDUSTRY_SECTIONS = [
  { href: '/dashboard/settings/industry', title: 'Industry template', description: 'Set up StockPilot for your industry in one click — Books, Distribution, Apparel, Food & Ag, or 3PL.' },
];

// Module control plane — turn features on or off for the whole org.
// Gated on `organization:update` so only admins and owners see the tile
// (the underlying page redirects anyone without that permission anyway).
const MODULES_SECTIONS = [
  { href: '/dashboard/settings/modules', title: 'Modules', description: 'Turn features on or off for your whole organization.' },
];

// Navigation customization — hide/rename/reorder sidebar items + add custom
// links for the whole org. Same `organization:update` gate as Modules; the
// underlying page redirects anyone without that permission.
const NAVIGATION_SECTIONS = [
  { href: '/dashboard/settings/navigation', title: 'Navigation', description: 'Customize the sidebar — hide, rename, and reorder items or add custom links.' },
];

// Dashboard customization — choose which landing-page cards show and in what
// order for the whole org. Same `organization:update` gate as Modules /
// Navigation; the underlying page redirects anyone without that permission.
const DASHBOARD_SECTIONS = [
  { href: '/dashboard/settings/dashboard', title: 'Dashboard', description: 'Choose which cards appear on the dashboard and in what order.' },
];

// Custom fields — per-org typed extra fields captured on every item. Same
// `organization:update` gate as Modules / Navigation; the underlying page
// redirects anyone without that permission.
const CUSTOM_FIELDS_SECTIONS = [
  { href: '/dashboard/settings/custom-fields', title: 'Custom fields', description: 'Define extra item fields — warranty, voltage, color, and more.' },
];

// Order statuses — rename + recolor the order request status badges for the
// whole org (a soft presentation override; the workflow is unchanged). Same
// `organization:update` gate as Modules / Navigation; the underlying page
// redirects anyone without that permission.
const ORDER_STATUS_SECTIONS = [
  { href: '/dashboard/settings/order-statuses', title: 'Order statuses', description: 'Rename and recolor the status badges shown on order requests.' },
];

// Integrations control plane — connect external tools (QuickBooks Online).
// Gated on `integrations:manage` (owner+admin); the underlying page also
// redirects anyone without that permission.
const INTEGRATIONS_SECTIONS = [
  { href: '/dashboard/settings/integrations', title: 'Integrations', description: 'Connect QuickBooks Online and other tools to export your data.' },
];

// Email routing — where the delivery-request and maintenance-request compose
// emails are addressed, per organization (organizations.email_routing,
// migration 0337). Same `organization:update` gate as Modules / Navigation
// (it matches the RLS floor: organizations_update = admin); the underlying
// page redirects anyone without that permission. NOT gated on any module:
// delivery requests belong to the core `orders` module, and an unconfigured
// org's admins need this tile to discover WHY their email actions are hidden.
const EMAIL_ROUTING_SECTIONS = [
  {
    href: '/dashboard/settings/email-routing',
    title: 'Email routing',
    description:
      'Where delivery and maintenance request emails are addressed for your organization.',
  },
];

// Maintenance requests — owner-only configuration (categories, notification
// audience, photo-link-in-email toggle; the fixed recipients display
// read-only). Per-user read_all/manage GRANTS route entirely through Roles
// & permissions (the existing per-user override system) — this tile only
// links there, it does not duplicate that matrix. Gated on BOTH
// `maintenance_requests:configure` (owner-only by design, adjudication C2 —
// filtered out of admin's derived permission set) AND the module actually
// being enabled: maintenance_requests is `defaultOnFor: []` (off by
// default), unlike every other tile in this hub today, so this is the
// first tile here that needs a module-enabled check alongside its
// permission check — a disabled module's settings shouldn't clutter
// Settings for orgs that never turned it on.
const MAINTENANCE_SECTIONS = [
  {
    href: '/dashboard/settings/maintenance',
    title: 'Maintenance requests',
    description: 'Categories, notification audiences, and photo link settings.',
  },
];

export default async function SettingsPage() {
  const ctx = await requireOrgContext();
  const maintenanceAccess = await checkModuleAccess('maintenance_requests');
  const sections = [
    ...BASE_SECTIONS,
    ...(can(ctx, 'billing:read') ? BILLING_SECTIONS : []),
    ...(can(ctx, 'orders:approve') ? MANAGER_SECTIONS : []),
    ...(can(ctx, 'activity_logs:read') ? ADMIN_SECTIONS : []),
    ...(can(ctx, 'ai:manage') ? AI_SECTIONS : []),
    ...(can(ctx, 'items:delete') ? RECOVERY_SECTIONS : []),
    ...(can(ctx, 'organization:update') ? INDUSTRY_SECTIONS : []),
    ...(can(ctx, 'organization:update') ? MODULES_SECTIONS : []),
    ...(can(ctx, 'organization:update') ? NAVIGATION_SECTIONS : []),
    ...(can(ctx, 'organization:update') ? DASHBOARD_SECTIONS : []),
    ...(can(ctx, 'organization:update') ? CUSTOM_FIELDS_SECTIONS : []),
    ...(can(ctx, 'organization:update') ? ORDER_STATUS_SECTIONS : []),
    ...(can(ctx, 'organization:update') ? EMAIL_ROUTING_SECTIONS : []),
    ...(can(ctx, 'integrations:manage') ? INTEGRATIONS_SECTIONS : []),
    ...(maintenanceAccess.enabled && can(ctx, 'maintenance_requests:configure')
      ? MAINTENANCE_SECTIONS
      : []),
  ];
  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage your workspace and account.</p>
      <div className="mt-2"><PageTour tour={SETTINGS_TOUR} /></div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href}>
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle className="text-base">{s.title}</CardTitle>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
              <CardContent />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
