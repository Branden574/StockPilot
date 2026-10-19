import { Compass } from 'lucide-react';
import Link from 'next/link';

import { DetailSection } from '@/components/patterns/detail-section';

/**
 * Demo-account scenario menu (owner PRD §8) — rendered ONLY inside the demo
 * organization (checked by the caller). Each scenario is a real guided path
 * through sample data: safe to try, and several arrive with the page's tour
 * auto-started (?tour=). Server component; pure links.
 */

/** StockPilot Demo Co — the App Store reviewer / prospect playground org. */
export const DEMO_ORG_ID = '71b27a4a-7948-4638-bc3f-535974713bd2';

const SCENARIOS: { title: string; body: string; href: string; cta: string }[] = [
  {
    title: 'Add your first item',
    body: 'Only a name is required — see how little it takes to start tracking.',
    href: '/dashboard/inventory/new?tour=new-item-form',
    cta: 'New item, guided',
  },
  {
    title: 'Import a vendor PO',
    body: 'Scan a PDF with AI or upload CSV, then watch stock stay untouched until you receive.',
    href: '/dashboard/purchase-orders/imports?tour=po-imports',
    cta: 'PO imports, guided',
  },
  {
    title: 'Fulfill an order',
    body: 'Place a request in the storefront, then approve, claim picking, pick, and hand over.',
    href: '/dashboard/orders/new?tour=order-create',
    cta: 'Start an order',
  },
  {
    title: 'Rename the terminology',
    body: 'Turn Charters into Schools or Staging into Receiving — the whole app follows.',
    href: '/dashboard/settings?tour=settings-hub',
    cta: 'Settings, guided',
  },
  {
    title: 'Ask the AI',
    body: '“What is running low?” — answers come from real queries against the demo data.',
    href: '/dashboard/ai?tour=ai-assistant',
    cta: 'Open the assistant',
  },
];

export function DemoScenarios() {
  return (
    <DetailSection
      aria-label="Demo scenarios"
      title={
        <span className="inline-flex items-center gap-2">
          <Compass aria-hidden className="text-accent size-4" /> Explore the demo
        </span>
      }
    >
      <p className="text-muted-foreground text-[12.5px] leading-[18.75px]">
        This workspace is sample data — try anything, break nothing. Five guided scenarios:
      </p>
      <div className="@container mt-3">
        <div className="@min-[520px]:grid-cols-2 @min-[960px]:grid-cols-5 grid gap-2">
          {SCENARIOS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="border-border hover:border-line-strong hover:bg-muted group flex flex-col rounded-md border p-3 transition-colors"
            >
              <p className="text-[13.5px] font-medium leading-5">{s.title}</p>
              <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{s.body}</p>
              <p className="text-accent mt-auto pt-2 text-[12.5px] font-medium group-hover:underline">
                {s.cta} →
              </p>
            </Link>
          ))}
        </div>
      </div>
    </DetailSection>
  );
}
