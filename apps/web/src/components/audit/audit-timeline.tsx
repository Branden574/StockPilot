import { History } from 'lucide-react';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { MetadataDiff } from '@/components/audit/metadata-diff';
import { formatAuditEvent } from '@/lib/audit/format';
import { formatRelative } from '@/lib/utils';
import { AuditLogService, type AuditLogRow } from '@/server/services/audit-log';

/**
 * Presentational rail — no data fetching, so it's unit-testable with
 * canned rows (see audit-timeline.test.tsx) without mocking the service
 * layer. `AuditTimeline` below is the async Server Component that fetches
 * and wraps this in an optional Card.
 */
export function AuditTimelineList({ rows }: { rows: AuditLogRow[] }) {
  if (rows.length === 0) return null;

  return (
    <ol className="relative space-y-5 border-l border-border pl-5">
      {rows.map((row) => {
        const actorName =
          row.actor?.fullName ?? row.actor?.email ?? (row.actor ? 'Unknown' : 'System');
        const reason = (row.metadata.reason as string | null | undefined) ?? null;
        return (
          <li key={row.id} className="relative">
            <span
              aria-hidden
              className="absolute -left-[27px] mt-1.5 block h-2.5 w-2.5 rounded-full border border-border bg-background"
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="text-sm font-medium">{formatAuditEvent(row.event)}</p>
              <time
                dateTime={row.createdAt}
                className="text-xs text-muted-foreground tabular-nums"
                title={new Date(row.createdAt).toLocaleString()}
              >
                {formatRelative(row.createdAt)}
              </time>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              by{' '}
              <span className="text-foreground">{actorName}</span>
              {row.actor?.email && row.actor.fullName ? (
                <span className="ml-1 text-[11px]">({row.actor.email})</span>
              ) : null}
            </p>
            {reason ? (
              <p className="mt-1 text-xs text-muted-foreground">{reason}</p>
            ) : null}
            <MetadataDiff metadata={row.metadata} />
          </li>
        );
      })}
    </ol>
  );
}

interface AuditTimelineProps {
  entityType: string;
  entityId: string;
  limit?: number;
  /**
   * When provided, the timeline renders itself wrapped in a Card with
   * this title. When omitted, only the timeline rail is rendered (so
   * callers can place it inside their own card chrome).
   *
   * Either way: if there are no rows, the component renders `null` so
   * pages don't end up with a hollow "Recent activity" card on items
   * that have never been touched.
   */
  wrapperTitle?: string;
}

export async function AuditTimeline({
  entityType,
  entityId,
  limit = 30,
  wrapperTitle,
}: AuditTimelineProps) {
  const svc = await AuditLogService.forCurrentUser();
  const rows = await svc.forEntity(entityType, entityId, limit);

  if (rows.length === 0) return null;

  const inner = <AuditTimelineList rows={rows} />;

  if (!wrapperTitle) return inner;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" />
          {wrapperTitle}
        </CardTitle>
      </CardHeader>
      <CardContent>{inner}</CardContent>
    </Card>
  );
}
