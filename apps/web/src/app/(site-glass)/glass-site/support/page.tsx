import type { Metadata } from 'next';

import type { LinkPartProps } from '@/components/marketing/content/parts';
import { SUPPORT, SUPPORT_METADATA, supportLede } from '@/components/marketing/content/support';
import { SiteNav } from '@/components/marketing/glass/site-nav';
import { SupportForm } from '@/components/marketing/support-form';
import '@/styles/liquid-glass/pages/site.css';

// The classic page's metadata, from the same module (R8: search sees one page).
export const metadata: Metadata = SUPPORT_METADATA;

/**
 * Site-Support.dc.html's split (the words on the left, the form on a glass
 * card on the right) around the classic page's words and the same
 * SupportForm: every field, the honeypot, the server action and the "Ticket
 * received" state are the classic ones, so nothing a ticket needs changes.
 * The form keeps what was typed across a switch of Design (support-form.tsx,
 * a sessionStorage draft). Recorded deviations: the board's new heading,
 * lede, "Already signed in?" note and "Send a message" heading are not drawn
 * (R8 keeps the content pages' headings and words equal); its visible Company
 * field is the classic form's hidden honeypot and stays hidden; Priority stays
 * the classic select, not the board's segmented control.
 */
export default function GlassSupportPage() {
  return (
    <>
      <SiteNav active="support" />
      <main className="lgs-main lgs-wrap mx-auto w-full max-w-[1240px] px-5 pb-24 pt-14 sm:px-10">
        <div className="lgs-support-split grid items-start gap-14 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="flex flex-col gap-4">
            <span className="lgs-eyebrow lgs-accent text-xs font-semibold uppercase tracking-[0.06em]">
              Support
            </span>
            <h1 className="lgs-h2 text-4xl font-semibold">{SUPPORT.heading}</h1>
            <p className="lgs-lede text-lg">{supportLede({ Anchor })}</p>
          </div>
          <div className="lgs-support relative">
            <SupportForm />
          </div>
        </div>
      </main>
    </>
  );
}

function Anchor({ href, children }: LinkPartProps) {
  return (
    <a href={href} className="lgs-a underline underline-offset-2">
      {children}
    </a>
  );
}
