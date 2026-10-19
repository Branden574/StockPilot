import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SettingsPage } from '@/components/settings/settings-nav';
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
    <SettingsPage>
      <PageHeader
        title="Custom fields"
        subline={
          'Define extra fields to capture on every item — warranty length, voltage, color, and anything else specific to your inventory. Fields appear on the item form and detail view for your whole organization.'
        }
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      <CustomFieldsEditor initialDefinitions={definitions} />
    </SettingsPage>
  );
}
