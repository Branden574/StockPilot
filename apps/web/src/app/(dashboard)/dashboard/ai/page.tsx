import { Sparkles } from 'lucide-react';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ChatPanel } from '@/components/ai/chat-panel';
import { PageHeader } from '@/components/patterns/page-header';
import { requireOrgContext } from '@/lib/auth/session';

import { can } from '@stockpilot/core';
import { PageTour } from '@/components/onboarding/page-tour';
import { AI_TOUR } from '@/lib/onboarding/tours';

export const metadata = {
  title: 'AI Assistant',
};

export default async function AiPage() {
  const moduleAccess = await checkModuleAccess('ai');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="ai" canManage={moduleAccess.canManage} />;
  }
  // AI tools include stock-adjusting actions (gated server-side by the
  // underlying tool's assertPermission, but exposing the chat surface
  // to a viewer is confusing). Restrict to items:update-or-better roles.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:update')) {
    redirect('/dashboard');
  }
  return (
    // The two-pane tool page: the page box with the redesign's gutters
    // (16 px on a phone), the shared header, then the sessions rail beside the
    // conversation. The AI tour's first step targets `main h1`, which is the
    // header's title.
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-4 pb-10 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" aria-hidden />
            AI Assistant · Beta
          </span>
        }
        title="Ask your inventory"
        subline={
          // Held to a reading width so the Tour trigger stays beside the
          // title block on a desktop instead of wrapping under it.
          <span className="block max-w-[680px]">
            Tool-call-grounded chat — every numeric answer comes from a real query against your
            Supabase. Most tools are read-only; the assistant can also adjust stock when you
            explicitly confirm.
          </span>
        }
        tour={<PageTour tour={AI_TOUR} />}
      />
      <ChatPanel />
    </div>
  );
}
