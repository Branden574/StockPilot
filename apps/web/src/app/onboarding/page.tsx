import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AuthCard } from '@/components/auth/auth-card';
import { ExternalShell } from '@/components/auth/external-shell';
import { CreateOrganizationForm } from '@/components/onboarding/create-organization-form';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { IconMark } from '@/components/ui/icon-mark';
import { requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Create workspace',
};

export default async function OnboardingPage() {
  const session = await requireSession();
  const supabase = await createClient();

  // If they already belong to an org, skip onboarding.
  const { data: existing } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', session.userId)
    .not('accepted_at', 'is', null)
    .limit(1)
    .maybeSingle();

  if (existing) redirect('/dashboard');

  // The shared external frame and the auth card (P5.1): a flat ground (no
  // mesh), the brand link and the theme menu, and one card. The user has no
  // workspace yet, so there is no app navigation to show.
  return (
    <ExternalShell
      width="lg"
      topBar={
        <>
          <Link
            href="/"
            className="focus-visible:ring-ring rounded-md focus-visible:outline-none focus-visible:ring-2"
          >
            <IconMark />
          </Link>
          <ThemeToggle />
        </>
      }
    >
      <AuthCard
        title="Create your workspace"
        description="We'll set you up with a default location so you can start adding inventory right away."
      >
        <CreateOrganizationForm />
      </AuthCard>
    </ExternalShell>
  );
}
