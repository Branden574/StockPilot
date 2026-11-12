import Link from 'next/link';

import { SiteGlyph } from './site-brand';
import { SITE_FOOTER } from './site-links';

import { COMPANY_NAME, SUPPORT_EMAIL } from '@/lib/site';

/**
 * SiteFooter.dc.html: the brand with its line and the support address, three
 * link groups (Product, Help, Trust; each a labelled nav), then the copyright
 * and the demo-data note. Every legal link of the classic footer is kept,
 * /privacy#california included.
 */
export function SiteFooter() {
  return (
    <footer className="lgs-foot border-border mt-auto border-t">
      <div className="lgs-wrap mx-auto flex w-full max-w-[1240px] flex-col gap-8 px-5 pb-10 pt-12 sm:px-10">
        <div className="flex flex-wrap items-start gap-x-12 gap-y-8">
          <div className="flex max-w-[440px] flex-[1_1_320px] flex-col gap-3">
            <Link
              href="/"
              aria-label="StockPilot home"
              className="lgs-brand inline-flex w-fit items-center gap-[9px]"
            >
              <SiteGlyph maskId="lgs-foot-mark" />
              <span className="lgs-wordmark">
                Stock<span>Pilot</span>
              </span>
            </Link>
            <p className="lgs-foot-line max-w-[340px] text-sm">
              Inventory, books, requests and warehouse work in one place. Invite-only, on the web
              and on iPhone, iPad and Android.
            </p>
            <a
              className="lgs-a w-fit text-sm underline underline-offset-2"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              {SUPPORT_EMAIL}
            </a>
          </div>
          {SITE_FOOTER.map((group) => (
            <nav
              key={group.label}
              aria-label={group.label}
              className="lgs-foot-nav flex flex-[0_0_160px] flex-col gap-2.5"
            >
              <span className="lgs-eyebrow text-xs font-semibold uppercase tracking-[0.06em]">
                {group.label}
              </span>
              {group.links.map((link) =>
                link.document ? (
                  <a key={link.href} href={link.href} className="lgs-foot-link w-fit text-sm">
                    {link.label}
                  </a>
                ) : (
                  <Link key={link.href} href={link.href} className="lgs-foot-link w-fit text-sm">
                    {link.label}
                  </Link>
                ),
              )}
            </nav>
          ))}
        </div>
        <div className="lgs-hr h-px" aria-hidden="true" />
        <div className="flex flex-wrap justify-between gap-3">
          <span className="lgs-foot-small text-xs">
            © {new Date().getFullYear()} {COMPANY_NAME}. All rights reserved.
          </span>
          <span className="lgs-foot-small text-xs">
            Every product preview on this site uses demo data.
          </span>
        </div>
      </div>
    </footer>
  );
}
