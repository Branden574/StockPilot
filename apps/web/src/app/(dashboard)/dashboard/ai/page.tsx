import { Sparkles } from 'lucide-react';
import { redirect } from 'next/navigation';

import { ChatPanel } from '@/components/ai/chat-panel';
import { requireOrgContext } from '@/lib/auth/session';

import { hasPermission } from '@stockpilot/core';

export const metadata = {
  title: 'AI Assistant',
};

export default async function AiPage() {
  // AI tools include stock-adjusting actions (gated server-side by the
  // underlying tool's assertPermission, but exposing the chat surface
  // to a viewer is confusing). Restrict to items:update-or-better roles.
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'items:update')) {
    redirect('/dashboard');
  }
  return (
    <div className="container mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="border-border mb-5 border-b pb-4">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
          <Sparkles className="mr-1 inline h-3 w-3" />
          AI Assistant · Beta
        </p>
        <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
          Ask your inventory
        </h1>
        <p className="text-muted-foreground mt-1 text-[13.5px]">
          Tool-call-grounded chat — every numeric answer comes from a real
          query against your Supabase. Most tools are read-only; the
          assistant can also adjust stock when you explicitly confirm.
        </p>
      </div>
      <ChatPanel />
    </div>
  );
}
