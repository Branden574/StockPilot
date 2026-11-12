import type { Metadata } from 'next';

import { ClassicLegalPage } from '@/components/marketing/classic-legal';
import { TERMS, TERMS_METADATA } from '@/components/marketing/content/terms';

// The words and metadata live in components/marketing/content/terms.tsx,
// shared with the Liquid Glass twin so the two can never drift.
export const metadata: Metadata = TERMS_METADATA;

export default function TermsPage() {
  return <ClassicLegalPage doc={TERMS} />;
}
