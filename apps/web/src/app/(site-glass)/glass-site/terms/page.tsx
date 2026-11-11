import type { Metadata } from 'next';

import { TERMS, TERMS_METADATA } from '@/components/marketing/content/terms';
import { GlassLegalPage } from '@/components/marketing/glass/glass-legal-page';
import '@/styles/liquid-glass/pages/site.css';

// The classic page's metadata, from the same module (R8: search sees one page).
export const metadata: Metadata = TERMS_METADATA;

export default function GlassTermsPage() {
  return <GlassLegalPage doc={TERMS} lede={String(TERMS_METADATA.description)} active="terms" />;
}
