import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthCard } from '@/components/auth/auth-card';
import { ResetForm } from '@/components/auth/reset-form';

export const metadata: Metadata = {
  title: 'Reset password',
};

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <AuthCard
      eyebrow="Password reset"
      title="Reset your password"
      description="We'll email you a link to set a new password."
      footer={
        <>
          Remembered it?{' '}
          <Link href="/signin" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {error === 'link_expired' && (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          That reset link has expired or was already used. Enter your email
          below and we&apos;ll send a fresh one.
        </p>
      )}
      <ResetForm />
    </AuthCard>
  );
}
