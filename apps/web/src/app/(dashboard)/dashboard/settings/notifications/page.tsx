import Link from 'next/link';

import { DigestControls } from '@/components/settings/digest-controls';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

export default async function NotificationsSettingsPage() {
  const session = await requireSession();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select(
      'email_digest_optin, digest_section_low_stock, digest_section_open_pos, digest_section_cycle_counts',
    )
    .eq('id', session.userId)
    .maybeSingle();

  const p = profile as {
    email_digest_optin?: boolean;
    digest_section_low_stock?: boolean;
    digest_section_open_pos?: boolean;
    digest_section_cycle_counts?: boolean;
  } | null;

  const optIn = Boolean(p?.email_digest_optin ?? false);
  const sections = {
    lowStock: p?.digest_section_low_stock ?? true,
    openPos: p?.digest_section_open_pos ?? true,
    cycleCounts: p?.digest_section_cycle_counts ?? true,
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Control which emails StockPilot sends you.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly inventory digest</CardTitle>
          <CardDescription>
            One email per week summarizing what needs attention.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DigestControls initialOptIn={optIn} initialSections={sections} />
        </CardContent>
      </Card>
    </div>
  );
}
