import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { SignInForm } from '@/components/auth/sign-in-form';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your StockPilot account.',
};

export default function SignInPage() {
  return (
    <AuthCard
      title="Welcome back"
      description="Sign in to continue managing your inventory."
      footer={
        <>
          New to StockPilot?{' '}
          <Link href="/signup" className="font-medium text-foreground hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <Suspense fallback={<SignInSkeleton />}>
        <SignInForm />
      </Suspense>
    </AuthCard>
  );
}

function SignInSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
