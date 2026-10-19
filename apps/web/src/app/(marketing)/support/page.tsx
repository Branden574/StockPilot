import type { Metadata } from 'next';

import { SupportForm } from '@/components/marketing/support-form';
import { COMPANY_NAME, SUPPORT_EMAIL } from '@/lib/site';

export const metadata: Metadata = {
  // The root layout's title template adds " · StockPilot" (CONFLICTS D15).
  title: 'Support',
  description: `Report a problem or ask a question — the ${COMPANY_NAME} team will get back to you.`,
};

export default function SupportPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 sm:px-8">
      <h1 className="font-display text-[34px] font-medium leading-[1.15] tracking-[-0.025em] sm:text-[40px]">
        Support
      </h1>
      <p className="text-muted-foreground mt-3 max-w-xl text-[15px] leading-relaxed">
        Something not working, or have a question? Send us a ticket below and we&apos;ll get back to
        you — usually within 1–2 business days. You can also email{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-foreground underline-offset-4 hover:underline">
          {SUPPORT_EMAIL}
        </a>
        .
      </p>

      <div className="mt-10">
        <SupportForm />
      </div>
    </div>
  );
}
