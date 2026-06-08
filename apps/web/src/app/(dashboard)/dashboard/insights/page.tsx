import { Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { Badge } from '@/components/ui/badge';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { gatherInsights, summarizeInsights, type InsightSeverity } from '@/server/services/insights';

import { hasPermission } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Briefing — StockPilot' };
export const dynamic = 'force-dynamic';

const SEVERITY_BADGE: Record<InsightSeverity, 'destructive' | 'warning' | 'outline'> = {
  urgent: 'destructive',
  warn: 'warning',
  info: 'outline',
};

export default async function InsightsPage() {
  const access = await checkModuleAccess('ai');
  if (!access.enabled) {
    return <ModuleNotEnabled moduleId="ai" canManage={access.canManage} />;
  }
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'items:update')) redirect('/dashboard');

  const insights = await gatherInsights();
  const summary = await summarizeInsights(insights);
  const nothing = insights.signals.length === 0;

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to dashboard
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Sparkles className="h-5 w-5" />
          Today&apos;s briefing
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What needs your attention right now, across orders, purchasing, and stock.
        </p>
      </div>

      {/* AI narrative — graceful: only shown when Gemini produced one. */}
      {summary && (
        <div className="border-border bg-card mb-6 rounded-xl border p-5">
          <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
            <Sparkles className="h-3.5 w-3.5" />
            AI summary
          </div>
          <p className="text-sm leading-relaxed">{summary}</p>
        </div>
      )}

      {nothing ? (
        <div className="border-border bg-card rounded-xl border p-8 text-center">
          <p className="text-sm font-medium">All clear 🎉</p>
          <p className="text-muted-foreground mt-1 text-sm">
            No orders awaiting approval, overdue POs, or low-stock items right now.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {insights.signals.map((s) => (
            <Link
              key={s.key}
              href={s.href}
              className="border-border bg-card hover:bg-muted/40 flex items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-xl font-semibold tabular-nums">{s.count}</span>
                <span className="text-sm">{s.label}</span>
              </div>
              <Badge variant={SEVERITY_BADGE[s.severity]}>
                {s.severity === 'urgent' ? 'Act now' : s.severity === 'warn' ? 'Review' : 'FYI'}
              </Badge>
            </Link>
          ))}
        </div>
      )}

      {insights.lowStock.length > 0 && (
        <div className="mt-8">
          <h2 className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
            Low stock
          </h2>
          <div className="border-border bg-card divide-border divide-y rounded-xl border">
            {insights.lowStock.map((i) => (
              <div key={i.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate">
                  {i.name} <span className="text-muted-foreground">· {i.sku}</span>
                </span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {i.qty} on hand · reorder at {i.reorderPoint}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
