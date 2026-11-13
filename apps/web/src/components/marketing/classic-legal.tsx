import type {
  ChildrenProps,
  ContentSectionProps,
  LegalDocument,
  LegalParts,
  LinkPartProps,
} from './content/parts';

/**
 * The classic presentation of the three legal pages (/privacy, /security,
 * /terms): exactly the markup each page drew before its words moved into
 * components/marketing/content (app/(marketing)/marketing.classic-parity.test.tsx
 * holds the proof). Classic only; the glass twins draw the same documents with
 * their own parts.
 *
 * The prettier-ignore marks keep these class strings in the order the legal
 * pages always wrote them: the Tailwind class sorter would reorder them, and
 * a reordered class attribute is a different classic page.
 */
export function ClassicLegalPage({ doc }: { doc: LegalDocument }) {
  // prettier-ignore
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 text-[15px] leading-7 text-foreground sm:px-8">
      <h1 className="font-display text-[34px] font-medium leading-[1.15] tracking-[-0.025em] sm:text-[40px]">
        {doc.heading}
      </h1>
      {/* One text node for the label and its space, one for the date: the
          markup "Effective {date}" always rendered. */}
      <p className="mt-2 text-sm text-muted-foreground">
        {`${doc.dateLabel} `}
        {doc.date}
      </p>
      {doc.sections.map((section) => (
        <Section key={section.title} title={section.title} id={section.id}>
          {section.body(CLASSIC_LEGAL_PARTS)}
        </Section>
      ))}
    </div>
  );
}

function Section({ title, id, children }: ContentSectionProps) {
  // prettier-ignore
  return (
    <section id={id} className={id ? 'mt-10 scroll-mt-20' : 'mt-10'}>
      <h2 className="font-display text-[20px] font-medium leading-[1.5] tracking-[-0.02em]">
        {title}
      </h2>
      <div className="mt-3 text-muted-foreground">{children}</div>
    </section>
  );
}

function List({ children }: ChildrenProps) {
  return <ul className="mt-2 list-disc space-y-2 pl-5">{children}</ul>;
}

function Sub({ children }: ChildrenProps) {
  // prettier-ignore
  return <h3 className="mt-6 font-semibold text-foreground">{children}</h3>;
}

function Statement({ children }: ChildrenProps) {
  // prettier-ignore
  return <p className="mt-4 font-medium text-foreground">{children}</p>;
}

function Follow({ children }: ChildrenProps) {
  return <p className="mt-2">{children}</p>;
}

function Link({ href, children }: LinkPartProps) {
  return (
    <a className="underline" href={href}>
      {children}
    </a>
  );
}

const CLASSIC_LEGAL_PARTS: LegalParts = { List, Sub, Statement, Follow, Link };
