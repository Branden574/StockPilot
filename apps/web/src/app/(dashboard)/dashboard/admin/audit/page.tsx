import { FileLock } from 'lucide-react';

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
import { createClient } from '@/lib/supabase/server';
import { formatRelative } from '@/lib/utils';

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

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; cursor?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  let q = supabase
    .from('audit_logs')
    .select(
      'id, event, metadata, ip, user_agent, created_at, user:user_profiles!user_id (id, full_name, email)',
      { count: 'estimated' },
    )
    .eq('organization_id', ctx.organizationId)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (params.event) q = q.eq('event', params.event);

  const { data, count } = await q;

  const rows = (data ?? []).map((r) => {
    const u = (r as { user?: unknown }).user;
    const userObj = Array.isArray(u) ? u[0] : u;
    return {
      id: r.id as string,
      event: r.event as string,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      user_agent: (r.user_agent as string | null) ?? null,
      created_at: r.created_at as string,
      user: (userObj as AuditRow['user']) ?? null,
    } satisfies AuditRow;
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

      {rows.length === 0 ? (
        <EmptyState
          icon={FileLock}
          title="No audit entries yet"
          description="Sensitive actions are logged here automatically. Invite a user or change a role to see this populate."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">When</TableHead>
                <TableHead className="w-64">Event</TableHead>
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
                  <TableCell className="font-mono text-xs">{row.event}</TableCell>
                  <TableCell className="text-sm">
                    {row.user?.full_name ?? row.user?.email ?? '—'}
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
