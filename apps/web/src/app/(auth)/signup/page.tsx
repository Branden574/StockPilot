import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthCard } from '@/components/auth/auth-card';
import { SignUpForm } from '@/components/auth/sign-up-form';

export const metadata: Metadata = {
  title: 'Create account',
  description: 'Start your StockPilot free trial.',
};

export default function SignUpPage() {
  return (
    <AuthCard
      title="Start free"
      description="14 days of Pro features. No credit card."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/signin" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SignUpForm />
    </AuthCard>
  );
}
