import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthCard } from '@/components/auth/auth-card';
import { ResetCompleteForm } from '@/components/auth/reset-complete-form';

export const metadata: Metadata = {
  title: 'Set new password',
};

export default function ResetCompletePage() {
  return (
    <AuthCard
      title="Set a new password"
      description="Choose a strong password you don't use anywhere else."
      footer={
        <>
          Changed your mind?{' '}
          <Link href="/signin" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <ResetCompleteForm />
    </AuthCard>
  );
}
