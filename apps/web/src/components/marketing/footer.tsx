import Link from 'next/link';

import { IconMark } from '@/components/ui/icon-mark';
import { COMPANY_NAME, SUPPORT_EMAIL } from '@/lib/site';

const COLUMNS: Array<{ heading: string; links: Array<{ href: string; label: string }> }> = [
  {
    heading: 'Product',
    links: [
      { href: '/#product', label: 'Features' },
      { href: '/#how-it-works', label: 'How it works' },
      { href: '/#compare', label: 'Compare' },
      { href: '/pricing', label: 'Pricing' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { href: '/contact', label: 'Contact' },
      { href: '/support', label: 'Support' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/privacy', label: 'Privacy Policy' },
      { href: '/terms', label: 'Terms of Service' },
      { href: '/security', label: 'Security' },
      { href: '/privacy#california', label: 'California privacy' },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-border border-t">
      <div className="mx-auto max-w-[1280px] px-4 py-12 sm:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {/* Brand + contact */}
          <div className="col-span-2 md:col-span-1">
            {/* The mark already carries the wordmark; a second COMPANY_NAME
                beside it printed "StockPilot StockPilot" (P5.1). */}
            <Link href="/" aria-label="Home" className="inline-flex items-center gap-2">
              <IconMark size={22} />
            </Link>
            <p className="text-muted-foreground mt-3 max-w-[220px] text-[12px] leading-relaxed">
              Inventory + order operations for modern teams.
            </p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-muted-foreground hover:text-foreground mt-3 inline-block text-[12px] transition-colors"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.1em]">
                {col.heading}
              </h3>
              <ul className="mt-3 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-muted-foreground hover:text-foreground text-[13px] transition-colors"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-border text-muted-foreground mt-10 flex flex-col items-start justify-between gap-3 border-t pt-6 text-[12px] sm:flex-row sm:items-center">
          <div>
            &copy; {new Date().getFullYear()} {COMPANY_NAME} &mdash; Inventory + order operations
          </div>
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </Link>
            <Link href="/security" className="hover:text-foreground transition-colors">
              Security
            </Link>
            <Link href="/support" className="hover:text-foreground transition-colors">
              Support
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
