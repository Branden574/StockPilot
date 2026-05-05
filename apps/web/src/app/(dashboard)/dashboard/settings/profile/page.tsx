import Link from 'next/link';

import { ProfileNameEditor } from '@/components/settings/profile-name-editor';
import { AvatarUploader } from '@/components/settings/avatar-uploader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

export default async function ProfileSettingsPage() {
  const session = await requireSession();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('full_name, avatar_url, email')
    .eq('id', session.userId)
    .maybeSingle();

  const fullName = (profile?.full_name as string | null) ?? null;
  const avatarUrl = (profile?.avatar_url as string | null) ?? null;
  const email = (profile?.email as string | null) ?? session.email;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your name and avatar shown across the app.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Avatar</CardTitle>
            <CardDescription>
              Square images look best. Max 5 MB. PNG, JPG, WEBP, or AVIF.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AvatarUploader
              userId={session.userId}
              initialUrl={avatarUrl}
              fullName={fullName}
              email={email}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Name</CardTitle>
            <CardDescription>
              Shown on movements, invites, and audit log entries you create.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileNameEditor current={fullName ?? ''} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Email</CardTitle>
            <CardDescription>
              Sign-in email. Changing this requires verifying the new address —
              ask your admin if you need to.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm tabular-nums">{email}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
