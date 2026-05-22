'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import {
  ProceduresService,
  type ProcedureDetailRow,
  type ProcedureListRow,
} from '@/server/services/procedures';
import { ProcedureCategoriesService } from '@/server/services/procedure-categories';
import {
  ProcedureVideosService,
  type ProcedureVideoRow,
} from '@/server/services/procedure-videos';
import { ProcedureCommentsService } from '@/server/services/procedure-comments';

import {
  createProcedureSchema,
  updateProcedureSchema,
  createProcedureCategorySchema,
  updateProcedureCategorySchema,
  createProcedureCommentSchema,
  updateProcedureCommentSchema,
  recordProcedureVideoSchema,
  err,
  ok,
  type ActionResult,
  type CreateProcedureInput,
  type UpdateProcedureInput,
  type CreateProcedureCategoryInput,
  type UpdateProcedureCategoryInput,
  type CreateProcedureCommentInput,
  type UpdateProcedureCommentInput,
  type RecordProcedureVideoInput,
} from '@stockpilot/core';

// Re-export types so the client form / pages can pull them without
// importing a server-only services file.
export type { ProcedureDetailRow, ProcedureListRow, ProcedureVideoRow };

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
   
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

export async function createProcedureAction(
  input: CreateProcedureInput,
): Promise<ActionResult<{ id: string }>> {
  // Aggressive logging to chase a 500 that throws inside 47ms with no
  // Supabase queries visible in Vercel logs (the action errors before
  // reaching the DB). Every line below logs to stdout so the function
  // log shows the exact step that fails. Strip once root cause found.
  console.log('[procedures.create] ENTER', {
    titleLen: input?.title?.length ?? 0,
    hasDescription: !!input?.description,
    hasBody: !!input?.body,
    categoryId: input?.categoryId ?? null,
    authoringWarehouseId: input?.authoringWarehouseId ?? null,
  });

  let parsed;
  try {
    parsed = createProcedureSchema.safeParse(input);
    console.log('[procedures.create] safeParse OK', { ok: parsed.success });
  } catch (e) {
    console.error('[procedures.create] safeParse THREW', e);
    return err('validation_error', 'Schema parse threw');
  }

  if (!parsed.success) {
    console.log('[procedures.create] validation_error', parsed.error.issues);
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  let svc: ProceduresService;
  try {
    svc = await ProceduresService.forCurrentUser();
    console.log('[procedures.create] forCurrentUser OK');
  } catch (e) {
    console.error('[procedures.create] forCurrentUser THREW', e);
    return toResult(e);
  }

  let res: { id: string };
  try {
    res = await svc.create(parsed.data);
    console.log('[procedures.create] svc.create OK', res.id);
  } catch (e) {
    console.error('[procedures.create] svc.create THREW', e);
    return toResult(e);
  }

  console.log('[procedures.create] returning ok', res.id);
  return ok(res);
}

export async function updateProcedureAction(
  id: string,
  input: UpdateProcedureInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateProcedureSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ProceduresService.forCurrentUser();
    const res = await svc.update(id, parsed.data);
    revalidatePath('/dashboard/procedures');
    revalidatePath(`/dashboard/procedures/${id}`);
    revalidatePath(`/dashboard/procedures/${id}/edit`);
    return ok(res);
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveProcedureAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await ProceduresService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/procedures');
    revalidatePath(`/dashboard/procedures/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function restoreProcedureAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await ProceduresService.forCurrentUser();
    await svc.restore(id);
    revalidatePath('/dashboard/procedures');
    revalidatePath(`/dashboard/procedures/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export async function recordProcedureVideoAction(
  input: RecordProcedureVideoInput,
): Promise<ActionResult<ProcedureVideoRow>> {
  const parsed = recordProcedureVideoSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ProcedureVideosService.forCurrentUser();
    const row = await svc.record(parsed.data);
    revalidatePath(`/dashboard/procedures/${parsed.data.procedureId}`);
    revalidatePath(`/dashboard/procedures/${parsed.data.procedureId}/edit`);
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

export async function deleteProcedureVideoAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await ProcedureVideosService.forCurrentUser();
    const { procedureId } = await svc.delete(id);
    revalidatePath('/dashboard/procedures');
    revalidatePath(`/dashboard/procedures/${procedureId}`);
    revalidatePath(`/dashboard/procedures/${procedureId}/edit`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function createProcedureCommentAction(
  input: CreateProcedureCommentInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createProcedureCommentSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ProcedureCommentsService.forCurrentUser();
    const node = await svc.create(parsed.data);
    revalidatePath(`/dashboard/procedures/${parsed.data.procedureId}`);
    return ok({ id: node.id });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateProcedureCommentAction(
  id: string,
  input: UpdateProcedureCommentInput,
): Promise<ActionResult<void>> {
  const parsed = updateProcedureCommentSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ProcedureCommentsService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/procedures');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function deleteProcedureCommentAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await ProcedureCommentsService.forCurrentUser();
    await svc.delete(id);
    revalidatePath('/dashboard/procedures');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function createProcedureCategoryAction(
  input: CreateProcedureCategoryInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createProcedureCategorySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ProcedureCategoriesService.forCurrentUser();
    const row = await svc.create(parsed.data);
    revalidatePath('/dashboard/procedures');
    return ok({ id: row.id });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateProcedureCategoryAction(
  id: string,
  input: UpdateProcedureCategoryInput,
): Promise<ActionResult<void>> {
  const parsed = updateProcedureCategorySchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ProcedureCategoriesService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/procedures');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveProcedureCategoryAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await ProcedureCategoriesService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/procedures');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
