import type { ComponentType, ReactNode } from 'react';

/**
 * The presentation parts a shared marketing content module renders its words
 * with (Liquid Glass plan 4.6 M3, plans/REVISION-DEFAULT.md R8).
 *
 * Six marketing pages (/contact, /pricing, /privacy, /security, /support,
 * /terms) have a classic page under app/(marketing) and a static glass twin
 * under app/(site-glass)/glass-site. Both render the SAME words and metadata
 * from the modules in this folder, so the two can never drift; each passes its
 * own parts, so each keeps its own markup. The classic pages pass parts that
 * render exactly the elements and classes they rendered before the words moved
 * here (app/(marketing)/marketing.classic-parity.test.tsx proves the server
 * HTML is byte for byte the same); the twins pass the elements their boards
 * draw.
 *
 * A module never reads the appearance: the parts it is given decide what it
 * looks like, and a page is classic or glass by its route.
 *
 * The JSX bodies carry `// prettier-ignore`. Their text keeps the line shape
 * the classic page wrote: Prettier's fill would move a space from one side of
 * a link to the other, which reads the same but splits the text nodes
 * differently, and the classic server HTML (its `<!-- -->` markers) changes.
 */

/** Children only. */
export interface ChildrenProps {
  children?: ReactNode;
}

/** A link to `href` with its words as children. */
export interface LinkPartProps {
  href: string;
  children?: ReactNode;
}

/** One section of a long legal page, as each page's own Section part draws it. */
export interface ContentSectionProps {
  /** The section's heading text (an h2 in every variant). */
  title: string;
  /**
   * The section's anchor. The classic page gives one only where it always had
   * one (/privacy's #california); the glass page gives every section one for
   * its "On this page" list.
   */
  id?: string;
  children?: ReactNode;
}

/** The parts a legal section's body is written with (privacy, security, terms). */
export interface LegalParts {
  /** A bulleted list; its items are plain li elements. */
  List: ComponentType<ChildrenProps>;
  /** A heading inside a section (an h3). */
  Sub: ComponentType<ChildrenProps>;
  /** A sentence set apart as a statement ("We do not sell or share ..."). */
  Statement: ComponentType<ChildrenProps>;
  /** A paragraph that follows a list or a statement inside a section. */
  Follow: ComponentType<ChildrenProps>;
  /** A plain anchor: a mailto: address or another page of the site. */
  Link: ComponentType<LinkPartProps>;
}

/** One section of a legal page. */
export interface LegalSection {
  /** The h2 text, the same in both variants. */
  title: string;
  /** The label in the glass page's "On this page" list (the title when absent). */
  short?: string;
  /** The anchor both variants give this section (only where classic always had one). */
  id?: string;
  /** The section's words, drawn with the variant's parts. */
  body: (parts: LegalParts) => ReactNode;
}

/** A legal page: its h1, its date line and its sections. */
export interface LegalDocument {
  /** The h1 text. */
  heading: string;
  /** The words before the date ("Effective", "Last updated"). */
  dateLabel: string;
  date: string;
  sections: readonly LegalSection[];
}

/** Inline parts for a sentence that holds an emphasis and links (contact, pricing, support). */
export interface InlineParts {
  /** An emphasised run of words. */
  Strong: ComponentType<ChildrenProps>;
  /** A link to another page of the site, a client navigation (classic renders next/link). */
  PageLink: ComponentType<LinkPartProps>;
  /** A plain anchor: a mailto: link, or a page that loads as a whole document (/signin). */
  Anchor: ComponentType<LinkPartProps>;
  /** The small separator dot between two phrases. */
  Dot: ComponentType;
}

/** The anchor id the glass page gives a section with no id of its own. */
export function sectionAnchor(section: Pick<LegalSection, 'title' | 'id'>): string {
  if (section.id) return section.id;
  return section.title
    .toLowerCase()
    .replace(/&/gu, 'and')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}
