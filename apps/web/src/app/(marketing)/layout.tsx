import type { ReactNode } from 'react';

import { MarketingFooter } from '@/components/marketing/footer';
import { MarketingHeader } from '@/components/marketing/header';
import { HideOnHome } from '@/components/marketing/hide-on-home';
import { MarketingJsonLd } from '@/components/marketing/json-ld';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      <MarketingJsonLd />
      {/* The scrollytelling homepage brings its own nav + footer; suppress the
          shared chrome on `/` only (sub-pages keep the standard header/footer). */}
      <HideOnHome>
        <MarketingHeader />
      </HideOnHome>
      <main className="flex-1">{children}</main>
      <HideOnHome>
        <MarketingFooter />
      </HideOnHome>
    </div>
  );
}
