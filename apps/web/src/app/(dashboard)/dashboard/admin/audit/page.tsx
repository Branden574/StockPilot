import { AlertTriangle, FileLock } from 'lucide-react';

import { AuditFilters, AUDIT_CATEGORIES } from '@/components/admin/audit-filters';
import { EmptyState } from '@/components/dashboard/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';
import { cn, formatRelative } from '@/lib/utils';

interface AuditRow {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  user: { id?: string; full_name?: string | null; email?: string | null } | null;
}

const PAGE_SIZE = 100;

const EVENT_TONE: Array<{ match: (e: string) => boolean; tone: string }> = [
  {
    match: (e) =>
      e.startsWith('stock.') ||
      e === 'inventory.item.deleted' ||
      e === 'inventory.item.archived',
    tone: 'bg-warning/10 text-warning border-warning/30',
  },
  {
    match: (e) => e.startsWith('inventory.'),
    tone: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  },
  {
    match: (e) => e.startsWith('user.'),
    tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  },
  {
    match: (e) => e.startsWith('warehouse'),
    tone: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  },
  {
    match: (e) => e.startsWith('cycle_count.'),
    tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-500/30',
  },
  {
    match: (e) => e.startsWith('po_import.'),
    tone: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  },
];

function eventTone(event: string): string {
  const m = EVENT_TONE.find((s) => s.match(event));
  return m?.tone ?? 'bg-muted text-foreground border-border';
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; category?: string; actor?: string; cursor?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const activeCategory = params.category ?? 'all';
  const categoryDef = AUDIT_CATEGORIES.find((c) => c.slug === activeCategory);
  const prefix = categoryDef?.prefix ?? null;

  // Two-pass fetch: rows first, then a separate best-effort count.
  // The previous combined `select('…', { count: 'estimated' })` made the
  // rows query fail entirely whenever the count subquery hit a planner
  // edge case on large tables — taking the whole admin page down with it.
  //
  // We also moved off the `user:user_profiles!user_id (...)` embed because
  // PostgREST can't reliably resolve user_profiles via the auth.users
  // chain (same fix the schedule service applies — see schedule.ts).
  // Failed embeds previously surfaced as a generic Server Components
  // crash. Now we batch-load user_profiles separately and tolerate
  // failures gracefully.
  let q = supabase
    .from('audit_logs')
    .select('id, event, metadata, ip, user_agent, created_at, user_id')
    .eq('organization_id', ctx.organizationId)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (params.event) q = q.eq('event', params.event);
  if (prefix) q = q.like('event', `${prefix}%`);

  const { data, error } = await q;
  if (error) {
    void reportError(new Error(error.message), {
      tag: 'audit.list',
      level: 'error',
      organizationId: ctx.organizationId,
      extra: {
        code: error.code ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null,
      },
    });
    return (
      <div className="mx-auto w-full max-w-[1480px] px-8 pb-20 pt-7">
        <div className="mb-6 border-b border-border pb-4">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
            Admin
          </p>
          <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">Audit log</h1>
        </div>
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-destructive mt-0.5 h-5 w-5" />
            <div>
              <h2 className="text-sm font-semibold">Audit log failed to load</h2>
              <p className="text-muted-foreground mt-1 text-[13px]">
                The query against{' '}
                <code className="rounded bg-muted px-1 font-mono text-[11.5px]">audit_logs</code>{' '}
                returned an error. The issue has been logged to the error reporter.
              </p>
              <pre className="bg-muted mt-3 overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-tight">
{(error.code ?? 'error') + ': ' + error.message}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Best-effort row count for the header — tolerates timeouts.
  let count: number | null = null;
  try {
    let countQuery = supabase
      .from('audit_logs')
      .select('id', { count: 'estimated', head: true })
      .eq('organization_id', ctx.organizationId);
    if (params.event) countQuery = countQuery.eq('event', params.event);
    if (prefix) countQuery = countQuery.like('event', `${prefix}%`);
    const { count: c } = await countQuery;
    count = c ?? null;
  } catch {
    count = null;
  }

  const actorTrim = params.actor?.trim().toLowerCase() ?? '';

  const rawRows = (data ?? []) as Array<{
    id: string;
    event: string;
    metadata: Record<string, unknown> | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
    user_id: string | null;
  }>;

  // Batch-load user_profiles for every distinct user_id on this page.
  // Tolerates failure: if user_profiles can't be read, we just leave
  // the actor column blank instead of crashing the page.
  const userIds = [...new Set(rawRows.map((r) => r.user_id).filter((v): v is string => Boolean(v)))];
  const usersById = new Map<string, { id: string; full_name: string | null; email: string | null }>();
  if (userIds.length > 0) {
    try {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .in('id', userIds);
      for (const p of (profiles ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string | null;
      }>) {
        usersById.set(p.id, p);
      }
    } catch {
      // Leave the map empty; rows will render with a blank actor.
    }
  }

  const rows = rawRows
    .map((r) => ({
      id: r.id,
      event: r.event,
      metadata: r.metadata ?? null,
      ip: r.ip ?? null,
      user_agent: r.user_agent ?? null,
      created_at: r.created_at,
      user: r.user_id ? usersById.get(r.user_id) ?? null : null,
    }) satisfies AuditRow)
    .filter((row) => {
      if (!actorTrim) return true;
      const name = (row.user?.full_name ?? '').toLowerCase();
      const email = (row.user?.email ?? '').toLowerCase();
      return name.includes(actorTrim) || email.includes(actorTrim);
    });

  return (
    <div className="mx-auto w-full max-w-[1480px] px-8 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
          Admin
        </p>
        <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">Audit log</h1>
        <p className="mt-1 text-[13.5px] text-[var(--ed-ink-3)]">
          Read-only record of every sensitive action — invites, role changes, warehouse
          assignments, stock adjustments, transfers. Showing the most recent {PAGE_SIZE} entries
          {count ? ` of ~${count.toLocaleString()}` : ''}.
        </p>
      </div>

      <AuditFilters activeCategory={activeCategory} initialActor={params.actor ?? ''} />

      {rows.length === 0 ? (
        <EmptyState
          icon={FileLock}
          title={
            actorTrim || prefix
              ? 'No matching audit entries'
              : 'No audit entries yet'
          }
          description={
            actorTrim || prefix
              ? 'Try clearing filters or broadening the search.'
              : 'Sensitive actions are logged here automatically. Invite a user or change a role to see this populate.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">When</TableHead>
                <TableHead className="w-72">Event</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="w-32">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(row.created_at)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 font-mono text-[10.5px]',
                        eventTone(row.event),
                      )}
                    >
                      <span className="truncate">{row.event}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="font-medium">
                      {row.user?.full_name ?? row.user?.email ?? '—'}
                    </div>
                    {row.user?.full_name && row.user?.email && (
                      <div className="text-muted-foreground text-[11px]">
                        {row.user.email}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <details className="font-mono text-[11px] text-muted-foreground">
                      <summary className="cursor-pointer truncate text-foreground">
                        {summarize(row.metadata)}
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-[11px] leading-tight">
                        {JSON.stringify(row.metadata ?? {}, null, 2)}
                      </pre>
                    </details>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {row.ip ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function summarize(meta: Record<string, unknown> | null): string {
  if (!meta) return '(no payload)';
  const pieces: string[] = [];
  if (meta.entity_type) pieces.push(`${meta.entity_type}`);
  if (meta.entity_id && typeof meta.entity_id === 'string') {
    pieces.push(meta.entity_id.slice(0, 8));
  }
  if (meta.warehouse_id && typeof meta.warehouse_id === 'string') {
    pieces.push(`wh:${meta.warehouse_id.slice(0, 8)}`);
  }
  if (meta.reason && typeof meta.reason === 'string') pieces.push(meta.reason);
  return pieces.length > 0 ? pieces.join(' · ') : 'click to expand';
}
