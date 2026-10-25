import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthCard } from '@/components/auth/auth-card';
import { AuthNotice } from '@/components/auth/auth-notice';
import { ResetForm } from '@/components/auth/reset-form';
import { resetNotice } from '@/lib/auth/auth-page-notices';

export const metadata: Metadata = {
  title: 'Reset password',
};

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  // app/auth/confirm sends an expired or used recovery link here with
  // ?error=link_expired, and one it refused from another site with
  // ?error=link_refused; every value is decided in lib/auth/auth-page-notices.ts
  // and none is ever printed.
  const notice = resetNotice(error);
  return (
    <AuthCard
      eyebrow="Password reset"
      title="Reset your password"
      description="We'll email you a link to set a new password."
      footer={
        <>
          Remembered it?{' '}
          <Link href="/signin" className="text-foreground font-medium hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {notice ? <AuthNotice notice={notice} /> : null}
      <ResetForm />
    </AuthCard>
  );
}
