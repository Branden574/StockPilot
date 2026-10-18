import { FileLock } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { actorText, isRowPersonDeleted } from '@/lib/deleted-user-labels';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface AuditRow {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  actor: { full_name: string | null; email: string | null } | null;
  /** The actor deleted their account (0393: user_id null and stamped). */
  actor_deleted: boolean;
}

/** No rows yet (one array, so an empty list keeps one identity). */
const NO_ROWS: AuditRow[] = [];

export default function AuditLogAdmin() {
  const { orgId } = useOrg();
  const { isAdmin, loading: roleLoading } = useRole();
  // The drawer item gates on effective activity_logs:read (managers hold it
  // by default; Auditor-preset viewers gain it), so the screen must accept
  // the same audience — an isAdmin-only gate here dead-ends everyone the nav
  // now routes in. While permissions are still loading (undefined) we let the
  // query run: audit_logs SELECT RLS (mig 0279) is the real enforcement and
  // simply returns no rows for the unauthorized.
  const perms = useEffectivePermissions();
  const canView = isAdmin || perms === undefined || perms.has('activity_logs:read');
  // The rows on screen and the workspace they were read for: a failed read
  // keeps them only when they are this workspace's (never the last
  // workspace's rows under "Could not refresh" after a switch).
  const [list, setList] = React.useState<{ orgId: string; rows: AuditRow[] } | null>(null);
  const rows = list?.rows ?? NO_ROWS;
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // The last read failed (set by every read that completes): said as a
  // failure, never "No audit events yet." (D25); rows from an earlier read
  // stay under "Could not refresh", and the eyebrow quotes no count it did
  // not read.
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!orgId || !canView) {
      setLoading(false);
      return;
    }
    const forOrg = orgId;
    let read;
    try {
      read = await supabase
        .from('audit_logs')
        .select(
          `id, event, metadata, ip, user_agent, created_at, user_id, deleted_users,
         actor:user_profiles!user_id (full_name, email)`,
        )
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(200);
    } catch {
      read = null;
    }
    if (!read || read.error) {
      setList((prev) => (prev !== null && prev.orgId === forOrg ? prev : null));
      setFailed(true);
      setLoading(false);
      return;
    }
    const { data } = read;
    setFailed(false);
    setList({
      orgId: forOrg,
      rows: (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const a = r.actor as AuditRow['actor'] | AuditRow['actor'][] | null;
        return {
          id: r.id as string,
          event: r.event as string,
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
          ip: (r.ip as string | null) ?? null,
          user_agent: (r.user_agent as string | null) ?? null,
          created_at: r.created_at as string,
          actor: Array.isArray(a) ? a[0] ?? null : a,
          actor_deleted: isRowPersonDeleted(r),
        };
      }),
    });
    setLoading(false);
  }, [orgId, canView]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await except the pre-await guard that resolves loading for the unauthorized; the effect synchronizes with the server
    if (!roleLoading) void load();
  }, [load, roleLoading]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!roleLoading && !canView) {
    return (
      <DataListScreen
        eyebrow="ADMIN · AUDIT LOG"
        title="Restricted"
        italic="access."
        emptyIcon={FileLock}
        emptyTitle="Requires audit log access."
        emptyBody="Ask an admin to grant the Activity logs permission."
        data={[]}
        loading={false}
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  return (
    <DataListScreen
      eyebrow={failed && rows.length === 0 ? 'ADMIN · AUDIT LOG' : `ADMIN · ${rows.length} EVENTS`}
      title="Audit"
      italic="log."
      emptyTitle="No audit events yet."
      emptyBody="Privileged actions (role changes, invites, PO approvals, admin edits) log here."
      emptyIcon={FileLock}
      failed={
        failed
          ? {
              title: 'Could not load audit events.',
              body: 'Check your connection and pull down to try again.',
              reloadNote: 'Could not refresh. Showing the last list.',
            }
          : null
      }
      data={rows}
      loading={loading || roleLoading}
      refreshing={refreshing}
      onRefresh={refresh}
      keyExtractor={(a) => a.id}
      renderItem={(a) => <AuditCard row={a} />}
    />
  );
}

function AuditCard({ row }: { row: AuditRow }) {
  const { c } = useTheme();
  const actor = actorText(row.actor, row.actor_deleted);
  const when = new Date(row.created_at);
  return (
    <Card padding={12}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.mono }}>
            {row.event}
          </Mono>
          <Body size={12.5} color={c.ink3} style={{ marginTop: 3, fontFamily: FONT.displayRegular }}>
            {actor}
            {row.ip ? ` · ${row.ip}` : ''}
          </Body>
        </View>
        <Mono size={10} tracking={0.04} color={c.ink3}>
          {when.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </Mono>
      </View>
    </Card>
  );
}
