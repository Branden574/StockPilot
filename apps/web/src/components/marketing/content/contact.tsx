import type { Metadata } from 'next';

import type { InlineParts } from './parts';

import { COMPANY_NAME, PRIVACY_EMAIL, SALES_EMAIL, SUPPORT_EMAIL } from '@/lib/site';

/**
 * The contact page's words and metadata, shared by the classic /contact page
 * and its glass twin (see ./parts.ts). Icons are presentation: each variant
 * picks its own for a card by the card's `id`.
 */
export const CONTACT_METADATA: Metadata = {
  // The root layout's title template adds " · StockPilot" (CONFLICTS D15).
  title: 'Contact',
  description: `Get in touch with the ${COMPANY_NAME} team — support, sales, and privacy requests.`,
};

export const CONTACT = {
  heading: 'Contact us',
  // Straight apostrophes: the classic page wrote them as &apos;.
  lede: "We're a small team and we read everything. Pick the channel that fits — for anything that's actually broken, a support ticket gets you a tracked response fastest.",
} as const;

export const CONTACT_CARDS = [
  {
    id: 'support',
    title: 'Something broken?',
    body: 'Report an issue and track it to resolution. The fastest way to reach us when something is not working.',
    cta: { href: '/support', label: 'Open a support ticket', internal: true },
  },
  {
    id: 'sales',
    title: 'Sales & general',
    body: 'Questions about plans, onboarding a new team, or anything else.',
    cta: { href: `mailto:${SALES_EMAIL}`, label: SALES_EMAIL, internal: false },
  },
  {
    id: 'privacy',
    title: 'Privacy requests',
    body: 'Exercise your data rights (access, deletion, correction) or ask a privacy question.',
    cta: { href: `mailto:${PRIVACY_EMAIL}`, label: PRIVACY_EMAIL, internal: false },
  },
] as const;

export type ContactCardId = (typeof CONTACT_CARDS)[number]['id'];

/** The general-support note under the cards. */
export function contactSupportNote({
  Strong,
  PageLink,
  Anchor,
}: Pick<InlineParts, 'Strong' | 'PageLink' | 'Anchor'>) {
  // prettier-ignore
  return (
    <>
      <Strong>General support:</Strong>{' '}
      <Anchor href={`mailto:${SUPPORT_EMAIL}`}>
        {SUPPORT_EMAIL}
      </Anchor>
      . We aim to respond within 1–2 business days. For urgent outages affecting your team, open
      a <PageLink href="/support">support ticket</PageLink>{' '}
      and mark it high priority.
    </>
  );
}
