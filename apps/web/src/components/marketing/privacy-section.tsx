'use client';

import {
  BellRing,
  FileDown,
  Fingerprint,
  History,
  Lock,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { useInView } from '@/lib/hooks/use-in-view';
import { cn } from '@/lib/utils';

// Every claim here is shipped and verifiable in the codebase — no aspirational
// certifications (we are NOT SOC 2 / ISO certified and must not imply it).
// RLS = 0144+ policies; admin MFA default = 0167; device alerts = 0168;
// account deletion = 0171; CCPA section lives at /privacy#california.
const ITEMS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ShieldCheck,
    title: 'Isolation enforced in the database',
    body: 'Every row is scoped to your organization with PostgreSQL row-level security. Tenant isolation is enforced by the database itself — not just the app code in front of it.',
  },
  {
    icon: Lock,
    title: 'Encrypted in transit and at rest',
    body: 'All traffic runs over TLS, and your data is encrypted at rest (AES-256) on our infrastructure providers. Secrets and API keys are stored hashed — we can’t read them back either.',
  },
  {
    icon: Fingerprint,
    title: 'Two-factor authentication',
    body: 'TOTP two-factor auth on web and mobile, on by default for admin accounts. Rate limiting guards sign-in and every sensitive endpoint.',
  },
  {
    icon: BellRing,
    title: 'New-device sign-in alerts',
    body: 'Sign in from a device we haven’t seen before and the account owner gets notified — so a stolen password doesn’t go unnoticed.',
  },
  {
    icon: History,
    title: 'A full audit trail',
    body: 'Every inventory change, order, and admin action lands in an audit log with who, what, and when. Accountability is a feature, not an afterthought.',
  },
  {
    icon: FileDown,
    title: 'Your data stays yours',
    body: 'We don’t sell or share your data — no ads, no brokers. Export everything to CSV, Excel, or PDF anytime, and delete your account (and your data with it) whenever you choose.',
  },
];

export function PrivacySection() {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <section id="privacy" className="border-t border-border bg-[color-mix(in_oklab,_hsl(var(--card))_55%,_transparent)]">
      <div className="mx-auto max-w-[1280px] scroll-mt-16 px-8 py-[72px]">
        <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
          — How we protect your privacy
        </p>
        <h2 className="max-w-3xl font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
          Your inventory is your business.{' '}
          <span className="font-serif-italic text-[var(--ed-ink-3)]">We keep it that way.</span>
        </h2>

        <div ref={ref} className="mt-9 grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
          {ITEMS.map((f, i) => (
            <article
              key={f.title}
              className={cn('reveal-up flex min-h-[180px] flex-col gap-3 bg-card p-7', inView && 'is-in')}
              style={{ transitionDelay: `${i * 55}ms` }}
            >
              <f.icon className="h-[22px] w-[22px] text-foreground" strokeWidth={1.4} />
              <h3 className="font-display text-[16px] font-medium tracking-[-0.01em]">{f.title}</h3>
              <p className="text-[13.5px] leading-[1.55] text-[var(--ed-ink-3)]">{f.body}</p>
            </article>
          ))}
        </div>

        <p className="mt-5 text-[13px] leading-relaxed text-[var(--ed-ink-3)]">
          The fine print, in plain language:{' '}
          <Link href="/privacy" className="text-foreground underline-offset-4 hover:underline">
            Privacy Policy
          </Link>{' '}
          ·{' '}
          <Link href="/privacy#california" className="text-foreground underline-offset-4 hover:underline">
            California privacy rights
          </Link>{' '}
          ·{' '}
          <Link href="/terms" className="text-foreground underline-offset-4 hover:underline">
            Terms of Service
          </Link>
        </p>
      </div>
    </section>
  );
}
