import type { Metadata } from 'next';

import type { LinkPartProps } from '@/components/marketing/content/parts';
import { SUPPORT, SUPPORT_METADATA, supportLede } from '@/components/marketing/content/support';
import { SupportForm } from '@/components/marketing/support-form';

// The words and metadata live in components/marketing/content/support.tsx,
// shared with the Liquid Glass twin so the two can never drift.
export const metadata: Metadata = SUPPORT_METADATA;

export default function SupportPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
      <h1 className="font-display text-[34px] font-medium leading-[1.15] tracking-[-0.025em] sm:text-[40px]">
        {SUPPORT.heading}
      </h1>
      <p className="text-muted-foreground mt-3 max-w-xl text-[15px] leading-relaxed">
        {supportLede({ Anchor })}
      </p>

      <div className="mt-10">
        <SupportForm />
      </div>
    </div>
  );
}

function Anchor({ href, children }: LinkPartProps) {
  return (
    <a href={href} className="text-foreground underline-offset-4 hover:underline">
      {children}
    </a>
  );
}
