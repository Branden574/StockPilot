import type { Metadata } from 'next';

import { ClassicLegalPage } from '@/components/marketing/classic-legal';
import { PRIVACY, PRIVACY_METADATA } from '@/components/marketing/content/privacy';

// The words and metadata live in components/marketing/content/privacy.tsx,
// shared with the Liquid Glass twin so the two can never drift.
export const metadata: Metadata = PRIVACY_METADATA;

export default function PrivacyPolicyPage() {
  return <ClassicLegalPage doc={PRIVACY} />;
}
