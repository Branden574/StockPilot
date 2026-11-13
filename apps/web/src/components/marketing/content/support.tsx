import type { Metadata } from 'next';

import type { InlineParts } from './parts';

import { COMPANY_NAME, SUPPORT_EMAIL } from '@/lib/site';

/**
 * The support page's words and metadata, shared by the classic /support page
 * and its glass twin (see ./parts.ts). Both render the same SupportForm.
 */
export const SUPPORT_METADATA: Metadata = {
  // The root layout's title template adds " · StockPilot" (CONFLICTS D15).
  title: 'Support',
  description: `Report a problem or ask a question — the ${COMPANY_NAME} team will get back to you.`,
};

export const SUPPORT = {
  heading: 'Support',
} as const;

/** The paragraph under the heading. */
export function supportLede({ Anchor }: Pick<InlineParts, 'Anchor'>) {
  // prettier-ignore
  return (
    <>
      Something not working, or have a question? Send us a ticket below and we&apos;ll get back to
      you — usually within 1–2 business days. You can also email{' '}
      <Anchor href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</Anchor>.
    </>
  );
}
