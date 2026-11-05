import { ChevronDown } from 'lucide-react';

import { SiteNav } from './site-nav';
import type { SitePage } from './site-links';

import {
  sectionAnchor,
  type ChildrenProps,
  type ContentSectionProps,
  type LegalDocument,
  type LegalParts,
  type LinkPartProps,
} from '@/components/marketing/content/parts';

/**
 * The glass legal page (Site-Privacy.dc.html, Site-Terms.dc.html,
 * Site-Security.dc.html): the "Trust" eyebrow, the h1, a lede, the date line,
 * then an "On this page" list beside one glass card that holds every section.
 *
 * The words are the classic page's, from the same content module (layout only;
 * current text kept, COVERAGE): the same h1, the same h2 and h3 headings in
 * the same order, every sentence and link. Recorded deviations: the boards'
 * placeholder notes ("Approved text carries over unchanged") are the real
 * text; the boards merge some sections (Analytics, Children, Changes; Governing
 * law, Changes) and drop the Summary, which here stay separate sections as the
 * classic page has them; the lede is the page's own description (no new legal
 * copy); the date keeps the classic page's label ("Effective" or "Last
 * updated").
 */
export function GlassLegalPage({
  doc,
  lede,
  active,
}: {
  doc: LegalDocument;
  lede: string;
  active: SitePage;
}) {
  return (
    <>
      <SiteNav active={active} />
      <main className="lgs-main lgs-wrap mx-auto w-full max-w-[1240px] px-5 pb-24 pt-14 sm:px-10">
        <header className="lgs-head flex max-w-[820px] flex-col gap-3">
          <span className="lgs-eyebrow lgs-accent text-xs font-semibold uppercase tracking-[0.06em]">
            Trust
          </span>
          <h1 className="lgs-h2 text-4xl font-semibold">{doc.heading}</h1>
          <p className="lgs-lede text-lg">{lede}</p>
          <span className="lgs-date text-sm">{`${doc.dateLabel} ${doc.date}`}</span>
        </header>
        <div className="lgs-legal-grid mt-10 grid gap-12 md:grid-cols-[230px_minmax(0,1fr)]">
          <nav aria-label="On this page" className="lgs-toc flex flex-col gap-0.5 text-sm">
            <Contents doc={doc} />
          </nav>
          <div className="flex min-w-0 flex-col gap-3">
            {/* Below 900 px the list folds into this card (Site-Security.dc.html). */}
            <details className="lgs-toc-m lgs-card hidden px-4 py-1">
              <summary className="lgs-toc-sum flex min-h-12 cursor-pointer items-center justify-between font-semibold">
                On this page
                <ChevronDown className="size-[18px]" aria-hidden="true" />
              </summary>
              <nav
                aria-label="On this page"
                className="lgs-toc flex flex-col gap-0.5 pb-2.5 text-sm"
              >
                <Contents doc={doc} />
              </nav>
            </details>
            <article className="lgs-card lgs-legal-art lgs-prose min-w-0 text-base">
              {doc.sections.map((section) => (
                <Section key={section.title} title={section.title} id={sectionAnchor(section)}>
                  {section.body(GLASS_LEGAL_PARTS)}
                </Section>
              ))}
            </article>
          </div>
        </div>
      </main>
    </>
  );
}

function Contents({ doc }: { doc: LegalDocument }) {
  return doc.sections.map((section) => (
    <a
      key={section.title}
      href={`#${sectionAnchor(section)}`}
      className="lgs-toc-link rounded-lg px-2.5 py-1.5"
    >
      {section.short ?? section.title}
    </a>
  ));
}

function Section({ title, id, children }: ContentSectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="lgs-legal-sec scroll-mt-24">
      <h2 id={`${id}-h`}>{title}</h2>
      <div className="lgs-legal-body">{children}</div>
    </section>
  );
}

function List({ children }: ChildrenProps) {
  return <ul className="list-disc pl-5">{children}</ul>;
}

function Sub({ children }: ChildrenProps) {
  return <h3>{children}</h3>;
}

function Statement({ children }: ChildrenProps) {
  return <p className="lgs-statement">{children}</p>;
}

function Follow({ children }: ChildrenProps) {
  return <p>{children}</p>;
}

function Link({ href, children }: LinkPartProps) {
  return (
    <a className="lgs-a underline underline-offset-2" href={href}>
      {children}
    </a>
  );
}

const GLASS_LEGAL_PARTS: LegalParts = { List, Sub, Statement, Follow, Link };
