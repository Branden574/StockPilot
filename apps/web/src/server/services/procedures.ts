import 'server-only';

import type { CreateProcedureInput, UpdateProcedureInput } from '@stockpilot/core';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { ProcedureVideosService, type ProcedureVideoWithUrl } from './procedure-videos';
import {
  ProcedureCommentsService,
  type ProcedureCommentNode,
} from './procedure-comments';

// UUID v4-ish regex; mirrors what the action schemas use upstream. Catches
// the common case of a hand-typed id ("foo") before it ever hits Postgres,
// where an invalid UUID becomes a 22P02 → 500. Hex-only, with the standard
// 8-4-4-4-12 dash layout; we accept ANY version, not just v4, because we
// generate v4 ourselves but Postgres also produces v1 in older paths.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id: string, what = 'id'): void {
  if (!UUID_RE.test(id)) {
    throw new ServiceError('validation_error', `Invalid ${what} — expected a UUID`);
  }
}

export interface ProcedureListRow {
  id: string;
  title: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  authoring_warehouse_id: string | null;
  authoring_warehouse_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  video_count: number;
  comment_count: number;
  thumbnail_url: string | null;
}

export interface ProcedureDetailRow {
  id: string;
  title: string;
  description: string | null;
  body: string | null;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  authoring_warehouse_id: string | null;
  authoring_warehouse_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string;
  archived_at: string | null;
  videos: ProcedureVideoWithUrl[];
  comments: ProcedureCommentNode[];
}

interface ListParams {
  q?: string | null;
  categoryId?: string | null;
  warehouseId?: string | null;
  limit?: number;
  offset?: number;
  /**
   * Binary toggle for the manager-facing list. When omitted/false, returns
   * rows where `archived_at IS NULL`. When true, returns ONLY archived rows
   * (`archived_at IS NOT NULL`).
   */
  includeArchived?: boolean;
}

/**
 * Convert a free-form user search string into a tsquery-safe form for
 * websearch_to_tsquery. websearch_to_tsquery is more forgiving than
 * to_tsquery (it accepts user-typed phrases, ORs, quoted terms) but it
 * can still error on certain inputs in very old Postgres versions, so
 * we wrap the search in a try/catch and fall back to ilike on title.
 */
function tsQueryFor(q: string): string {
  return q.trim();
}

/**
 * Escape the two ilike wildcards (`%`, `_`) so a search like `50%_off`
 * doesn't degenerate into "match anything containing 50, then anything,
 * then off". PostgREST passes the pattern through to Postgres
 * unmodified, so the escape has to happen here. We use the conventional
 * backslash escape character — `like '...' escape '\'` is the Postgres
 * default and PostgREST honors it without any extra wiring.
 */
function escapeIlike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * ProceduresService — SOP knowledge base records.
 *
 * Read is open to org members (RLS enforces). Writes gate on
 * `categories:manage` which is the manager+ permission, matching the
 * migration's manager-level RLS on the procedures table.
 */
export class ProceduresService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ProceduresService(await withContext());
  }

  /**
   * List active procedures with optional full-text search + category +
   * warehouse filters. Returns the rows for the current page plus a
   * total count. Categories and authoring warehouses are joined inline.
   *
   * When `q` is provided we use Postgres's `websearch_to_tsquery` against
   * the generated `search_tsv` column (defined in 0053_procedures.sql).
   * If PostgREST returns a parse error from the tsquery, we transparently
   * fall back to `ilike` on title so the user still sees something useful.
   */
  async list({
    q,
    categoryId,
    warehouseId,
    limit = 24,
    offset = 0,
    includeArchived = false,
  }: ListParams): Promise<{ rows: ProcedureListRow[]; total: number }> {
    // TODO(perf): the embedded `videos` + `comments` arrays are an N+1
    // shape — we hydrate every row to compute the live comment count and
    // pick a thumbnail. The proper fix is a server-side view / RPC that
    // returns `video_count`, `live_comment_count`, and `first_video_path`
    // pre-aggregated. Deferring for now: org procedure tables are tiny in
    // practice (<<1K rows) and the cost is dwarfed by the storage signed
    // URL roundtrip below. Revisit when the largest org crosses ~5K SOPs.
    const baseSelect = `id, title, description, category_id, authoring_warehouse_id,
        created_by, created_at, updated_at,
        category:procedure_categories!category_id (id, name, color),
        authoring_warehouse:warehouses!authoring_warehouse_id (id, name),
        author:user_profiles!created_by (id, full_name),
        videos:procedure_videos!procedure_id (id, storage_path, order_idx),
        comments:procedure_comments!procedure_id (id, deleted_at)`;

    // NOTE: We currently use `count: 'exact'` because the procedures
    // tables stay small for the lifetime of most orgs (low hundreds of
    // SOPs is a reasonable ceiling). If this ever exceeds ~50K rows,
    // swap to `count: 'estimated'` — the pagination footer would lose
    // precision but list latency wouldn't degrade linearly with table
    // size.
    const buildBase = () => {
      let qry = this.ctx.supabase
        .from('procedures')
        .select(baseSelect, { count: 'exact' })
        .eq('organization_id', this.ctx.organizationId);
      qry = includeArchived
        ? qry.not('archived_at', 'is', null)
        : qry.is('archived_at', null);
      if (categoryId) qry = qry.eq('category_id', categoryId);
      if (warehouseId) qry = qry.eq('authoring_warehouse_id', warehouseId);
      return qry;
    };

    const trimmed = (q ?? '').trim();

    // Run the actual query, with a tsquery → ilike fallback path for the
    // rare case where the user's search string can't be parsed.
    let data:
      | Array<Record<string, unknown>>
      | null = null;
    let count: number | null = null;
    if (trimmed.length > 0) {
      const tsq = tsQueryFor(trimmed);
      const tsRes = await buildBase()
        // PostgREST: `textSearch` builds `to_tsquery` against the column.
        // We pass `websearch` to use websearch_to_tsquery (Postgres ≥ 11).
        .textSearch('search_tsv', tsq, { type: 'websearch', config: 'english' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (tsRes.error) {
        // Fallback: ilike on title only. Logs (but does not throw) so we
        // can see how often this branch fires.
         
        console.warn('[procedures] tsquery parse failed, falling back to ilike', tsRes.error.message);
        const ilikeRes = await buildBase()
          .ilike('title', `%${escapeIlike(trimmed)}%`)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);
        if (ilikeRes.error) throw new ServiceError('internal_error', ilikeRes.error.message);
        data = (ilikeRes.data ?? []) as Array<Record<string, unknown>>;
        count = ilikeRes.count ?? data.length;
      } else {
        data = (tsRes.data ?? []) as Array<Record<string, unknown>>;
        count = tsRes.count ?? data.length;
      }
    } else {
      const res = await buildBase()
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (res.error) throw new ServiceError('internal_error', res.error.message);
      data = (res.data ?? []) as Array<Record<string, unknown>>;
      count = res.count ?? data.length;
    }

    // Collect first-video paths for signed-URL minting (thumbnail row).
    const firstVideoPathByProc = new Map<string, string>();
    for (const r of data) {
      const videos = r.videos as Array<{ storage_path: string; order_idx: number }> | null;
      if (Array.isArray(videos) && videos.length > 0) {
        const sorted = [...videos].sort((a, b) => a.order_idx - b.order_idx);
        firstVideoPathByProc.set(r.id as string, sorted[0]!.storage_path);
      }
    }
    let thumbUrlByPath = new Map<string, string>();
    if (firstVideoPathByProc.size > 0) {
      const videosSvc = new ProcedureVideosService(this.ctx);
      thumbUrlByPath = await videosSvc.signedUrls([...firstVideoPathByProc.values()]);
    }

    const rows: ProcedureListRow[] = data.map((r) => {
      const cat = Array.isArray(r.category) ? r.category[0] : r.category;
      const wh = Array.isArray(r.authoring_warehouse)
        ? r.authoring_warehouse[0]
        : r.authoring_warehouse;
      const auth = Array.isArray(r.author) ? r.author[0] : r.author;
      const videos = (r.videos as Array<{ id: string }> | null) ?? [];
      const comments = (r.comments as Array<{ deleted_at: string | null }> | null) ?? [];
      const liveCommentCount = comments.filter((c) => c.deleted_at === null).length;
      const firstPath = firstVideoPathByProc.get(r.id as string);
      return {
        id: r.id as string,
        title: r.title as string,
        description: (r.description as string | null) ?? null,
        category_id: (r.category_id as string | null) ?? null,
        category_name: (cat as { name?: string } | null)?.name ?? null,
        category_color: (cat as { color?: string | null } | null)?.color ?? null,
        authoring_warehouse_id: (r.authoring_warehouse_id as string | null) ?? null,
        authoring_warehouse_name: (wh as { name?: string } | null)?.name ?? null,
        created_by: (r.created_by as string | null) ?? null,
        created_by_name: (auth as { full_name?: string } | null)?.full_name ?? null,
        created_at: r.created_at as string,
        updated_at: r.updated_at as string,
        video_count: videos.length,
        comment_count: liveCommentCount,
        thumbnail_url: firstPath ? thumbUrlByPath.get(firstPath) ?? null : null,
      };
    });

    return { rows, total: count ?? rows.length };
  }

  /**
   * Loads one procedure with its category, authoring warehouse, videos
   * (with fresh signed URLs), and full comment tree (with author display
   * info joined). Throws not_found if RLS hides the row.
   */
  async get(id: string): Promise<ProcedureDetailRow> {
    assertUuid(id, 'procedure id');
    const { data, error } = await this.ctx.supabase
      .from('procedures')
      .select(
        `id, title, description, body, category_id, authoring_warehouse_id,
         created_by, created_at, updated_by, updated_at, archived_at,
         category:procedure_categories!category_id (id, name, color),
         authoring_warehouse:warehouses!authoring_warehouse_id (id, name),
         author:user_profiles!created_by (id, full_name),
         editor:user_profiles!updated_by (id, full_name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Procedure not found');

    const videosSvc = new ProcedureVideosService(this.ctx);
    const commentsSvc = new ProcedureCommentsService(this.ctx);
    const [videos, comments] = await Promise.all([
      videosSvc.listForProcedureWithUrls(id),
      commentsSvc.listForProcedure(id),
    ]);

    const cat = Array.isArray(data.category) ? data.category[0] : data.category;
    const wh = Array.isArray(data.authoring_warehouse)
      ? data.authoring_warehouse[0]
      : data.authoring_warehouse;
    const auth = Array.isArray(data.author) ? data.author[0] : data.author;
    const ed = Array.isArray(data.editor) ? data.editor[0] : data.editor;

    return {
      id: data.id as string,
      title: data.title as string,
      description: (data.description as string | null) ?? null,
      body: (data.body as string | null) ?? null,
      category_id: (data.category_id as string | null) ?? null,
      category_name: (cat as { name?: string } | null)?.name ?? null,
      category_color: (cat as { color?: string | null } | null)?.color ?? null,
      authoring_warehouse_id: (data.authoring_warehouse_id as string | null) ?? null,
      authoring_warehouse_name: (wh as { name?: string } | null)?.name ?? null,
      created_by: (data.created_by as string | null) ?? null,
      created_by_name: (auth as { full_name?: string } | null)?.full_name ?? null,
      created_at: data.created_at as string,
      updated_by: (data.updated_by as string | null) ?? null,
      updated_by_name: (ed as { full_name?: string } | null)?.full_name ?? null,
      updated_at: data.updated_at as string,
      archived_at: (data.archived_at as string | null) ?? null,
      videos,
      comments,
    };
  }

  async create(input: CreateProcedureInput): Promise<{ id: string }> {
    assertPermission(this.ctx, 'categories:manage');
    const { data, error } = await this.ctx.supabase
      .from('procedures')
      .insert({
        organization_id: this.ctx.organizationId,
        title: input.title,
        description: input.description ?? null,
        body: input.body ?? null,
        category_id: input.categoryId ?? null,
        authoring_warehouse_id: input.authoringWarehouseId ?? null,
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      {
        event: 'procedure.created',
        entityType: 'procedure',
        entityId: (data as { id: string }).id,
        after: { title: input.title, category_id: input.categoryId ?? null },
      },
      this.ctx,
    );
    return { id: (data as { id: string }).id };
  }

  async update(id: string, patch: UpdateProcedureInput): Promise<{ id: string }> {
    assertPermission(this.ctx, 'categories:manage');
    assertUuid(id, 'procedure id');
    // Optimistic concurrency: when the caller passes an `ifMatch`
    // timestamp (the row's updated_at as loaded by the form), gate
    // the UPDATE on it. A concurrent manager's save will have bumped
    // updated_at (via the BEFORE-UPDATE trigger), so this caller's
    // WHERE no longer matches and 0 rows are returned — we surface
    // that as a `conflict` ServiceError instead of silently overwriting
    // their changes (last-write-wins).
    const updates: Record<string, unknown> = { updated_by: this.ctx.userId };
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.description !== undefined) updates.description = patch.description ?? null;
    if (patch.body !== undefined) updates.body = patch.body ?? null;
    if (patch.categoryId !== undefined) updates.category_id = patch.categoryId ?? null;
    if (patch.authoringWarehouseId !== undefined)
      updates.authoring_warehouse_id = patch.authoringWarehouseId ?? null;
    let query = this.ctx.supabase
      .from('procedures')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (patch.ifMatch) {
      query = query.eq('updated_at', patch.ifMatch);
    }
    const { data, error } = await query.select('id').maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      // Either the row doesn't exist, or ifMatch was stale. Disambiguate
      // with a presence check so the user gets the right error copy.
      if (patch.ifMatch) {
        const { data: exists } = await this.ctx.supabase
          .from('procedures')
          .select('id')
          .eq('organization_id', this.ctx.organizationId)
          .eq('id', id)
          .maybeSingle();
        if (exists) {
          throw new ServiceError(
            'conflict',
            'Someone else just saved this procedure. Refresh the page to see their changes before re-saving yours.',
          );
        }
      }
      throw new ServiceError('not_found', 'Procedure not found.');
    }
    void audit(
      {
        event: 'procedure.updated',
        entityType: 'procedure',
        entityId: id,
        after: patch,
      },
      this.ctx,
    );
    return { id: (data as { id: string }).id };
  }

  async archive(id: string): Promise<void> {
    assertPermission(this.ctx, 'categories:manage');
    assertUuid(id, 'procedure id');
    // Filter on `archived_at is null` so we only flip live rows. If the
    // procedure is already archived (or doesn't exist), the .single()
    // returns PGRST116 and we map it to not_found instead of pretending
    // the call did something useful.
    const { data, error } = await this.ctx.supabase
      .from('procedures')
      .update({ archived_at: new Date().toISOString(), updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('archived_at', null)
      .select('id')
      .single();
    if (error) {
      if (error.code === 'PGRST116') {
        throw new ServiceError('not_found', 'Procedure not found or already archived');
      }
      throw new ServiceError('internal_error', error.message);
    }
    void audit(
      {
        event: 'procedure.archived',
        entityType: 'procedure',
        entityId: (data as { id: string }).id,
      },
      this.ctx,
    );
  }

  /**
   * Restore an archived procedure — clears `archived_at` so it reappears
   * in the active list. Same permission gate as archive() (manager+).
   * Throws `not_found` when the id is unknown OR the row was already live
   * (no-op restores are user-visible bugs, not silent successes).
   */
  async restore(id: string): Promise<void> {
    assertPermission(this.ctx, 'categories:manage');
    assertUuid(id, 'procedure id');
    const { data, error } = await this.ctx.supabase
      .from('procedures')
      .update({ archived_at: null, updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .not('archived_at', 'is', null)
      .select('id')
      .single();
    if (error) {
      if (error.code === 'PGRST116') {
        throw new ServiceError('not_found', 'Procedure not found or not archived');
      }
      throw new ServiceError('internal_error', error.message);
    }
    void audit(
      {
        event: 'procedure.restored',
        entityType: 'procedure',
        entityId: (data as { id: string }).id,
      },
      this.ctx,
    );
  }
}
