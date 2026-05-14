import 'server-only';

import type {
  CreateProcedureCommentInput,
  UpdateProcedureCommentInput,
} from '@stockpilot/core';
import { isAdminRole } from '@stockpilot/core';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export interface ProcedureCommentAuthor {
  id: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

export interface ProcedureCommentNode {
  id: string;
  procedure_id: string;
  body: string;
  author: ProcedureCommentAuthor;
  is_own: boolean;
  parent_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  replies: ProcedureCommentNode[];
}

interface RawCommentRow {
  id: string;
  procedure_id: string;
  parent_id: string | null;
  author_id: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  author?:
    | {
        id: string;
        full_name: string | null;
        avatar_url: string | null;
      }
    | Array<{
        id: string;
        full_name: string | null;
        avatar_url: string | null;
      }>
    | null;
}

/**
 * ProcedureCommentsService — single-level threaded discussion under a
 * procedure. Posting a NEW comment requires `items:update` (staff+),
 * so viewer-only accounts can read the thread but can't add to it. The
 * database goes a step further: RLS on `procedure_comments_insert`
 * requires manager+ (migration 0088). Update/delete is allowed for the
 * author OR an admin+. Reply-to-reply is rejected at the service layer.
 */
export class ProcedureCommentsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ProcedureCommentsService(await withContext());
  }

  /**
   * Returns a 2-level comment tree for a single procedure. Top-level
   * comments come first, then their replies are nested under `.replies`.
   * Deleted comments are kept in the tree so threads don't collapse —
   * the body field is preserved but the UI is expected to render
   * "(deleted)" when `deleted_at` is non-null.
   */
  async listForProcedure(procedureId: string): Promise<ProcedureCommentNode[]> {
    const { data, error } = await this.ctx.supabase
      .from('procedure_comments')
      .select(
        `id, procedure_id, parent_id, author_id, body, created_at, edited_at, deleted_at,
         author:user_profiles!author_id (id, full_name, avatar_url)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('procedure_id', procedureId)
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    const rows = (data ?? []) as unknown as RawCommentRow[];
    const byId = new Map<string, ProcedureCommentNode>();
    const roots: ProcedureCommentNode[] = [];

    for (const r of rows) {
      const a = Array.isArray(r.author) ? r.author[0] : r.author;
      const node: ProcedureCommentNode = {
        id: r.id,
        procedure_id: r.procedure_id,
        body: r.body,
        author: {
          id: a?.id ?? r.author_id,
          full_name: a?.full_name ?? null,
          avatar_url: a?.avatar_url ?? null,
        },
        is_own: r.author_id === this.ctx.userId,
        parent_id: r.parent_id,
        created_at: r.created_at,
        edited_at: r.edited_at,
        deleted_at: r.deleted_at,
        replies: [],
      };
      byId.set(node.id, node);
    }
    for (const node of byId.values()) {
      if (node.parent_id && byId.has(node.parent_id)) {
        byId.get(node.parent_id)!.replies.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * Creates a comment. Reply-to-reply is rejected here: if `parentId` is
   * provided, we fetch that comment and refuse if it ITSELF has a
   * non-null parent_id — the schema allows arbitrary nesting but the
   * product is intentionally single-level.
   */
  async create(input: CreateProcedureCommentInput): Promise<ProcedureCommentNode> {
    // Gate posting on `items:update` (staff+). Viewers can read the
    // thread via RLS but can't add to it through the service. The
    // database insert policy is stricter still (manager+, see migration
    // 0088) — this assert exists so a viewer hits a friendly 403 instead
    // of a raw RLS denial from PostgREST.
    assertPermission(this.ctx, 'items:update');
    if (input.parentId) {
      const { data: parent, error: parentErr } = await this.ctx.supabase
        .from('procedure_comments')
        .select('id, parent_id, procedure_id, organization_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', input.parentId)
        .maybeSingle();
      if (parentErr) throw new ServiceError('internal_error', parentErr.message);
      if (!parent) throw new ServiceError('not_found', 'Parent comment not found');
      if ((parent.parent_id as string | null) !== null) {
        throw new ServiceError(
          'validation_error',
          'Replies to replies are not allowed — reply to the top-level comment instead.',
        );
      }
      if ((parent.procedure_id as string) !== input.procedureId) {
        throw new ServiceError('validation_error', 'Parent comment is on a different procedure');
      }
    }
    const { data, error } = await this.ctx.supabase
      .from('procedure_comments')
      .insert({
        organization_id: this.ctx.organizationId,
        procedure_id: input.procedureId,
        parent_id: input.parentId ?? null,
        author_id: this.ctx.userId,
        body: input.body,
      })
      .select(
        `id, procedure_id, parent_id, author_id, body, created_at, edited_at, deleted_at,
         author:user_profiles!author_id (id, full_name, avatar_url)`,
      )
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    const r = data as unknown as RawCommentRow;
    const a = Array.isArray(r.author) ? r.author[0] : r.author;
    void audit(
      {
        event: 'procedure.commented',
        entityType: 'procedure',
        entityId: input.procedureId,
        extra: { comment_id: r.id, parent_id: input.parentId ?? null },
      },
      this.ctx,
    );
    return {
      id: r.id,
      procedure_id: r.procedure_id,
      body: r.body,
      author: {
        id: a?.id ?? r.author_id,
        full_name: a?.full_name ?? null,
        avatar_url: a?.avatar_url ?? null,
      },
      is_own: true,
      parent_id: r.parent_id,
      created_at: r.created_at,
      edited_at: r.edited_at,
      deleted_at: r.deleted_at,
      replies: [],
    };
  }

  async update(id: string, input: UpdateProcedureCommentInput): Promise<void> {
    const row = await this.fetchOwnedOrAdmin(id);
    if (row.deleted_at) {
      throw new ServiceError('validation_error', 'Cannot edit a deleted comment');
    }
    const { error } = await this.ctx.supabase
      .from('procedure_comments')
      .update({ body: input.body, edited_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      {
        event: 'procedure.comment.updated',
        entityType: 'procedure',
        entityId: row.procedure_id,
        extra: {
          comment_id: id,
          before_body: row.body,
          moderator: row.author_id !== this.ctx.userId,
        },
      },
      this.ctx,
    );
  }

  /**
   * Soft delete. Sets `deleted_at` and zeroes the body so the original
   * text isn't returned on subsequent reads — but leaves the row in
   * place so the thread shape (parent → replies) doesn't collapse.
   */
  async delete(id: string): Promise<void> {
    const row = await this.fetchOwnedOrAdmin(id);
    if (row.deleted_at) return; // idempotent
    const { error } = await this.ctx.supabase
      .from('procedure_comments')
      .update({ deleted_at: new Date().toISOString(), body: '(deleted)' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      {
        event: 'procedure.comment.deleted',
        entityType: 'procedure',
        entityId: row.procedure_id,
        extra: {
          comment_id: id,
          before_body: row.body,
          moderator: row.author_id !== this.ctx.userId,
        },
      },
      this.ctx,
    );
  }

  /**
   * Fetches the comment row + asserts the current user is its author or
   * an admin+. Returns the row so the caller can use procedure_id /
   * deleted_at for follow-up logic.
   */
  private async fetchOwnedOrAdmin(id: string): Promise<{
    procedure_id: string;
    author_id: string | null;
    body: string;
    deleted_at: string | null;
  }> {
    const { data, error } = await this.ctx.supabase
      .from('procedure_comments')
      .select('procedure_id, author_id, body, deleted_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Comment not found');
    const authorId = data.author_id as string | null;
    if (authorId !== this.ctx.userId && !isAdminRole(this.ctx.role)) {
      throw new ServiceError('forbidden', 'You can only edit or delete your own comments');
    }
    return {
      procedure_id: data.procedure_id as string,
      author_id: authorId,
      body: (data.body as string) ?? '',
      deleted_at: data.deleted_at as string | null,
    };
  }
}
