import { CheckCircle2, ChevronRight, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { Badge } from '@/components/ui/badge';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { cn } from '@/lib/utils';
import {
  gatherInsights,
  summarizeInsights,
  type InsightSeverity,
} from '@/server/services/insights';

import { can } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Briefing' };
export const dynamic = 'force-dynamic';

const SEVERITY_BADGE: Record<InsightSeverity, 'destructive' | 'warning' | 'outline'> = {
  urgent: 'destructive',
  warn: 'warning',
  info: 'outline',
};

const SEVERITY_DOT: Record<InsightSeverity, string> = {
  urgent: 'bg-destructive',
  warn: 'bg-warning',
  info: 'bg-muted-foreground',
};

export default async function InsightsPage() {
  const access = await checkModuleAccess('ai');
  if (!access.enabled) {
    return <ModuleUnavailable moduleId="ai" access={access} />;
  }
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:update')) redirect('/dashboard');

  const insights = await gatherInsights();
  const summary = await summarizeInsights(insights);
  const nothing = insights.signals.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard">← Back to dashboard</PageHeaderBackLink>}
        title={
          <span className="inline-flex items-center gap-2.5">
            <Sparkles className="text-accent h-5 w-5 shrink-0" aria-hidden strokeWidth={1.75} />
            Today&apos;s briefing
          </span>
        }
        subline="What needs your attention right now, across orders, purchasing, and stock."
      />

      {/* AI narrative — graceful: only shown when the provider produced one. */}
      {summary && (
        <DetailSection
          title={
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="text-accent h-3.5 w-3.5" aria-hidden />
              AI summary
            </span>
          }
        >
          <p className="text-[13.5px] leading-relaxed">{summary}</p>
        </DetailSection>
      )}

      {nothing ? (
        <StatePanel
          kind="empty"
          size="sm"
          icon={CheckCircle2}
          title="All clear"
          description="No orders awaiting approval, overdue POs, or low-stock items right now."
        />
      ) : (
        // The Overview's "Needs attention" rows: tone dot, the count, what it
        // is, and the severity in words (never colour alone).
        <ul className="border-border bg-card overflow-hidden rounded-lg border">
          {insights.signals.map((s) => (
            <li key={s.key} className="border-border border-b last:border-b-0">
              <Link
                href={s.href}
                data-severity={s.severity}
                className="hover:bg-muted flex items-center gap-3.5 px-[18px] py-3 transition-colors focus-visible:ring-inset focus-visible:ring-offset-0"
              >
                <span
                  aria-hidden
                  className={cn('size-2 shrink-0 rounded-full', SEVERITY_DOT[s.severity])}
                />
                <span className="min-w-[2ch] font-display text-[22px] font-medium tabular-nums leading-7">
                  {s.count}
                </span>
                <span className="text-foreground min-w-0 flex-1 text-[13.5px] leading-5">
                  {s.label}
                </span>
                <Badge variant={SEVERITY_BADGE[s.severity]} className="shrink-0">
                  {s.severity === 'urgent' ? 'Act now' : s.severity === 'warn' ? 'Review' : 'FYI'}
                </Badge>
                <ChevronRight
                  aria-hidden
                  className="text-muted-foreground hidden size-3.5 shrink-0 sm:block"
                  strokeWidth={1.8}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {insights.lowStock.length > 0 && (
        <DetailSection title="Low stock" flush className="mt-3">
          <ul>
            {insights.lowStock.map((i) => (
              <li
                key={i.id}
                className="border-border flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b px-[18px] py-2.5 text-[13.5px] last:border-b-0"
              >
                <span className="min-w-0 truncate">
                  {i.name}{' '}
                  <span className="text-muted-foreground font-mono text-[12.5px]">· {i.sku}</span>
                </span>
                <span className="text-muted-foreground shrink-0 text-[12.5px] tabular-nums">
                  {i.qty} on hand · reorder at {i.reorderPoint}
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
    </div>
  );
}
