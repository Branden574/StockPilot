import { LifeBuoy, Mail, ShieldCheck } from 'lucide-react';
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

// The words and metadata live in components/marketing/content/contact.tsx,
// shared with the Liquid Glass twin so the two can never drift.
export const metadata: Metadata = CONTACT_METADATA;

const ICONS: Record<ContactCardId, typeof LifeBuoy> = {
  support: LifeBuoy,
  sales: Mail,
  privacy: ShieldCheck,
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
      <h1 className="font-display text-[34px] font-medium leading-[1.15] tracking-[-0.025em] sm:text-[40px]">
        {CONTACT.heading}
      </h1>
      <p className="text-muted-foreground mt-3 max-w-xl text-[15px] leading-relaxed">
        {CONTACT.lede}
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {CONTACT_CARDS.map((c) => {
          const Icon = ICONS[c.id];
          return (
            <div
              key={c.title}
              className="border-border bg-card flex flex-col rounded-lg border p-5"
            >
              <Icon className="text-foreground h-5 w-5" strokeWidth={1.7} />
              <h2 className="mt-3 text-[13.5px] font-medium">{c.title}</h2>
              <p className="text-muted-foreground mt-1.5 flex-1 text-[13px] leading-relaxed">
                {c.body}
              </p>
              {c.cta.internal ? (
                <Link
                  href={c.cta.href}
                  className="text-foreground mt-3 inline-block text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  {c.cta.label} →
                </Link>
              ) : (
                <a
                  href={c.cta.href}
                  className="text-foreground mt-3 inline-block break-all text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  {c.cta.label}
                </a>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-border text-muted-foreground mt-10 rounded-lg border border-dashed p-5 text-[13px] leading-relaxed">
        <p>{contactSupportNote({ Strong, PageLink, Anchor })}</p>
      </div>
    </div>
  );
}

function Strong({ children }: ChildrenProps) {
  return <span className="text-foreground font-medium">{children}</span>;
}

function PageLink({ href, children }: LinkPartProps) {
  return (
    <Link href={href} className="underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

function Anchor({ href, children }: LinkPartProps) {
  return (
    <a href={href} className="underline-offset-4 hover:underline">
      {children}
    </a>
  );
}
