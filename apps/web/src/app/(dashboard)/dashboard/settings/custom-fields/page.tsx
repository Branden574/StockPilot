import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CustomFieldsEditor } from '@/components/settings/custom-fields-editor';
import { requireOrgContext } from '@/lib/auth/session';
import { CustomFieldsService } from '@/server/services/custom-fields';

import { can } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Custom fields — Settings' };

/**
 * Admin-only editor for per-org item custom field DEFINITIONS. Each definition
 * names a snake_case key stored inside inventory_items.custom_fields and is
 * rendered into the item form by <CustomFieldsInputs>. Gated on
 * `organization:update` (owner/admin) — mirrors Modules / Navigation.
 */
export default async function CustomFieldsSettingsPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) {
    redirect('/dashboard');
  }

  const service = await CustomFieldsService.forCurrentUser();
  const definitions = await service.listDefinitions('item', { includeArchived: true });

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Custom fields</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Define extra fields to capture on every item — warranty length, voltage, color, and
          anything else specific to your inventory. Fields appear on the item form and detail
          view for your whole organization.
        </p>
      </div>

      <CustomFieldsEditor initialDefinitions={definitions} />
    </div>
  );
}
