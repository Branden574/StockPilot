import 'server-only';

import { GoogleGenerativeAI } from '@google/generative-ai';

import { env } from '@/lib/env';

import { withContext, type ServiceContext } from './context';
import { getDashboardActions, getLowStockItems } from './movements';
import { OrderRequestsService } from './order-requests';
import { PurchaseOrdersService } from './purchase-orders';

/**
 * "What needs attention" insights briefing. Gathers the actionable signals
 * already computed elsewhere (low stock, overdue/open POs, pending approvals,
 * in-progress cycle counts) into one structured payload, and — when a Gemini
 * key is present — adds a short natural-language summary on top. The structured
 * signals stand alone; the AI narrative is a graceful enhancement (null if no
 * key / on any error), so the page never breaks because the model is down.
 */

export type InsightSeverity = 'urgent' | 'warn' | 'info';

export interface InsightSignal {
  key: string;
  label: string;
  count: number;
  severity: InsightSeverity;
  href: string;
}

export interface InsightsResult {
  signals: InsightSignal[];
  lowStock: Array<{ id: string; name: string; sku: string; qty: number; reorderPoint: number }>;
}

export async function gatherInsights(): Promise<InsightsResult> {
  return gatherInsightsForCtx(await withContext());
}

/**
 * Context-explicit variant so the daily-briefing cron can run the same
 * gathering under a per-org system context (the page path above stays bound
 * to the signed-in user's context).
 */
export async function gatherInsightsForCtx(ctx: ServiceContext): Promise<InsightsResult> {
  const [lowStock, actions, overdue, pending] = await Promise.all([
    getLowStockItems(8, { ctx }).catch(() => []),
    getDashboardActions({ ctx }).catch(() => ({ openPoCount: 0, openCycleCount: 0, pendingReceipts: 0 })),
    new PurchaseOrdersService(ctx).overdueCount().catch(() => 0),
    new OrderRequestsService(ctx).pendingCount().catch(() => 0),
  ]);

  const signals: InsightSignal[] = [];
  if (pending > 0)
    signals.push({ key: 'pending_approvals', label: pending === 1 ? 'order awaiting approval' : 'orders awaiting approval', count: pending, severity: 'urgent', href: '/dashboard/orders?status=needs_approval' });
  if (overdue > 0)
    signals.push({ key: 'overdue_pos', label: overdue === 1 ? 'overdue inbound PO' : 'overdue inbound POs', count: overdue, severity: 'warn', href: '/dashboard/purchase-orders' });
  if (lowStock.length > 0)
    signals.push({ key: 'low_stock', label: 'items at or under their reorder point', count: lowStock.length, severity: 'warn', href: '/dashboard/inventory' });
  if (actions.openCycleCount > 0)
    signals.push({ key: 'open_cycle_counts', label: actions.openCycleCount === 1 ? 'cycle count in progress' : 'cycle counts in progress', count: actions.openCycleCount, severity: 'info', href: '/dashboard/cycle-counts' });
  if (actions.openPoCount > 0)
    signals.push({ key: 'open_pos', label: 'open purchase orders', count: actions.openPoCount, severity: 'info', href: '/dashboard/purchase-orders' });

  return {
    signals,
    lowStock: lowStock.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      qty: Number(i.quantity_on_hand) || 0,
      reorderPoint: Number(i.reorder_point) || 0,
    })),
  };
}

/**
 * One-shot Gemini summary of the signals. Returns null (caller shows the
 * structured signals alone) when there's no key, nothing to report, or the
 * model errors — never throws.
 */
export async function summarizeInsights(result: InsightsResult): Promise<string | null> {
  if (!env.GEMINI_API_KEY || result.signals.length === 0) return null;
  try {
    const model = new GoogleGenerativeAI(env.GEMINI_API_KEY).getGenerativeModel({
      model: env.GEMINI_MODEL,
    });
    const facts = result.signals.map((s) => `- ${s.count} ${s.label}`).join('\n');
    const low = result.lowStock
      .slice(0, 5)
      .map((i) => `${i.name} (${i.sku}): ${i.qty} on hand, reorder at ${i.reorderPoint}`)
      .join('; ');
    const prompt = `You are an inventory operations assistant. In 2-3 plain sentences, write a "what needs attention today" briefing for a warehouse manager based ONLY on these facts. Lead with the most urgent, be specific with numbers, and never invent anything not listed.\n\nSignals:\n${facts}${low ? `\n\nLow-stock examples: ${low}` : ''}`;
    const res = await model.generateContent(prompt);
    const text = res.response.text().trim();
    return text || null;
  } catch {
    return null;
  }
}
