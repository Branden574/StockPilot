import type { Metadata } from 'next';

import { ClassicLegalPage } from '@/components/marketing/classic-legal';
import { SECURITY, SECURITY_METADATA } from '@/components/marketing/content/security';

// The words and metadata live in components/marketing/content/security.tsx,
// shared with the Liquid Glass twin so the two can never drift.
export const metadata: Metadata = SECURITY_METADATA;

export default function SecurityPage() {
  return <ClassicLegalPage doc={SECURITY} />;
}
