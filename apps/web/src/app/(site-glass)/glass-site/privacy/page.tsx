import type { Metadata } from 'next';

import { PRIVACY, PRIVACY_METADATA } from '@/components/marketing/content/privacy';
import { GlassLegalPage } from '@/components/marketing/glass/glass-legal-page';
import '@/styles/liquid-glass/pages/site.css';

// The classic page's metadata, from the same module (R8: search sees one page).
export const metadata: Metadata = PRIVACY_METADATA;

export default function GlassPrivacyPage() {
  return (
    <GlassLegalPage doc={PRIVACY} lede={String(PRIVACY_METADATA.description)} active="privacy" />
  );
}
