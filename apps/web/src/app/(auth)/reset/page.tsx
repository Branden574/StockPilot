import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthCard } from '@/components/auth/auth-card';
import { ResetForm } from '@/components/auth/reset-form';

export const metadata: Metadata = {
  title: 'Reset password',
};

export default function ResetPage() {
  return (
    <AuthCard
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
      <ResetForm />
    </AuthCard>
  );
}
