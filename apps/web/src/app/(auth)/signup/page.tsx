import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Sign up',
  description: 'StockPilot is invite-only.',
};

/**
 * Public self-signup is disabled — this is an internal-company tool.
 * Users join only via an admin-issued invite link.
 */
export default function SignUpPage() {
  return (
    <AuthCard
      title="Invite-only access"
      description="StockPilot is a private company tool. Accounts are created by admin invitation."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/signin" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-[13px] text-[var(--ed-ink-3)]">
          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ed-ink-4)]" />
          <p>
            If you&apos;re expecting access, your administrator will email you an invite link. Open
            that email and click <span className="font-medium text-foreground">Accept invite</span>{' '}
            to set up your account.
          </p>
        </div>
        <p className="text-[12.5px] text-[var(--ed-ink-4)]">
          Need access? Reach out to your company&apos;s StockPilot administrator and ask them to
          invite you. They can assign you to a charter and warehouse from the admin dashboard.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/signin">Back to sign in</Link>
        </Button>
      </div>
    </AuthCard>
  );
}
