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
    <footer className="border-t border-border">
      <div className="mx-auto max-w-[1280px] px-8 py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {/* Brand + contact */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/" aria-label="Home" className="inline-flex items-center gap-2">
              <IconMark size={22} />
              <span className="text-sm font-semibold">{COMPANY_NAME}</span>
            </Link>
            <p className="mt-3 max-w-[220px] text-[12px] leading-relaxed text-[var(--ed-ink-4)]">
              Inventory + order operations for modern teams.
            </p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-3 inline-block text-[12px] text-[var(--ed-ink-3)] transition-colors hover:text-foreground"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ed-ink-3)]">
                {col.heading}
              </h3>
              <ul className="mt-3 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-[13px] text-[var(--ed-ink-4)] transition-colors hover:text-foreground"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border pt-6 text-[12px] text-[var(--ed-ink-4)] sm:flex-row sm:items-center">
          <div>
            &copy; {new Date().getFullYear()} {COMPANY_NAME} &mdash; Inventory + order operations
          </div>
          <div className="flex gap-4">
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href="/security" className="transition-colors hover:text-foreground">
              Security
            </Link>
            <Link href="/support" className="transition-colors hover:text-foreground">
              Support
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
