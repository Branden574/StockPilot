import { ArrowRight, Handshake, LifeBuoy, Mail, Shield } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import {
  CONTACT,
  CONTACT_CARDS,
  CONTACT_METADATA,
  contactSupportNote,
  type ContactCardId,
} from '@/components/marketing/content/contact';
import type { ChildrenProps, LinkPartProps } from '@/components/marketing/content/parts';
import { SiteNav } from '@/components/marketing/glass/site-nav';
import '@/styles/liquid-glass/pages/site.css';

// The classic page's metadata, from the same module (R8: search sees one page).
export const metadata: Metadata = CONTACT_METADATA;

/** The board's tinted icon tile per card (Site-Contact.dc.html). */
const ICONS: Record<ContactCardId, { Icon: typeof LifeBuoy; tone: string }> = {
  support: { Icon: LifeBuoy, tone: 'danger' },
  sales: { Icon: Handshake, tone: 'accent' },
  privacy: { Icon: Shield, tone: 'info' },
};

/**
 * Site-Contact.dc.html with the classic page's words (components/marketing/
 * content/contact.tsx): the same h1, the three channel cards with their h2s,
 * targets and words, and the general-support note. Recorded deviations: the
 * board's new heading, lede and support note and its "Need access to
 * StockPilot?" section are not drawn (they would change the page's headings
 * and add words the classic page does not have; R8 keeps the content pages'
 * headings equal); the support card keeps its own link instead of making the
 * whole card one link, so the link's name stays "Open a support ticket".
 */
export default function GlassContactPage() {
  return (
    <>
      <SiteNav active="contact" />
      <main className="lgs-main lgs-wrap mx-auto flex w-full max-w-[1240px] flex-col gap-10 px-5 pb-24 pt-14 sm:px-10">
        <header className="lgs-head flex max-w-[780px] flex-col gap-3">
          <span className="lgs-eyebrow lgs-accent text-xs font-semibold uppercase tracking-[0.06em]">
            Contact
          </span>
          <h1 className="lgs-h2 text-4xl font-semibold">{CONTACT.heading}</h1>
          <p className="lgs-lede text-lg">{CONTACT.lede}</p>
        </header>
        <div className="lgs-cards grid gap-4 md:grid-cols-3">
          {CONTACT_CARDS.map((card) => {
            const { Icon, tone } = ICONS[card.id];
            return (
              <div key={card.id} className="lgs-card lgs-contact-card flex flex-col gap-3.5 p-7">
                <span className={`lgs-tile lgs-tone-${tone} grid size-14 place-items-center`}>
                  <Icon className="size-[26px]" aria-hidden="true" />
                </span>
                <h2 className="lgs-card-title text-xl font-semibold">{card.title}</h2>
                <p className="lgs-ink2 flex-1">{card.body}</p>
                {card.cta.internal ? (
                  <Link
                    href={card.cta.href}
                    className="lgs-card-cta inline-flex w-fit items-center gap-1.5 font-semibold"
                  >
                    {card.cta.label}
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                ) : (
                  <a
                    href={card.cta.href}
                    className="lgs-card-cta inline-flex w-fit items-center gap-1.5 break-all font-semibold"
                  >
                    <Mail className="size-4 shrink-0" aria-hidden="true" />
                    {card.cta.label}
                  </a>
                )}
              </div>
            );
          })}
        </div>
        <p className="lgs-note lgs-glass w-fit max-w-full px-4 py-2.5 text-sm">
          {contactSupportNote({ Strong, PageLink, Anchor })}
        </p>
      </main>
    </>
  );
}

function Strong({ children }: ChildrenProps) {
  return <span className="lgs-strong font-semibold">{children}</span>;
}

function PageLink({ href, children }: LinkPartProps) {
  return (
    <Link href={href} className="lgs-a underline underline-offset-2">
      {children}
    </Link>
  );
}

function Anchor({ href, children }: LinkPartProps) {
  return (
    <a href={href} className="lgs-a underline underline-offset-2">
      {children}
    </a>
  );
}
