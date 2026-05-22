import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OrgLogoUploader } from '@/components/settings/org-logo-uploader';
import { OrgNameEditor } from '@/components/settings/org-name-editor';
import { OrgTimezoneEditor } from '@/components/settings/org-timezone-editor';
import { PoTermsEditor } from '@/components/settings/po-terms-editor';
import { TerminologyEditor } from '@/components/settings/terminology-editor';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Organization</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Workspace name, labels for {current.charter_plural.toLowerCase()} and{' '}
          {current.warehouse_plural.toLowerCase()}.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Logo</CardTitle>
            <CardDescription>
              Square or wordmark, max 5 MB. Shown in the sidebar and on
              outbound emails.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrgLogoUploader
              organizationId={ctx.organizationId}
              initialUrl={(data?.logo_url as string | null) ?? null}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Name</CardTitle>
            <CardDescription>
              The display name of your organization. Shows in the sidebar header
              and on outbound emails.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrgNameEditor current={(data?.name as string | null) ?? ''} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timezone</CardTitle>
            <CardDescription>
              Pin every date and time the system renders — pick slips,
              packing slips, reports, schedule, dashboard — to your
              warehouse&apos;s local time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrgTimezoneEditor current={(data?.timezone as string | null) ?? null} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Labels</CardTitle>
            <CardDescription>
              Rename the top-level grouping and physical-site terms to match how
              your organization talks about them. Applies everywhere in the app.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TerminologyEditor current={current} defaults={DEFAULT_TERMINOLOGY} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Purchase order terms</CardTitle>
            <CardDescription>
              Free-form text printed at the bottom of every PO PDF you send
              to suppliers. Leave blank to omit the section entirely.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PoTermsEditor
              current={(data?.po_terms as string | null) ?? null}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
