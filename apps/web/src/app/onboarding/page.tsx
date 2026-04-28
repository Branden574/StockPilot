import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CreateOrganizationForm } from '@/components/onboarding/create-organization-form';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-mesh" />
      <header className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/">
          <IconMark />
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg">
          <Card className="border-border/60 shadow-xl">
            <CardHeader>
              <CardTitle className="text-2xl">Create your workspace</CardTitle>
              <CardDescription>
                We'll set you up with a default location so you can start adding inventory right away.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateOrganizationForm />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
