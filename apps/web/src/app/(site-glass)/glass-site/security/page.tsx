import type { Metadata } from 'next';

import { SECURITY, SECURITY_METADATA } from '@/components/marketing/content/security';
import { GlassLegalPage } from '@/components/marketing/glass/glass-legal-page';
import '@/styles/liquid-glass/pages/site.css';

// The classic page's metadata, from the same module (R8: search sees one page).
export const metadata: Metadata = SECURITY_METADATA;

export default function GlassSecurityPage() {
  return (
    <GlassLegalPage doc={SECURITY} lede={String(SECURITY_METADATA.description)} active="security" />
  );
}
