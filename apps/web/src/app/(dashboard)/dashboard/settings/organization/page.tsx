import { redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { OrgLogoUploader } from '@/components/settings/org-logo-uploader';
import { OrgNameEditor } from '@/components/settings/org-name-editor';
import { OrgTimezoneEditor } from '@/components/settings/org-timezone-editor';
import { PoTermsEditor } from '@/components/settings/po-terms-editor';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
import { TerminologyEditor } from '@/components/settings/terminology-editor';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import { DEFAULT_TERMINOLOGY, resolveTerminology } from '@stockpilot/core';

export default async function OrganizationSettingsPage() {
  const ctx = await requireOrgContext();
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    redirect('/dashboard/settings');
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from('organizations')
    .select('terminology, name, logo_url, po_terms, timezone')
    .eq('id', ctx.organizationId)
    .maybeSingle();

  const current = resolveTerminology(
    (data?.terminology as Partial<typeof DEFAULT_TERMINOLOGY>) ?? null,
  );

  return (
    <SettingsPage>
      <PageHeader
        title="Organization"
        subline={
          <>
            Workspace name, labels for {current.charter_plural.toLowerCase()} and{' '}
            {current.warehouse_plural.toLowerCase()}.
          </>
        }
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      <SettingsPanel
        title="Logo"
        description="Square or wordmark, max 5 MB. Shown in the sidebar and on outbound emails."
      >
        <OrgLogoUploader
          organizationId={ctx.organizationId}
          initialUrl={(data?.logo_url as string | null) ?? null}
        />
      </SettingsPanel>

      <SettingsPanel
        title="Name"
        description="The display name of your organization. Shows in the sidebar header and on outbound emails."
      >
        <OrgNameEditor current={(data?.name as string | null) ?? ''} />
      </SettingsPanel>

      <SettingsPanel
        title="Timezone"
        description="Pin every date and time the system renders — pick slips, packing slips, reports, schedule, dashboard — to your warehouse's local time."
      >
        <OrgTimezoneEditor current={(data?.timezone as string | null) ?? null} />
      </SettingsPanel>

      <SettingsPanel
        title="Labels"
        description="Rename the top-level grouping and physical-site terms to match how your organization talks about them. Applies everywhere in the app."
      >
        <TerminologyEditor current={current} defaults={DEFAULT_TERMINOLOGY} />
      </SettingsPanel>

      <SettingsPanel
        title="Purchase order terms"
        description="Free-form text printed at the bottom of every PO PDF you send to suppliers. Leave blank to omit the section entirely."
      >
        <PoTermsEditor current={(data?.po_terms as string | null) ?? null} />
      </SettingsPanel>
    </SettingsPage>
  );
}
